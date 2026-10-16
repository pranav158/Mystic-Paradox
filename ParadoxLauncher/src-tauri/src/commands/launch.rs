use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::auth::scope::AuthScope;
use crate::auth::{consent, session_epoch};
use crate::commands::auth::{
    fetch_policy_from, http_client_for, refresh_session_for, safe_api_error,
};
use crate::commands::updates::{install_runtime_update_for, runtime_install_lock};
use crate::install::{paths, verify};
use crate::launch::flags;
use crate::launch::logs::{self, SessionMetadata};
use crate::launch::process::{self, LaunchIdentity, LaunchSettings};
use crate::servers::network::NetworkRules;
use crate::servers::{self, ServerKind, ServerTarget};

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
    // [2026-10-14 realms] The realm this Play enters. Absent for the official server, so its request body is unchanged.
    // No invite code or host key is stored by the launcher yet, so a realm entry carries the name only.
    #[serde(skip_serializing_if = "Option::is_none")]
    realm: Option<RealmEntryRequest<'a>>,
    // [2026-10-15] This launcher's own build (official server and Paradox realms only). The backend flags a hash that is not
    // the build its Guard manifest pins (UNOFFICIAL_LAUNCHER, a monitor: Play is never refused for it). Self-reported, so a
    // modified launcher can lie; it catches self-built and repackaged launchers that do not.
    #[serde(skip_serializing_if = "Option::is_none")]
    launcher: Option<LauncherBuildReport<'a>>,
}

#[derive(Serialize)]
struct LauncherBuildReport<'a> {
    version: &'a str,
    sha256: &'a str,
}

#[derive(Serialize)]
struct RealmEntryRequest<'a> {
    name: &'a str,
    /// [2026-10-14 realms] The host key the player agreed to. The realm refuses the entry (REALM_OWNER_CHANGED) when its
    /// name now belongs to another key.
    #[serde(rename = "knownHostKey", skip_serializing_if = "Option::is_none")]
    known_host_key: Option<&'a str>,
}

/// [2026-10-14 realms] Play's two refusals that the UI answers with a dialog instead of a sentence: the realm's host
/// changed (`REALM_OWNER_CHANGED`), or the realm has no host key yet (`REALM_HOST_KEY_REQUIRED`: the player confirms the host
/// first). The UI matches these exact tokens (src/servers/RealmTrust.tsx).
pub(crate) const REALM_OWNER_CHANGED: &str = "REALM_OWNER_CHANGED";
pub(crate) const REALM_HOST_KEY_REQUIRED: &str = "REALM_HOST_KEY_REQUIRED";
/// [2026-10-15] Play asked the host for approval (an invite-only realm, no invite): the request is sent and the player waits. Not a
/// failure; the UI matches this token and says so (src/screens/dashboard/HomeTab.tsx).
pub(crate) const REALM_JOIN_REQUESTED: &str = "REALM_JOIN_REQUESTED";

/// [2026-10-14 realms] Play's host check, before anything is verified or signed in: a Paradox realm is entered only with the
/// host key the player agreed to. Pure, so the rule is tested without a window.
pub(crate) fn realm_host_gate(
    kind: ServerKind,
    host_public_key: Option<&str>,
) -> Result<(), String> {
    if kind == ServerKind::ParadoxRealm && host_public_key.is_none() {
        return Err(REALM_HOST_KEY_REQUIRED.to_string());
    }
    Ok(())
}

/// [2026-10-16] A realm in solo mode (join policy SOLO): only its host enters. Shown for Play and for a join request.
pub(crate) const REALM_SOLO_MESSAGE: &str =
    "This realm is in solo mode: its host is playing alone right now.";

/// [2026-10-14 realms] The game-session refusal of a realm entry, as the realm's own sentence. Only the realm codes
/// are read here; anything else is `None`, so the caller keeps its existing message.
fn realm_refusal_message(body: &[u8]) -> Option<String> {
    let envelope: serde_json::Value = serde_json::from_slice(body).ok()?;
    let code = envelope["error"]["code"].as_str()?;
    let backend_message = envelope["error"]["message"]
        .as_str()
        .filter(|message| !message.is_empty());
    let message = match code {
        "REALM_OFFLINE" => "The realm host is offline.",
        "REALM_SOLO" => REALM_SOLO_MESSAGE,
        "REALM_BANNED" => "You cannot join this realm.",
        REALM_OWNER_CHANGED => REALM_OWNER_CHANGED,
        REALM_JOIN_REQUESTED => REALM_JOIN_REQUESTED,
        // [2026-10-15] The backend asks for a request now; this sentence is the fallback for a server that still refuses outright.
        "REALM_INVITE_REQUIRED" => {
            "This realm is invite-only. Ask its host to approve you, or use an invite code."
        }
        "REALMS_DISABLED" => "Realms are not available on this server.",
        _ if code.starts_with("REALM") => return backend_message.map(str::to_string),
        _ => return None,
    };
    Some(message.to_string())
}

