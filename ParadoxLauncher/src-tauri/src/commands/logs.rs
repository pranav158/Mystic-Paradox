use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::auth::scope;
use crate::commands::auth::{
    api_base_url, api_error_message, current_account_id, error_code_of, send_authorized,
};
use crate::install::{paths, verify};
use crate::launch::log_upload::{self, ManifestFile, PlanInputs, PlaySession};
use crate::launch::{logs, process};
use crate::servers;

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
    /// Sessions written before the server list have none: they were the official scope's.
    #[serde(default = "official_scope_key")]
    auth_scope: String,
    exit_code: Option<u32>,
    exited_at: Option<String>,
    #[serde(default)]
    game_exe_path: Option<String>,
}

fn official_scope_key() -> String {
    servers::OFFICIAL_ID.to_string()
}

/// The newest Play sessions of one account of the SELECTED server's scope on this PC, read from each session
/// folder's metadata.json (written once the game process starts). Attempts that failed before spawn have
/// no metadata and are not listed. Other accounts' sessions on a shared PC, and sessions of another server's
/// scope, are never returned.
#[tauri::command]
pub async fn native_recent_sessions(
    app: AppHandle,
    account_id: String,
    limit: Option<u32>,
) -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = logs::sessions_root(&app)?;
        let scope = scope::scope_for(&servers::store::load(&app), None)?;
        Ok(read_recent_sessions(
            &root,
            scope.key(),
            &account_id,
            limit.unwrap_or(5).clamp(1, 20) as usize,
        ))
    })
    .await
    .map_err(|_| "The session history task stopped unexpectedly.".to_string())?
}

/// Every session folder with readable metadata, as (folder, metadata).
fn stored_sessions(root: &Path) -> Vec<(PathBuf, StoredSessionMetadata)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let bytes = fs::read(entry.path().join("metadata.json")).ok()?;
            let metadata = serde_json::from_slice::<StoredSessionMetadata>(&bytes).ok()?;
            Some((entry.path(), metadata))
        })
        .collect()
}

fn read_recent_sessions(
    root: &Path,
    scope_key: &str,
    account_id: &str,
    limit: usize,
) -> Vec<SessionSummary> {
    let mut sessions: Vec<SessionSummary> = stored_sessions(root)
        .into_iter()
        .map(|(_, metadata)| metadata)
        .filter(|metadata| metadata.account_id == account_id && metadata.auth_scope == scope_key)
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

/// Only the official network's sessions go to the official backend. A local server's logs (its account, its game
/// folder) are the player's own and are never uploaded to us.
fn is_uploadable_scope(scope_key: &str) -> bool {
    scope_key == servers::OFFICIAL_ID
}

/// The account's newest Play session on the official network, if any. Another account's sessions on a shared PC are
/// never uploaded under this one.
fn latest_account_session(
    root: &Path,
    account_id: &str,
) -> Option<(PathBuf, StoredSessionMetadata)> {
    stored_sessions(root)
        .into_iter()
        .filter(|(_, metadata)| {
            metadata.account_id == account_id && is_uploadable_scope(&metadata.auth_scope)
        })
        .max_by(|a, b| a.1.started_at.cmp(&b.1.started_at))
}

#[tauri::command]
pub fn native_open_log_folder(app: AppHandle) -> Result<(), String> {
    let root = logs::sessions_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| format!("Couldn't create the log folder: {e}"))?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "Couldn't open the log folder.".to_string())
}

// ---- the log upload ----------------------------------------------------------------------------------------------
//
// [2026-10-17] "Upload logs" sends the account's newest Play session and the logs written since it started: the
// launcher log, the game client's runtime log from where it stood at Play, the newest hosted-server logs, the
// connection and realm host logs, and the game's settings files (launch/log_upload.rs chooses and cleans them). Only
// files the launcher chooses itself, never a path from the page. The backend checks the tester role and every name
// again (services/launcherLogNames.ts). Without a Play session of the account (a host that only hosts) it sends the
// host's logs of the last day under a new upload id. One file failing does not stop the rest.

