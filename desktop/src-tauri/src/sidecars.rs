//! The two helper processes: the Python document engine (always on) and
//! llama-server (started for a model on first detection). Both listen on
//! 127.0.0.1 only, with a per-launch token passed through the environment.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::error::{Error, Result};

pub struct Proc {
    child: Child,
    // Held so the engine sees EOF on stdin (and exits) if this process dies.
    _stdin: Option<ChildStdin>,
    pub port: u16,
    pub token: String,
}

impl Proc {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    /// How it ended, for the log: "exit status: 1", "signal: 9 (SIGKILL)".
    fn ended(&mut self) -> String {
        match self.child.try_wait() {
            Ok(Some(st)) => st.to_string(),
            Ok(None) => "still running".into(),
            Err(e) => e.to_string(),
        }
    }
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub struct Llama {
    pub proc: Proc,
    pub model: PathBuf,
    pub draft: Option<PathBuf>,
    pub ctx: u32,
}

#[derive(Default)]
pub struct Sidecars {
    engine: Mutex<Option<Proc>>,
    llama: Mutex<Option<Llama>>,
    engine_error: std::sync::Mutex<Option<String>>,
    llama_error: std::sync::Mutex<Option<String>>,
}

fn token() -> String {
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap_or_else(|_| PathBuf::from("."))
}

/// The frozen engine inside the bundle; in dev, the PyInstaller build or the venv.
fn engine_command(app: &AppHandle) -> Result<Command> {
    let res = app.path().resource_dir()?;
    #[cfg(target_os = "macos")]
    let bundled = res.join("../Helpers/AnonEngine.app/Contents/MacOS/anon-engine");
    #[cfg(not(target_os = "macos"))]
    let bundled = res.join("engine").join(if cfg!(windows) { "anon-engine.exe" } else { "anon-engine" });
    if bundled.exists() {
        return Ok(Command::new(bundled));
    }
    #[cfg(debug_assertions)]
    {
        let root = repo_root().join("engine");
        let frozen = root.join("dist/AnonEngine.app/Contents/MacOS/anon-engine");
        if frozen.exists() && std::env::var_os("ANON_ENGINE_VENV").is_none() {
            return Ok(Command::new(frozen));
        }
        let py = root.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" });
        let mut c = Command::new(py);
        c.args(["-m", "engine.desktop"]).current_dir(&root);
        return Ok(c);
    }
    #[allow(unreachable_code)]
    Err(Error::msg("document engine not found"))
}

fn llama_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| Error::msg("no exe dir"))?;
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    for p in [dir.join(name), dir.join("llama").join(name)] {
        if p.exists() {
            return Ok(p);
        }
    }
    if let Some(p) = std::env::var_os("ANON_LLAMA_SERVER") {
        return Ok(PathBuf::from(p));
    }
    #[cfg(debug_assertions)]
    for p in ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"] {
        if Path::new(p).exists() {
            return Ok(PathBuf::from(p));
        }
    }
    Err(Error::msg("llama-server not found"))
}

fn no_window(c: &mut Command) {
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = c;
}

/// A helper's output, line by line, into the log. Neither prints document
/// content: the engine logs warnings and tracebacks only, llama-server logs
/// timings and slot state (prompts only with --verbose, which we never pass).
fn pipe_to_log(source: &'static str, r: impl AsyncRead + Unpin + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        let mut r = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim_end();
                    if line.is_empty() {
                        continue;
                    }
                    let l = line.to_ascii_lowercase();
                    if l.contains("error") || l.contains("traceback") || l.contains("exception") || l.contains("failed") {
                        crate::log::warn(source, line);
                    } else {
                        crate::log::info(source, line);
                    }
                }
            }
        }
    });
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

