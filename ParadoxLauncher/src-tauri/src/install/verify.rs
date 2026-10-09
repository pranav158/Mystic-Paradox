use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Every build needs the runtime and the winmm proxy that loads it next to the game exe.
pub(crate) const CORE_RUNTIME_ARTIFACT_NAMES: [&str; 2] = ["MysticParadox.dll", "winmm.dll"];

/// The files this build requires, hashes at Play and reports to the backend for the game ticket.
pub(crate) fn required_runtime_artifact_names() -> Vec<&'static str> {
    #[cfg_attr(not(feature = "p2p"), allow(unused_mut))]
    let mut names = CORE_RUNTIME_ARTIFACT_NAMES.to_vec();
    #[cfg(feature = "p2p")]
    names.extend(crate::p2p::RUNTIME_ARTIFACT_NAMES);
    names
}

fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn absolute_inspection_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        // Resolve relative paths lexically only. Do not canonicalize: resolving
        // links before hashing would introduce a check/use race and would also
        // make the result depend on the target rather than the requested path.
        std::env::current_dir()
            .map(|current_dir| current_dir.join(path))
            .map_err(|e| format!("Couldn't inspect protected path: {e}"))
    }
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    let mut current = path.parent();
    while let Some(parent) = current {
        // `Path::parent()` returns an empty path for a bare relative filename;
        // the caller supplies an absolute inspection path, but keep this guard
        // here so the helper remains safe if it is reused independently.
        if parent.as_os_str().is_empty() {
            current = parent.parent();
            continue;
        }
        let metadata = std::fs::symlink_metadata(parent)
            .map_err(|e| format!("Couldn't inspect protected path: {e}"))?;
        if is_reparse_point(&metadata) {
            return Err("Protected runtime path crosses a reparse point.".to_string());
        }
        current = parent.parent();
    }
    Ok(())
}

fn regular_file(path: &Path) -> Result<std::fs::Metadata, String> {
    reject_reparse_ancestors(&absolute_inspection_path(path)?)?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("Couldn't inspect file: {e}"))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err("Protected runtime path is not a regular file.".to_string());
    }
    Ok(metadata)
}

/// Full SHA-256 of a protected file, always read from disk. Play, install/repair and Guard
/// session start use this; it also refreshes the cache below.
pub fn hash_file_sha256(path: &Path) -> Result<String, String> {
    hash_file(path, false)
}

/// Same digest, but reuses the previous result while the open file's identity is unchanged.
/// Only for periodic checks (install status, P2P presence, Guard heartbeats): those used to
/// re-read the 121 MB game executable every 20 seconds even with the game closed.
pub fn hash_file_sha256_cached(path: &Path) -> Result<String, String> {
    hash_file(path, true)
}

/// Volume, file index, size, creation and last-write time. Replacing a file (including a rename
/// over a running image) changes the file index; Windows refuses in-place writes to a mapped
/// image. Timestamps can be reset by the user, which is why entitlement checks never reuse it.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u32,
    index: u64,
    size: u64,
    created: u64,
    written: u64,
}

fn file_identity(file: &std::fs::File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err("Couldn't inspect protected file identity.".to_string());
    }
    let join = |high: u32, low: u32| ((high as u64) << 32) | low as u64;
    Ok(FileIdentity {
        volume: info.dwVolumeSerialNumber,
        index: join(info.nFileIndexHigh, info.nFileIndexLow),
        size: join(info.nFileSizeHigh, info.nFileSizeLow),
        created: join(
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
        ),
        written: join(
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
        ),
    })
}

fn hash_cache() -> &'static Mutex<HashMap<PathBuf, (FileIdentity, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (FileIdentity, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// Bounds the cache to a few game folders' worth of modules.
const HASH_CACHE_LIMIT: usize = 512;

fn hash_file(path: &Path, reuse: bool) -> Result<String, String> {
    regular_file(path)?;
    let mut file = std::fs::File::open(path).map_err(|e| format!("Couldn't read file: {e}"))?;
    let before = file_identity(&file)?;
    let key = path.to_path_buf();
    if reuse {
        if let Ok(cache) = hash_cache().lock() {
            if let Some((identity, hash)) = cache.get(&key) {
                if *identity == before {
                    return Ok(hash.clone());
                }
            }
        }
    }
    // Stream in 1 MiB blocks instead of reading the whole file into memory.
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Couldn't read file: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    // sha2's digest output type doesn't implement LowerHex directly (as of
    // sha2 0.11's switch to hybrid-array) — format each byte by hand instead
    // of pulling in a hex-encoding crate for one call site.
    let hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    // Only remember a digest whose file did not change while it was being read.
    if file_identity(&file)? == before {
        if let Ok(mut cache) = hash_cache().lock() {
            if cache.len() >= HASH_CACHE_LIMIT && !cache.contains_key(&key) {
                cache.clear();
            }
            cache.insert(key, (before, hash.clone()));
        }
    }
    Ok(hash)
}

