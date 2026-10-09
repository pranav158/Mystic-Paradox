use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::commands::auth::{
    api_base_url, fetch_policy, http_client, refresh_native_session, safe_api_error,
};
use crate::commands::updates::{install_runtime_update, runtime_install_lock};
use crate::install::{paths, verify};
use crate::launch::flags;
use crate::launch::logs::{self, SessionMetadata};
use crate::launch::process::{self, LaunchIdentity};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    supported_build_changelist: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionRequest<'a> {
    build_changelist: u32,
    executable_sha256: &'a str,
    // The server re-validates this against the account's CURRENT roles at the moment the
    // ticket is issued — the actual authoritative boundary, since the policy fetch/channel
    // check a few lines above this could already be stale by the time this request lands.
    runtime_channel: &'a str,
    // The backend compares the installed set and release version with the latest signed manifest
    // for the server-derived account channel. Presence-only checks are not an authority boundary;
    // every required file is hashed here: the runtime and winmm proxy (`verify::required_runtime_artifact_names`),
    // plus the co-op files while the co-op switch is on (`p2p::prepare_play`).
    runtime_manifest_version: &'a str,
    runtime_artifacts: &'a [RuntimeArtifactHash],
}

#[derive(Serialize)]
struct RuntimeArtifactHash {
    name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionResponse {
    exchange_code: String,
}

#[tauri::command]
pub async fn is_game_running() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(process::is_game_running)
        .await
        .map_err(|_| "The game status check stopped unexpectedly.".to_string())?
}

/// Security boundary for Play: the WebView supplies no token, identity, build
/// hash, or exchange code. Rust loads the DPAPI/Credential Manager refresh
/// token, rotates it, verifies the install, requests the one-time game ticket,
/// and spawns immediately. The ticket never becomes JavaScript-visible.
/// `expected_channel` is the channel value the TS side fetched for this exact Play attempt (see HomeTab.tsx's
/// `handlePlay`). Re-fetching policy here and comparing closes a race: TS's policy fetch and
/// this function's fetch happen moments apart, so an admin could revoke Tester in between —
/// without this check, the already-installed beta/dev runtime would still launch even though
/// the account is no longer entitled to it.
#[tauri::command]
pub async fn secure_launch(app: AppHandle, expected_channel: String) -> Result<(), String> {
    let account_epoch = crate::auth::session_epoch::current();
    // Reject duplicate Play before any update or authentication work begins. Move the owned
    // guard into the blocking task: cancelling the IPC future must not unlock a running spawn.
    let launch_guard = secure_launch_lock()
        .clone()
        .try_lock_owned()
        .map_err(|_| "A launch is already being prepared. Please wait a moment.".to_string())?;
    let launch_session_id = logs::generate_launch_session_id();
    let session_dir = logs::session_dir(&app, &launch_session_id)?;
    let started = std::time::Instant::now();
    logs::append_launcher_log(
        &session_dir,
        "play preparation started; verifying signed runtime",
    );
    // Native Play owns runtime repair and verification; the WebView is not a security boundary.
    let runtime_manifest_version = install_runtime_update(app.clone(), expected_channel.clone())
        .await
        .and_then(|runtime| {
            runtime
                .version
                .ok_or_else(|| "No approved runtime release is available for Play.".to_string())
        })
        .map_err(|error| {
            logs::append_launcher_log(
                &session_dir,
                &format!("runtime preparation failed: {error}"),
            );
            error
        })?;
    // Keep every launcher-managed Repair/prefetch out of the hash -> ticket -> DLL load
    // window. If an update won the gap before this lock, the fresh hashes below still have
    // to match the approved manifest/version at the backend before a process can start.
    let runtime_guard = runtime_install_lock().clone().lock_owned().await;
    logs::append_launcher_log(
        &session_dir,
        &format!(
            "runtime verified after {}ms; checking install and account",
            started.elapsed().as_millis()
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _launch_guard = launch_guard;
        let _runtime_guard = runtime_guard;
        let result = secure_launch_after_runtime(
            app,
            expected_channel,
            runtime_manifest_version,
            account_epoch,
            launch_session_id,
            &session_dir,
        );
        let outcome = match &result {
            Ok(()) => "process started (Ramsgate arrival not yet verified)".to_string(),
            Err(error) => format!("preparation failed: {error}"),
        };
        logs::append_launcher_log(
            &session_dir,
            &format!("{outcome}; elapsed={}ms", started.elapsed().as_millis()),
        );
        result
    })
    .await
    .map_err(|_| "The secure launch task stopped unexpectedly.".to_string())?
}

fn secure_launch_lock() -> &'static std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCK: OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
}

