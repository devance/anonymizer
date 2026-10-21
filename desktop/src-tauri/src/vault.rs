//! The password protects one random master key; everything else is derived from it.
//!
//! password ─Argon2id─► KEK ─AES-GCM wraps─► master key (vault.json)
//! master key ─HKDF─► SQLCipher key, blob key
//!
//! Changing the password only rewraps the master key, so it is instant and
//! crash-safe. The master key never leaves Rust; the UI only sends passwords.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::paths::{write_atomic, Paths};

pub type Key = Zeroizing<[u8; 32]>;

const KEYRING_SERVICE: &str = "ca.devance.anonymizer";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Kdf {
    pub alg: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Wrap {
    pub nonce: String,
    pub ct: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub v: u32,
    pub install_id: String,
    pub kdf: Kdf,
    pub wrap: Wrap,
    pub auto_unlock: bool,
    pub created_at: u64,
}

/// 256 MiB, 3 passes, 4 lanes: about a second on a 2020 laptop.
pub const DEFAULT_KDF: (u32, u32, u32) = (256 * 1024, 3, 4);

pub const MIN_PASSWORD_CHARS: usize = 10;

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn derive_kek(password: &str, kdf: &Kdf) -> Result<Key> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| Error::msg(format!("kdf params: {e}")))?;
    let salt = B64.decode(&kdf.salt).map_err(|_| Error::msg("bad salt"))?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, out.as_mut())
        .map_err(|e| Error::msg(format!("kdf: {e}")))?;
    Ok(out)
}

/// Binds the wrapped key to this install and these KDF settings.
fn aad(install_id: &str, kdf: &Kdf) -> String {
    format!("devance-anon/vault/v1|{}|{}|{}|{}|{}|{}", install_id, kdf.alg, kdf.m, kdf.t, kdf.p, kdf.salt)
}

fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Result<([u8; 12], Vec<u8>)> {
    let nonce = random::<12>();
    let ct = Aes256Gcm::new_from_slice(key)
        .map_err(|_| Error::msg("key length"))?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::msg("encrypt"))?;
    Ok((nonce, ct))
}

pub fn open(key: &[u8; 32], nonce: &[u8], ct: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    if nonce.len() != 12 {
        return None;
    }
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad }).ok()
}

fn wrap(kek: &Key, mk: &Key, install_id: &str, kdf: &Kdf) -> Result<Wrap> {
    let (nonce, ct) = seal(kek, mk.as_ref(), aad(install_id, kdf).as_bytes())?;
    Ok(Wrap { nonce: B64.encode(nonce), ct: B64.encode(ct) })
}

fn unwrap(kek: &Key, vf: &VaultFile) -> Result<Key> {
    let nonce = B64.decode(&vf.wrap.nonce).map_err(|_| Error::WrongPassword)?;
    let ct = B64.decode(&vf.wrap.ct).map_err(|_| Error::WrongPassword)?;
    let plain = Zeroizing::new(open(kek, &nonce, &ct, aad(&vf.install_id, &vf.kdf).as_bytes()).ok_or(Error::WrongPassword)?);
    let mut mk = Zeroizing::new([0u8; 32]);
    if plain.len() != 32 {
        return Err(Error::WrongPassword);
    }
    mk.copy_from_slice(&plain);
    Ok(mk)
}

/// A key for one purpose ("sqlcipher/v1", "blobs/v1"), derived from the master key.
pub fn subkey(mk: &Key, install_id: &str, info: &str) -> Key {
    let hk = Hkdf::<Sha256>::new(Some(install_id.as_bytes()), mk.as_ref());
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF length");
    out
}

