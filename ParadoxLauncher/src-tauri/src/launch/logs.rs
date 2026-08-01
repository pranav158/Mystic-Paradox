use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use sha2::{Digest, Sha256};

/// %LOCALAPPDATA%\MysticParadox\Logs\Sessions — a fixed, memorable path independent of the
/// Tauri bundle identifier, so testers/support can find it without asking the launcher.
pub fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the log directory: {e}"))?;
    Ok(base.join("MysticParadox").join("Logs").join("Sessions"))
}

pub fn session_dir(app: &AppHandle, launch_session_id: &str) -> Result<PathBuf, String> {
    let dir = sessions_root(app)?.join(launch_session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the session log folder: {e}"))?;
    Ok(dir)
}

/// Not cryptographically random and not RFC4122-strict — just a globally-unique,
/// filesystem-safe id to correlate one Play attempt's logs. Built from sha2, which is
/// already a dependency, instead of pulling in a `uuid`/`rand` crate for this alone.
pub fn generate_launch_session_id() -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{nanos}-{}-{count}", std::process::id());
    let digest = Sha256::digest(seed.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Howard Hinnant's days-from-civil algorithm (public domain), inverted: days since the Unix
/// epoch -> (year, month, day). Avoids pulling in a date/time crate for one ISO 8601 stamp.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let (h, m, s) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

pub fn append_launcher_log(dir: &Path, line: &str) {
    let path = dir.join("launcher.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {line}", iso8601_now());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub launch_session_id: String,
    pub started_at: String,
    pub account_id: String,
    pub display_name: String,
    pub game_exe_path: String,
    pub channel: String,
    pub exit_code: Option<u32>,
    pub exited_at: Option<String>,
}

pub fn write_metadata(dir: &Path, metadata: &SessionMetadata) {
    if let Ok(json) = serde_json::to_string_pretty(metadata) {
        let _ = fs::write(dir.join("metadata.json"), json);
    }
}

/// Best-effort: copies any ParadoxRuntime DLL log (`mysticparadox_dll_port*.log`, written
/// beside the game exe — see ParadoxRuntime/dllmain.cpp's MpLogDir()) modified since launch
/// into the session folder. The DLL doesn't accept a log-path argument, so this is the
/// non-invasive way to get its output into the per-session folder without changing the
/// (signed, separately-published) runtime DLL itself.
pub fn copy_runtime_logs_best_effort(game_dir: &Path, session_dir: &Path, since: SystemTime) {
    let Ok(entries) = fs::read_dir(game_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("mysticparadox_dll_port") || !name_str.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < since {
            continue;
        }
        let _ = fs::copy(
            entry.path(),
            session_dir.join(format!("runtime-{name_str}")),
        );
    }
}

/// Most recently modified session folder under Sessions/, if any — used by the Settings tab
/// to show/upload the last Play attempt without the frontend needing to remember the id
/// across launcher restarts.
pub fn latest_session_dir(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let root = sessions_root(app)?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(None);
    };
    let mut latest: Option<(PathBuf, SystemTime)> = None;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if latest.as_ref().map(|(_, t)| modified > *t).unwrap_or(true) {
            latest = Some((entry.path(), modified));
        }
    }
    Ok(latest.map(|(path, _)| path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_unique_filesystem_safe_ids() {
        let a = generate_launch_session_id();
        let b = generate_launch_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn formats_a_plausible_iso8601_timestamp() {
        let stamp = iso8601_now();
        // e.g. 2026-07-27T10:00:00.000Z
        assert_eq!(stamp.len(), 24);
        assert!(stamp.starts_with("20"));
        assert!(stamp.ends_with('Z'));
    }
}
