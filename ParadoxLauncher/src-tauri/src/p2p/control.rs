use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::GetSystemTimes;

use super::P2PHostSettingsView;
use crate::commands::auth::{api_base_url, refresh_native_session};
use crate::install::{paths, verify};
use crate::launch::logs::iso8601_now as iso_now;
use crate::launch::{guard_loop, process};
use crate::p2p::session as p2p_session;
use crate::p2p::transport;

const PRESENCE_INTERVAL: Duration = Duration::from_secs(20);
const OBSERVATION_INTERVAL: Duration = Duration::from_secs(5);
const CONTROL_WAIT_MS: u64 = 5_000;
const FALLBACK_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Set while a protected process runs without a backend-verified Guard, so the presence log says
/// so once rather than every 20 s.
static GUARD_UNVERIFIED_LOGGED: AtomicBool = AtomicBool::new(false);

/// [2026-10-16] Control sequences are per account, so the cursor is kept per account id. Launchers up to 0.1.71 kept one
/// `controlCursor` per PC: a second account on the PC polled after the first account's 103 while its own JOIN_RENDEZVOUS was
/// sequence 1, never saw it, and its realm entry expired ("matchmaking failed", 16 Oct 06:10 UTC). That old field is not read
/// (nobody can tell which account wrote it) and is gone from the file at the next save.
#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct P2PHostSettings {
    #[serde(default)]
    control_cursors: HashMap<String, u64>,
}

/// [2026-10-16] The last control sequence this PC handled for `account_id`; 0 for an account it has not served.
fn cursor_for(settings: &P2PHostSettings, account_id: &str) -> u64 {
    settings
        .control_cursors
        .get(account_id)
        .copied()
        .unwrap_or(0)
}

/// [2026-10-16] Moves `account_id`'s cursor to `sequence` (never back).
fn advance_cursor(settings: &mut P2PHostSettings, account_id: &str, sequence: u64) {
    let cursor = settings
        .control_cursors
        .entry(account_id.to_string())
        .or_insert(0);
    *cursor = (*cursor).max(sequence);
}

