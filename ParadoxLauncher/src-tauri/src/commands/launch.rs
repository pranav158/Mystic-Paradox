use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::commands::auth::{
    api_base_url, fetch_policy, http_client, refresh_native_session, safe_api_error,
};
use crate::commands::updates::RUNTIME_DLL_NAME;
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
    // Exact installed DLL hash; the backend compares it with the signed manifest for the
    // server-derived account channel and stores it in the one-time exchange-code record.
    runtime_sha256: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionResponse {
    exchange_code: String,
}

#[tauri::command]
pub fn is_game_running() -> Result<bool, String> {
    process::is_game_running()
}

/// Security boundary for Play: the WebView supplies no token, identity, build
/// hash, or exchange code. Rust loads the DPAPI/Credential Manager refresh
/// token, rotates it, verifies the install, requests the one-time game ticket,
/// and spawns immediately. The ticket never becomes JavaScript-visible.
/// `expected_channel` is the channel value the TS side already fetched and used to
/// check/install the runtime DLL for this exact Play attempt (see HomeTab.tsx's
/// `handlePlay`). Re-fetching policy here and comparing closes a race: TS's policy fetch and
/// this function's fetch happen moments apart, so an admin could revoke Tester in between —
/// without this check, the already-installed beta/dev runtime would still launch even though
/// the account is no longer entitled to it.
#[tauri::command]
pub fn secure_launch(app: AppHandle, expected_channel: String) -> Result<(), String> {
    static SECURE_LAUNCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = SECURE_LAUNCH_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "A launch is already being prepared. Please wait a moment.".to_string())?;

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
    let runtime_sha256 = verify::hash_file_sha256(&game_dir.join(RUNTIME_DLL_NAME))?;
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

    // One launch-session id per Play operation, with its own log folder — created up front so
    // even a failure later in this function (server unreachable, ticket denied, etc.) leaves a
    // record of the attempt.
    let launch_session_id = logs::generate_launch_session_id();
    let session_dir = logs::session_dir(&app, &launch_session_id)?;
    logs::append_launcher_log(
        &session_dir,
        &format!("play requested for {}", refreshed.account.display_name),
    );

    // Diagnostic flags only (VERBOSE_DIAG.flag) — not the actual access control (that's
    // fully server-side; see the channel check above and testerFeatures.ts). A failure here
    // is logged but doesn't block Play.
    if let Err(error) = flags::reconcile(&game_dir, &policy.managed_feature_ids) {
        logs::append_launcher_log(&session_dir, &format!("flag reconcile failed: {error}"));
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

    let ticket_response = client
        .post(format!("{base}/launcher/v1/game-sessions"))
        .bearer_auth(&refreshed.access_token)
        .json(&GameSessionRequest {
            build_changelist: status.supported_build_changelist,
            executable_sha256: &executable_sha256,
            runtime_channel: &expected_channel,
            runtime_sha256: &runtime_sha256,
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
    logs::write_metadata(&session_dir, &metadata);

    process::spawn_game(
        &exe_path,
        &ticket.exchange_code,
        &LaunchIdentity {
            account_id: refreshed.account.user_id,
            display_name: refreshed.account.display_name,
        },
        &session_dir,
        metadata,
    )
}
