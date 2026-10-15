//! P2P player-hosted hunts: the co-op transport module, host/join sessions and the P2P control loop.
//! Compiled in when this folder is present (`build.rs` sets `cfg(mystic_p2p)`); used only while the runtime
//! co-op switch below is on.
//!
//! This folder is private for now. The public repository leaves it out (`scripts/public-export`), and the
//! public launcher is dedicated-only. The rest of the launcher calls only the hooks below; the modules behind
//! them are internal to this folder.

use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::launch::{guard, logs, process};

mod control;
mod realm;
mod session;
mod transport;

// [2026-10-14] The realm host's Tauri commands (`realm.rs`) and their types: registered in `lib.rs`, P2P build only.
pub(crate) use realm::*;

/// Guard manifest roles of the co-op files, then of the core runtime files a player host verifies and reports
/// (the runtime DLL and its loader). Their names are feed data: the signed Guard manifest names them and the
/// signed runtime feed installs them.
const COOP_ROLES: [&str; 4] = [
    "TRANSPORT_MODULE",
    "ADMISSION_KEY",
    "INTERNAL_SERVER",
    "UDP_PROXY",
];
/// The Steam transport's own runtime. [2026-10-13] The ICE transport (ParadoxTransport.dll) has none: its manifest
/// leaves the role out and the module stands in for it (the backend then expects the module's hash for both).
const TRANSPORT_RUNTIME_ROLE: &str = "TRANSPORT_RUNTIME";
/// How long the control loop reuses the last switch result.
const SWITCH_RECHECK: Duration = Duration::from_secs(60);

/// The co-op files of this install: the transport module, the runtime it loads and the P2P admission key; and the
/// names the signed manifest gives the runtime DLL (`INTERNAL_SERVER`) and its loader (`UDP_PROXY`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CoopArtifacts {
    pub(crate) transport_module: String,
    pub(crate) transport_runtime: String,
    pub(crate) admission_key: String,
    pub(crate) internal_server: String,
    pub(crate) udp_proxy: String,
}

impl CoopArtifacts {
    fn from_names(names: Vec<String>, transport_runtime: Option<String>) -> Option<Self> {
        let [transport_module, admission_key, internal_server, udp_proxy]: [String; 4] =
            names.try_into().ok()?;
        Some(Self {
            transport_runtime: transport_runtime.unwrap_or_else(|| transport_module.clone()),
            transport_module,
            admission_key,
            internal_server,
            udp_proxy,
        })
    }

    /// The co-op files only: they join the core runtime set the game ticket already reports.
    pub(crate) fn names(&self) -> Vec<&str> {
        let mut names = vec![self.transport_module.as_str()];
        if self.transport_runtime != self.transport_module {
            names.push(&self.transport_runtime);
        }
        names.push(&self.admission_key);
        names
    }
}

struct SwitchState {
    checked_at: Option<Instant>,
    artifacts: Option<CoopArtifacts>,
    reason: String,
    play: Option<CoopArtifacts>,
}

fn switch_state() -> &'static Mutex<SwitchState> {
    static STATE: OnceLock<Mutex<SwitchState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(SwitchState {
            checked_at: None,
            artifacts: None,
            reason: "not checked yet".to_string(),
            play: None,
        })
    })
}