#[derive(Clone, Default)]
struct TransportObservation {
    ready: bool,
    peer_id: Option<String>,
    detail: String,
    checked_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactHashes {
    game_exe: String,
    internal_server: String,
    winmm_proxy: String,
    transport_module: String,
    transport_runtime: String,
    admission_public_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuardSessionPresence {
    role: String,
    guard_session_id: String,
    guard_sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostPresence {
    preflight_only: bool,
    consent_to_host: bool,
    observed_at: String,
    free_physical_memory_mi_b: u64,
    commit_headroom_mi_b: u64,
    logical_cpu_count: usize,
    cpu_load_percent: f64,
    power_saver: bool,
    runtime_supported: bool,
    transport_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_id: Option<String>,
    backend_rtt_ms: f64,
    worst_peer_rtt_ms: f64,
    jitter_ms: f64,
    packet_loss_percent: f64,
    artifacts: ArtifactHashes,
    launcher_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    guard_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    guard_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    guard_sessions: Vec<GuardSessionPresence>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    guard_required_roles: Vec<String>,
    /// [2026-10-14] The realm hub and realm hunts this launcher hosts (`realmHostSessions`).
    #[serde(skip_serializing_if = "Option::is_none")]
    realm_host_sessions: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostPresenceResponse {
    artifacts_verified: bool,
    #[serde(default)]
    guard_verified: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlMessage {
    message_id: String,
    sequence: u64,
    message_type: String,
    session_id: Option<String>,
    generation: Option<u32>,
    payload: Value,
    expires_at: String,
    /// [2026-10-16] Set when a launcher already handled it (this one before a restart, or another PC signed in to the same
    /// account): a poll from 0 lists those too while they live (10 min), and they must not run twice.
    #[serde(default)]
    acknowledged_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlEnvelope {
    messages: Vec<ControlMessage>,
    /// [2026-10-16] The backend found the cursor beyond this account's last message and answered from the start with the
    /// messages not acknowledged yet (a launcher up to 0.1.71 on a PC shared by accounts).
    #[serde(default)]
    stale_cursor: bool,
}

fn runner_started() -> &'static Mutex<bool> {
    static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();
    STARTED.get_or_init(|| Mutex::new(false))
}

/// Held for a whole presence report (the periodic cycle and the realm host's report before a hub start), so a report
/// built before the transport was loaded can never be sent after the one that follows the load.
fn presence_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn transport_observation() -> &'static Mutex<TransportObservation> {
    static OBSERVATION: OnceLock<Mutex<TransportObservation>> = OnceLock::new();
    OBSERVATION.get_or_init(|| Mutex::new(TransportObservation::default()))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Couldn't resolve launcher settings storage.".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Couldn't create launcher settings storage.".to_string())?;
    Ok(directory.join("p2p-host-settings.json"))
}

fn load_settings(app: &AppHandle) -> P2PHostSettings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &P2PHostSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|_| "Couldn't encode launcher host settings.".to_string())?;
    std::fs::write(&temporary, contents)
        .map_err(|_| "Couldn't save launcher host settings.".to_string())?;
    std::fs::rename(&temporary, &path)
        .map_err(|_| "Couldn't commit launcher host settings.".to_string())
}

pub fn get_settings(_app: &AppHandle) -> P2PHostSettingsView {
    let observed = transport_observation()
        .lock()
        .map(|state| state.clone())
        .unwrap_or_default();
    P2PHostSettingsView {
        // The control loop's last switch result: this command runs on the UI thread and never waits on I/O.
        available: super::coop_active(),
        memory_notice: "Hosting starts an additional headless Dauntless server on this PC. Expect several GB of RAM, CPU, and upstream bandwidth while a hunt is active.",
        transport_ready: observed.ready,
        transport_status: if observed.ready { "READY" } else if observed.checked_at.is_some() { "UNAVAILABLE" } else { "DETECTING" }.to_string(),
        transport_status_detail: if observed.detail.is_empty() { "The co-op connection is checked automatically.".to_string() } else { observed.detail },
        transport_checked_at: observed.checked_at,
    }
}

fn filetime(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn cpu_load_percent() -> f64 {
    unsafe {
        let mut idle_a = std::mem::zeroed();
        let mut kernel_a = std::mem::zeroed();
        let mut user_a = std::mem::zeroed();
        if GetSystemTimes(&mut idle_a, &mut kernel_a, &mut user_a) == 0 {
            return 100.0;
        }
        std::thread::sleep(Duration::from_millis(200));
        let mut idle_b = std::mem::zeroed();
        let mut kernel_b = std::mem::zeroed();
        let mut user_b = std::mem::zeroed();
        if GetSystemTimes(&mut idle_b, &mut kernel_b, &mut user_b) == 0 {
            return 100.0;
        }
        let idle = filetime(idle_b).saturating_sub(filetime(idle_a));
        let total = filetime(kernel_b)
            .saturating_sub(filetime(kernel_a))
            .saturating_add(filetime(user_b).saturating_sub(filetime(user_a)));
        if total == 0 {
            100.0
        } else {
            100.0 * (total.saturating_sub(idle)) as f64 / total as f64
        }
    }
}

pub(super) fn memory_status() -> (u64, u64) {
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return (0, 0);
        }
        (
            status.ullAvailPhys / 1_048_576,
            status.ullAvailPageFile / 1_048_576,
        )
    }
}

fn power_saver() -> bool {
    unsafe {
        let mut status: SYSTEM_POWER_STATUS = std::mem::zeroed();
        GetSystemPowerStatus(&mut status) != 0 && status.SystemStatusFlag != 0
    }
}

fn runtime_artifacts(app: &AppHandle) -> (ArtifactHashes, bool) {
    let fallback = || ArtifactHashes {
        game_exe: FALLBACK_HASH.to_string(),
        internal_server: FALLBACK_HASH.to_string(),
        winmm_proxy: FALLBACK_HASH.to_string(),
        transport_module: FALLBACK_HASH.to_string(),
        transport_runtime: FALLBACK_HASH.to_string(),
        admission_public_key: FALLBACK_HASH.to_string(),
    };
    let Some(coop) = super::coop_artifacts() else {
        return (fallback(), false);
    };
    let Some(game_exe) = paths::load_saved_exe_path(app) else {
        return (fallback(), false);
    };
    let Ok(game_dir) = paths::game_dir(&game_exe) else {
        return (fallback(), false);
    };
    let candidates = [
        game_exe,
        game_dir.join(&coop.internal_server),
        game_dir.join(&coop.udp_proxy),
        game_dir.join(&coop.transport_module),
        game_dir.join(&coop.transport_runtime),
        game_dir.join(&coop.admission_key),
    ];
    let mut hashes = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        match verify::hash_file_sha256_cached(candidate) {
            Ok(hash) => hashes.push(hash),
            Err(_) => return (fallback(), false),
        }
    }
    (
        ArtifactHashes {
            game_exe: hashes[0].clone(),
            internal_server: hashes[1].clone(),
            winmm_proxy: hashes[2].clone(),
            transport_module: hashes[3].clone(),
            transport_runtime: hashes[4].clone(),
            admission_public_key: hashes[5].clone(),
        },
        true,
    )
}

fn store_transport_observation(
    ready: bool,
    peer_id: Option<String>,
    detail: impl Into<String>,
) -> TransportObservation {
    let observation = TransportObservation {
        ready,
        peer_id,
        detail: detail.into(),
        checked_at: Some(iso_now()),
    };
    if let Ok(mut current) = transport_observation().lock() {
        *current = observation.clone();
    }
    observation
}

/// The co-op connection is ready when the module is loaded, its networking is up and it has a peer id. The module's
/// identity exists from its load, so a report sent right after the load already says ready.
fn transport_is_ready(status: &transport::TransportStatus) -> bool {
    status.loaded && status.networking_ready && status.peer_id.is_some()
}

fn transport_preflight() -> TransportObservation {
    // Presence must never start the transport. Play starts it exactly once; this path only inspects
    // the already-loaded module, so a launcher sitting on the home screen starts nothing.
    let status = transport::status();
    let peer_id = status.peer_id.map(|value| value.to_string());
    if transport_is_ready(&status) {
        store_transport_observation(true, peer_id, "The co-op connection is ready.")
    } else if status.loaded {
        store_transport_observation(false, peer_id, "The co-op connection is starting.")
    } else {
        store_transport_observation(
            false,
            None,
            "The co-op connection starts automatically when you press Play.",
        )
    }
}

