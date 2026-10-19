//! Non-secret machine settings that Rust needs before the vault is open.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::paths::{write_atomic, Paths};

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The user's own Ollama, e.g. http://127.0.0.1:11434. The proxy only reaches this base.
    pub ollama_base: Option<String>,
}

pub fn load(paths: &Paths) -> Config {
    std::fs::read(&paths.config).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(paths: &Paths, c: &Config) -> Result<()> {
    write_atomic(&paths.config, &serde_json::to_vec_pretty(c)?)
}

#[tauri::command]
pub fn config_get(state: tauri::State<'_, crate::AppState>) -> Config {
    load(&state.paths)
}

#[tauri::command]
pub fn config_set_ollama(state: tauri::State<'_, crate::AppState>, base: Option<String>) -> Result<()> {
    let base = match base.map(|b| b.trim().trim_end_matches('/').to_string()).filter(|b| !b.is_empty()) {
        Some(b) if b.starts_with("http://") || b.starts_with("https://") => Some(b),
        Some(_) => return Err(crate::error::Error::msg("the Ollama address must start with http:// or https://")),
        None => None,
    };
    let mut c = load(&state.paths);
    c.ollama_base = base;
    save(&state.paths, &c)
}