pub fn read(paths: &Paths) -> Result<Option<VaultFile>> {
    match std::fs::read(&paths.vault) {
        Ok(b) => Ok(Some(serde_json::from_slice(&b)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write(paths: &Paths, vf: &VaultFile) -> Result<()> {
    write_atomic(&paths.vault, &serde_json::to_vec_pretty(vf)?)
}

fn new_kdf(params: (u32, u32, u32)) -> Kdf {
    Kdf { alg: "argon2id".into(), m: params.0, t: params.1, p: params.2, salt: B64.encode(random::<16>()) }
}

pub fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(Error::msg("password_too_short"));
    }
    Ok(())
}

/// First launch: a new master key, wrapped by the password.
pub fn create(paths: &Paths, password: &str, params: (u32, u32, u32)) -> Result<(VaultFile, Key)> {
    if paths.vault.exists() {
        return Err(Error::VaultExists);
    }
    check_password(password)?;
    let mk: Key = Zeroizing::new(random::<32>());
    let install_id = uuid::Uuid::new_v4().to_string();
    let kdf = new_kdf(params);
    let kek = derive_kek(password, &kdf)?;
    let vf = VaultFile { v: 1, wrap: wrap(&kek, &mk, &install_id, &kdf)?, install_id, kdf, auto_unlock: false, created_at: now() };
    write(paths, &vf)?;
    Ok((vf, mk))
}

pub fn unlock(paths: &Paths, password: &str) -> Result<(VaultFile, Key)> {
    let vf = read(paths)?.ok_or(Error::NoVault)?;
    let kek = derive_kek(password, &vf.kdf)?;
    let mk = unwrap(&kek, &vf)?;
    Ok((vf, mk))
}

/// Rewraps the same master key: the database and files are untouched.
pub fn change_password(paths: &Paths, old: &str, new: &str, params: (u32, u32, u32)) -> Result<()> {
    check_password(new)?;
    let (mut vf, mk) = unlock(paths, old)?;
    vf.kdf = new_kdf(params);
    let kek = derive_kek(new, &vf.kdf)?;
    vf.wrap = wrap(&kek, &mk, &vf.install_id, &vf.kdf)?;
    write(paths, &vf)
}

fn keyring_entry(install_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("mk-{install_id}")).map_err(|e| Error::msg(format!("keychain: {e}")))
}

/// Opt-in: keep the master key in the macOS Keychain / Windows Credential Manager.
pub fn set_auto_unlock(paths: &Paths, password: &str, enabled: bool) -> Result<()> {
    let (mut vf, mk) = unlock(paths, password)?;
    let entry = keyring_entry(&vf.install_id)?;
    if enabled {
        entry.set_password(&hex::encode(mk.as_ref())).map_err(|e| Error::msg(format!("keychain: {e}")))?;
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(Error::msg(format!("keychain: {e}"))),
        }
    }
    vf.auto_unlock = enabled;
    write(paths, &vf)
}

/// The master key from the keychain, if auto-unlock is on and the item is still there.
pub fn auto_unlock(paths: &Paths) -> Result<Option<(VaultFile, Key)>> {
    let Some(vf) = read(paths)? else { return Ok(None) };
    if !vf.auto_unlock {
        return Ok(None);
    }
    let Ok(secret) = keyring_entry(&vf.install_id)?.get_password() else { return Ok(None) };
    let secret = Zeroizing::new(secret);
    let Ok(bytes) = hex::decode(secret.as_str()) else { return Ok(None) };
    let bytes = Zeroizing::new(bytes);
    if bytes.len() != 32 {
        return Ok(None);
    }
    let mut mk = Zeroizing::new([0u8; 32]);
    mk.copy_from_slice(&bytes);
    Ok(Some((vf, mk)))
}

/// Forgotten password: delete the vault, database and files. Models are kept.
pub fn reset(paths: &Paths) -> Result<()> {
    if let Some(vf) = read(paths)? {
        if let Ok(entry) = keyring_entry(&vf.install_id) {
            let _ = entry.delete_credential();
        }
    }
    for name in ["data.db", "data.db-wal", "data.db-shm"] {
        let p = paths.data.join(name);
        if p.exists() {
            std::fs::remove_file(p)?;
        }
    }
    if paths.blobs.exists() {
        std::fs::remove_dir_all(&paths.blobs)?;
    }
    std::fs::create_dir_all(&paths.blobs)?;
    if paths.vault.exists() {
        std::fs::remove_file(&paths.vault)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: (u32, u32, u32) = (8 * 1024, 1, 1);

    fn paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::at(dir.path()).unwrap();
        (dir, p)
    }

    #[test]
    fn create_unlock_and_wrong_password() {
        let (_d, p) = paths();
        let (_, mk) = create(&p, "correct horse battery", FAST).unwrap();
        let (_, again) = unlock(&p, "correct horse battery").unwrap();
        assert_eq!(mk.as_ref(), again.as_ref());
        assert!(matches!(unlock(&p, "wrong horse battery"), Err(Error::WrongPassword)));
        assert!(matches!(create(&p, "correct horse battery", FAST), Err(Error::VaultExists)));
    }

    #[test]
    fn short_password_is_refused() {
        let (_d, p) = paths();
        assert!(create(&p, "short", FAST).is_err());
        assert!(!p.vault.exists());
    }

    #[test]
    fn change_password_keeps_the_master_key() {
        let (_d, p) = paths();
        let (_, mk) = create(&p, "first password", FAST).unwrap();
        change_password(&p, "first password", "second password", FAST).unwrap();
        assert!(matches!(unlock(&p, "first password"), Err(Error::WrongPassword)));
        let (_, again) = unlock(&p, "second password").unwrap();
        assert_eq!(mk.as_ref(), again.as_ref());
    }

    #[test]
    fn tampered_vault_fails() {
        let (_d, p) = paths();
        create(&p, "correct horse battery", FAST).unwrap();
        let mut vf = read(&p).unwrap().unwrap();
        vf.install_id = uuid::Uuid::new_v4().to_string();
        write(&p, &vf).unwrap();
        assert!(matches!(unlock(&p, "correct horse battery"), Err(Error::WrongPassword)));
    }

    #[test]
    fn subkeys_differ_by_purpose() {
        let mk: Key = Zeroizing::new([7u8; 32]);
        assert_ne!(subkey(&mk, "i", "sqlcipher/v1").as_ref(), subkey(&mk, "i", "blobs/v1").as_ref());
    }
}
