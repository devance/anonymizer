//! The only way the WebView reaches the helpers. Rust picks the base URL and
//! adds the token, so the page never sees either, and only three targets exist.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::AppState;

#[derive(Deserialize)]
pub struct Req {
    target: String,
    method: String,
    path: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
struct Meta {
    status: u16,
    headers: HashMap<String, String>,
}

#[derive(Default)]
pub struct Streams {
    next: AtomicU32,
    running: std::sync::Mutex<HashMap<u32, tokio::task::AbortHandle>>,
}

fn client() -> Result<reqwest::Client> {
    // No timeout: OCR of a long scan legitimately takes minutes. Callers time out on their side.
    Ok(reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build()?)
}

async fn base(state: &AppState, app: &AppHandle, target: &str) -> Result<(String, Option<String>)> {
    match target {
        "engine" => state.sidecars.engine(app).await.map(|(b, t)| (b, Some(t))),
        "llama" => state.sidecars.llama().await.map(|(b, t)| (b, Some(t))),
        "ollama" => crate::config::load(&state.paths).ollama_base.map(|b| (b, None)).ok_or_else(|| Error::msg("no Ollama address set")),
        _ => Err(Error::msg("unknown target")),
    }
}

fn build(state_base: (String, Option<String>), r: &Req, body: Vec<u8>) -> Result<reqwest::RequestBuilder> {
    if !r.path.starts_with('/') || r.path.contains("://") || r.path.contains("..") {
        return Err(Error::msg("bad path"));
    }
    let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|_| Error::msg("bad method"))?;
    let mut rb = client()?.request(method, format!("{}{}", state_base.0, r.path));
    for (k, v) in &r.headers {
        if !k.eq_ignore_ascii_case("authorization") && !k.eq_ignore_ascii_case("host") {
            rb = rb.header(k, v);
        }
    }
    if let Some(t) = state_base.1 {
        rb = rb.bearer_auth(t);
    }
    Ok(rb.body(body))
}

/// The page probes the engine's /health every 15 s while a call is out: logged only when it isn't 200.
fn quiet(r: &Req) -> bool {
    r.path == "/health"
}

/// A line before each helper call (one that can take minutes, or hang), and one after it.
fn log_start(r: &Req, sent: usize) {
    if !quiet(r) {
        crate::log::info(&r.target, &format!("{} {} started, {} kB in", r.method, r.path, sent / 1024));
    }
}

/// One line per helper call: what, how long, how big. Paths are the app's own ("/ocr", "/v1/chat/completions").
fn log_done(r: &Req, status: u16, t: std::time::Instant, sent: usize, got: usize, note: &str) {
    if quiet(r) && status == 200 {
        return;
    }
    let line = format!("{} {} {status} in {:.2} s, {} kB in, {} kB out{note}", r.method, r.path, t.elapsed().as_secs_f32(), sent / 1024, got / 1024);
    if status >= 400 {
        crate::log::warn(&r.target, &line);
    } else {
        crate::log::info(&r.target, &line);
    }
}

fn log_failed(r: &Req, t: std::time::Instant, e: &Error) {
    crate::log::warn(&r.target, &format!("{} {} failed after {:.2} s: {e}", r.method, r.path, t.elapsed().as_secs_f32()));
}

fn meta_of(res: &reqwest::Response) -> Meta {
    let headers = res.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string()))).collect();
    Meta { status: res.status().as_u16(), headers }
}