fn secure_launch_after_runtime(
    app: AppHandle,
    expected_channel: String,
    runtime_manifest_version: String,
    account_epoch: u64,
    launch_session_id: String,
    session_dir: &std::path::Path,
) -> Result<(), String> {
    crate::auth::session_epoch::check(account_epoch, crate::auth::session_epoch::current())?;
    let exe_path = paths::load_saved_exe_path(&app)
        .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
    if !exe_path.is_file() {
        return Err("Your Dauntless installation is missing. Locate it again.".to_string());
    }
    let game_dir = paths::game_dir(&exe_path)?;
    verify::verify_runtime_dlls_present(&game_dir)?;
    if process::is_game_running()? {
        return Err("Dauntless is already running.".to_string());
    }
    let executable_sha256 = verify::hash_file_sha256(&exe_path)?;
    #[cfg_attr(not(mystic_p2p), allow(unused_mut))]
    let mut runtime_artifacts = verify::required_runtime_artifact_names()
        .into_iter()
        .map(|name| {
            Ok(RuntimeArtifactHash {
                name: name.to_string(),
                sha256: verify::hash_file_sha256(&game_dir.join(name))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let refreshed = refresh_native_session(&app)?;

    // Fetch policy fresh, right before spawning — used for flag reconciliation AND the
    // channel-consistency check above. Fails closed: if we can't reach the policy endpoint we
    // can't confirm current entitlement, so we don't launch. This doesn't cost real
    // availability — the ticket request a few lines below needs the same backend anyway, so a
    // backend outage was going to fail Play regardless.
    let policy = fetch_policy(&refreshed.access_token).map_err(|_| {
        "Couldn't verify your account access. Check your connection and try again.".to_string()
    })?;
    if policy.channel != expected_channel {
        return Err(
            "Your account access changed. Press Play again to pick up the new settings."
                .to_string(),
        );
    }
    // The co-op switch for this Play: with co-op on, the co-op files join the reported runtime set and the
    // transport starts before the game (process::spawn_game).
    #[cfg(mystic_p2p)]
    for name in crate::p2p::prepare_play(
        &app,
        policy.coop_hunts,
        &policy.channel,
        &refreshed.access_token,
        session_dir,
    ) {
        let sha256 = verify::hash_file_sha256(&game_dir.join(&name))?;
        runtime_artifacts.push(RuntimeArtifactHash { name, sha256 });
    }

    // The session directory is created before runtime preparation so early failures are retained.
    logs::append_launcher_log(
        session_dir,
        &format!("play requested for {}", refreshed.account.display_name),
    );

    // Diagnostic flags only (VERBOSE_DIAG.flag) — not the actual access control (that's
    // fully server-side; see the channel check above and testerFeatures.ts). A failure here
    // is logged but doesn't block Play.
    if let Err(error) = flags::reconcile(&game_dir, &policy.managed_feature_ids) {
        logs::append_launcher_log(session_dir, &format!("flag reconcile failed: {error}"));
    }

    let client = http_client()?;
    let base = api_base_url();

    let status_response = client
        .get(format!("{base}/launcher/v1/status"))
        .send()
        .map_err(|_| "Couldn't reach the Mystic Paradox game server.".to_string())?;
    if !status_response.status().is_success() {
        return Err(safe_api_error(
            status_response,
            "Couldn't read the supported game build.",
        ));
    }
    let status: ServerStatus = status_response
        .json()
        .map_err(|_| "The game server returned an invalid build response.".to_string())?;

    let runtime_profile = match policy.diagnostics_profile.as_str() {
        "PRODUCTION" => "production",
        "DEVELOPMENT" => "development",
        _ => return Err("The server returned an invalid diagnostics policy.".to_string()),
    };

    let ticket_response = client
        .post(format!("{base}/launcher/v1/game-sessions"))
        .bearer_auth(&refreshed.access_token)
        .json(&GameSessionRequest {
            build_changelist: status.supported_build_changelist,
            executable_sha256: &executable_sha256,
            runtime_channel: &expected_channel,
            runtime_manifest_version: &runtime_manifest_version,
            runtime_artifacts: &runtime_artifacts,
        })
        .send()
        .map_err(|_| "Couldn't request a game session.".to_string())?;
    if !ticket_response.status().is_success() {
        return Err(safe_api_error(
            ticket_response,
            "Couldn't request a game session.",
        ));
    }
    let ticket: GameSessionResponse = ticket_response
        .json()
        .map_err(|_| "The game server returned an invalid launch response.".to_string())?;

    let metadata = SessionMetadata {
        launch_session_id: launch_session_id.clone(),
        started_at: logs::iso8601_now(),
        account_id: refreshed.account.user_id.clone(),
        display_name: refreshed.account.display_name.clone(),
        game_exe_path: exe_path.to_string_lossy().into_owned(),
        channel: policy.channel,
        exit_code: None,
        exited_at: None,
    };
    logs::write_metadata(session_dir, &metadata);

    // Hold the account fence through process registration. A concurrent logout either cancels
    // this launch here or terminates its registered Job Object after spawn has finished.
    let epoch = crate::auth::session_epoch::lock();
    crate::auth::session_epoch::check(account_epoch, *epoch)?;
    process::spawn_game(
        &app,
        &exe_path,
        &ticket.exchange_code,
        &LaunchIdentity {
            account_id: refreshed.account.user_id,
            display_name: refreshed.account.display_name,
        },
        runtime_profile,
        session_dir,
        metadata,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_launch_is_rejected_until_blocking_work_releases_guard() {
        let lock = secure_launch_lock();
        let guard = lock.clone().try_lock_owned().unwrap();
        assert!(lock.clone().try_lock_owned().is_err());
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let task = std::thread::spawn(move || {
            let _guard = guard;
            wait.recv().unwrap();
        });
        assert!(lock.clone().try_lock_owned().is_err());
        release.send(()).unwrap();
        task.join().unwrap();
        assert!(lock.clone().try_lock_owned().is_ok());
    }
}
