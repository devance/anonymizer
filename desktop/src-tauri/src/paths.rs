use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::Result;

/// Everything the app writes, under one folder:
/// macOS `~/Library/Application Support/ca.devance.anonymizer/`,
/// Windows `%LOCALAPPDATA%\ca.devance.anonymizer\` (not roaming: models are GBs).
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub vault: PathBuf,
    pub db: PathBuf,
    pub blobs: PathBuf,
    pub models: PathBuf,
    pub config: PathBuf,
}

impl Paths {
    pub fn new(app: &AppHandle) -> Result<Self> {
        // Dev and test runs can point at a throwaway folder instead of the real data.
        #[cfg(debug_assertions)]
        if let Some(dir) = std::env::var_os("ANON_DATA_DIR") {
            return Self::at(Path::new(&dir));
        }
        Self::at(&app.path().app_local_data_dir()?)
    }

    pub fn at(dir: &Path) -> Result<Self> {
        let p = Paths {
            data: dir.to_path_buf(),
            vault: dir.join("vault.json"),
            db: dir.join("data.db"),
            blobs: dir.join("blobs"),
            models: dir.join("models"),
            config: dir.join("config.json"),
        };
        std::fs::create_dir_all(&p.blobs)?;
        std::fs::create_dir_all(&p.models)?;
        Ok(p)
    }
}

/// Write to a temp file, fsync, then rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}
