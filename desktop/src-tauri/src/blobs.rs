//! Encrypted files next to the database: uploads, extracted text, working
//! copies. One file per blob, `[1][12-byte nonce][ciphertext + tag]` like
//! @anon/core's crypto.ts, with the blob id as associated data so a file
//! renamed onto another id fails to open.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::paths::write_atomic;
use crate::vault::open;

/// f = uploaded file, t = extracted text, w = working copy, x = fields, o = output.
const KINDS: &[char] = &['f', 't', 'w', 'x', 'o'];

fn path_of(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = id.len() == 33 && KINDS.contains(&id.chars().next().unwrap_or(' ')) && id[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Err(Error::msg("bad blob id"));
    }
    Ok(dir.join(&id[1..3]).join(id))
}

fn aad(id: &str) -> Vec<u8> {
    format!("blob:{id}").into_bytes()
}

pub fn put(dir: &Path, key: &[u8; 32], kind: char, plain: &[u8]) -> Result<String> {
    if !KINDS.contains(&kind) {
        return Err(Error::msg("bad blob kind"));
    }
    let id = format!("{kind}{}", uuid::Uuid::new_v4().simple());
    let path = path_of(dir, &id)?;
    std::fs::create_dir_all(path.parent().expect("blob paths have a parent"))?;
    let (nonce, ct) = seal(key, plain, &aad(&id))?;
    let mut out = Vec::with_capacity(13 + ct.len());
    out.push(1u8);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    write_atomic(&path, &out)?;
    Ok(id)
}

fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Result<([u8; 12], Vec<u8>)> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    use rand::RngCore;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = Aes256Gcm::new_from_slice(key)
        .map_err(|_| Error::msg("key length"))?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::msg("encrypt"))?;
    Ok((nonce, ct))
}

pub fn get(dir: &Path, key: &[u8; 32], id: &str) -> Result<Vec<u8>> {
    let raw = std::fs::read(path_of(dir, id)?)?;
    if raw.len() < 13 + 16 || raw[0] != 1 {
        return Err(Error::msg("blob is damaged"));
    }
    open(key, &raw[1..13], &raw[13..], &aad(id)).ok_or_else(|| Error::msg("blob is damaged"))
}

pub fn delete(dir: &Path, ids: &[String]) -> Result<()> {
    for id in ids {
        match std::fs::remove_file(path_of(dir, id)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Deletes blob files no row points to (left by a crash between write and insert).
pub fn gc(dir: &Path, keep: &HashSet<String>) -> Result<usize> {
    let mut removed = 0;
    for sub in std::fs::read_dir(dir)? {
        let sub = sub?.path();
        if !sub.is_dir() {
            continue;
        }
        for f in std::fs::read_dir(&sub)? {
            let f = f?.path();
            let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            if !keep.contains(&name) {
                std::fs::remove_file(&f)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_tamper_and_gc() {
        let dir = tempfile::tempdir().unwrap();
        let key = [3u8; 32];
        let id = put(dir.path(), &key, 'f', b"Jean Tremblay").unwrap();
        assert_eq!(get(dir.path(), &key, &id).unwrap(), b"Jean Tremblay");
        assert!(get(dir.path(), &[4u8; 32], &id).is_err());

        let p = path_of(dir.path(), &id).unwrap();
        let raw = std::fs::read(&p).unwrap();
        assert!(!raw.windows(8).any(|w| w == b"Tremblay"));
        let mut bad = raw.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        std::fs::write(&p, &bad).unwrap();
        assert!(get(dir.path(), &key, &id).is_err());

        let other = put(dir.path(), &key, 't', b"x").unwrap();
        let keep: HashSet<String> = [other.clone()].into();
        assert_eq!(gc(dir.path(), &keep).unwrap(), 1);
        assert!(get(dir.path(), &key, &other).is_ok());
        assert!(path_of(dir.path(), "../etc").is_err());
    }
}