/// One presence report: the preflight, then (when the artifacts verify) the report that carries the transport's state.
/// Holds `presence_lock` for the whole run. Returns whether the report that was stored says the co-op connection is ready.
fn submit_presence(app: &AppHandle, access_token: &str) -> Result<bool, String> {
    let _presence = presence_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (artifacts, runtime_supported) = runtime_artifacts(app);
    let (free_memory, commit_headroom) = memory_status();
    let cpu = cpu_load_percent();
    let ping_start = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't prepare P2P presence transport.".to_string())?;
    let _ = client
        .get(format!("{}/launcher/v1/status", api_base_url()))
        .send();
    let backend_rtt = ping_start.elapsed().as_secs_f64() * 1000.0;
    // Publish hashes first.  The bridge must not execute until the backend has confirmed every
    // runtime artifact against its private release policy.
    //
    // Guard heartbeats run on their own loop (guard_loop); presence reports the latest verdicts.
    // The backend decides what a missing or unhealthy Guard means for hosting. The launcher never
    // ends a game over it.
    let client_pid = process::game_process_id();
    let host_pid = p2p_session::guarded_host_process_id();
    let guard_verdicts = [("client", client_pid), ("host", host_pid)]
        .into_iter()
        .filter(|(_, pid)| pid.is_some())
        .filter_map(|(role, _)| guard_loop::latest_verdict(role).map(|verdict| (role, verdict)))
        .collect::<Vec<_>>();
    let guard_required_roles = required_guard_roles(client_pid, host_pid);
    let guard_sessions = guard_verdicts
        .iter()
        .filter(|(_, verdict)| verdict.healthy)
        .map(|(role, verdict)| GuardSessionPresence {
            role: role.to_string(),
            guard_session_id: verdict.session_id.clone(),
            guard_sequence: verdict.sequence,
        })
        .collect::<Vec<_>>();
    let client_guard = guard_verdicts
        .iter()
        .find(|(role, _)| *role == "client")
        .map(|(_, verdict)| verdict)
        .filter(|verdict| verdict.healthy);
    let protected_process_running = !guard_required_roles.is_empty();
    let mut presence = HostPresence {
        preflight_only: runtime_supported,
        // Hosting is centrally selected and fully automatic. The launcher no longer persists
        // a user toggle that can silently strand the rest of the party during matchmaking.
        consent_to_host: true,
        observed_at: iso_now(),
        free_physical_memory_mi_b: free_memory,
        commit_headroom_mi_b: commit_headroom,
        logical_cpu_count: std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1),
        cpu_load_percent: cpu,
        power_saver: power_saver(),
        runtime_supported,
        transport_ready: false,
        peer_id: None,
        backend_rtt_ms: backend_rtt,
        // Until the transport's ping-location exchange is available for every frozen peer, the central RTT
        // is a conservative seed. Actual direct/relay observations supersede it after admission.
        worst_peer_rtt_ms: backend_rtt,
        jitter_ms: 0.0,
        packet_loss_percent: 0.0,
        artifacts,
        launcher_version: env!("CARGO_PKG_VERSION"),
        guard_session_id: client_guard.map(|verdict| verdict.session_id.clone()),
        guard_sequence: client_guard.map(|verdict| verdict.sequence),
        guard_sessions,
        guard_required_roles,
        realm_host_sessions: Some(p2p_session::realm_host_session_count()),
    };
    let publish = |report: &HostPresence| -> Result<HostPresenceResponse, String> {
        let response = client
            .post(format!("{}/launcher/v1/p2p/host-presence", api_base_url()))
            .bearer_auth(access_token)
            .json(report)
            .send()
            .map_err(|_| "Couldn't publish P2P host presence.".to_string())?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .map(|bytes| bytes.to_vec())
                .unwrap_or_default();
            // [2026-10-14] A deactivated account is told the day its deletion is set.
            return Err(crate::commands::account::deactivated_message(&body)
                .unwrap_or_else(|| format!("P2P presence rejected ({status})")));
        }
        response
            .json::<HostPresenceResponse>()
            .map_err(|_| "The P2P presence response was malformed.".to_string())
    };
    let verdict = publish(&presence)?;
    let mut guard_verified = verdict.guard_verified;
    let mut transport_reported = false;
    if verdict.artifacts_verified && runtime_supported {
        let observed = transport_preflight();
        transport_reported = observed.ready;
        presence.preflight_only = false;
        presence.transport_ready = observed.ready;
        presence.peer_id = observed.peer_id;
        presence.observed_at = iso_now();
        let second_verdict = publish(&presence)?;
        if !second_verdict.artifacts_verified {
            return Err("Runtime policy changed during the co-op transport check.".to_string());
        }
        guard_verified = second_verdict.guard_verified;
    }
    log_guard_verification(protected_process_running, guard_verified);
    Ok(transport_reported)
}

/// One presence report now, for the realm host. The transport has just been loaded, and the backend keeps only the
/// last report: one sent before the load would refuse the hub start (HOST_RUNTIME_UNVERIFIED) until the next periodic
/// cycle. Same steps and lock as the periodic cycle. Returns whether the stored report says the transport is ready.
pub(crate) fn submit_presence_now(app: &AppHandle) -> Result<bool, String> {
    let access_token = crate::commands::auth::current_access_token(app)?;
    submit_presence(app, &access_token)
}