/// `winmm.dll` (the proxy that loads `MysticParadox.dll` — see
/// ParadoxRuntime's build) and the DLL itself must both be present
/// alongside the game exe. This is a presence/non-empty check, not a hash
/// match — unlike the game exe (checked against the backend's approved-hash
/// allow-list), these are project-owned files that get rebuilt far more often,
/// so pinning them to a hash here would break on every rebuild.
pub fn verify_runtime_dlls_present(game_dir: &Path) -> Result<(), String> {
    const GENERIC_ERR: &str =
        "Runtime binaries are missing or corrupted. Repair your installation.";

    for name in required_runtime_artifact_names() {
        let path = game_dir.join(name);
        let metadata = regular_file(&path).map_err(|_| GENERIC_ERR.to_string())?;
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

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("mysticparadox-{name}-{}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            // remove_dir_all uses symlink metadata for directory entries and
            // therefore removes a junction itself instead of traversing it.
            fs::remove_dir_all(&self.path).ok();
        }
    }

    #[test]
    fn hashes_known_content() {
        let dir =
            std::env::temp_dir().join(format!("mysticparadox-hash-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.bin");
        fs::write(&file, b"hello").unwrap();

        // sha256("hello")
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(hash_file_sha256(&file).unwrap(), expected);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cached_hash_follows_file_changes() {
        let dir = TestDirectory::new("hash-cache-test");
        let file = dir.path.join("sample.bin");
        // Larger than one read block so the streamed path is exercised.
        let large = vec![7u8; 1024 * 1024 + 17];
        fs::write(&file, &large).unwrap();
        let expected: String = Sha256::digest(&large)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hash_file_sha256_cached(&file).unwrap(), expected);
        assert_eq!(hash_file_sha256_cached(&file).unwrap(), expected);

        // A replacement gets a new file index, so the cache must not return the old digest.
        let replacement = dir.path.join("replacement.bin");
        fs::write(&replacement, b"hello").unwrap();
        fs::remove_file(&file).unwrap();
        fs::rename(&replacement, &file).unwrap();
        assert_eq!(
            hash_file_sha256_cached(&file).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn rejects_missing_dlls() {
        let dir =
            std::env::temp_dir().join(format!("mysticparadox-dll-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        assert!(verify_runtime_dlls_present(&dir).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_dll() {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-dll-empty-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CORE_RUNTIME_ARTIFACT_NAMES[1]), b"").unwrap();
        fs::write(dir.join(CORE_RUNTIME_ARTIFACT_NAMES[0]), b"content").unwrap();

        assert!(verify_runtime_dlls_present(&dir).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_reparse_final_file() {
        let test_dir = TestDirectory::new("reparse-final-test");
        let target = test_dir.path.join("target.bin");
        let link = test_dir.path.join("link.bin");
        fs::write(&target, b"hello").unwrap();

        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink"])
            .arg(&link)
            .arg(&target)
            .status()
            .unwrap();
        if !status.success() {
            // File-symlink creation can be unavailable without the Windows
            // developer-mode/privilege needed by the test environment.
            return;
        }

        assert!(hash_file_sha256(&link).is_err());
    }

    #[test]
    fn rejects_reparse_parent_directory() {
        let test_dir = TestDirectory::new("reparse-ancestor-test");
        let target = test_dir.path.join("target");
        let junction = test_dir.path.join("junction");
        let escaped_file = junction.join("sample.bin");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("sample.bin"), b"hello").unwrap();

        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .unwrap();
        if !status.success() {
            // Junction creation can be unavailable in restricted Windows
            // test environments. The normal-file tests still run.
            return;
        }

        assert!(hash_file_sha256(&escaped_file).is_err());
    }

    #[test]
    fn accepts_present_nonempty_dlls() {
        let dir =
            std::env::temp_dir().join(format!("mysticparadox-dll-ok-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for name in required_runtime_artifact_names() {
            fs::write(dir.join(name), b"content").unwrap();
        }

        assert!(verify_runtime_dlls_present(&dir).is_ok());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn required_set_follows_the_build() {
        let names = required_runtime_artifact_names();
        assert_eq!(&names[..2], &CORE_RUNTIME_ARTIFACT_NAMES);
        #[cfg(feature = "p2p")]
        assert_eq!(&names[2..], &crate::p2p::RUNTIME_ARTIFACT_NAMES);
        #[cfg(not(feature = "p2p"))]
        assert_eq!(names.len(), 2);
    }
}
