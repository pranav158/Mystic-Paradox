// Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
// Licensed under the GNU Affero General Public License v3.0.
// SPDX-License-Identifier: AGPL-3.0-only
// Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.

//! Guard's integrity measurements, run on every heartbeat of a protected game (`launch::guard::integrity_signals`):
//! executable private memory, the hash allowlist of loaded modules, the protected code pages of the signed artifacts,
//! and the publisher of each module that fails the allowlist. The launcher only measures and reports. Nothing here
//! ends a process or blocks a launch; the backend decides what a finding means.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Memory::{
    VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_PRIVATE, PAGE_EXECUTE,
    PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY,
};

use crate::install::verify;
use crate::launch::guard::{GuardPayload, IntegritySignals, LoadedModule};
use crate::launch::module_signer;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutableMemoryPolicy {
    pub(crate) maximum_private_executable_bytes: usize,
    #[serde(default)]
    pub(crate) maximum_writable_executable_bytes: usize,
    #[serde(default)]
    pub(crate) allowlisted_module_hashes: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct ProtectedRegion {
    pub(crate) rva: usize,
    pub(crate) size: usize,
    pub(crate) sha256: String,
}

/// Bounds of the policy a signed manifest may carry.
pub(crate) fn policy_is_valid(policy: &ExecutableMemoryPolicy) -> bool {
    policy.maximum_private_executable_bytes <= 64 * 1024 * 1024
        && policy.maximum_writable_executable_bytes <= 16 * 1024 * 1024
        && policy.allowlisted_module_hashes.len() <= 512
        && policy
            .allowlisted_module_hashes
            .iter()
            .all(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn is_path_below(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['\\', '/']);
    !root.is_empty()
        && (path == root
            || path
                .strip_prefix(root)
                .is_some_and(|suffix| suffix.starts_with('\\') || suffix.starts_with('/')))
}

fn is_allowed_platform_module(
    path: &str,
    module_name: &str,
    windows_dir: &str,
    steam_roots: &[String],
) -> bool {
    let lower = path.to_lowercase();
    if is_path_below(&lower, windows_dir) {
        return true;
    }
    // Steam injects this signed overlay from its own installation rather than the game folder.
    // It remains visible in moduleSetDigest; only this exact basename under a Steam installation is
    // excluded from unexpectedModuleCount. All other external user/tool/temp modules are findings.
    module_name.eq_ignore_ascii_case("gameoverlayrenderer64.dll")
        && steam_roots.iter().any(|root| is_path_below(&lower, root))
}

/// A folder as `is_path_below` compares it: backslashes, lowercase, no trailing separator; absolute paths only.
fn normalized_root(value: &str) -> Option<String> {
    let root = value
        .trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    Path::new(&root).is_absolute().then_some(root)
}

/// The Steam installations the overlay may come from: the registry's install folders (Steam keeps the current one
/// in HKCU SteamPath, its installer writes HKLM InstallPath) and, as before, `<Program Files>\Steam`.
fn steam_roots_from(
    registry: impl IntoIterator<Item = String>,
    program_files: &[String],
) -> Vec<String> {
    let fallback = program_files
        .iter()
        .map(|root| format!("{}\\steam", root.trim_end_matches(['\\', '/'])));
    let mut roots = Vec::new();
    for root in registry
        .into_iter()
        .chain(fallback)
        .filter_map(|root| normalized_root(&root))
    {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

// RegGetValueW from advapi32 (the windows-sys registry feature is not enabled for this crate).
#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(
        key: isize,
        sub_key: *const u16,
        value: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut core::ffi::c_void,
        data_bytes: *mut u32,
    ) -> u32;
}

const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;

/// One REG_SZ value, or None when it is missing, unreadable or implausibly long.
fn registry_string(key: isize, sub_key: &str, value: &str) -> Option<String> {
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (sub_key, value) = (wide(sub_key), wide(value));
    let mut bytes = 0u32;
    // SAFETY: a size query with no buffer; both names are NUL-terminated.
    let status = unsafe {
        RegGetValueW(
            key,
            sub_key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if status != 0 || !(2..=64 * 1024).contains(&bytes) {
        return None;
    }
    let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
    let mut bytes = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` holds `bytes` bytes.
    let status = unsafe {
        RegGetValueW(
            key,
            sub_key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
}

/// The Steam installation folders of this PC. A registry folder counts only while it holds `steam.exe`: HKCU is
/// writable by the user, so a value pointing anywhere else is ignored.
fn steam_roots(program_files: &[String]) -> Vec<String> {
    let registry = [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ]
    .into_iter()
    .filter_map(|(key, sub_key, value)| registry_string(key, sub_key, value))
    .filter(|root| Path::new(root.trim()).join("steam.exe").is_file());
    steam_roots_from(registry, program_files)
}

/// The most unexpected modules one heartbeat lists. The count still covers every unexpected module.
pub(crate) const MAX_UNEXPECTED_MODULES: usize = 32;
/// The longest file name the report keeps.
const MAX_FILE_NAME_CHARS: usize = 260;
/// Signer answers kept in memory. The cache is emptied when it is full.
const SIGNER_CACHE_LIMIT: usize = 512;

/// One unexpected module as a heartbeat reports it (`unexpectedModules`). The name is the file name only, never a path.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnexpectedModule {
    pub(crate) file_name: String,
    pub(crate) signer: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

/// A module that failed the expected-hash check, before its publisher is read. Sorted by file name, hash and size
/// first, so the cap keeps the same modules every time.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct UnexpectedCandidate {
    file_name: String,
    sha256: String,
    size: u64,
    path: String,
    modified_nanos: Option<u128>,
}

impl UnexpectedCandidate {
    /// None when the path has no usable file name, the hash is not SHA-256 hex, or the file cannot be read.
    fn new(path: &str, sha256: &str) -> Option<Self> {
        if !is_sha256_hex(sha256) {
            return None;
        }
        let file_name = module_file_name(path)?;
        let metadata = std::fs::metadata(path).ok()?;
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_nanos());
        Some(Self {
            file_name,
            sha256: sha256.to_lowercase(),
            size: metadata.len(),
            path: path.to_string(),
            modified_nanos,
        })
    }
}

/// The file name of a module path: the text after its last separator, control characters removed, at most
/// `MAX_FILE_NAME_CHARS` characters. None when nothing is left.
pub(crate) fn module_file_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?;
    let cleaned: String = name
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_FILE_NAME_CHARS)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Exactly 64 hexadecimal digits.
pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Sorts the candidates, drops repeats of the same file (name, hash and size) and keeps the first
/// `MAX_UNEXPECTED_MODULES`. Only the kept ones are looked up for a publisher, so a heartbeat does a bounded amount of
/// signature work however many modules are unexpected.
pub(crate) fn select_unexpected_candidates(
    mut candidates: Vec<UnexpectedCandidate>,
) -> Vec<UnexpectedCandidate> {
    candidates.sort();
    candidates.dedup_by(|later, earlier| {
        later.file_name == earlier.file_name
            && later.sha256 == earlier.sha256
            && later.size == earlier.size
    });
    candidates.truncate(MAX_UNEXPECTED_MODULES);
    candidates
}

/// The report's final order: by file name, publisher, hash and size, exact repeats removed, at most
/// `MAX_UNEXPECTED_MODULES` entries.
pub(crate) fn finish_unexpected_modules(
    mut modules: Vec<UnexpectedModule>,
) -> Vec<UnexpectedModule> {
    modules.sort();
    modules.dedup();
    modules.truncate(MAX_UNEXPECTED_MODULES);
    modules
}

/// The publisher of a candidate. The cache key is the path with the file's size and write time, and the stored hash
/// must match too, so a file replaced under the same name is read again. The signature is checked off the UI thread
/// (Guard's heartbeat thread) and the lock is never held across the check.
fn cached_signer(candidate: &UnexpectedCandidate) -> String {
    type Key = (String, u64, u128);
    type Cache = Mutex<HashMap<Key, (String, String)>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let path = Path::new(&candidate.path);
    let Some(modified) = candidate.modified_nanos else {
        return module_signer::authenticode_signer(path);
    };
    let key: Key = (candidate.path.to_lowercase(), candidate.size, modified);
    if let Ok(cache) = CACHE.get_or_init(Default::default).lock() {
        if let Some((sha256, signer)) = cache.get(&key) {
            if *sha256 == candidate.sha256 {
                return signer.clone();
            }
        }
    }
    let signer = module_signer::authenticode_signer(path);
    if let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() {
        if cache.len() >= SIGNER_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, (candidate.sha256.clone(), signer.clone()));
    }
    signer
}

/// Turns the candidates of one heartbeat into the report: the capped, sorted selection with its publishers.
fn unexpected_module_report(candidates: Vec<UnexpectedCandidate>) -> Vec<UnexpectedModule> {
    finish_unexpected_modules(
        select_unexpected_candidates(candidates)
            .into_iter()
            .map(|candidate| UnexpectedModule {
                signer: cached_signer(&candidate),
                file_name: candidate.file_name,
                sha256: candidate.sha256,
                size: candidate.size,
            })
            .collect(),
    )
}

/// # Safety
/// `process` must be an open handle with `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` access, and
/// `modules` must come from a Toolhelp snapshot of that same process.
pub(crate) unsafe fn collect(
    process: HANDLE,
    process_id: u32,
    payload: &GuardPayload,
    game_dir: &Path,
    modules: &[LoadedModule],
) -> IntegritySignals {
    let mut signals = IntegritySignals::default();
    let mut address = 0usize;
    loop {
        let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
        let read = VirtualQueryEx(
            process,
            address as *const _,
            &mut info,
            std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
        );
        if read == 0 || info.RegionSize == 0 {
            break;
        }
        let executable = matches!(
            info.Protect,
            PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY
        );
        if info.State == MEM_COMMIT && info.Type == MEM_PRIVATE && executable {
            signals.private_executable_bytes = signals
                .private_executable_bytes
                .saturating_add(info.RegionSize);
            if matches!(
                info.Protect,
                PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY
            ) {
                signals.writable_executable_bytes = signals
                    .writable_executable_bytes
                    .saturating_add(info.RegionSize);
            }
        }
        let next = address.saturating_add(info.RegionSize);
        if next <= address {
            break;
        }
        address = next;
    }

    let mut expected: HashSet<String> = payload
        .artifacts
        .iter()
        .map(|a| a.sha256.to_lowercase())
        .collect();
    expected.extend(
        payload
            .executable_memory_policy
            .allowlisted_module_hashes
            .iter()
            .map(|hash| hash.to_lowercase()),
    );
    let game_dir = game_dir.to_string_lossy().to_lowercase();
    let windows_dir = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|path| path.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let program_files = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .map(|path| path.to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    let steam_roots = steam_roots(&program_files);
    let mut unexpected_details = Vec::new();
    let mut candidates = Vec::new();
    for module in modules {
        let lower = module.path.to_lowercase();
        // Every entry here is a mapped image: Windows refuses writes to it and a replacement
        // gets a new file index, so the identity-keyed cache is exact. Artifact verification
        // still re-hashes in full on every heartbeat.
        if lower.starts_with(&game_dir)
            || !is_allowed_platform_module(&module.path, &module.name, &windows_dir, &steam_roots)
        {
            match verify::hash_file_sha256_cached(Path::new(&module.path)) {
                Ok(hash) if expected.contains(&hash.to_lowercase()) => {}
                result => {
                    signals.unexpected_module_count += 1;
                    // A module that cannot be hashed is counted but not listed: there is no hash to report.
                    if let Ok(hash) = &result {
                        if let Some(candidate) = UnexpectedCandidate::new(&module.path, hash) {
                            candidates.push(candidate);
                        }
                    }
                    if unexpected_details.len() < 16 {
                        unexpected_details.push(format!(
                            "name={:?} sha256={}",
                            module.name,
                            result.unwrap_or_else(|_| "unreadable".into())
                        ));
                    }
                }
            }
        }
        if let Some(artifact) = payload
            .artifacts
            .iter()
            .find(|artifact| artifact.name.eq_ignore_ascii_case(&module.name))
        {
            for region in &artifact.protected_regions {
                if region.size == 0 || region.size > 1024 * 1024 || region.sha256.len() != 64 {
                    signals.protected_page_mismatch_count += 1;
                    continue;
                }
                let mut bytes = vec![0u8; region.size];
                let mut read = 0usize;
                let address = module.base.add(region.rva).cast();
                if ReadProcessMemory(
                    process,
                    address,
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                    &mut read,
                ) == 0
                    || read != bytes.len()
                {
                    signals.protected_page_mismatch_count += 1;
                    continue;
                }
                let actual: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if !actual.eq_ignore_ascii_case(&region.sha256) {
                    signals.protected_page_mismatch_count += 1;
                }
            }
        }
    }
    signals.unexpected_modules = unexpected_module_report(candidates);
    if signals.unexpected_module_count > 0 {
        crate::launch::process::append_active_session_log(&format!(
            "guard unexpected modules pid={process_id} count={} first_16=[{}]",
            signals.unexpected_module_count,
            unexpected_details.join(", ")
        ));
    }
    signals
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_module_allowlist_is_narrow() {
        let steam = steam_roots_from(Vec::new(), &[r"c:\program files (x86)".into()]);
        assert_eq!(steam, [r"c:\program files (x86)\steam"]);
        assert!(is_allowed_platform_module(
            r"C:\Windows\System32\kernel32.dll",
            "kernel32.dll",
            r"c:\windows",
            &steam
        ));
        assert!(is_allowed_platform_module(
            r"C:\Program Files (x86)\Steam\gameoverlayrenderer64.dll",
            "gameoverlayrenderer64.dll",
            r"c:\windows",
            &steam
        ));
        assert!(!is_allowed_platform_module(
            r"C:\Users\player\AppData\Local\Temp\inject.dll",
            "inject.dll",
            r"c:\windows",
            &steam
        ));
        assert!(!is_allowed_platform_module(
            r"C:\Windows-Evil\inject.dll",
            "inject.dll",
            r"c:\windows",
            &steam
        ));
        assert!(!is_allowed_platform_module(
            r"C:\Users\player\Steam\gameoverlayrenderer64.dll",
            "gameoverlayrenderer64.dll",
            r"c:\windows",
            &steam
        ));
        assert!(!is_allowed_platform_module(
            r"C:\Program Files (x86)\Steam\inject.dll",
            "inject.dll",
            r"c:\windows",
            &steam
        ));
    }

    #[test]
    fn steam_overlay_is_accepted_from_the_registry_install_folder() {
        // HKCU SteamPath uses forward slashes; HKLM InstallPath backslashes. Both normalise, duplicates drop out,
        // relative values are ignored, and the Program Files folders stay as the fallback.
        let steam = steam_roots_from(
            [
                "D:/Games/Steam/".to_string(),
                r"d:\games\steam".to_string(),
                r"Steam".to_string(),
            ],
            &[r"c:\program files (x86)".into()],
        );
        assert_eq!(steam, [r"d:\games\steam", r"c:\program files (x86)\steam"]);
        assert!(is_allowed_platform_module(
            r"D:\Games\Steam\gameoverlayrenderer64.dll",
            "gameoverlayrenderer64.dll",
            r"c:\windows",
            &steam
        ));
        assert!(!is_allowed_platform_module(
            r"D:\Games\SteamTools\gameoverlayrenderer64.dll",
            "gameoverlayrenderer64.dll",
            r"c:\windows",
            &steam
        ));
        // A registry read on this PC never fails the scan.
        let _ = steam_roots(&[r"c:\program files (x86)".into()]);
    }

    fn candidate(name: &str, sha256: &str, size: u64, path: &str) -> UnexpectedCandidate {
        UnexpectedCandidate {
            file_name: name.into(),
            sha256: sha256.into(),
            size,
            path: path.into(),
            modified_nanos: Some(1),
        }
    }

    fn digest(fill: char) -> String {
        fill.to_string().repeat(64)
    }

    #[test]
    fn report_names_are_file_names_only() {
        assert_eq!(
            module_file_name(r"C:\Users\player\AppData\Local\Temp\overlay.dll").as_deref(),
            Some("overlay.dll")
        );
        assert_eq!(
            module_file_name("C:/Program Files/Discord/DiscordHook64.dll").as_deref(),
            Some("DiscordHook64.dll")
        );
        assert_eq!(module_file_name("plain.dll").as_deref(), Some("plain.dll"));
        assert_eq!(module_file_name(r"C:\folder\"), None);
        assert_eq!(module_file_name("\u{1}\u{2}"), None);
        let long = format!("{}.dll", "n".repeat(400));
        assert_eq!(
            module_file_name(&long).map(|name| name.chars().count()),
            Some(MAX_FILE_NAME_CHARS)
        );
    }

    #[test]
    fn candidates_need_a_hex_hash_and_a_readable_file() {
        let exe = std::env::current_exe()
            .expect("test executable path")
            .to_string_lossy()
            .to_string();
        assert!(UnexpectedCandidate::new(&exe, &"z".repeat(64)).is_none());
        assert!(UnexpectedCandidate::new(&exe, "ab").is_none());
        assert!(UnexpectedCandidate::new(r"C:\no such folder\x.dll", &digest('a')).is_none());
        let made = UnexpectedCandidate::new(&exe, &"AB".repeat(32)).expect("readable test binary");
        assert_eq!(made.sha256, "ab".repeat(32));
        assert!(!made.file_name.contains('\\'));
        assert!(made.size > 0);
        assert!(made.modified_nanos.is_some());
    }

    #[test]
    fn selection_drops_repeats_of_the_same_file_and_sorts() {
        // Two copies of one file in different folders are one report entry; the same name with another hash is not.
        let candidates = vec![
            candidate("b.dll", &digest('a'), 10, r"C:\game\b.dll"),
            candidate("b.dll", &digest('a'), 10, r"C:\other\b.dll"),
            candidate("b.dll", &digest('b'), 10, r"C:\game\b2.dll"),
            candidate("a.dll", &digest('a'), 10, r"C:\game\a.dll"),
        ];
        let selected = select_unexpected_candidates(candidates);
        let names: Vec<(String, String)> = selected
            .iter()
            .map(|c| (c.file_name.clone(), c.sha256.clone()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("a.dll".to_string(), digest('a')),
                ("b.dll".to_string(), digest('a')),
                ("b.dll".to_string(), digest('b')),
            ]
        );
    }

    #[test]
    fn selection_caps_the_list_at_the_first_names_in_order() {
        let candidates: Vec<UnexpectedCandidate> = (0..40)
            .rev()
            .map(|n| {
                candidate(
                    &format!("mod{n:02}.dll"),
                    &digest('c'),
                    10,
                    &format!(r"C:\game\mod{n:02}.dll"),
                )
            })
            .collect();
        let selected = select_unexpected_candidates(candidates);
        assert_eq!(selected.len(), MAX_UNEXPECTED_MODULES);
        assert_eq!(selected[0].file_name, "mod00.dll");
        assert_eq!(selected[MAX_UNEXPECTED_MODULES - 1].file_name, "mod31.dll");
    }

    #[test]
    fn final_report_is_sorted_deduplicated_and_capped() {
        let entry = |name: &str, signer: &str| UnexpectedModule {
            file_name: name.into(),
            signer: signer.into(),
            sha256: digest('d'),
            size: 7,
        };
        let mut modules = vec![entry("z.dll", "unsigned"), entry("a.dll", "unsigned")];
        modules.push(entry("a.dll", "unsigned"));
        modules.push(entry("a.dll", "invalid"));
        let report = finish_unexpected_modules(modules);
        assert_eq!(
            report,
            vec![
                entry("a.dll", "invalid"),
                entry("a.dll", "unsigned"),
                entry("z.dll", "unsigned"),
            ]
        );
        let many: Vec<UnexpectedModule> = (0..40)
            .map(|n| entry(&format!("m{n:02}.dll"), "unsigned"))
            .collect();
        assert_eq!(
            finish_unexpected_modules(many).len(),
            MAX_UNEXPECTED_MODULES
        );
    }

    #[test]
    fn report_entries_serialize_with_the_agreed_field_names() {
        let entry = UnexpectedModule {
            file_name: "a.dll".into(),
            signer: "unsigned".into(),
            sha256: "ab".repeat(32),
            size: 12,
        };
        let sha256 = "ab".repeat(32);
        assert_eq!(
            serde_json::to_value(&entry).expect("serializes"),
            serde_json::json!({
                "fileName": "a.dll",
                "signer": "unsigned",
                "sha256": sha256,
                "size": 12
            })
        );
    }
}