fn log_guard_verification(protected_process_running: bool, guard_verified: bool) {
    let unverified = protected_process_running && !guard_verified;
    if GUARD_UNVERIFIED_LOGGED.swap(unverified, Ordering::AcqRel) != unverified {
        process::append_active_session_log(if unverified {
            "host presence: the backend has not verified Launcher Guard; this PC cannot host until it does"
        } else {
            "host presence: Launcher Guard verified by the backend"
        });
    }
}

fn required_guard_roles(client_pid: Option<u32>, host_pid: Option<u32>) -> Vec<String> {
    [("client", client_pid), ("host", host_pid)]
        .into_iter()
        .filter_map(|(role, pid)| pid.map(|_| role.to_string()))
        .collect()
}

fn acknowledge(access_token: &str, message_id: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .and_then(|client| {
            client
                .post(format!(
                    "{}/launcher/v1/p2p/control/{message_id}/ack",
                    api_base_url()
                ))
                .bearer_auth(access_token)
                .send()
        })
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// [2026-10-16] What the backend said about one observation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ObservationAnswer {
    /// Accepted. `state` is the hunt's state when the answer names one (today's backend does not; a later one may).
    Accepted { state: Option<String> },
    /// The generation is no longer the hunt's, or the hunt is gone (409 P2P_GENERATION_FENCED, 404, 410).
    Ended,
    /// No answer, or one that says nothing about the session (network, 401, 429, 5xx, ...): asked again next time.
    Unknown,
}

/// [2026-10-16] Hunt states after which there is nothing left to observe. DRAINING is not one: its server still serves the
/// players in it, and the drain needs the observations.
fn is_terminal_hunt_state(state: &str) -> bool {
    matches!(state, "COMPLETED" | "ABORTED" | "FENCED")
}

fn read_observation_answer(status: u16, body: &[u8]) -> ObservationAnswer {
    match status {
        200..=299 => ObservationAnswer::Accepted {
            state: serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|answer| answer.get("state")?.as_str().map(str::to_string)),
        },
        404 | 410 => ObservationAnswer::Ended,
        409 if crate::commands::auth::error_code_of(body).as_deref()
            == Some("P2P_GENERATION_FENCED") =>
        {
            ObservationAnswer::Ended
        }
        _ => ObservationAnswer::Unknown,
    }
}

/// [2026-10-16] Whether a session stays in the 5 s observation set. A session that no longer runs on this PC (its server
/// reaped itself, its join ended, or it was closed here) has nothing to observe; nor has one the backend called ended. Until
/// 0.1.72 a session left the set only on one of the terminal control messages, so every hunt that simply completed was
/// observed every 5 s for as long as the launcher ran (VPS log, 16 Oct 05:25-05:28: two COMPLETED hunts).
fn keeps_observing(running_locally: bool, answer: &ObservationAnswer) -> bool {
    if !running_locally {
        return false;
    }
    match answer {
        ObservationAnswer::Ended => false,
        ObservationAnswer::Accepted { state: Some(state) } => !is_terminal_hunt_state(state),
        ObservationAnswer::Accepted { state: None } | ObservationAnswer::Unknown => true,
    }
}

/// [2026-10-16] One observation tick over the observed sessions: `observe` says whether a session still runs here and, only
/// for one that does, what the backend answered. A session that no longer runs is not reported (an "unreachable" report for a
/// session this PC merely left would count against a hunt other players are still in). Returns the sessions dropped, each
/// with the reason, for the log.
fn prune_observed(
    known: &mut HashMap<String, u32>,
    mut observe: impl FnMut(&str, u32) -> (bool, Option<ObservationAnswer>),
) -> Vec<(String, String)> {
    let mut dropped = Vec::new();
    known.retain(|session_id, generation| {
        let (running, answer) = observe(session_id, *generation);
        let answer = answer.unwrap_or(ObservationAnswer::Unknown);
        if keeps_observing(running, &answer) {
            return true;
        }
        let reason = match (&answer, running) {
            (_, false) => "not running on this PC".to_string(),
            (ObservationAnswer::Accepted { state: Some(state) }, _) => format!("hunt {state}"),
            _ => "ended by the server".to_string(),
        };
        dropped.push((session_id.clone(), reason));
        false
    });
    dropped
}

fn submit_observation(access_token: &str, session_id: &str, generation: u32) -> ObservationAnswer {
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .and_then(|client| {
            client
                .post(format!(
                    "{}/launcher/v1/p2p/hunts/{session_id}/observation",
                    api_base_url()
                ))
                .bearer_auth(access_token)
                .json(&serde_json::json!({
                    "generation": generation,
                    // [2026-10-16] Only a session that runs on this PC is reported (prune_observed).
                    "hostReachable": true,
                    "localBridgeAlive": true,
                    // The current native ABI exposes aggregate diagnostics, not a coherent
                    // per-session metrics snapshot. Mark that absence explicitly instead of
                    // publishing made-up zero latency/loss values as healthy measurements.
                    "metricsAvailable": false,
                    "routeKind": "UNKNOWN",
                    "observedAt": iso_now()
                }))
                .send()
        });
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .map(|bytes| bytes.to_vec())
                .unwrap_or_default();
            read_observation_answer(status, &body)
        }
        Err(_) => ObservationAnswer::Unknown,
    }
}

/// [2026-10-16] A message some launcher already acknowledged (launchers acknowledge after handling).
fn is_already_handled(message: &ControlMessage) -> bool {
    message.acknowledged_at.is_some()
}

