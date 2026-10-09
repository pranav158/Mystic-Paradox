use serde::Serialize;
use std::fs;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::commands::auth::{api_base_url, http_client, safe_api_error, send_authorized};
use crate::launch::logs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPaths {
    pub sessions_root: String,
    pub latest_session_dir: Option<String>,
}

#[tauri::command]
pub fn native_get_log_paths(app: AppHandle) -> Result<LogPaths, String> {
    let root = logs::sessions_root(&app)?;
    // Best-effort so "open folder" has somewhere to open even before a first Play.
    let _ = fs::create_dir_all(&root);
    let latest = logs::latest_session_dir(&app)?;
    Ok(LogPaths {
        sessions_root: root.to_string_lossy().into_owned(),
        latest_session_dir: latest.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub started_at: String,
    pub exited_at: Option<String>,
    pub exit_code: Option<u32>,
    pub channel: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSessionMetadata {
    launch_session_id: String,
    started_at: String,
    account_id: String,
    channel: String,
    exit_code: Option<u32>,
    exited_at: Option<String>,
}

/// The newest Play sessions of one account on this PC, read from each session folder's
/// metadata.json (written once the game process starts). Attempts that failed before spawn have
/// no metadata and are not listed. Other accounts' sessions on a shared PC are never returned.
#[tauri::command]
pub async fn native_recent_sessions(
    app: AppHandle,
    account_id: String,
    limit: Option<u32>,
) -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = logs::sessions_root(&app)?;
        Ok(read_recent_sessions(
            &root,
            &account_id,
            limit.unwrap_or(5).clamp(1, 20) as usize,
        ))
    })
    .await
    .map_err(|_| "The session history task stopped unexpectedly.".to_string())?
}

fn read_recent_sessions(
    root: &std::path::Path,
    account_id: &str,
    limit: usize,
) -> Vec<SessionSummary> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut sessions: Vec<SessionSummary> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| fs::read(entry.path().join("metadata.json")).ok())
        .filter_map(|bytes| serde_json::from_slice::<StoredSessionMetadata>(&bytes).ok())
        .filter(|metadata| metadata.account_id == account_id)
        .map(|metadata| SessionSummary {
            id: metadata.launch_session_id,
            started_at: metadata.started_at,
            exited_at: metadata.exited_at,
            exit_code: metadata.exit_code,
            channel: metadata.channel,
        })
        .collect();
    // RFC 3339 UTC timestamps from one writer sort correctly as strings.
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    sessions.truncate(limit);
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_sessions_are_this_accounts_newest_first() {
        let root = std::env::temp_dir().join(format!(
            "mysticparadox-sessions-test-{}",
            std::process::id()
        ));
        let write = |id: &str, account: &str, started: &str| {
            let dir = root.join(id);
            fs::create_dir_all(&dir).unwrap();
            let metadata = serde_json::json!({
                "launchSessionId": id, "startedAt": started, "accountId": account, "displayName": "x",
                "gameExePath": "x", "channel": "stable", "exitCode": 0, "exitedAt": started
            });
            fs::write(dir.join("metadata.json"), metadata.to_string()).unwrap();
        };
        write("a", "me", "2026-10-01T10:00:00.000Z");
        write("b", "me", "2026-10-03T10:00:00.000Z");
        write("c", "someone-else", "2026-10-04T10:00:00.000Z");
        write("d", "me", "2026-10-02T10:00:00.000Z");
        fs::create_dir_all(root.join("no-metadata")).unwrap();

        let ids: Vec<String> = read_recent_sessions(&root, "me", 2)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["b".to_string(), "d".to_string()]);
        assert!(read_recent_sessions(&root.join("missing"), "me", 5).is_empty());
        fs::remove_dir_all(&root).ok();
    }
}

#[tauri::command]
pub fn native_open_log_folder(app: AppHandle) -> Result<(), String> {
    let root = logs::sessions_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| format!("Couldn't create the log folder: {e}"))?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "Couldn't open the log folder.".to_string())
}

// Only ever uploads files the launcher itself writes into a session folder (see
// launch::logs) — never an arbitrary path from JS. The backend independently re-validates
// both the session id and file name against the same allow-list (routes/launcherLogs.ts) and
// re-checks the tester role server-side, since a local file existing is not proof of anything.
fn uploadable_files(dir: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    for fixed in ["metadata.json", "launcher.log"] {
        if dir.join(fixed).is_file() {
            names.push(fixed.to_string());
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("runtime-") && name.ends_with(".log") {
                names.push(name);
            }
        }
    }
    names
}

#[tauri::command]
pub async fn native_upload_last_session(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = logs::latest_session_dir(&app)? else {
            return Err("No session logs found yet — play once first.".to_string());
        };
        let session_id = dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid session folder.".to_string())?
            .to_string();

        let files = uploadable_files(&dir);
        if files.is_empty() {
            return Err("No log files were found in the last session.".to_string());
        }

        let client = http_client()?;
        let base = api_base_url();
        let mut uploaded = 0u32;
        for name in files {
            let bytes =
                fs::read(dir.join(&name)).map_err(|e| format!("Couldn't read {name}: {e}"))?;
            let response = send_authorized(&app, |token| {
                client
                    .put(format!(
                        "{base}/launcher/v1/logs/sessions/{session_id}/{name}"
                    ))
                    .bearer_auth(token)
                    .header("Content-Type", "application/octet-stream")
                    .body(bytes.clone())
                    .send()
                    .map_err(|_| "Couldn't reach the Mystic Paradox server right now.".to_string())
            })?;
            if !response.status().is_success() {
                return Err(safe_api_error(response, "Log upload failed."));
            }
            uploaded += 1;
        }
        Ok(uploaded)
    })
    .await
    .map_err(|_| "The upload task stopped unexpectedly.".to_string())?
}
