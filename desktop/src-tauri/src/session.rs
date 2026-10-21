//! The unlocked state, and the commands the UI uses for the vault, the
//! database and blobs. Locking drops the connection and zeroizes the keys.

use std::collections::HashSet;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::error::{Error, Result};
use crate::vault::{self, Key, DEFAULT_KDF};
use crate::{blobs, db, AppState};

pub struct Session {
    pub db: Mutex<Connection>,
    pub blob_key: Key,
}

impl Session {
    pub fn open(paths: &crate::paths::Paths, install_id: &str, mk: &Key) -> Result<Session> {
        let db_key = vault::subkey(mk, install_id, "sqlcipher/v1");
        let conn = db::open(&paths.db, &db_key)?;
        Ok(Session { db: Mutex::new(conn), blob_key: vault::subkey(mk, install_id, "blobs/v1") })
    }
}

/// Logs a failed command; the error still goes back to the page.
fn logged<T>(what: &str, r: Result<T>) -> Result<T> {
    if let Err(e) = &r {
        match e {
            Error::WrongPassword | Error::Locked => crate::log::info("vault", &format!("{what}: {e}")),
            _ => crate::log::error("app", &format!("{what}: {e}")),
        }
    }
    r
}

fn with_session<T>(state: &AppState, f: impl FnOnce(&Session) -> Result<T>) -> Result<T> {
    let guard = state.session.lock().expect("session lock");
    let s = guard.as_ref().ok_or(Error::Locked)?;
    f(s)
}

fn start(state: &AppState, install_id: &str, mk: &Key) -> Result<()> {
    let s = Session::open(&state.paths, install_id, mk)?;
    // Blob files no document points to: left by a crash between write and insert.
    let keep: HashSet<String> = {
        let c = s.db.lock().expect("db lock");
        db::all(&c, "SELECT file_key AS k FROM documents UNION SELECT text_key FROM documents UNION SELECT work_key FROM documents UNION SELECT fields_key FROM documents", &[])?
            .into_iter()
            .filter_map(|r| r.get("k").and_then(|v| v.as_str()).map(String::from))
            .collect()
    };
    match blobs::gc(&state.paths.blobs, &keep) {
        Ok(n) if n > 0 => crate::log::info("vault", &format!("removed {n} orphaned blob files")),
        Err(e) => crate::log::warn("vault", &format!("blob cleanup: {e}")),
        _ => {}
    }
    *state.session.lock().expect("session lock") = Some(s);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    /// "new" (no vault yet), "locked" or "unlocked".
    vault: &'static str,
    auto_unlock: bool,
    version: String,
    data_dir: String,
    log_dir: String,
}