/// The game-session refusal: a realm's codes read as the realm's sentences, every other code exactly as before
/// (`safe_api_error`). The body is read once and the response rebuilt from it for `safe_api_error`, which takes a response.
fn ticket_refusal(response: reqwest::blocking::Response, fallback: &str) -> String {
    let status = response.status();
    let body = response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    // [2026-10-14] A deactivated account (a deletion was requested) cannot play: the sentence names the day it is deleted.
    if let Some(message) = crate::commands::account::deactivated_message(&body) {
        return message;
    }
    if let Some(message) = realm_refusal_message(&body) {
        return message;
    }
    match tauri::http::Response::builder().status(status).body(body) {
        Ok(rebuilt) => safe_api_error(reqwest::blocking::Response::from(rebuilt), fallback),
        Err(_) => fallback.to_string(),
    }
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
///
/// [2026-10-13 realms S5] Every network step follows the SELECTED server (`ServerKind::network_rules`): the official
/// server and Paradox realms use the official backend, session and signed feed, as always; a local server uses its own
/// backend and its own saved session (sign-in, policy, status, runtime version and the game ticket all go there, and
/// the official account is never involved), and skips our feed, Guard and the co-op transport.
/// `expected_channel` is the channel value the TS side fetched for this exact Play attempt (see HomeTab.tsx's
/// `handlePlay`). Re-fetching policy here and comparing closes a race: TS's policy fetch and
/// this function's fetch happen moments apart, so an admin could revoke Tester in between —
/// without this check, the already-installed beta/dev runtime would still launch even though
/// the account is no longer entitled to it.
#[tauri::command]
pub async fn secure_launch(app: AppHandle, expected_channel: String) -> Result<(), String> {
    // Reject duplicate Play before any update or authentication work begins. Move the owned
    // guard into the blocking task: cancelling the IPC future must not unlock a running spawn.
    let launch_guard = secure_launch_lock()
        .clone()
        .try_lock_owned()
        .map_err(|_| "A launch is already being prepared. Please wait a moment.".to_string())?;
    // [2026-10-13 realms S1] The server to play is resolved ONCE, here, under the launch lock, and carried through the
    // whole launch (runtime update, install check, ticket, spawn). Changing the selected server or its folder takes
    // the same lock (`try_hold_launch_lock`), so no change can land between this resolution and the spawn.
    let target = servers::active_target(&app);
    // [2026-10-13 realms S5] The scope fixes the backend and the saved session of the whole launch. A local server is
    // contacted only after its LOCAL SERVER WARNING was accepted.
    let scope = AuthScope::from_entry(&target.server)?;
    let rules = target.kind().network_rules();
    if rules.warning_required && !consent::is_accepted(&app, &target.server.id) {
        return Err(consent::NOT_ACCEPTED.to_string());
    }
    // [2026-10-14 realms] A Paradox realm is entered only with the host the player agreed to (the UI asks first).
    realm_host_gate(target.kind(), target.server.host_public_key.as_deref())?;
    let account_epoch = session_epoch::current(scope.key());
    let launch_session_id = logs::generate_launch_session_id();
    let session_dir = logs::session_dir(&app, &launch_session_id)?;
    let started = std::time::Instant::now();
    logs::append_launcher_log(
        &session_dir,
        "play preparation started; verifying signed runtime",
    );
    if target.server.id != servers::OFFICIAL_ID {
        // The kind only: a realm or local server's name and address stay out of the log.
        logs::append_launcher_log(
            &session_dir,
            &format!("server: {} (its install folder)", target.kind().label()),
        );
    }
    // Native Play owns runtime repair and verification; the WebView is not a security boundary. Only our signed feed
    // is used, and only for the folders it serves: a local server's files are its own, so the launcher neither
    // installs nor checks them, and asks that server for the release it approves instead (after sign-in, below).
    let runtime_manifest_version = if rules.runtime_feed {
        Some(
            install_runtime_update_for(app.clone(), expected_channel.clone(), target.clone())
                .await
                .and_then(|runtime| {
                    runtime.version.ok_or_else(|| {
                        "No approved runtime release is available for Play.".to_string()
                    })
                })
                .map_err(|error| {
                    logs::append_launcher_log(
                        &session_dir,
                        &format!("runtime preparation failed: {error}"),
                    );
                    error
                })?,
        )
    } else {
        logs::append_launcher_log(
            &session_dir,
            "runtime: this server's own files; the launcher does not install or check them",
        );
        None
    };
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
            scope,
            expected_channel,
            runtime_manifest_version,
            account_epoch,
            launch_session_id,
            &session_dir,
            &target,
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

/// The launch lock, for a change to the selected server or its folder: while it is held no Play can start, and it
/// is refused (`None`) while a Play is being prepared. Play holds the same lock from its first check to the spawn.
pub(crate) fn try_hold_launch_lock() -> Option<tokio::sync::OwnedMutexGuard<()>> {
    secure_launch_lock().clone().try_lock_owned().ok()
}

/// The diagnostics profile the game runs with. Our servers choose it centrally (a tester or admin account gets the
/// development profile only when the operator enabled it); a local server is not an authority over this PC's runtime,
/// so its policy never selects anything but the production profile.
fn runtime_profile_for(
    rules: NetworkRules,
    diagnostics_profile: &str,
) -> Result<&'static str, String> {
    if !rules.server_diagnostics {
        return Ok("production");
    }
    match diagnostics_profile {
        "PRODUCTION" => Ok("production"),
        "DEVELOPMENT" => Ok("development"),
        _ => Err("The server returned an invalid diagnostics policy.".to_string()),
    }
}

/// The diagnostic features the server may switch on in the game folder. A local server may switch none on (and the
/// launcher removes the ones it created before).
fn managed_features_for(rules: NetworkRules, requested: &[String]) -> Vec<String> {
    if rules.server_diagnostics {
        requested.to_vec()
    } else {
        Vec::new()
    }
}

/// Same shape as the backend's `SAFE_VERSION` (`runtimeAuthorization.ts`): `1.2.3`, optionally `-pre` or `+build`.
fn is_runtime_version(version: &str) -> bool {
    let (core, suffix) = match version.find(['-', '+']) {
        Some(at) => (&version[..at], Some(&version[at + 1..])),
        None => (version, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    version.len() <= 64
        && numbers.len() == 3
        && numbers
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|text| {
            !text.is_empty()
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

/// The runtime release a LOCAL server approves for `channel`, read from that server's own manifest endpoint. The
/// launcher does not install or verify anything from it (a local server's runtime files are the player's own); it
/// only names the release in the ticket request, and the server compares its own hashes against the files reported.
fn fetch_own_runtime_version(
    scope: &AuthScope,
    channel: &str,
    access_token: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }
    if !matches!(channel, "stable" | "beta" | "dev") {
        return Err("Invalid runtime channel.".to_string());
    }
    let response = http_client_for(scope)?
        .get(format!(
            "{}/launcher/v1/runtime/{channel}/windows-x86_64",
            scope.base_url()
        ))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Couldn't reach this server.".to_string())?;
    if matches!(response.status().as_u16(), 204 | 404) {
        return Err(format!(
            "This server has not published a runtime release for the {channel} channel, so it cannot approve Play."
        ));
    }
    if !response.status().is_success() {
        return Err(safe_api_error(
            response,
            "Couldn't read this server's runtime release.",
        ));
    }
    let manifest: Manifest = response
        .json()
        .map_err(|_| "This server returned an invalid runtime release.".to_string())?;
    if !is_runtime_version(&manifest.version) {
        return Err("This server returned an invalid runtime release.".to_string());
    }
    Ok(manifest.version)
}

#[allow(clippy::too_many_arguments)]
fn secure_launch_after_runtime(
    app: AppHandle,
    scope: AuthScope,
    expected_channel: String,
    runtime_manifest_version: Option<String>,
    account_epoch: u64,
    launch_session_id: String,
    session_dir: &std::path::Path,
    target: &ServerTarget,
) -> Result<(), String> {
    let rules = target.kind().network_rules();
    session_epoch::check(account_epoch, session_epoch::current(scope.key()))?;
    // The selected server's own game executable (the official server's is the saved install path, as before).
    // A folder refused for being the official install is never launched from.
    if let Some(problem) = &target.folder_problem {
        return Err(problem.clone());
    }
    let exe_path = target
        .exe_path
        .clone()
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
    // This scope's own session: the official one for the official server and realms, the server's own for a local one.
    let refreshed = refresh_session_for(&app, &scope)?;

    // Fetch policy fresh, right before spawning — used for flag reconciliation AND the
    // channel-consistency check above. Fails closed: if we can't reach the policy endpoint we
    // can't confirm current entitlement, so we don't launch. This doesn't cost real
    // availability — the ticket request a few lines below needs the same backend anyway, so a
    // backend outage was going to fail Play regardless.
    let policy = fetch_policy_from(&scope, &refreshed.access_token).map_err(|_| {
        "Couldn't verify your account access. Check your connection and try again.".to_string()
    })?;
    if policy.channel != expected_channel {
        return Err(
            "Your account access changed. Press Play again to pick up the new settings."
                .to_string(),
        );
    }
    // The co-op switch for this Play: with co-op on, the co-op files join the reported runtime set and the
    // transport starts before the game (process::spawn_game). Co-op belongs to our network: for a local server the
    // switch is told "off" (which also clears any earlier Play's result, so no transport starts) and the module is
    // never handed the local server's token.
    #[cfg(mystic_p2p)]
    for name in crate::p2p::prepare_play(
        &app,
        rules.coop && policy.coop_hunts,
        &policy.channel,
        if rules.coop {
            &refreshed.access_token
        } else {
            ""
        },
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
    // is logged but doesn't block Play. A local server cannot switch any on.
    if let Err(error) = flags::reconcile(
        &game_dir,
        &managed_features_for(rules, &policy.managed_feature_ids),
    ) {
        logs::append_launcher_log(session_dir, &format!("flag reconcile failed: {error}"));
    }

    let client = http_client_for(&scope)?;
    let base = scope.base_url();

    let status_response = client
        .get(format!("{base}/launcher/v1/status"))
        .send()
        .map_err(|_| {
            scope
                .pick(
                    "Couldn't reach the Mystic Paradox game server.",
                    "Couldn't reach this server.",
                )
                .to_string()
        })?;
    if !status_response.status().is_success() {
        return Err(safe_api_error(
            status_response,
            "Couldn't read the supported game build.",
        ));
    }
    let status: ServerStatus = status_response
        .json()
        .map_err(|_| "The game server returned an invalid build response.".to_string())?;

    let runtime_profile = runtime_profile_for(rules, &policy.diagnostics_profile)?;

    // Our feed named the release for the official server and realms; a local server names its own.
    let runtime_manifest_version = match runtime_manifest_version {
        Some(version) => version,
        None => fetch_own_runtime_version(&scope, &expected_channel, &refreshed.access_token)?,
    };

    // [2026-10-14 realms] Play on a Paradox realm names the realm it enters (the official server sends nothing extra).
    let realm_name = target
        .server
        .realm_name
        .clone()
        .filter(|_| target.kind() == ServerKind::ParadoxRealm);
    // [2026-10-15] The installed launcher.exe, hashed whole (the file Guard's LAUNCHER role pins); a local server gets nothing.
    let launcher_sha256 = if target.kind() == ServerKind::Local {
        None
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|path| verify::hash_file_sha256(&path).ok())
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
            realm: realm_name.as_deref().map(|name| RealmEntryRequest {
                name,
                known_host_key: target.server.host_public_key.as_deref(),
            }),
            launcher: launcher_sha256
                .as_deref()
                .map(|sha256| LauncherBuildReport {
                    version: env!("CARGO_PKG_VERSION"),
                    sha256,
                }),
        })
        .send()
        .map_err(|_| "Couldn't request a game session.".to_string())?;
    if !ticket_response.status().is_success() {
        return Err(ticket_refusal(
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
        auth_scope: scope.key().to_string(),
        exit_code: None,
        exited_at: None,
    };
    logs::write_metadata(session_dir, &metadata);

    // Hold the account fence through process registration. A concurrent logout either cancels
    // this launch here or terminates its registered Job Object after spawn has finished.
    let epoch = session_epoch::lock(scope.key());
    session_epoch::check(account_epoch, *epoch)?;
    let spawned = process::spawn_game(
        &app,
        &exe_path,
        &ticket.exchange_code,
        &LaunchIdentity {
            account_id: refreshed.account.user_id,
            display_name: refreshed.account.display_name,
        },
        &LaunchSettings {
            runtime_profile,
            backend_url: target.backend_url(),
            scope_key: scope.key(),
        },
        session_dir,
        metadata,
    );
    // [2026-10-14 realms] A realm game keeps its presence alive until it exits (the exit hook is in launch/process.rs).
    if spawned.is_ok() {
        if let Some(name) = &realm_name {
            servers::realm_presence::start(&app, name);
        }
    }
    spawned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_of(kind: crate::servers::ServerKind) -> NetworkRules {
        kind.network_rules()
    }

    #[test]
    fn only_our_servers_choose_the_diagnostics_profile() {
        use crate::servers::ServerKind::{Local, Official, ParadoxRealm};
        for kind in [Official, ParadoxRealm] {
            assert_eq!(
                runtime_profile_for(rules_of(kind), "PRODUCTION"),
                Ok("production")
            );
            assert_eq!(
                runtime_profile_for(rules_of(kind), "DEVELOPMENT"),
                Ok("development")
            );
            assert!(runtime_profile_for(rules_of(kind), "VERBOSE").is_err());
        }
        // A local server's policy cannot put this PC's runtime into the development profile, nor break Play by
        // sending garbage.
        for profile in ["PRODUCTION", "DEVELOPMENT", "VERBOSE", ""] {
            assert_eq!(
                runtime_profile_for(rules_of(Local), profile),
                Ok("production")
            );
        }
    }

    #[test]
    fn only_our_servers_switch_diagnostic_flags_on() {
        use crate::servers::ServerKind::{Local, Official, ParadoxRealm};
        let requested = vec!["diagnostics.verbose".to_string()];
        assert_eq!(
            managed_features_for(rules_of(Official), &requested),
            requested
        );
        assert_eq!(
            managed_features_for(rules_of(ParadoxRealm), &requested),
            requested
        );
        assert!(managed_features_for(rules_of(Local), &requested).is_empty());
    }

    #[test]
    fn runtime_versions_have_the_backends_shape() {
        for good in [
            "0.2.131",
            "1.0.0",
            "10.20.30",
            "1.2.3-beta.1",
            "1.2.3+build-7",
        ] {
            assert!(is_runtime_version(good), "{good}");
        }
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "a.b.c",
            "1.2.3-",
            "1.2.3 beta",
            "1.2.3/../x",
            "v1.2.3",
            "1..3",
        ] {
            assert!(!is_runtime_version(bad), "{bad:?}");
        }
        assert!(!is_runtime_version(&format!("1.2.3-{}", "x".repeat(80))));
    }

    #[test]
    fn a_local_server_names_its_own_runtime_release_from_its_own_backend() {
        use crate::commands::test_support::mock_backend;
        let (base, requests) = mock_backend(vec![(
            200,
            r#"{"version":"0.2.131","targetChangelist":647472,"sha256":"x"}"#.to_string(),
        )]);
        let scope = AuthScope::Local {
            id: "s-launch-version".to_string(),
            base_url: base,
        };
        let version =
            fetch_own_runtime_version(&scope, "stable", "the-local-access-token").unwrap();
        assert_eq!(version, "0.2.131");
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/launcher/v1/runtime/stable/windows-x86_64");
        assert!(request.text.contains("bearer the-local-access-token"));
    }

    #[test]
    fn a_local_server_without_a_published_release_says_so_and_a_bad_one_is_refused() {
        use crate::commands::test_support::mock_backend;
        let (base, requests) = mock_backend(vec![
            (404, "{}".to_string()),
            (200, r#"{"version":"../../evil"}"#.to_string()),
        ]);
        let scope = AuthScope::Local {
            id: "s-launch-noversion".to_string(),
            base_url: base,
        };
        let error = fetch_own_runtime_version(&scope, "beta", "t").unwrap_err();
        assert!(
            error.contains("has not published a runtime release for the beta channel"),
            "{error}"
        );
        requests.recv().unwrap();
        assert!(fetch_own_runtime_version(&scope, "stable", "t").is_err());
        assert!(fetch_own_runtime_version(&scope, "../x", "t").is_err());
    }

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

    fn ticket_body(realm: Option<(&str, Option<&str>)>) -> serde_json::Value {
        serde_json::to_value(GameSessionRequest {
            build_changelist: 647472,
            executable_sha256: "00",
            runtime_channel: "stable",
            runtime_manifest_version: "0.2.131",
            runtime_artifacts: &[],
            realm: realm.map(|(name, known_host_key)| RealmEntryRequest {
                name,
                known_host_key,
            }),
            launcher: None,
        })
        .unwrap()
    }

    #[test]
    fn the_ticket_reports_this_launcher_build_when_it_could_hash_itself() {
        let body = serde_json::to_value(GameSessionRequest {
            build_changelist: 647472,
            executable_sha256: "00",
            runtime_channel: "stable",
            runtime_manifest_version: "0.2.137",
            runtime_artifacts: &[],
            realm: None,
            launcher: Some(LauncherBuildReport {
                version: "0.1.65",
                sha256: "ab",
            }),
        })
        .unwrap();
        assert_eq!(
            body["launcher"],
            serde_json::json!({ "version": "0.1.65", "sha256": "ab" })
        );
        assert_eq!(body.as_object().unwrap().len(), 6);
    }

    #[test]
    fn the_official_ticket_body_is_unchanged_and_a_realm_sends_the_host_it_knows() {
        let official = ticket_body(None);
        assert!(official.get("realm").is_none());
        // The five fields the official request always carried, and no `realm`.
        assert_eq!(official.as_object().unwrap().len(), 5);
        // A realm names itself and, once the player agreed to its host, the key they agreed to (knownHostKey).
        let realm = ticket_body(Some(("tempest", None)));
        assert_eq!(realm["realm"], serde_json::json!({ "name": "tempest" }));
        let keyed = ticket_body(Some(("tempest", Some("KEY-0123456789abcdef"))));
        assert_eq!(
            keyed["realm"],
            serde_json::json!({ "name": "tempest", "knownHostKey": "KEY-0123456789abcdef" })
        );
    }

    #[test]
    fn play_refuses_a_realm_with_no_host_key_and_passes_everything_else() {
        assert_eq!(
            realm_host_gate(ServerKind::ParadoxRealm, None),
            Err(REALM_HOST_KEY_REQUIRED.to_string())
        );
        assert!(realm_host_gate(ServerKind::ParadoxRealm, Some("KEY-0123456789abcdef")).is_ok());
        assert!(realm_host_gate(ServerKind::Official, None).is_ok());
        assert!(realm_host_gate(ServerKind::Local, None).is_ok());
    }

    #[test]
    fn realm_refusals_read_as_the_realm_sentences() {
        let refusal = |code: &str, message: &str| {
            serde_json::json!({ "error": { "code": code, "message": message, "requestId": "r" } })
                .to_string()
                .into_bytes()
        };
        assert_eq!(
            realm_refusal_message(&refusal("REALM_OFFLINE", "x")).as_deref(),
            Some("The realm host is offline.")
        );
        assert_eq!(
            realm_refusal_message(&refusal("REALM_SOLO", "x")).as_deref(),
            Some(REALM_SOLO_MESSAGE)
        );
        // The owner change is a token the UI turns into its warning dialog, not a sentence.
        assert_eq!(
            realm_refusal_message(&refusal("REALM_OWNER_CHANGED", "x")).as_deref(),
            Some(REALM_OWNER_CHANGED)
        );
        assert_eq!(
            realm_refusal_message(&refusal("REALM_INVITE_EXPIRED", "That invite has expired."))
                .as_deref(),
            Some("That invite has expired.")
        );
        // [2026-10-15] A join request is a token (the UI shows it as information); a full list is the backend's own sentence.
        assert_eq!(
            realm_refusal_message(&refusal(
                "REALM_JOIN_REQUESTED",
                "Request sent to the host."
            ))
            .as_deref(),
            Some(REALM_JOIN_REQUESTED)
        );
        assert_eq!(
            realm_refusal_message(&refusal("REALM_REQUESTS_FULL", "Too many requests.")).as_deref(),
            Some("Too many requests.")
        );
        // Not a realm code: the caller keeps safe_api_error's message.
        assert_eq!(realm_refusal_message(&refusal("GUARD_REQUIRED", "x")), None);
        assert_eq!(realm_refusal_message(b"not json"), None);
    }
}
