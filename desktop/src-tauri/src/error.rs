//! One error type for every command. It reaches the UI as a short string:
//! a stable code ("wrong_password", "locked"…) or a message without document content.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("wrong_password")]
    WrongPassword,
    #[error("locked")]
    Locked,
    #[error("no_vault")]
    NoVault,
    #[error("vault_exists")]
    VaultExists,
    #[error("sidecar_down")]
    SidecarDown,
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