#[tauri::command]
pub fn app_status(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<AppStatus> {
    let vf = vault::read(&state.paths)?;
    let unlocked = state.session.lock().expect("session lock").is_some();
    Ok(AppStatus {
        vault: if vf.is_none() { "new" } else if unlocked { "unlocked" } else { "locked" },
        auto_unlock: vf.map(|v| v.auto_unlock).unwrap_or(false),
        version: app.package_info().version.to_string(),
        data_dir: state.paths.data.display().to_string(),
        log_dir: crate::log::dir().display().to_string(),
    })
}

#[tauri::command(async)]
pub fn vault_create(state: State<'_, AppState>, password: String, auto_unlock: bool) -> Result<()> {
    let t = std::time::Instant::now();
    let (vf, mk) = logged("vault create", vault::create(&state.paths, &password, DEFAULT_KDF))?;
    logged("vault open", start(&state, &vf.install_id, &mk))?;
    if auto_unlock {
        logged("auto-unlock on", vault::set_auto_unlock(&state.paths, &password, true))?;
    }
    crate::log::info("vault", &format!("created and unlocked in {} ms (auto-unlock {})", t.elapsed().as_millis(), if auto_unlock { "on" } else { "off" }));
    Ok(())
}

#[tauri::command(async)]
pub fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<()> {
    let t = std::time::Instant::now();
    let (vf, mk) = logged("unlock", vault::unlock(&state.paths, &password))?;
    logged("vault open", start(&state, &vf.install_id, &mk))?;
    crate::log::info("vault", &format!("unlocked in {} ms", t.elapsed().as_millis()));
    Ok(())
}

/// True when the keychain held the key and the app is now unlocked.
#[tauri::command(async)]
pub fn vault_auto_unlock(state: State<'_, AppState>) -> Result<bool> {
    match logged("auto-unlock", vault::auto_unlock(&state.paths))? {
        Some((vf, mk)) => {
            logged("vault open", start(&state, &vf.install_id, &mk))?;
            crate::log::info("vault", "unlocked from the keychain");
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    *state.session.lock().expect("session lock") = None;
    crate::log::info("vault", "locked");
    Ok(())
}

#[tauri::command(async)]
pub fn vault_change_password(state: State<'_, AppState>, old: String, new: String) -> Result<()> {
    logged("change password", vault::change_password(&state.paths, &old, &new, DEFAULT_KDF))?;
    crate::log::info("vault", "password changed");
    Ok(())
}

#[tauri::command(async)]
pub fn vault_set_auto_unlock(state: State<'_, AppState>, password: String, enabled: bool) -> Result<()> {
    logged("auto-unlock", vault::set_auto_unlock(&state.paths, &password, enabled))?;
    crate::log::info("vault", &format!("auto-unlock {}", if enabled { "on" } else { "off" }));
    Ok(())
}

/// Deletes everything but the models. The UI asks the user to type EFFACER/DELETE first.
#[tauri::command(async)]
pub fn vault_reset(state: State<'_, AppState>, confirm: String) -> Result<()> {
    if confirm != "EFFACER" && confirm != "DELETE" {
        return Err(Error::msg("confirmation required"));
    }
    *state.session.lock().expect("session lock") = None;
    logged("reset", vault::reset(&state.paths))?;
    crate::log::warn("vault", "all data erased (models kept)");
    Ok(())
}

#[tauri::command(async)]
pub fn db_all(state: State<'_, AppState>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>> {
    with_session(&state, |s| db::all(&s.db.lock().expect("db lock"), &sql, &params)).inspect_err(|e| db_error(e, &sql))
}

#[tauri::command(async)]
pub fn db_run(state: State<'_, AppState>, sql: String, params: Vec<Value>) -> Result<db::RunResult> {
    with_session(&state, |s| db::run(&s.db.lock().expect("db lock"), &sql, &params)).inspect_err(|e| db_error(e, &sql))
}

#[tauri::command(async)]
pub fn db_batch(state: State<'_, AppState>, stmts: Vec<db::Stmt>) -> Result<Vec<db::RunResult>> {
    with_session(&state, |s| db::batch(&mut s.db.lock().expect("db lock"), &stmts)).inspect_err(|e| db_error(e, stmts.first().map(|s| s.sql.as_str()).unwrap_or("")))
}

/// The statement is the app's own SQL; parameters (the values) are never logged.
fn db_error(e: &Error, sql: &str) {
    if !matches!(e, Error::Locked) {
        let head: String = sql.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
        crate::log::error("db", &format!("{e} in: {head}"));
    }
}

/// Raw body = the bytes; header `x-kind` = f|t|w|x|o. Returns the blob id.
#[tauri::command(async)]
pub fn blob_put(state: State<'_, AppState>, request: Request<'_>) -> Result<String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err(Error::msg("raw body expected")) };
    let kind = request.headers().get("x-kind").and_then(|v| v.to_str().ok()).and_then(|s| s.chars().next()).ok_or_else(|| Error::msg("x-kind header missing"))?;
    logged("blob put", with_session(&state, |s| blobs::put(&state.paths.blobs, &s.blob_key, kind, bytes)))
}

#[tauri::command(async)]
pub fn blob_get(state: State<'_, AppState>, id: String) -> Result<Response> {
    logged("blob get", with_session(&state, |s| blobs::get(&state.paths.blobs, &s.blob_key, &id))).map(Response::new)
}

#[tauri::command(async)]
pub fn blob_delete(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    with_session(&state, |_| blobs::delete(&state.paths.blobs, &ids))
}

/// Decrypted bytes for code that runs in Rust (saving a file, the engine proxy).
pub fn read_blob(state: &AppState, id: &str) -> Result<Vec<u8>> {
    with_session(state, |s| blobs::get(&state.paths.blobs, &s.blob_key, id))
}
