//! Detection models: the catalog compiled into the app, resumable downloads
//! checked by sha256, import of a .gguf the user already has, and starting
//! llama-server on the chosen one. Each model has an optional MTP draft that
//! llama-server uses for speculative decoding (same output, about twice as
//! fast); without it the model still runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{Error, Result};
use crate::AppState;

/// One downloadable .gguf.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub urls: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    /// "standard" | "accurate" | "best": the UI's label.
    pub tier: String,
    #[serde(flatten)]
    pub gguf: ModelFile,
    #[serde(default)]
    pub draft: Option<ModelFile>,
    pub license: String,
    pub license_url: String,
    /// Below this, the UI warns it may be slow.
    pub min_ram_gb: u32,
    /// Suggested from this much RAM (the largest such model wins); never if unset.
    #[serde(default)]
    pub suggest_ram_gb: Option<u32>,
    pub ctx: u32,
    pub chunk_chars: u32,
}

impl Model {
    fn files(&self) -> impl Iterator<Item = &ModelFile> {
        std::iter::once(&self.gguf).chain(self.draft.as_ref())
    }
}

#[derive(Deserialize)]
struct Catalog {
    models: Vec<Model>,
}

pub fn catalog() -> Vec<Model> {
    serde_json::from_str::<Catalog>(include_str!("../resources/models.json")).expect("models.json is valid").models
}

fn find(id: &str) -> Result<Model> {
    catalog().into_iter().find(|m| m.id == id).ok_or_else(|| Error::msg("unknown model"))
}

fn available(m: &Model) -> bool {
    m.files().all(|f| !f.file.is_empty() && f.sha256.len() == 64 && !f.urls.is_empty())
}

fn file_path(dir: &Path, f: &ModelFile) -> PathBuf {
    dir.join(&f.file)
}

fn part_path(dir: &Path, f: &ModelFile) -> PathBuf {
    file_path(dir, f).with_extension("gguf.part")
}

fn present(dir: &Path, f: &ModelFile) -> bool {
    !f.file.is_empty() && file_path(dir, f).exists()
}

#[derive(Default)]
pub struct Downloads {
    cancel: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    #[serde(flatten)]
    model: Model,
    /// The catalog lists a verified download for it.
    available: bool,
    /// The model itself is on disk: it can run.
    installed: bool,
    /// The draft is there too (or there is none).
    complete: bool,
    /// Model and draft together.
    total_size: u64,
    partial_bytes: u64,
    downloading: bool,
}

#[tauri::command]
pub fn model_catalog(state: State<'_, AppState>) -> Vec<ModelInfo> {
    let busy = state.downloads.cancel.lock().expect("lock");
    catalog()
        .into_iter()
        .map(|m| {
            let dir = &state.paths.models;
            let installed = present(dir, &m.gguf);
            let complete = m.files().all(|f| present(dir, f));
            let total_size = m.files().map(|f| f.size).sum();
            let partial_bytes = m.files().map(|f| std::fs::metadata(part_path(dir, f)).map(|md| md.len()).unwrap_or(0)).sum();
            ModelInfo { available: available(&m), installed, complete, total_size, partial_bytes, downloading: busy.contains_key(&m.id), model: m }
        })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    received: u64,
    total: u64,
    bytes_per_sec: u64,
    /// "downloading" | "verifying" | "done"
    phase: &'static str,
}

fn free_space(dir: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks.list().iter().filter(|d| dir.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space())
}

async fn hash_file(path: &Path, hasher: &mut Sha256) -> Result<u64> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let read = f.read(&mut buf).await?;
        if read == 0 {
            return Ok(n);
        }
        hasher.update(&buf[..read]);
        n += read as u64;
    }
}