/// Sent before each file: `{index, total, name}` (index from 1).
pub const LOG_UPLOAD_PROGRESS_EVENT: &str = "log-upload-progress";

static UPLOAD_RUNNING: AtomicBool = AtomicBool::new(false);

struct UploadRunning;

impl Drop for UploadRunning {
    fn drop(&mut self) {
        UPLOAD_RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    index: u32,
    total: u32,
    name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileProblem {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadReport {
    pub upload_id: String,
    /// `play` or `host` (no Play session of this account on this PC).
    pub upload_kind: String,
    pub uploaded: u32,
    pub total: u32,
    pub failed: Vec<FileProblem>,
    pub skipped: Vec<FileProblem>,
    /// Why the upload stopped before its last file (tester access, the hourly limit, the storage limit, sign-in).
    pub stopped: Option<String>,
}

const NETWORK_ERROR: &str = "Couldn't reach the Mystic Paradox server right now.";

/// A whole file can take a while on a slow connection; the shared client's 10 s would cut it off.
fn upload_client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())?;
    let _ = CLIENT.set(client.clone());
    Ok(CLIENT.get().cloned().unwrap_or(client))
}

#[derive(Debug, PartialEq)]
enum PutError {
    /// The rest of the upload would be refused too.
    Stop(String),
    /// This file only.
    Failed(String),
}

/// What a refusal means for the rest of the upload. Tester access, the hourly limit, the storage limit and sign-in
/// apply to every file, so the upload stops; anything else concerns this file only.
fn classify_refusal(status: u16, code: Option<&str>) -> PutError {
    match code {
        Some("AUTH_TESTER_REQUIRED") => {
            PutError::Stop("Tester access is required to upload logs.".to_string())
        }
        Some("LOG_UPLOAD_RATE_LIMITED") => PutError::Stop(
            "Too many log files were uploaded in the last hour. Try again later.".to_string(),
        ),
        Some("LOG_UPLOAD_QUOTA") => PutError::Stop(
            "The server's log storage for this account or upload is full. Ask the team to clear older uploads."
                .to_string(),
        ),
        _ if status == 429 => PutError::Stop(
            "Too many log files were uploaded in the last hour. Try again later.".to_string(),
        ),
        _ if status == 401 || status == 403 => {
            PutError::Stop(api_error_message(status, code, "Sign in again to upload logs."))
        }
        _ => PutError::Failed(api_error_message(
            status,
            code,
            "The server refused this file.",
        )),
    }
}

/// One file, with one retry on a network error or a server error.
fn put_file(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    url: &str,
    bytes: &[u8],
) -> Result<(), PutError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let sent = send_authorized(app, |token| {
            client
                .put(url)
                .bearer_auth(token)
                .header("Content-Type", "application/octet-stream")
                .body(bytes.to_vec())
                .send()
                .map_err(|_| NETWORK_ERROR.to_string())
        });
        let response = match sent {
            Ok(response) => response,
            Err(message) if message == NETWORK_ERROR && attempt < 2 => continue,
            Err(message) if message == NETWORK_ERROR => return Err(PutError::Failed(message)),
            // The session could not be refreshed: signed out, disabled or unapproved.
            Err(message) => return Err(PutError::Stop(message)),
        };
        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(());
        }
        if status >= 500 && attempt < 2 {
            continue;
        }
        let body = response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .unwrap_or_default();
        return Err(classify_refusal(status, error_code_of(&body).as_deref()));
    }
}

fn host_only_metadata(upload_id: &str, account_id: &str, created_at: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "launchSessionId": upload_id,
        "uploadKind": "host",
        "startedAt": created_at,
        "accountId": account_id,
        "authScope": servers::OFFICIAL_ID,
        "launcherVersion": env!("CARGO_PKG_VERSION"),
        "note": "No Play session of this account on this PC: the logs of the servers it hosted in the last day.",
    }))
    .unwrap_or_default()
}

fn game_dir_of(exe: &Path) -> Option<PathBuf> {
    exe.parent().map(Path::to_path_buf)
}

