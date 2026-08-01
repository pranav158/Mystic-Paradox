use sha2::{Digest, Sha256};
use std::path::Path;

const WINMM_DLL_NAME: &str = "winmm.dll";
const INTERNAL_SERVER_DLL_NAME: &str = "MystPaxInternalServer.dll";

pub fn hash_file_sha256(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read file: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    // sha2's digest output type doesn't implement LowerHex directly (as of
    // sha2 0.11's switch to hybrid-array) — format each byte by hand instead
    // of pulling in a hex-encoding crate for one call site.
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// `winmm.dll` (the proxy that loads `MystPaxInternalServer.dll` — see
/// MystPaxInternalServer's build) and the DLL itself must both be present
/// alongside the game exe. This is a presence/non-empty check, not a hash
/// match — unlike the game exe (checked against the backend's approved-hash
/// allow-list), these are project-owned files that get rebuilt far more often,
/// so pinning them to a hash here would break on every rebuild.
pub fn verify_runtime_dlls_present(game_dir: &Path) -> Result<(), String> {
    const GENERIC_ERR: &str =
        "Runtime binaries are missing or corrupted. Repair your installation.";

    for name in [WINMM_DLL_NAME, INTERNAL_SERVER_DLL_NAME] {
        let path = game_dir.join(name);
        let metadata = std::fs::metadata(&path).map_err(|_| GENERIC_ERR.to_string())?;

        if metadata.len() == 0 {
            return Err(GENERIC_ERR.to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn hashes_known_content() {
        let dir = std::env::temp_dir().join(format!("mystpax-hash-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.bin");
        fs::write(&file, b"hello").unwrap();

        // sha256("hello")
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(hash_file_sha256(&file).unwrap(), expected);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_missing_dlls() {
        let dir = std::env::temp_dir().join(format!("mystpax-dll-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        assert!(verify_runtime_dlls_present(&dir).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_dll() {
        let dir =
            std::env::temp_dir().join(format!("mystpax-dll-empty-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(WINMM_DLL_NAME), b"").unwrap();
        fs::write(dir.join(INTERNAL_SERVER_DLL_NAME), b"content").unwrap();

        assert!(verify_runtime_dlls_present(&dir).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepts_present_nonempty_dlls() {
        let dir = std::env::temp_dir().join(format!("mystpax-dll-ok-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(WINMM_DLL_NAME), b"content").unwrap();
        fs::write(dir.join(INTERNAL_SERVER_DLL_NAME), b"content").unwrap();

        assert!(verify_runtime_dlls_present(&dir).is_ok());

        fs::remove_dir_all(&dir).ok();
    }
}
