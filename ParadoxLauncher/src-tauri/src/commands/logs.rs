use serde::Serialize;
use std::fs;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::commands::auth::{api_base_url, http_client, refresh_native_session, safe_api_error};
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

        let refreshed = refresh_native_session(&app)?;
        let client = http_client()?;
        let base = api_base_url();
        let mut uploaded = 0u32;
        for name in files {
            let bytes =
                fs::read(dir.join(&name)).map_err(|e| format!("Couldn't read {name}: {e}"))?;
            let response = client
                .put(format!(
                    "{base}/launcher/v1/logs/sessions/{session_id}/{name}"
                ))
                .bearer_auth(&refreshed.access_token)
                .header("Content-Type", "application/octet-stream")
                .body(bytes)
                .send()
                .map_err(|_| "Couldn't reach the Mystic Paradox server right now.".to_string())?;
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