async fn wait_healthy(base: &str, token: &str, timeout: Duration) -> Result<()> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(r) = client.get(format!("{base}/health")).bearer_auth(token).send().await {
            if r.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() > deadline {
            return Err(Error::msg("timed out waiting for the helper to start"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    engine: bool,
    engine_error: Option<String>,
    llama: bool,
    llama_model: Option<String>,
    llama_error: Option<String>,
}

impl Sidecars {
    /// The engine's base URL and token, starting it if needed. Restarts only
    /// when the process has exited: OCR can take minutes, so slowness isn't death.
    /// The engine bounds its own steps (engine/engine/guard.py): a step that hangs
    /// answers 504, and an engine stuck for good exits, so the next call lands here
    /// and gets a fresh one.
    pub async fn engine(&self, app: &AppHandle) -> Result<(String, String)> {
        let mut guard = self.engine.lock().await;
        if let Some(p) = guard.as_mut() {
            if p.alive() {
                return Ok((p.base(), p.token.clone()));
            }
            crate::log::warn("engine", &format!("the document engine had stopped ({}); restarting", p.ended()));
        }
        let t = std::time::Instant::now();
        let started = self.start_engine(app).await;
        *self.engine_error.lock().expect("lock") = started.as_ref().err().map(|e| e.to_string());
        match &started {
            Ok(p) => crate::log::info("engine", &format!("started in {} ms (pid {}, port {})", t.elapsed().as_millis(), p.child.id().unwrap_or(0), p.port)),
            Err(e) => crate::log::error("engine", &format!("did not start: {e}")),
        }
        let p = started?;
        let out = (p.base(), p.token.clone());
        *guard = Some(p);
        Ok(out)
    }

    /// How the engine process ended, if it has (None while it runs, or before it started).
    pub async fn engine_ended(&self) -> Option<String> {
        let mut guard = self.engine.lock().await;
        let p = guard.as_mut()?;
        if p.alive() {
            None
        } else {
            Some(p.ended())
        }
    }

    async fn start_engine(&self, app: &AppHandle) -> Result<Proc> {
        let token = token();
        let mut cmd = engine_command(app)?;
        cmd.env("ANON_ENGINE_TOKEN", &token).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        no_window(&mut cmd);
        let mut child = cmd.spawn()?;
        if let Some(err) = child.stderr.take() {
            pipe_to_log("engine", err);
        }
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| Error::msg("engine stdout"))?;
        let mut lines = BufReader::new(stdout).lines();
        let port = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(line) = lines.next_line().await? {
                if let Some(p) = line.strip_prefix("ANON_ENGINE_PORT=") {
                    return p.trim().parse::<u16>().map_err(|_| Error::msg("bad engine port"));
                }
            }
            Err(Error::msg("the document engine exited at startup"))
        })
        .await
        .map_err(|_| Error::msg("the document engine took too long to start"))??;
        // Keep draining stdout so the engine never blocks on a full pipe.
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    crate::log::info("engine", &line);
                }
            }
        });
        Ok(Proc { child, _stdin: stdin, port, token })
    }

    /// Starts llama-server for this model (or keeps the one already running it).
    pub async fn llama_ensure(&self, model: &Path, draft: Option<&Path>, ctx: u32) -> Result<()> {
        let mut guard = self.llama.lock().await;
        if let Some(l) = guard.as_mut() {
            if l.proc.alive() && l.model == model && l.draft.as_deref() == draft && l.ctx == ctx {
                return Ok(());
            }
            if !l.proc.alive() {
                crate::log::warn("llama", &format!("llama-server had stopped ({}); restarting", l.proc.ended()));
            }
        }
        *guard = None; // kill_on_drop stops the old one
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        crate::log::info("llama", &format!("starting llama-server: model {}, draft {}, ctx {ctx}", name(model), draft.map(name).unwrap_or_else(|| "none".into())));
        let t = std::time::Instant::now();
        let started = Self::start_llama(model, draft, ctx).await;
        match &started {
            Ok(l) => crate::log::info("llama", &format!("ready in {:.1} s (pid {}, port {})", t.elapsed().as_secs_f32(), l.proc.child.id().unwrap_or(0), l.proc.port)),
            Err(e) => crate::log::error("llama", &format!("did not start after {:.1} s: {e}", t.elapsed().as_secs_f32())),
        }
        *self.llama_error.lock().expect("lock") = started.as_ref().err().map(|e| e.to_string());
        *guard = Some(started?);
        Ok(())
    }

    async fn start_llama(model: &Path, draft: Option<&Path>, ctx: u32) -> Result<Llama> {
        if !model.exists() {
            return Err(Error::msg("model file missing"));
        }
        let token = token();
        let port = free_port()?;
        let mut cmd = Command::new(llama_path()?);
        cmd.arg("-m").arg(model);
        if let Some(d) = draft {
            // Gemma 4's MTP head: speculative decoding, same output, about 2x faster.
            cmd.args(["--spec-type", "draft-mtp", "--spec-draft-model"]).arg(d);
        }
        cmd.args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", &ctx.to_string(), "-np", "1", "-fa", "auto", "--jinja", "--no-webui"]);
        cmd.env("LLAMA_API_KEY", &token).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        no_window(&mut cmd);
        let mut child = cmd.spawn()?;
        if let Some(out) = child.stdout.take() {
            pipe_to_log("llama", out);
        }
        if let Some(err) = child.stderr.take() {
            pipe_to_log("llama", err);
        }
        let mut proc = Proc { child, _stdin: None, port, token };
        // Loading a multi-GB model from disk can take a while the first time.
        if let Err(e) = wait_healthy(&proc.base(), &proc.token, Duration::from_secs(180)).await {
            return Err(if proc.alive() { e } else { Error::msg(format!("llama-server exited at startup ({})", proc.ended())) });
        }
        Ok(Llama { proc, model: model.to_path_buf(), draft: draft.map(Path::to_path_buf), ctx })
    }

    pub async fn llama(&self) -> Result<(String, String)> {
        let mut guard = self.llama.lock().await;
        match guard.as_mut() {
            Some(l) => {
                if l.proc.alive() {
                    Ok((l.proc.base(), l.proc.token.clone()))
                } else {
                    crate::log::warn("llama", &format!("llama-server is not running ({})", l.proc.ended()));
                    Err(Error::SidecarDown)
                }
            }
            None => Err(Error::SidecarDown),
        }
    }

    pub async fn llama_stop(&self) {
        if self.llama.lock().await.take().is_some() {
            crate::log::info("llama", "stopped");
        }
    }

    pub async fn status(&self) -> Status {
        let engine = self.engine.lock().await.as_mut().map(|p| p.alive()).unwrap_or(false);
        let mut l = self.llama.lock().await;
        let (llama, llama_model) = match l.as_mut() {
            Some(l) => (l.proc.alive(), l.model.file_name().map(|n| n.to_string_lossy().into_owned())),
            None => (false, None),
        };
        Status {
            engine,
            engine_error: self.engine_error.lock().expect("lock").clone(),
            llama,
            llama_model,
            llama_error: self.llama_error.lock().expect("lock").clone(),
        }
    }

    /// On quit: stop both helpers now rather than waiting on drop order.
    pub fn kill_all(&self) {
        if let Ok(mut g) = self.engine.try_lock() {
            if let Some(p) = g.as_mut() {
                let _ = p.child.start_kill();
            }
        }
        if let Ok(mut g) = self.llama.try_lock() {
            if let Some(l) = g.as_mut() {
                let _ = l.proc.child.start_kill();
            }
        }
    }
}

#[tauri::command]
pub async fn sidecar_status(state: tauri::State<'_, crate::AppState>) -> Result<Status> {
    Ok(state.sidecars.status().await)
}