/// The runtime co-op switch. Co-op is on only when the server enables co-op hunts for this account (policy
/// `coopHunts`), DISABLE_COOP_TRANSPORT.flag is absent, and the signed Guard manifest of the account's channel
/// lists the transport module, its runtime, the admission key, the runtime DLL and its loader, each installed with
/// the signed size and hash.
/// Otherwise this launcher behaves like the dedicated-only build: no transport, no presence, Guard Lite.
fn evaluate_switch(
    app: &AppHandle,
    coop_hunts: bool,
    channel: &str,
    access_token: &str,
) -> Result<CoopArtifacts, String> {
    if !coop_hunts {
        return Err("co-op hunts are off on this server".to_string());
    }
    // [2026-10-13 realms S1] Co-op belongs to our network: a local realm's folder carries its own runtime files, and the
    // presence loop would report that folder's hashes to our backend. Only the official server and Paradox realms (our
    // feed) may switch co-op on.
    if !crate::servers::active_target(app).uses_official_feed() {
        return Err("the selected server is a local realm".to_string());
    }
    if coop_transport_disabled() {
        return Err("DISABLE_COOP_TRANSPORT.flag is present".to_string());
    }
    let names = guard::installed_artifacts_by_role(app, channel, access_token, &COOP_ROLES)?;
    let transport_runtime =
        if guard::manifest_lists_role(app, channel, access_token, TRANSPORT_RUNTIME_ROLE)? {
            guard::installed_artifacts_by_role(
                app,
                channel,
                access_token,
                &[TRANSPORT_RUNTIME_ROLE],
            )?
            .into_iter()
            .next()
        } else {
            None
        };
    CoopArtifacts::from_names(names, transport_runtime)
        .ok_or_else(|| "The signed Guard manifest lists an incomplete co-op set.".to_string())
}

/// Stores a switch result and logs every on/off change once.
fn record_switch(result: Result<CoopArtifacts, String>) -> Option<CoopArtifacts> {
    let Ok(mut state) = switch_state().lock() else {
        return None;
    };
    let (artifacts, reason) = match result {
        Ok(artifacts) => (Some(artifacts), "on".to_string()),
        Err(reason) => (None, reason),
    };
    if state.checked_at.is_none() || state.artifacts != artifacts || state.reason != reason {
        process::append_active_session_log(&match &artifacts {
            Some(_) => {
                "co-op switch: on (server enabled, signed co-op files installed)".to_string()
            }
            None => format!("co-op switch: off ({reason}); dedicated hunts only"),
        });
    }
    state.checked_at = Some(Instant::now());
    state.artifacts = artifacts.clone();
    state.reason = reason;
    artifacts
}

/// The co-op files while the switch is on (its last result), for sessions, presence and Guard.
pub(crate) fn coop_artifacts() -> Option<CoopArtifacts> {
    switch_state()
        .lock()
        .ok()
        .and_then(|state| state.artifacts.clone())
}

/// True while the switch is on: the co-op card shows it, and Guard runs the anti-cheat module's checks, if built in.
pub(crate) fn coop_active() -> bool {
    coop_artifacts().is_some()
}

/// The control loop's view: the last result, re-evaluated at most once a minute.
fn refresh_switch(app: &AppHandle) -> Option<CoopArtifacts> {
    if let Ok(state) = switch_state().lock() {
        if state
            .checked_at
            .is_some_and(|at| at.elapsed() < SWITCH_RECHECK)
        {
            return state.artifacts.clone();
        }
    }
    let result = crate::commands::auth::fetch_policy_cached(app).and_then(|policy| {
        let token = crate::commands::auth::current_access_token(app)?;
        evaluate_switch(app, policy.coop_hunts, &policy.channel, &token)
    });
    record_switch(result)
}

/// Play: re-reads the switch with the policy Play just fetched. The returned co-op file names join the runtime set
/// reported for the game ticket; `start_play_transport` starts the transport only when the switch is on.
pub fn prepare_play(
    app: &AppHandle,
    coop_hunts: bool,
    channel: &str,
    access_token: &str,
    session_dir: &Path,
) -> Vec<String> {
    let result = evaluate_switch(app, coop_hunts, channel, access_token);
    if let Err(reason) = &result {
        logs::append_launcher_log(session_dir, &format!("co-op off for this Play: {reason}"));
    }
    let artifacts = record_switch(result);
    if let Ok(mut state) = switch_state().lock() {
        state.play = artifacts.clone();
    }
    artifacts
        .map(|artifacts| artifacts.names().into_iter().map(String::from).collect())
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2PStartResult {
    pub session_id: String,
    pub generation: u32,
    pub role: &'static str,
    pub local_host: &'static str,
    pub local_port: u16,
    pub log_path: String,
}

/// Launcher start: host presence, the control channel and host/join sessions.
pub fn start(app: AppHandle) {
    control::start(app);
}

/// Settings → co-op card (`src/p2p/CoopCard.tsx`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2PHostSettingsView {
    pub available: bool,
    pub memory_notice: &'static str,
    pub transport_ready: bool,
    pub transport_status: String,
    pub transport_status_detail: String,
    pub transport_checked_at: Option<String>,
}