// [2026-10-14] HOST_OFFER_CANCELLED is terminal too: the backend sends it to the host and every member when a hunt ends before it
// is active, now also when the party leader cancels the search (DELETE /candidate/leave). It used to fall through to the ignored
// branch, so a host that had already started the hunt's server kept it running. Stopping an unknown session does nothing.
fn is_terminal_p2p_control(message_type: &str) -> bool {
    matches!(
        message_type,
        "FENCE_NOW"
            | "RETURN_TO_RAMSGATE"
            | "DEDICATED_FALLBACK_READY"
            | "REALM_SESSION_LEAVE"
            | "HOST_OFFER_CANCELLED"
    )
}

fn handle_control(
    app: &AppHandle,
    access_token: &mut String,
    message: &ControlMessage,
) -> Result<(), String> {
    let session_id = message.session_id.clone().unwrap_or_default();
    match message.message_type.as_str() {
        "HOST_OFFERED" => {
            let offer_id = message
                .payload
                .get("offerId")
                .and_then(Value::as_str)
                .ok_or_else(|| "The automatic host offer omitted its identifier.".to_string())?;
            // [2026-10-14 realms] While this PC hosts a realm, an offer is refused when it lacks memory or a server slot.
            match super::realm::offer_refusal() {
                Some(reason) => respond_to_offer(access_token, offer_id, false, Some(reason))?,
                None => {
                    respond_to_offer(access_token, offer_id, true, Some("AUTOMATIC_SELECTION"))?
                }
            }
        }
        "HUNT_BOOTSTRAP" if !session_id.is_empty() => {
            if p2p_session::is_session_running(&session_id) {
                return Ok(());
            }
            // Never launch a long-lived bridge using the token that happened to poll this
            // control message. Refresh once up-front and retain it for route-ready, ACKs,
            // presence, and subsequent controls.
            *access_token = refresh_native_session(app)?.access_token;
            p2p_session::start_host_bundle(app, access_token, &session_id)
                .map_err(|_| "Host bootstrap did not reach readiness.".to_string())?;
        }
        "JOIN_RENDEZVOUS" if !session_id.is_empty() => {
            let realm_hub =
                message.payload.get("sessionKind").and_then(Value::as_str) == Some("REALM_HUB");
            // [2026-10-15] A hub's entry means the account is leaving its hunt: the hunt's join ends, so the host stops listing
            // this player there (`stop_hunt_joins_for_hub_join`). [2026-10-16] It ends once the game has left the hunt, not
            // before the hub join starts: the game still travels over it (the airship timed out to the login screen).
            if realm_hub {
                p2p_session::stop_hunt_joins_for_hub_join();
            }
            if p2p_session::is_session_running(&session_id) {
                // A realm hub join that is still registered is replaced: its member re-entered the hub, and the old
                // link must end before the new one starts. A hunt join is never replaced.
                if !realm_hub {
                    return Ok(());
                }
                if !p2p_session::replace_running_join(&session_id) {
                    return Err("The earlier realm hub connection did not end in time.".to_string());
                }
            }
            *access_token = refresh_native_session(app)?.access_token;
            p2p_session::start_join_bundle(app, access_token, &session_id)
                .map_err(|_| "Join bootstrap did not reach readiness.".to_string())?;
        }
        // [2026-10-14] A realm hub's member left the hub (travel, kick, ban, host offline): the join ends, the game
        // keeps running (the terminal branch below stops this session's join only).
        "REALM_SESSION_LEAVE" if !session_id.is_empty() => {
            let reason = message
                .payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN");
            process::append_active_session_log(&format!(
                "realm session left session={session_id} reason={reason}"
            ));
            // [2026-10-14 realms] The member is told why, when the reason is worth a banner (never a travel).
            super::realm::notify_session_leave(app, reason);
            if let Some(generation) = message.generation {
                let _ = p2p_session::stop_session_generation(&session_id, generation);
            }
        }
        // [2026-10-14] A member of this realm hub is expected (or was removed): the host re-reads its roster now.
        "REALM_PEER_EXPECTED" if !session_id.is_empty() => {
            if let Some(generation) = message.generation {
                p2p_session::request_peer_sync(&session_id, generation);
            }
        }
        // [2026-10-13] The other side's ICE description or candidate (session/ice.rs). Not delivered when this
        // launcher does not run that session generation; never retried.
        "ICE_SIGNAL" if !session_id.is_empty() => {
            let field = |name: &str| message.payload.get(name).and_then(Value::as_str);
            if let (Some(from), Some(kind), Some(data)) =
                (field("fromAccountId"), field("kind"), field("data"))
            {
                if !p2p_session::deliver_ice_signal(
                    &session_id,
                    message.generation,
                    from,
                    kind,
                    data,
                ) {
                    process::append_active_session_log(&format!(
                        "co-op signal not delivered (no matching session) kind={kind}"
                    ));
                }
            }
        }
        message_type if is_terminal_p2p_control(message_type) && !session_id.is_empty() => {
            if let Some(generation) = message.generation {
                let _ = p2p_session::stop_session_generation(&session_id, generation);
            }
        }
        _ => {}
    }
    Ok(())
}