fn upload_logs(app: &AppHandle) -> Result<UploadReport, String> {
    let account_id = current_account_id(app)?;
    let root = logs::sessions_root(app)?;
    let logs_dir = logs::logs_dir()
        .or_else(|| root.parent().map(Path::to_path_buf))
        .ok_or_else(|| "Couldn't locate the log folder.".to_string())?;

    let stored = latest_account_session(&root, &account_id);
    let session = stored.as_ref().map(|(dir, metadata)| PlaySession {
        dir: dir.clone(),
        started_ms: log_upload::parse_utc_stamp_ms(&metadata.started_at),
        game_dir: metadata
            .game_exe_path
            .as_deref()
            .and_then(|exe| game_dir_of(Path::new(exe))),
        offsets: log_upload::read_session_offsets(dir),
    });
    // The session's game folder, and the one hosted servers start from (a realm plays from the official install).
    let mut game_dirs: Vec<PathBuf> = session
        .as_ref()
        .and_then(|session| session.game_dir.clone())
        .into_iter()
        .collect();
    if let Some(dir) = paths::load_saved_exe_path(app).and_then(|exe| game_dir_of(&exe)) {
        game_dirs.push(dir);
    }

    let created_at = logs::iso8601_now();
    let (upload_id, upload_kind) = match &stored {
        Some((dir, _)) => (
            dir.file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "Invalid session folder.".to_string())?
                .to_string(),
            "play",
        ),
        None => (logs::generate_launch_session_id(), "host"),
    };
    let config_dir = std::env::var("LOCALAPPDATA").ok().map(|local| {
        PathBuf::from(local)
            .join("Archon")
            .join("Saved")
            .join("Config")
            .join("WindowsClient")
    });
    let plan = log_upload::plan_upload(&PlanInputs {
        session: session.as_ref(),
        game_dirs: game_dirs.clone(),
        logs_dir: logs_dir.clone(),
        idle_connection_dir: app
            .path()
            .app_local_data_dir()
            .ok()
            .map(|dir| dir.join("p2p-logs")),
        config_dir,
        host_starts: log_upload::read_host_starts(&logs_dir),
        account_id: &account_id,
        now_ms: log_upload::now_ms(),
        host_only_metadata: host_only_metadata(&upload_id, &account_id, &created_at),
    });
    let sources = plan.sources;

    let client = upload_client()?;
    let base = api_base_url();
    let total = sources.len() as u32 + 1;
    let mut report = UploadReport {
        upload_id: upload_id.clone(),
        upload_kind: upload_kind.to_string(),
        uploaded: 0,
        total,
        failed: Vec::new(),
        skipped: plan
            .skipped
            .iter()
            .map(|skip| FileProblem {
                name: skip.name.clone(),
                reason: skip.reason.clone(),
            })
            .collect(),
        stopped: None,
    };
    let mut manifest_files = Vec::new();
    let mut sent_total: u64 = 0;

    for (index, source) in sources.iter().enumerate() {
        let _ = app.emit(
            LOG_UPLOAD_PROGRESS_EVENT,
            UploadProgress {
                index: index as u32 + 1,
                total,
                name: source.name.clone(),
            },
        );
        let mut entry = ManifestFile {
            name: source.name.clone(),
            kind: source.kind,
            status: "uploaded",
            reason: None,
            source_bytes: None,
            range_start: None,
            range_end: None,
            dropped_bytes: None,
            sent_bytes: 0,
            redactions: Default::default(),
        };
        if let Some(stopped) = &report.stopped {
            entry.status = "failed";
            entry.reason = Some(format!("not sent: {stopped}"));
            report.failed.push(FileProblem {
                name: source.name.clone(),
                reason: "not sent: the upload stopped".to_string(),
            });
            manifest_files.push(entry);
            continue;
        }
        let prepared = match log_upload::prepare(source) {
            Ok(prepared) => prepared,
            Err(_) => {
                entry.status = "failed";
                entry.reason = Some("couldn't read the file".to_string());
                report.failed.push(FileProblem {
                    name: source.name.clone(),
                    reason: "couldn't read the file".to_string(),
                });
                manifest_files.push(entry);
                continue;
            }
        };
        if let Some(window) = &prepared.window {
            entry.source_bytes = Some(window.source_len);
            entry.range_start = Some(window.start);
            entry.range_end = Some(window.end);
            entry.dropped_bytes = (window.dropped > 0).then_some(window.dropped);
        }
        entry.redactions = prepared.redactions.clone();
        let skip_reason = if prepared.bytes.is_empty() {
            Some("nothing written in this window".to_string())
        } else if sent_total + prepared.bytes.len() as u64 > log_upload::UPLOAD_BUDGET {
            Some(format!(
                "over the upload's {} MB limit",
                log_upload::UPLOAD_BUDGET / (1024 * 1024)
            ))
        } else {
            None
        };
        if let Some(reason) = skip_reason {
            entry.status = "skipped";
            entry.reason = Some(reason.clone());
            report.skipped.push(FileProblem {
                name: source.name.clone(),
                reason,
            });
            manifest_files.push(entry);
            continue;
        }
        let url = format!(
            "{base}/launcher/v1/logs/sessions/{upload_id}/{}",
            source.name
        );
        match put_file(app, &client, &url, &prepared.bytes) {
            Ok(()) => {
                entry.sent_bytes = prepared.bytes.len() as u64;
                sent_total += entry.sent_bytes;
                report.uploaded += 1;
            }
            Err(PutError::Failed(reason)) => {
                entry.status = "failed";
                entry.reason = Some(reason.clone());
                report.failed.push(FileProblem {
                    name: source.name.clone(),
                    reason,
                });
            }
            Err(PutError::Stop(reason)) => {
                entry.status = "failed";
                entry.reason = Some(reason.clone());
                report.failed.push(FileProblem {
                    name: source.name.clone(),
                    reason: reason.clone(),
                });
                report.stopped = Some(reason);
            }
        }
        manifest_files.push(entry);
    }

    // The manifest last, so it records what really happened to every file.
    let _ = app.emit(
        LOG_UPLOAD_PROGRESS_EVENT,
        UploadProgress {
            index: total,
            total,
            name: log_upload::MANIFEST_NAME.to_string(),
        },
    );
    if report.stopped.is_some() {
        report.failed.push(FileProblem {
            name: log_upload::MANIFEST_NAME.to_string(),
            reason: "not sent: the upload stopped".to_string(),
        });
        return Ok(report);
    }
    let runtime_sha256 = game_dirs
        .iter()
        .map(|dir| dir.join("MysticParadox.dll"))
        .find(|dll| dll.is_file())
        .and_then(|dll| verify::hash_file_sha256_cached(&dll).ok());
    let manifest = log_upload::Manifest {
        schema: 1,
        upload_id: upload_id.clone(),
        upload_kind,
        created_at,
        since: millis_to_stamp(plan.since_ms),
        launcher_version: env!("CARGO_PKG_VERSION"),
        runtime_sha256,
        game_running: process::game_process_id().is_some(),
        files: manifest_files,
        skipped: plan.skipped.clone(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| "Couldn't write the upload manifest.".to_string())?;
    let url = format!(
        "{base}/launcher/v1/logs/sessions/{upload_id}/{}",
        log_upload::MANIFEST_NAME
    );
    match put_file(app, &client, &url, &manifest_bytes) {
        Ok(()) => report.uploaded += 1,
        Err(PutError::Failed(reason)) | Err(PutError::Stop(reason)) => {
            report.failed.push(FileProblem {
                name: log_upload::MANIFEST_NAME.to_string(),
                reason,
            })
        }
    }
    Ok(report)
}