/// Registered only in a P2P build (`lib.rs`).
#[tauri::command]
pub fn native_get_p2p_host_settings(app: AppHandle) -> P2PHostSettingsView {
    control::get_settings(&app)
}

/// The running player-host server, which Guard protects alongside the client.
pub fn guarded_host_process_id() -> Option<u32> {
    session::guarded_host_process_id()
}

/// [2026-10-15] Whether this PC is hosting anything right now: a realm (any state but stopped) or a player-hosted
/// session. A launcher self-update restarts the launcher and ends them, so it waits (commands/updates.rs).
pub fn hosting_active() -> bool {
    realm::hosting_active() || !session::hosted_sessions().is_empty()
}

/// Testing override of the co-op switch: %LOCALAPPDATA%\MysticParadox\DISABLE_COOP_TRANSPORT.flag (same root as
/// the session logs) keeps co-op off. Delete the file to let the switch decide again.
fn coop_transport_disabled() -> bool {
    std::env::var("LOCALAPPDATA")
        .map(|local| {
            std::path::PathBuf::from(local)
                .join("MysticParadox")
                .join("DISABLE_COOP_TRANSPORT.flag")
                .is_file()
        })
        .unwrap_or(false)
}

/// Play: start the co-op transport before the game process exists, when the switch was on for this Play
/// (`prepare_play`).
///
/// Play is the only normal production boundary that starts the transport. The module keeps one runtime
/// for the complete Dauntless lifetime, so Ramsgate/Training keep relay access warm.
///
/// [2026-10-08] With co-op off, Play does not start the transport AT ALL. Ramsgate/Training are dedicated hubs
/// and never use it; P2P host/join refuse on their own when it is not loaded. Skipping only on failure was not
/// enough: a successful transport start injected an overlay module into this process, the WebView2 window died,
/// Tauri raised ExitRequested and shutdown_all() killed the game with 0xE302 under a windowless launcher.
pub fn start_play_transport(game_dir: &Path, session_dir: &Path) -> Result<(), String> {
    let play = switch_state()
        .lock()
        .ok()
        .and_then(|state| state.play.clone());
    let Some(artifacts) = play else {
        logs::append_launcher_log(
            session_dir,
            "co-op transport not started (co-op off); dedicated hubs and hunts only",
        );
        return Ok(());
    };
    let status = transport::initialize(&game_dir.join(&artifacts.transport_module))?;
    logs::append_launcher_log(
        session_dir,
        &format!(
            "co-op transport started (peerId={} relayReady={})",
            status
                .peer_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            status.networking_ready
        ),
    );
    Ok(())
}

/// [2026-10-14] A realm host start (`realm.rs`) loads the co-op transport module without a Play. The same module and
/// the same switch as Play's start; the caller logs. Refused when co-op is off.
pub(crate) fn start_host_transport(game_dir: &Path) -> Result<(), String> {
    let artifacts =
        coop_artifacts().ok_or_else(|| "co-op hunts are off on this server".to_string())?;
    transport::initialize(&game_dir.join(&artifacts.transport_module)).map(|_| ())
}

/// Releases the transport Play started once no game or host session needs it.
pub fn release_play_transport() {
    session::shutdown_transport_if_no_sessions();
}

/// Sign-out or account switch: stop every player-host and join session.
pub fn stop_all_sessions() -> usize {
    session::stop_all_sessions()
}

/// Launcher exit, first stage: no new presence, bootstrap or acknowledgement traffic.
pub fn stop_control_loop() {
    control::stop();
}

/// Launcher exit: wait (bounded) for owned sessions to unregister. True when none remain.
pub fn drain_sessions(timeout: Duration) -> bool {
    session::drain_sessions(timeout)
}

/// Launcher exit, after the sessions: stop the transport module's runtime and join its worker before
/// the module is unloaded.
pub fn shutdown_transport() {
    transport::shutdown();
}