fn run_control_loop(app: AppHandle) {
    let mut access_token: Option<String> = None;
    // [2026-10-16] The account the token belongs to: the control cursor is that account's (P2PHostSettings).
    let mut account_id = String::new();
    let mut next_presence = Instant::now();
    let mut next_observation = Instant::now();
    let mut known_sessions = HashMap::<String, u32>::new();
    // A failed cycle (session refresh, presence) is logged and retried. It never ends a game:
    // Guard enforcement is the backend's, which stops offering this PC as a host.
    loop {
        if is_stopped() {
            process::append_active_session_log("p2p control loop stopped (launcher exit)");
            return;
        }
        // The runtime co-op switch: with co-op off there is no presence, no control traffic and no session.
        if super::refresh_switch(&app).is_none() {
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        if access_token.is_none() {
            match refresh_native_session(&app) {
                Ok(session) => {
                    if session.account.user_id != account_id {
                        // Another account signed in on this PC: its sessions and cursor are its own.
                        if !account_id.is_empty() {
                            process::append_active_session_log(
                                "p2p control account changed; its own control cursor applies",
                            );
                        }
                        known_sessions.clear();
                        account_id = session.account.user_id.clone();
                    }
                    access_token = Some(session.access_token);
                }
                Err(error) => {
                    process::append_active_session_log(&format!(
                        "p2p control session refresh failed reason={error}"
                    ));
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
            }
        }
        let mut token = access_token.clone().unwrap_or_default();
        if Instant::now() >= next_presence {
            if let Err(error) = submit_presence(&app, &token) {
                process::append_active_session_log(&format!(
                    "p2p presence cycle failed reason={error}"
                ));
            }
            next_presence = Instant::now() + PRESENCE_INTERVAL;
        }
        if Instant::now() >= next_observation {
            // [2026-10-16] Ended sessions leave the set here (prune_observed); a DRAINING hunt whose server runs stays.
            let dropped = prune_observed(&mut known_sessions, |session_id, generation| {
                if !p2p_session::is_session_running(session_id) {
                    return (false, None);
                }
                (
                    true,
                    Some(submit_observation(&token, session_id, generation)),
                )
            });
            for (session_id, reason) in dropped {
                process::append_active_session_log(&format!(
                    "p2p observation stopped session={session_id} reason={reason}"
                ));
            }
            next_observation = Instant::now() + OBSERVATION_INTERVAL;
        }
        let cursor = cursor_for(&load_settings(&app), &account_id);
        let client = match reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(client) => client,
            Err(_) => {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        let response = client
            .get(format!(
                "{}/launcher/v1/p2p/control?afterSequence={cursor}&waitMs={CONTROL_WAIT_MS}",
                api_base_url()
            ))
            .bearer_auth(&token)
            .send();
        let Ok(response) = response else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        if response.status().as_u16() == 401 {
            access_token = None;
            continue;
        }
        let Ok(envelope) = response.json::<ControlEnvelope>() else {
            continue;
        };
        if envelope.stale_cursor {
            process::append_active_session_log(&format!(
                "p2p control cursor {cursor} was beyond this account's messages; the server answered from the start"
            ));
        }
        for message in envelope.messages {
            if is_already_handled(&message) {
                // Handled before (here before a restart, or on another PC of this account): only the cursor moves.
                let mut settings = load_settings(&app);
                advance_cursor(&mut settings, &account_id, message.sequence);
                let _ = save_settings(&app, &settings);
                continue;
            }
            let handled = handle_control(&app, &mut token, &message).is_ok();
            if !handled {
                std::thread::sleep(Duration::from_secs(2));
                if message.message_type == "HOST_OFFERED" {
                    // A transient automatic-response failure must leave the durable offer
                    // unacknowledged so the same control message can be retried. Bootstrap
                    // failures are different: those are bounded attempts and require a fresh
                    // centrally-issued generation before retrying.
                    break;
                }
                // A bootstrap performs its own bounded transport attempt and writes concrete
                // failure details to its session diagnostics. Replaying the same durable message reused fresh
                // admission tickets every two seconds after the first timeout and could starve
                // later fencing/recovery controls. ACK the failed attempt; a new attempt must be a
                // new centrally-issued control message with its own policy/backoff.
            }
            if !acknowledge(&token, &message.message_id) {
                break;
            }
            let mut settings = load_settings(&app);
            advance_cursor(&mut settings, &account_id, message.sequence);
            let _ = save_settings(&app, &settings);
            if handled {
                if let (Some(session_id), Some(generation)) =
                    (&message.session_id, message.generation)
                {
                    if matches!(
                        message.message_type.as_str(),
                        "HUNT_BOOTSTRAP" | "JOIN_RENDEZVOUS"
                    ) {
                        // Only a successfully running bridge is observable. Registering the
                        // session before bootstrap succeeded produced false "bridgeAlive=false"
                        // observations for failed joins.
                        known_sessions.insert(session_id.clone(), generation);
                    } else if is_terminal_p2p_control(&message.message_type) {
                        known_sessions.remove(session_id);
                    }
                }
            }
        }
        access_token = Some(token);
    }
}

/// Set when the launcher begins an orderly exit. The control loop checks it so it stops issuing
/// presence, bootstrap and acknowledgement traffic against a backend and transport that are being
/// torn down underneath it.
static CONTROL_STOPPED: AtomicBool = AtomicBool::new(false);

pub fn is_stopped() -> bool {
    CONTROL_STOPPED.load(Ordering::Acquire)
}

pub fn stop() {
    if CONTROL_STOPPED.swap(true, Ordering::AcqRel) {
        return;
    }
    process::append_active_session_log("p2p control loop stop requested (launcher exit)");
}

pub fn start(app: AppHandle) {
    if is_stopped() {
        return;
    }
    let Ok(mut started) = runner_started().lock() else {
        return;
    };
    if *started {
        return;
    }
    *started = true;
    std::thread::spawn(move || run_control_loop(app));
}

fn respond_to_offer(
    access_token: &str,
    offer_id: &str,
    accept: bool,
    reason: Option<&str>,
) -> Result<(), String> {
    if offer_id.len() != 36
        || !offer_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid host offer identifier.".to_string());
    }
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't prepare host offer response.".to_string())?
        .post(format!(
            "{}/launcher/v1/p2p/host-offers/{offer_id}/respond",
            api_base_url()
        ))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "accept": accept, "reason": reason }))
        .send()
        .map_err(|_| "Couldn't answer the host offer.".to_string())?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .unwrap_or_default();
        return Err(crate::commands::account::deactivated_message(&body)
            .unwrap_or_else(|| format!("The host offer response was rejected ({status})")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_launcher_does_not_report_transport_ready() {
        // Presence inspection is deliberately side-effect free: it must not start the transport.
        let status = transport::status();
        if !status.loaded {
            assert!(!status.networking_ready);
            assert!(status.peer_id.is_none());
        }
    }

    #[test]
    fn a_loaded_transport_with_its_peer_id_is_ready_at_once() {
        let fresh = transport::TransportStatus {
            loaded: true,
            networking_ready: true,
            peer_id: Some(7),
        };
        assert!(transport_is_ready(&fresh));
        assert!(!transport_is_ready(&transport::TransportStatus::default()));
        let no_identity = transport::TransportStatus {
            loaded: true,
            networking_ready: false,
            peer_id: None,
        };
        assert!(!transport_is_ready(&no_identity));
        let no_networking = transport::TransportStatus {
            loaded: true,
            networking_ready: false,
            peer_id: Some(7),
        };
        assert!(!transport_is_ready(&no_networking));
    }

    #[test]
    fn dedicated_fallback_is_a_terminal_p2p_control() {
        assert!(is_terminal_p2p_control("DEDICATED_FALLBACK_READY"));
        assert!(is_terminal_p2p_control("RETURN_TO_RAMSGATE"));
        assert!(is_terminal_p2p_control("HOST_OFFER_CANCELLED"));
        assert!(!is_terminal_p2p_control("JOIN_RENDEZVOUS"));
    }

    #[test]
    fn host_presence_requires_both_guard_roles_when_both_processes_exist() {
        assert_eq!(
            required_guard_roles(Some(10), Some(20)),
            vec!["client", "host"]
        );
    }

    #[test]
    fn host_presence_keeps_client_role_for_joiners_without_a_headless_host() {
        assert_eq!(required_guard_roles(Some(10), None), vec!["client"]);
    }

    #[test]
    fn host_presence_keeps_host_role_when_only_headless_process_is_running() {
        assert_eq!(required_guard_roles(None, Some(20)), vec!["host"]);
    }

    #[test]
    fn host_presence_requires_no_roles_when_no_protected_process_exists() {
        assert!(required_guard_roles(None, None).is_empty());
    }

    // [2026-10-16] The control cursor is the signed-in account's (0.1.71 kept one per PC: "matchmaking failed").

    #[test]
    fn each_account_keeps_its_own_control_cursor() {
        let mut settings = P2PHostSettings::default();
        advance_cursor(&mut settings, "acc-vps", 103);
        assert_eq!(
            cursor_for(&settings, "acc-vps"),
            103,
            "the same account resumes"
        );
        assert_eq!(
            cursor_for(&settings, "acc-mysticx"),
            0,
            "another account on this PC starts at its own beginning"
        );
        advance_cursor(&mut settings, "acc-mysticx", 1);
        advance_cursor(&mut settings, "acc-vps", 90);
        assert_eq!(cursor_for(&settings, "acc-mysticx"), 1);
        assert_eq!(
            cursor_for(&settings, "acc-vps"),
            103,
            "a cursor never moves back"
        );
        // Saved and read again, each account keeps its own.
        let saved = serde_json::to_string(&settings).unwrap();
        let read: P2PHostSettings = serde_json::from_str(&saved).unwrap();
        assert_eq!(cursor_for(&read, "acc-vps"), 103);
        assert_eq!(cursor_for(&read, "acc-mysticx"), 1);
    }

    #[test]
    fn the_old_single_cursor_is_not_given_to_any_account() {
        // A 0.1.71 file: one cursor for the whole PC, written by an account nobody can name.
        let read: P2PHostSettings = serde_json::from_str(r#"{"controlCursor":103}"#).unwrap();
        assert_eq!(cursor_for(&read, "acc-vps"), 0);
        assert_eq!(cursor_for(&read, "acc-mysticx"), 0);
        let saved = serde_json::to_string(&read).unwrap();
        assert!(
            !saved.contains("\"controlCursor\""),
            "the old field is gone at the next save: {saved}"
        );
    }

    #[test]
    fn a_message_another_launcher_already_handled_is_not_handled_again() {
        let message = |acknowledged: Option<&str>| -> ControlMessage {
            serde_json::from_value(serde_json::json!({
                "messageId": "00000000-0000-0000-0000-000000000001",
                "sequence": 7,
                "messageType": "JOIN_RENDEZVOUS",
                "sessionId": "s",
                "generation": 1,
                "payload": {},
                "expiresAt": "2026-10-16T06:20:00.000Z",
                "acknowledgedAt": acknowledged,
            }))
            .unwrap()
        };
        assert!(is_already_handled(&message(Some(
            "2026-10-16T06:10:06.000Z"
        ))));
        assert!(!is_already_handled(&message(None)));
        // The backend's answer to a stale cursor is read too.
        let envelope: ControlEnvelope =
            serde_json::from_str(r#"{"messages":[],"staleCursor":true}"#).unwrap();
        assert!(envelope.stale_cursor);
        let envelope: ControlEnvelope = serde_json::from_str(r#"{"messages":[]}"#).unwrap();
        assert!(!envelope.stale_cursor);
    }

    // [2026-10-16] The 5 s observation set lets ended sessions go (0.1.71 observed every completed hunt until exit).

    #[test]
    fn an_observation_answer_is_read_for_its_end() {
        assert_eq!(
            read_observation_answer(200, br#"{"accepted":true,"sessionId":"s","generation":2}"#),
            ObservationAnswer::Accepted { state: None }
        );
        assert_eq!(
            read_observation_answer(200, br#"{"accepted":true,"state":"COMPLETED"}"#),
            ObservationAnswer::Accepted {
                state: Some("COMPLETED".to_string())
            }
        );
        assert_eq!(
            read_observation_answer(
                409,
                br#"{"error":{"code":"P2P_GENERATION_FENCED","message":"x"}}"#
            ),
            ObservationAnswer::Ended
        );
        assert_eq!(
            read_observation_answer(404, b"{}"),
            ObservationAnswer::Ended
        );
        assert_eq!(
            read_observation_answer(409, br#"{"error":{"code":"SOMETHING_ELSE"}}"#),
            ObservationAnswer::Unknown,
            "only a fenced generation ends it"
        );
        assert_eq!(
            read_observation_answer(503, b""),
            ObservationAnswer::Unknown
        );
        assert_eq!(
            read_observation_answer(401, b""),
            ObservationAnswer::Unknown
        );
    }

    #[test]
    fn ended_sessions_leave_the_observation_set_and_a_draining_one_stays() {
        let mut known = HashMap::from([
            ("completed".to_string(), 3),
            ("fenced".to_string(), 1),
            ("reaped".to_string(), 2),
            ("draining".to_string(), 4),
            ("flaky".to_string(), 5),
        ]);
        let mut reported = Vec::new();
        let dropped = prune_observed(&mut known, |session_id, generation| {
            match session_id {
                // Its server reaped itself (the 60 s empty reap) or the session was closed here: not running, not reported.
                "reaped" => (false, None),
                _ => {
                    reported.push((session_id.to_string(), generation));
                    let answer = match session_id {
                        "completed" => ObservationAnswer::Accepted {
                            state: Some("COMPLETED".to_string()),
                        },
                        "fenced" => ObservationAnswer::Ended,
                        "draining" => ObservationAnswer::Accepted {
                            state: Some("DRAINING".to_string()),
                        },
                        _ => ObservationAnswer::Unknown,
                    };
                    (true, Some(answer))
                }
            }
        });
        let mut kept: Vec<_> = known.keys().cloned().collect();
        kept.sort();
        assert_eq!(
            kept,
            vec!["draining".to_string(), "flaky".to_string()],
            "a draining hunt whose server runs is kept, and so is one whose answer was lost"
        );
        let mut dropped: Vec<_> = dropped;
        dropped.sort();
        assert_eq!(
            dropped,
            vec![
                ("completed".to_string(), "hunt COMPLETED".to_string()),
                ("fenced".to_string(), "ended by the server".to_string()),
                ("reaped".to_string(), "not running on this PC".to_string()),
            ]
        );
        assert!(
            !reported
                .iter()
                .any(|(session_id, _)| session_id == "reaped"),
            "a session that no longer runs here is not reported"
        );
        assert!(reported.contains(&("draining".to_string(), 4)));

        // The next tick asks only about what is left.
        let mut asked = Vec::new();
        prune_observed(&mut known, |session_id, _| {
            asked.push(session_id.to_string());
            (true, Some(ObservationAnswer::Accepted { state: None }))
        });
        asked.sort();
        assert_eq!(asked, vec!["draining".to_string(), "flaky".to_string()]);
    }

    #[test]
    fn a_session_is_observed_only_while_it_runs_here_and_is_not_ended() {
        let accepted = ObservationAnswer::Accepted { state: None };
        assert!(keeps_observing(true, &accepted));
        assert!(
            !keeps_observing(false, &accepted),
            "its process exited or it was closed here"
        );
        assert!(!keeps_observing(true, &ObservationAnswer::Ended));
        for state in ["COMPLETED", "ABORTED", "FENCED"] {
            assert!(!keeps_observing(
                true,
                &ObservationAnswer::Accepted {
                    state: Some(state.to_string())
                }
            ));
        }
        for state in ["DRAINING", "RUNNING", "SUSPECT", "ABORTING", "RECOVERING"] {
            assert!(keeps_observing(
                true,
                &ObservationAnswer::Accepted {
                    state: Some(state.to_string())
                }
            ));
        }
        assert!(keeps_observing(true, &ObservationAnswer::Unknown));
    }
}