/// Streams the file to `<file>.part`, resuming with a Range request, hashing
/// as it goes; renamed into place only when size and sha256 match.
pub async fn download(dir: &Path, m: &ModelFile, cancel: &AtomicBool, progress: impl Fn(Progress)) -> Result<()> {
    let dest = file_path(dir, m);
    if dest.exists() {
        return Ok(());
    }
    let part = part_path(dir, m);
    let mut hasher = Sha256::new();
    let mut have = if part.exists() { hash_file(&part, &mut hasher).await? } else { 0 };
    let mb = |b: u64| b / 1_048_576;
    crate::log::info("models", &format!("downloading {} ({} MB){}", m.file, mb(m.size), if have > 0 { format!(", resuming at {} MB", mb(have)) } else { String::new() }));
    if let Some(free) = free_space(dir) {
        if free < (m.size.saturating_sub(have)) + m.size / 10 {
            crate::log::warn("models", &format!("not enough disk space: {} MB free", mb(free)));
            return Err(Error::msg("not_enough_disk_space"));
        }
    }
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build()?;
    let mut last_err = Error::msg("no download source");
    for url in &m.urls {
        let mut rb = client.get(url);
        if have > 0 {
            rb = rb.header("Range", format!("bytes={have}-"));
        }
        let host = url.split('/').nth(2).unwrap_or_default().to_string();
        let res = match rb.send().await.and_then(|r| r.error_for_status()) {
            Ok(r) => r,
            Err(e) => {
                crate::log::warn("models", &format!("{}: {host} failed: {e}", m.file));
                last_err = e.into();
                continue;
            }
        };
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&part).await?;
        if res.status() != reqwest::StatusCode::PARTIAL_CONTENT && have > 0 {
            // The server ignored the range: start over.
            file.set_len(0).await?;
            hasher = Sha256::new();
            have = 0;
        }
        let started = Instant::now();
        let start_bytes = have;
        let mut last_tick = Instant::now();
        let mut stream = res.bytes_stream();
        let mut failed = None;
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                file.flush().await?;
                crate::log::info("models", &format!("{}: cancelled at {} MB", m.file, mb(have)));
                return Err(Error::Cancelled);
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            };
            file.write_all(&chunk).await?;
            hasher.update(&chunk);
            have += chunk.len() as u64;
            if last_tick.elapsed() >= Duration::from_millis(250) {
                last_tick = Instant::now();
                let secs = started.elapsed().as_secs_f64().max(0.001);
                progress(Progress { received: have, total: m.size, bytes_per_sec: ((have - start_bytes) as f64 / secs) as u64, phase: "downloading" });
            }
        }
        file.flush().await?;
        drop(file);
        if let Some(e) = failed {
            crate::log::warn("models", &format!("{}: {host} broke off at {} MB: {e}", m.file, mb(have)));
            last_err = e.into();
            continue;
        }
        progress(Progress { received: have, total: m.size, bytes_per_sec: 0, phase: "verifying" });
        let digest = hex::encode(std::mem::take(&mut hasher).finalize());
        if have != m.size || !digest.eq_ignore_ascii_case(&m.sha256) {
            crate::log::error("models", &format!("{}: {} bytes, sha256 {digest}: does not match the catalog; removed", m.file, have));
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::msg("download_corrupt"));
        }
        tokio::fs::rename(&part, &dest).await?;
        let secs = started.elapsed().as_secs_f64().max(0.001);
        crate::log::info("models", &format!("{}: done from {host}, {} MB in {secs:.0} s ({:.1} MB/s), sha256 ok", m.file, mb(have - start_bytes), (have - start_bytes) as f64 / 1_048_576.0 / secs));
        return Ok(());
    }
    Err(last_err)
}

#[tauri::command]
pub async fn model_download(state: State<'_, AppState>, id: String, on_progress: Channel<Progress>) -> Result<()> {
    let m = find(&id)?;
    if !available(&m) {
        return Err(Error::msg("model not available yet"));
    }
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut busy = state.downloads.cancel.lock().expect("lock");
        if busy.contains_key(&id) {
            return Err(Error::msg("already downloading"));
        }
        busy.insert(id.clone(), flag.clone());
    }
    let total: u64 = m.files().map(|f| f.size).sum();
    let mut done = 0u64;
    let mut out = Ok(());
    for f in m.files() {
        // Progress covers model and draft as one download.
        out = download(&state.paths.models, f, &flag, |p| {
            let _ = on_progress.send(Progress { received: done + p.received, total, ..p });
        })
        .await;
        if out.is_err() {
            break;
        }
        done += f.size;
    }
    if out.is_ok() {
        let _ = on_progress.send(Progress { received: total, total, bytes_per_sec: 0, phase: "done" });
    }
    state.downloads.cancel.lock().expect("lock").remove(&id);
    out
}