fn millis_to_stamp(millis: u64) -> String {
    logs::format_epoch_rfc3339((millis / 1000) as i64, (millis % 1000) as u32)
}

/// Uploads this account's newest Play session and the logs written since, or its host logs when it has no session.
#[tauri::command]
pub async fn native_upload_logs(app: AppHandle) -> Result<UploadReport, String> {
    if UPLOAD_RUNNING.swap(true, Ordering::AcqRel) {
        return Err("An upload is already running.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _running = UploadRunning;
        upload_logs(&app)
    })
    .await
    .map_err(|_| "The upload task stopped unexpectedly.".to_string())?
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
            // Written before the server list existed: no `authScope`, so the official scope's.
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

        let ids: Vec<String> = read_recent_sessions(&root, "official", "me", 2)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["b".to_string(), "d".to_string()]);
        assert!(read_recent_sessions(&root.join("missing"), "official", "me", 5).is_empty());
        // The upload takes this account's newest session, never the other account's newer one.
        let (dir, metadata) = latest_account_session(&root, "me").unwrap();
        assert_eq!(dir.file_name().unwrap(), "b");
        assert_eq!(metadata.game_exe_path.as_deref(), Some("x"));
        assert!(latest_account_session(&root, "nobody").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recent_sessions_never_cross_server_scopes() {
        let root = std::env::temp_dir().join(format!(
            "mysticparadox-sessions-scope-test-{}",
            std::process::id()
        ));
        let write = |id: &str, scope: Option<&str>, started: &str| {
            let dir = root.join(id);
            fs::create_dir_all(&dir).unwrap();
            let mut metadata = serde_json::json!({
                "launchSessionId": id, "startedAt": started, "accountId": "me", "displayName": "x",
                "gameExePath": "x", "channel": "stable", "exitCode": 0, "exitedAt": started
            });
            if let Some(scope) = scope {
                metadata["authScope"] = scope.into();
            }
            fs::write(dir.join("metadata.json"), metadata.to_string()).unwrap();
        };
        write("old", None, "2026-10-01T10:00:00.000Z");
        write("official", Some("official"), "2026-10-02T10:00:00.000Z");
        write(
            "local-a",
            Some("s-aaaaaaaaaaaa"),
            "2026-10-03T10:00:00.000Z",
        );
        write(
            "local-b",
            Some("s-bbbbbbbbbbbb"),
            "2026-10-04T10:00:00.000Z",
        );
        let ids = |scope: &str| -> Vec<String> {
            read_recent_sessions(&root, scope, "me", 10)
                .into_iter()
                .map(|s| s.id)
                .collect()
        };
        assert_eq!(
            ids("official"),
            vec!["official".to_string(), "old".to_string()]
        );
        assert_eq!(ids("s-aaaaaaaaaaaa"), vec!["local-a".to_string()]);
        assert_eq!(ids("s-bbbbbbbbbbbb"), vec!["local-b".to_string()]);
        // Only the official network's sessions may be uploaded to it: the newer local sessions are passed over.
        let (dir, _) = latest_account_session(&root, "me").unwrap();
        assert_eq!(dir.file_name().unwrap(), "official");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refusals_that_apply_to_every_file_stop_the_upload() {
        for (status, code) in [
            (403, Some("AUTH_TESTER_REQUIRED")),
            (429, Some("LOG_UPLOAD_RATE_LIMITED")),
            (413, Some("LOG_UPLOAD_QUOTA")),
            (429, None),
            (401, None),
        ] {
            assert!(
                matches!(classify_refusal(status, code), PutError::Stop(_)),
                "{status} {code:?}"
            );
        }
        for (status, code) in [
            (400, Some("AUTH_VALIDATION_FAILED")),
            (500, None),
            (413, None),
        ] {
            assert!(
                matches!(classify_refusal(status, code), PutError::Failed(_)),
                "{status} {code:?}"
            );
        }
    }

    #[test]
    fn a_host_only_upload_names_itself_in_its_metadata() {
        let bytes = host_only_metadata("abcdef12-0000", "acct1", "2026-10-17T10:00:00.000Z");
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["launchSessionId"], "abcdef12-0000");
        assert_eq!(value["uploadKind"], "host");
        assert_eq!(value["authScope"], "official");
        assert_eq!(
            millis_to_stamp(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }
}
