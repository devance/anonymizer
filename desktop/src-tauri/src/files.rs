//! Exports go through a native save dialog opened here, so the page never
//! names a path and Rust never writes where the user didn't choose.

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};
use crate::AppState;

/// Decrypts a blob into the file the user picks. Returns the path, or null if cancelled.
#[tauri::command]
pub async fn save_blob_as(state: State<'_, AppState>, app: AppHandle, blob_id: String, suggested_name: String) -> Result<Option<String>> {
    let bytes = crate::session::read_blob(&state, &blob_id)?;
    let name = suggested_name.replace(['/', '\\'], "_");
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(&name).blocking_save_file()).await.map_err(|e| Error::msg(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| Error::msg(e.to_string()))?;
    tokio::fs::write(&path, bytes).await?;
    Ok(Some(path.display().to_string()))
}

/// The licences of everything bundled, in the system's text viewer. Release
/// builds carry the file (desktop/scripts/notices.py); debug builds use the
/// last one generated in desktop/build.
#[tauri::command]
pub fn open_notices(app: AppHandle) -> Result<()> {
    let mut path = app.path().resolve("THIRD_PARTY_NOTICES.txt", BaseDirectory::Resource).map_err(|e| Error::msg(e.to_string()))?;
    if cfg!(debug_assertions) && !path.exists() {
        path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/THIRD_PARTY_NOTICES.txt");
    }
    if !path.exists() {
        return Err(Error::msg("notices_missing"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| Error::msg(e.to_string()))
}

#[tauri::command]
pub fn reveal_data_dir(state: State<'_, AppState>) -> Result<()> {
    tauri_plugin_opener::reveal_item_in_dir(&state.paths.vault).map_err(|e| Error::msg(e.to_string()))
}