#[tauri::command]
pub fn model_cancel(state: State<'_, AppState>, id: String) {
    if let Some(f) = state.downloads.cancel.lock().expect("lock").get(&id) {
        f.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn model_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let m = find(&id)?;
    state.sidecars.llama_stop().await;
    for f in m.files() {
        for p in [file_path(&state.paths.models, f), part_path(&state.paths.models, f)] {
            if p.exists() {
                tokio::fs::remove_file(p).await?;
            }
        }
    }
    crate::log::info("models", &format!("deleted {id}"));
    Ok(())
}

/// A .gguf the user already has (no internet, or downloaded elsewhere): the
/// model or its draft. Accepted only if its sha256 matches one of them.
/// Returns false if cancelled.
#[tauri::command]
pub async fn model_import(state: State<'_, AppState>, app: AppHandle, id: String) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    let m = find(&id)?;
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().add_filter("GGUF", &["gguf"]).blocking_pick_file()).await.map_err(|e| Error::msg(e.to_string()))?;
    let Some(picked) = picked else { return Ok(false) };
    let src = picked.into_path().map_err(|e| Error::msg(e.to_string()))?;
    let mut hasher = Sha256::new();
    let n = hash_file(&src, &mut hasher).await?;
    let digest = hex::encode(hasher.finalize());
    let Some(f) = m.files().find(|f| n == f.size && digest.eq_ignore_ascii_case(&f.sha256)) else {
        crate::log::warn("models", &format!("import for {id} refused: {n} bytes, sha256 {digest} is not in the catalog"));
        return Err(Error::msg("import_mismatch"));
    };
    let dest = file_path(&state.paths.models, f);
    let tmp = dest.with_extension("gguf.import");
    tokio::fs::copy(&src, &tmp).await?;
    tokio::fs::rename(&tmp, &dest).await?;
    crate::log::info("models", &format!("imported {}", f.file));
    Ok(true)
}

/// Starts (or keeps) llama-server on this model. `ctx` 0 = the catalog default.
#[tauri::command]
pub async fn llama_start(state: State<'_, AppState>, id: String, ctx: u32) -> Result<()> {
    let m = find(&id)?;
    let dir = &state.paths.models;
    if !present(dir, &m.gguf) {
        return Err(Error::msg("model_not_installed"));
    }
    let draft = m.draft.as_ref().filter(|d| present(dir, d)).map(|d| file_path(dir, d));
    state.sidecars.llama_ensure(&file_path(dir, &m.gguf), draft.as_deref(), if ctx == 0 { m.ctx } else { ctx }).await
}

#[tauri::command]
pub async fn llama_stop(state: State<'_, AppState>) -> Result<()> {
    state.sidecars.llama_stop().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A tiny HTTP server that honours Range, or ignores it when `ignore_range`.
    fn serve(data: Vec<u8>, ignore_range: bool) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let mut s = s.unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let from = req.lines().find_map(|l| l.strip_prefix("Range: bytes=")).and_then(|r| r.trim_end_matches('-').parse::<usize>().ok());
                let (status, body) = match from {
                    Some(f) if !ignore_range => ("206 Partial Content", &data[f..]),
                    _ => ("200 OK", &data[..]),
                };
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(body);
            }
        });
        format!("http://{addr}/model.gguf")
    }

    fn model(data: &[u8], url: String) -> ModelFile {
        ModelFile { file: "t.gguf".into(), size: data.len() as u64, sha256: hex::encode(Sha256::digest(data)), urls: vec![url] }
    }

    #[test]
    fn catalog_is_complete() {
        let c = catalog();
        assert!(!c.is_empty());
        for m in &c {
            assert!(available(m), "{} has no verified download", m.id);
            assert!(m.files().all(|f| f.size > 0 && f.urls.iter().all(|u| u.starts_with("https://"))));
        }
    }

    #[tokio::test]
    async fn resumes_and_verifies() {
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        for ignore_range in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let m = model(&data, serve(data.clone(), ignore_range));
            std::fs::write(dir.path().join("t.gguf.part"), &data[..1000]).unwrap();
            download(dir.path(), &m, &AtomicBool::new(false), |_| {}).await.unwrap();
            assert_eq!(std::fs::read(dir.path().join("t.gguf")).unwrap(), data);
        }
    }

    #[tokio::test]
    async fn wrong_hash_is_rejected() {
        let data = vec![1u8; 5000];
        let dir = tempfile::tempdir().unwrap();
        let mut m = model(&data, serve(data.clone(), false));
        m.sha256 = "0".repeat(64);
        assert!(download(dir.path(), &m, &AtomicBool::new(false), |_| {}).await.is_err());
        assert!(!dir.path().join("t.gguf").exists());
    }
}