/// A request to the engine that broke mid-way: when the engine process has ended (its watchdog
/// restarts it when a step hangs, or it crashed), say so in a message the page shows as such
/// ("document engine /ocr: …"). The next request starts a fresh engine.
async fn engine_gone(state: &AppState, r: &Req, err: Error) -> Error {
    if r.target != "engine" {
        return err;
    }
    // The broken connection can come before the exited process is reaped: look for up to a second.
    for _ in 0..10 {
        if let Some(how) = state.sidecars.engine_ended().await {
            return Error::msg(format!("document engine {}: the engine had stopped ({how}); it restarts on the next request", r.path));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    err
}

/// Header `x-anon-req` = {target, method, path, headers}; raw body. Returns
/// `[u32 LE meta length][meta JSON][body]`.
#[tauri::command]
pub async fn local_http(state: State<'_, AppState>, app: AppHandle, request: Request<'_>) -> Result<Response> {
    let r: Req = serde_json::from_str(request.headers().get("x-anon-req").and_then(|v| v.to_str().ok()).ok_or_else(|| Error::msg("x-anon-req missing"))?)?;
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(serde_json::Value::Null) => Vec::new(),
        InvokeBody::Json(v) => serde_json::to_vec(v)?,
    };
    let t = std::time::Instant::now();
    let sent = body.len();
    let rb = build(base(&state, &app, &r.target).await.inspect_err(|e| log_failed(&r, t, e))?, &r, body)?;
    log_start(&r, sent);
    let res = match rb.send().await {
        Ok(res) => res,
        Err(e) if e.is_connect() => return Err(Error::SidecarDown).inspect_err(|e| log_failed(&r, t, e)),
        Err(e) => return Err(engine_gone(&state, &r, e.into()).await).inspect_err(|e| log_failed(&r, t, e)),
    };
    let status = res.status().as_u16();
    let meta = serde_json::to_vec(&meta_of(&res))?;
    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(e) => return Err(engine_gone(&state, &r, e.into()).await).inspect_err(|e| log_failed(&r, t, e)),
    };
    log_done(&r, status, t, sent, bytes.len(), "");
    let mut out = Vec::with_capacity(4 + meta.len() + bytes.len());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

/// Streaming variant for model output (SSE, NDJSON). Each channel message is
/// raw bytes whose first byte says what follows: 0 meta JSON, 1 data, 2 end, 3 error.
#[tauri::command]
pub async fn local_http_stream(state: State<'_, AppState>, app: AppHandle, req: Req, body: String, on_event: Channel<Response>) -> Result<u32> {
    let t = std::time::Instant::now();
    let sent = body.len();
    let rb = build(base(&state, &app, &req.target).await.inspect_err(|e| log_failed(&req, t, e))?, &req, body.into_bytes())?;
    log_start(&req, sent);
    let id = state.streams.next.fetch_add(1, Ordering::Relaxed) + 1;
    let send = move |tag: u8, payload: &[u8]| {
        let mut v = Vec::with_capacity(1 + payload.len());
        v.push(tag);
        v.extend_from_slice(payload);
        let _ = on_event.send(Response::new(v));
    };
    let got = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let status = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(0));
    let (got2, status2) = (got.clone(), status.clone());
    let (target, label) = (req.target.clone(), format!("{} {}", req.method, req.path));
    let task = tokio::spawn(async move {
        let res = match rb.send().await {
            Ok(r) => r,
            Err(e) => {
                crate::log::warn(&target, &format!("{label}: {e}"));
                return send(3, (if e.is_connect() { "sidecar_down".to_string() } else { e.to_string() }).as_bytes());
            }
        };
        status2.store(res.status().as_u16(), Ordering::Relaxed);
        send(0, &serde_json::to_vec(&meta_of(&res)).unwrap_or_default());
        let mut s = res.bytes_stream();
        while let Some(chunk) = s.next().await {
            match chunk {
                Ok(b) => {
                    got2.fetch_add(b.len(), Ordering::Relaxed);
                    send(1, &b)
                }
                Err(e) => {
                    crate::log::warn(&target, &format!("{label}: stream broke: {e}"));
                    return send(3, e.to_string().as_bytes());
                }
            }
        }
        send(2, &[]);
    });
    state.streams.running.lock().expect("lock").insert(id, task.abort_handle());
    let streams = state.streams.clone();
    tokio::spawn(async move {
        let outcome = task.await;
        streams.running.lock().expect("lock").remove(&id);
        let note = match outcome {
            Err(e) if e.is_cancelled() => ", stopped by the app",
            Err(_) => ", crashed",
            Ok(()) => "",
        };
        match status.load(Ordering::Relaxed) {
            0 => crate::log::warn(&req.target, &format!("{} {} got no answer after {:.2} s{note}", req.method, req.path, t.elapsed().as_secs_f32())),
            st => log_done(&req, st, t, sent, got.load(Ordering::Relaxed), &format!(" (stream){note}")),
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn local_http_cancel(state: State<'_, AppState>, id: u32) {
    if let Some(h) = state.streams.running.lock().expect("lock").remove(&id) {
        h.abort();
    }
}
