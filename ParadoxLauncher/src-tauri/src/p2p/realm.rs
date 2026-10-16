//! [2026-10-14] Hosting a realm from this PC (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 6.2): the realm
//! host's state, its Ramsgate hub with the Training hubs and realm hunts around it, the realm heartbeat that keeps the
//! realm listed, the supervisor that starts a dead hub again, and the member actions (kick, ban, unban) of the realm panel.
//!
//! The hub words in the status are this launcher's own: STARTING (a hub start is in flight), RUNNING (the hub's bundle is
//! registered; the backend mirrors RUNNING once route-ready succeeds), RESTARTING (the hub ended and the supervisor is
//! waiting to start it again) and STOPPING. The backend's states (HOST_OFFERED, ADMITTING, SUSPECT, ...) are never shown.
//!
//! This module never ends a game. It stops only what this launcher runs for the realm: the Ramsgate hub, Training hubs,
//! and realm hunts. Plain hunts are never touched.

use reqwest::blocking::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

use super::control;
use super::session::{
    hosted_sessions, is_session_running, refresh_relay_expiry, set_hub_afk_seconds,
    start_host_bundle, stop_session_generation, HostedSession, HubKind, PeerLive, SessionKind,
};
use super::{coop_artifacts, start_host_transport};
use crate::commands::auth::{api_base_url, http_client, refresh_native_session, send_authorized};
use crate::install::paths;
use crate::launch::logs::iso8601_now;
use crate::servers::active_target;

/// Free memory a host needs before a hub, a Training hub or a realm hunt starts (MiB).
pub(crate) const HOST_MEMORY_FLOOR_MIB: u64 = 3072;
const MAX_PLAYERS_LIMIT: u32 = 64;
const MAX_SERVERS_LIMIT: u32 = 8;
/// 0 means "never" (the runtime floors any other value at 60 s).
const AFK_SECONDS_LIMIT: u32 = 7200;
const DEFAULT_MAX_PLAYERS: u32 = 16;
const MAX_SERVERS_CAP: u32 = 6;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const REALM_CACHE_TTL: Duration = Duration::from_secs(10);
const SUPERVISOR_TICK: Duration = Duration::from_secs(5);
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_RESTARTS_IN_WINDOW: usize = 5;
/// A hub up longer than this with nobody present is restarted silently.
const SCHEDULED_RESTART_WHEN_IDLE: Duration = Duration::from_secs(20 * 3600);
/// A hub is restarted silently at this age regardless (its capability lasts 24 h).
const SCHEDULED_RESTART_AT: Duration = Duration::from_secs(23 * 3600);
const TRAINING_IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);
/// How often the supervisor reads the hub's relay credential expiry (the credential itself is not replaced: see the
/// TODO in `check_relay`).
const RELAY_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
const SESSION_WAIT: Duration = Duration::from_secs(20);
const BAN_REASON_LIMIT: usize = 200;
const HOST_BUSY: &str = "HOST_BUSY";

const MINE: &str = "/launcher/v1/realms/mine";
const HEARTBEAT: &str = "/launcher/v1/realms/mine/heartbeat";
const HUB_START: &str = "/launcher/v1/realm-hosting/hubs/start";
const HUB_STOP: &str = "/launcher/v1/realm-hosting/hubs/stop";

// ---- the contract types (camelCase on the wire) --------------------------------------------------------------------

/// What the realm panel chooses. `afkSeconds` absent means the runtime's default; 0 means never. Saved per server
/// (`realm-host-limits.json`), so the same shape is read back from that file.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmHostOptions {
    pub max_players: u32,
    pub max_servers: u32,
    pub afk_seconds: Option<u32>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostState {
    Stopped,
    Starting,
    Online,
    Restarting,
    Stopping,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LocationKind {
    Hub,
    Training,
    Hunt,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub kind: LocationKind,
    pub session_id: String,
    pub hunt_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RealmSummary {
    pub name: String,
    pub serving: bool,
    /// [2026-10-15] "INVITE_ONLY" (approved players only) or "PUBLIC" (anyone); [2026-10-16] or "SOLO" (the host alone);
    /// "" when the server did not say.
    pub join_policy: String,
    /// [2026-10-15] Players waiting for the host's approval.
    pub join_request_count: u32,
}

/// [2026-10-15] A player waiting for the host's approval (`GET .../mine/requests`, newest first).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestSummary {
    pub account_id: String,
    pub display_name: Option<String>,
    pub at: Option<String>,
}

/// The host's request list, or why it could not be read (then `requests` is empty and `error` says why).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestsStatus {
    pub requests: Vec<JoinRequestSummary>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HubSummary {
    pub session_id: String,
    /// The launcher's word: STARTING, RUNNING, RESTARTING or STOPPING.
    pub state: &'static str,
    pub started_at: Option<String>,
    pub players: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrainingSummary {
    pub session_id: String,
    pub state: &'static str,
    pub players: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuntSummary {
    pub session_id: String,
    pub hunt_id: String,
    pub state: &'static str,
    pub players: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSummary {
    pub account_id: String,
    pub display_name: Option<String>,
    #[serde(rename = "where")]
    pub location: Location,
    pub since: Option<String>,
    pub route: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BanSummary {
    pub account_id: String,
    pub display_name: Option<String>,
    pub reason: Option<String>,
    pub at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySummary {
    pub max_servers: u32,
    /// The realm servers this PC runs now (hub, Training hubs and hunts), the count the hunt offers are checked against.
    pub active_servers: u32,
    pub max_players: u32,
    pub afk_seconds: Option<u32>,
    #[serde(rename = "freeMemMiB")]
    pub free_mem_mib: u64,
    #[serde(rename = "totalMemMiB")]
    pub total_mem_mib: u64,
}

/// The launcher's word on a notice. `info` is what happened (a restart, a limit that applies later); `error` is a refusal or
/// a failure: the panel shows it in the error style, and kick, ban and unban show it inside their open dialog.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind {
    #[default]
    Info,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Notice {
    text: String,
    kind: NoticeKind,
}

fn info_notice(text: impl Into<String>) -> Notice {
    Notice {
        text: text.into(),
        kind: NoticeKind::Info,
    }
}

fn error_notice(text: impl Into<String>) -> Notice {
    Notice {
        text: text.into(),
        kind: NoticeKind::Error,
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RealmHostStatus {
    pub state: HostState,
    pub notice: Option<String>,
    pub notice_kind: NoticeKind,
    pub realm: Option<RealmSummary>,
    pub hub: Option<HubSummary>,
    pub training: Option<TrainingSummary>,
    pub hunts: Vec<HuntSummary>,
    pub players: Vec<PlayerSummary>,
    pub bans: Vec<BanSummary>,
    pub capacity: CapacitySummary,
}

// ---- pure rules (tested) -------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CapacityDecision {
    Accept,
    Refuse { reason: &'static str },
}

/// `floor((GB - 4) / 1.5)` clamped to 1..=6, in integer math as `floor(2 * (GB - 4) / 3)`. Below 4 GB there is no room
/// for a second server, so the answer is 1. `physical_gb` is the installed memory in whole GB (MiB / 1024).
pub(crate) fn default_max_servers(physical_gb: u64) -> u32 {
    if physical_gb < 4 {
        return 1;
    }
    (2 * (physical_gb - 4) / 3).clamp(1, MAX_SERVERS_CAP as u64) as u32
}

/// A hunt or hub offer (or a Training start) is accepted only with the memory floor free and a server slot left.
pub(crate) fn capacity_decision(
    free_mib: u64,
    active_servers: u32,
    max_servers: u32,
) -> CapacityDecision {
    if free_mib < HOST_MEMORY_FLOOR_MIB || active_servers >= max_servers {
        CapacityDecision::Refuse { reason: HOST_BUSY }
    } else {
        CapacityDecision::Accept
    }
}

/// The wait before restart attempt number `attempts_in_window + 1`: 5 s, then 15 s, then 60 s for every later one.
pub(crate) fn restart_backoff(attempts_in_window: usize) -> Duration {
    match attempts_in_window {
        0 => Duration::from_secs(5),
        1 => Duration::from_secs(15),
        _ => Duration::from_secs(60),
    }
}

/// Restart attempts made within the last ten minutes.
pub(crate) fn attempts_in_window(attempts: &[Instant], now: Instant) -> usize {
    attempts
        .iter()
        .filter(|at| now.saturating_duration_since(**at) < RESTART_WINDOW)
        .count()
}

/// Whether one more restart attempt may start now (at most five in any ten minutes).
pub(crate) fn restart_allowed(attempts: &[Instant], now: Instant) -> bool {
    attempts_in_window(attempts, now) < MAX_RESTARTS_IN_WINDOW
}

/// The moment since which a Training hub has had nobody present (`None` while someone is).
pub(crate) fn next_idle_since(
    previous: Option<Instant>,
    present: usize,
    now: Instant,
) -> Option<Instant> {
    if present > 0 {
        None
    } else {
        Some(previous.unwrap_or(now))
    }
}

/// A Training hub stops once it has been idle for five minutes (exactly five counts).
pub(crate) fn training_should_stop(idle_since: Option<Instant>, now: Instant) -> bool {
    idle_since.is_some_and(|since| now.saturating_duration_since(since) >= TRAINING_IDLE_LIMIT)
}

/// The silent restart rule for the Ramsgate hub: 20 h up with nobody present, or 23 h up regardless.
/// How long before the running hub's relay credential expires the supervisor restarts the hub (which mints a fresh one):
/// ABI 3 cannot hand a new credential to a running session, and a hub past that point loses its relay.
const RELAY_RESTART_MARGIN: Duration = Duration::from_secs(15 * 60);

/// Seconds until an RFC 3339 expiry (negative once past); None for an unreadable value.
pub(crate) fn seconds_until(expires_at: &str, now: time::OffsetDateTime) -> Option<i64> {
    let expires =
        time::OffsetDateTime::parse(expires_at, &time::format_description::well_known::Rfc3339)
            .ok()?;
    Some((expires - now).whole_seconds())
}

/// Pure: whether the running hub's relay credential is close enough to expiry that the hub must restart now.
pub(crate) fn relay_restart_due(seconds_left: Option<i64>) -> bool {
    seconds_left.is_some_and(|left| left <= RELAY_RESTART_MARGIN.as_secs() as i64)
}

pub(crate) fn scheduled_restart_due(uptime: Duration, present: bool) -> bool {
    uptime >= SCHEDULED_RESTART_AT || (!present && uptime > SCHEDULED_RESTART_WHEN_IDLE)
}

pub(crate) fn validate_options(options: &RealmHostOptions) -> Result<(), String> {
    if !(1..=MAX_PLAYERS_LIMIT).contains(&options.max_players) {
        return Err(format!(
            "The player limit must be from 1 to {MAX_PLAYERS_LIMIT}."
        ));
    }
    if !(1..=MAX_SERVERS_LIMIT).contains(&options.max_servers) {
        return Err(format!(
            "The server limit must be from 1 to {MAX_SERVERS_LIMIT}."
        ));
    }
    if options
        .afk_seconds
        .is_some_and(|seconds| seconds > AFK_SECONDS_LIMIT)
    {
        return Err(format!(
            "The AFK limit must be from 0 to {AFK_SECONDS_LIMIT} seconds."
        ));
    }
    Ok(())
}

/// A player id as the realm API takes it in a path: 1 to 128 characters from `[A-Za-z0-9._:-]`, the backend's account
/// id rule (ParadoxBackend src/realms/realmInput.ts `AccountIdPattern`).
pub(crate) fn valid_account_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn ban_reason(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.chars().count() > BAN_REASON_LIMIT || trimmed.chars().any(char::is_control) {
        return Err(format!(
            "The ban reason must be plain text of at most {BAN_REASON_LIMIT} characters."
        ));
    }
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

/// The body of the realm heartbeat: `hosting` always, `afkSeconds` only when the host set it.
pub(crate) fn heartbeat_body(options: RealmHostOptions) -> Value {
    let mut hosting = json!({
        "maxServers": options.max_servers,
        "maxPlayers": options.max_players,
    });
    if let Some(afk) = options.afk_seconds {
        hosting["afkSeconds"] = json!(afk);
    }
    json!({ "online": true, "hosting": hosting })
}

fn default_options() -> RealmHostOptions {
    RealmHostOptions {
        max_players: DEFAULT_MAX_PLAYERS,
        max_servers: default_max_servers(physical_total_mib() / 1024),
        afk_seconds: None,
    }
}

// ---- process-wide state --------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct HubRun {
    session_id: String,
    /// When the hub reached RUNNING (the scheduled restart counts from here).
    started: Option<Instant>,
    word: &'static str,
}

/// [2026-10-15] The signed-in account that hosts the realm: the host's own row in the player list.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HostAccount {
    account_id: String,
    display_name: Option<String>,
}

struct HostRecord {
    state: HostState,
    notice: Option<Notice>,
    options: RealmHostOptions,
    hub: Option<HubRun>,
    /// [2026-10-15] Set when a hub starts (`start_hub`), cleared when the realm stops.
    account: Option<HostAccount>,
    /// Dropping this closes the heartbeat loop (which then closes the realm). `None` when no run is alive.
    heartbeat_stop: Option<mpsc::Sender<()>>,
    /// Dropping this ends the supervisor at its next tick.
    supervisor_stop: Option<mpsc::Sender<()>>,
}

/// [2026-10-15] Whether the realm is hosted from this PC in any state but stopped (mod.rs `hosting_active`).
pub(crate) fn hosting_active() -> bool {
    lock(host_state()).state != HostState::Stopped
}

fn host_state() -> &'static Mutex<HostRecord> {
    static HOST: OnceLock<Mutex<HostRecord>> = OnceLock::new();
    HOST.get_or_init(|| {
        Mutex::new(HostRecord {
            state: HostState::Stopped,
            notice: None,
            options: default_options(),
            hub: None,
            account: None,
            heartbeat_stop: None,
            supervisor_stop: None,
        })
    })
}

/// Serializes starts, stops, restarts and member-limit changes. A status read never takes it.
fn lifecycle() -> &'static Mutex<()> {
    static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct HostedRealm {
    name: String,
    #[serde(default)]
    members: Vec<MemberView>,
    #[serde(default)]
    bans: Vec<BanView>,
    /// [2026-10-15] "INVITE_ONLY" or "PUBLIC"; "" when the server did not say.
    #[serde(default)]
    join_policy: String,
    /// [2026-10-15] Players waiting for the host's approval.
    #[serde(default)]
    join_request_count: u32,
}

/// [2026-10-15] The answer of `GET .../mine/requests`.
#[derive(Deserialize)]
struct JoinRequestsView {
    #[serde(default)]
    requests: Vec<JoinRequestSummary>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MemberView {
    account_id: String,
    display_name: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct BanView {
    account_id: String,
    display_name: Option<String>,
    reason: Option<String>,
    at: Option<String>,
}

#[derive(Deserialize)]
struct MineView {
    hosted: Option<HostedRealm>,
}

struct RealmCache {
    fetched_at: Instant,
    hosted: Option<HostedRealm>,
}

fn realm_cache() -> &'static Mutex<Option<RealmCache>> {
    static CACHE: OnceLock<Mutex<Option<RealmCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An informational notice (or none).
fn set_notice(notice: Option<String>) {
    lock(host_state()).notice = notice.map(info_notice);
}

/// A refusal or failure, shown in the error style.
fn set_error(message: String) {
    lock(host_state()).notice = Some(error_notice(message));
}

// ---- memory --------------------------------------------------------------------------------------------------------

fn physical_total_mib() -> u64 {
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return 0;
        }
        status.ullTotalPhys / 1_048_576
    }
}

// ---- HTTP and logs -------------------------------------------------------------------------------------------------

/// A failed realm or hub call: the HTTP status (0 when the call never got an answer), the backend's code and message,
/// and the `reason` the backend gives for REALM_HOST_INELIGIBLE.
struct Failure {
    status: u16,
    code: String,
    message: String,
    reason: Option<String>,
}

impl Failure {
    fn local(message: String) -> Self {
        Self {
            status: 0,
            code: String::new(),
            message,
            reason: None,
        }
    }

    fn from_response(response: Response) -> Self {
        let status = response.status().as_u16();
        let body: Value = response.json().unwrap_or(Value::Null);
        let error = &body["error"];
        // [2026-10-14] A deactivated account is told the same way on every route: the day it is deleted.
        let message = crate::commands::account::deactivated_sentence(error)
            .unwrap_or_else(|| error["message"].as_str().unwrap_or_default().to_string());
        Self {
            status,
            code: error["code"].as_str().unwrap_or_default().to_string(),
            message,
            reason: error["reason"].as_str().map(str::to_string),
        }
    }

    fn readable(&self) -> String {
        match self.code.as_str() {
            "REALM_HOST_INELIGIBLE" => format!(
                "This PC cannot host the realm right now: {}",
                ineligible_text(self.reason.as_deref())
            ),
            "REALM_FULL" => "This realm already runs the most servers its host allows.".to_string(),
            "REALM_NOT_FOUND" => "This account does not host a realm yet.".to_string(),
            "REALM_HUB_EXISTS" => "This realm already has a running hub.".to_string(),
            _ if !self.message.is_empty() => self.message.clone(),
            _ => format!("The server refused the request (status {}).", self.status),
        }
    }
}

/// The sentence the realm panel shows for a host eligibility reason (`HostIneligibilityReason`, realmHubPolicy.ts).
fn ineligible_text(reason: Option<&str>) -> &'static str {
    match reason {
        Some("HOST_PRESENCE_MISSING" | "HOST_PRESENCE_STALE") => {
            "it has not reported as a host recently. Keep the launcher open for a minute, then try again."
        }
        Some("HOST_MEMORY_LOW") => "it has too little free memory.",
        Some("HOST_CPU_UNSUITABLE") => "its processor is busy or the PC is in power saver.",
        Some("HOST_NETWORK_UNSUITABLE") => "its connection is too slow for hosting.",
        Some("HOST_GUARD_UNVERIFIED") => "Launcher Guard has not verified it yet.",
        Some("HOST_RUNTIME_UNVERIFIED") => "its game files are not verified. Repair the installation.",
        Some("HOST_LAUNCHER_OUTDATED") => "this launcher is too old to host. Update it.",
        Some("HOST_COOLDOWN") => "it is cooling down after a session that failed.",
        Some("HOST_CONSENT_REQUIRED") => "hosting has not been agreed on this PC.",
        _ => "the server's checks did not pass.",
    }
}

fn answered(response: Response) -> Result<Response, Failure> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(Failure::from_response(response))
    }
}

fn post(app: &AppHandle, path: &str, body: &Value) -> Result<Response, Failure> {
    let url = format!("{}{path}", api_base_url());
    let response = send_authorized(app, |token| {
        http_client()?
            .post(&url)
            .bearer_auth(token)
            .json(body)
            .send()
            .map_err(|_| "Couldn't reach the Mystic Paradox server.".to_string())
    })
    .map_err(Failure::local)?;
    answered(response)
}

fn get(app: &AppHandle, path: &str) -> Result<Response, Failure> {
    let url = format!("{}{path}", api_base_url());
    let response = send_authorized(app, |token| {
        http_client()?
            .get(&url)
            .bearer_auth(token)
            .send()
            .map_err(|_| "Couldn't reach the Mystic Paradox server.".to_string())
    })
    .map_err(Failure::local)?;
    answered(response)
}

/// `%LOCALAPPDATA%\MysticParadox\Logs\realm-host.log`: the realm host's own record. The session logs only exist while a
/// game runs, and a realm host runs without one.
fn realm_log(line: &str) {
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let dir = PathBuf::from(local).join("MysticParadox").join("Logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("realm-host.log"))
    {
        let _ = writeln!(file, "[{}] {line}", iso8601_now());
    }
}

// ---- the realm (members, bans, names) -------------------------------------------------------------------------------

/// The hosted realm as the server describes it, refreshed at most every ten seconds unless `refresh` is set. A failed
/// refresh keeps the last answer (and does not retry at every status read).
fn cached_hosted(app: Option<&AppHandle>, refresh: bool) -> Option<HostedRealm> {
    if let Some(app) = app {
        let stale = lock(realm_cache())
            .as_ref()
            .is_none_or(|cache| cache.fetched_at.elapsed() >= REALM_CACHE_TTL);
        if refresh || stale {
            refresh_cache(app);
        }
    }
    lock(realm_cache())
        .as_ref()
        .and_then(|cache| cache.hosted.clone())
}

fn refresh_cache(app: &AppHandle) {
    let fetched = get(app, MINE)
        .ok()
        .and_then(|response| response.json::<MineView>().ok())
        .map(|view| view.hosted);
    let mut cache = lock(realm_cache());
    let hosted = match fetched {
        Some(hosted) => hosted,
        None => cache.as_ref().and_then(|cache| cache.hosted.clone()),
    };
    *cache = Some(RealmCache {
        fetched_at: Instant::now(),
        hosted,
    });
}

// ---- saved limits (per server) ---------------------------------------------------------------------------------------

/// `realm-host-limits.json` in the app config folder: the limits chosen in the panel, per server id, so they come back
/// when the launcher starts. Written like `servers.json` (temporary file, then rename). Removing a server removes its entry.
const LIMITS_FILE: &str = "realm-host-limits.json";
const LIMITS_FILE_VERSION: u32 = 1;
/// Serialises every read-modify-write of the file (commands run on several threads).
static LIMITS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredLimits {
    #[serde(default)]
    version: u32,
    /// Keyed by server id.
    #[serde(default)]
    servers: BTreeMap<String, RealmHostOptions>,
}

/// The saved limits in `dir`: entries that fail the limits' own checks are dropped. A missing file is empty; a file that
/// is not valid JSON is reported as damaged, so the next write sets it aside instead of replacing it.
fn read_limits(dir: &Path) -> Result<(BTreeMap<String, RealmHostOptions>, bool), String> {
    let text = match std::fs::read_to_string(dir.join(LIMITS_FILE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((BTreeMap::new(), false));
        }
        Err(_) => return Err("Couldn't read the saved realm limits.".to_string()),
    };
    match serde_json::from_str::<StoredLimits>(&text) {
        Ok(stored) => Ok((
            stored
                .servers
                .into_iter()
                .filter(|(id, options)| {
                    !id.is_empty() && id.len() <= 64 && validate_options(options).is_ok()
                })
                .collect(),
            false,
        )),
        Err(_) => Ok((BTreeMap::new(), true)),
    }
}

fn write_limits(dir: &Path, servers: &BTreeMap<String, RealmHostOptions>) -> Result<(), String> {
    let path = dir.join(LIMITS_FILE);
    let temporary = path.with_extension("json.tmp");
    let stored = StoredLimits {
        version: LIMITS_FILE_VERSION,
        servers: servers.clone(),
    };
    let contents = serde_json::to_vec_pretty(&stored)
        .map_err(|_| "Couldn't encode the saved realm limits.".to_string())?;
    std::fs::write(&temporary, contents)
        .map_err(|_| "Couldn't save the realm limits.".to_string())?;
    std::fs::rename(&temporary, &path).map_err(|_| "Couldn't commit the realm limits.".to_string())
}

/// Applies `change` to the saved limits in `dir`. A change that leaves them as they were writes nothing.
fn update_limits_in(
    dir: &Path,
    change: impl FnOnce(&mut BTreeMap<String, RealmHostOptions>),
) -> Result<(), String> {
    let _guard = lock(&LIMITS_LOCK);
    let (mut servers, damaged) = read_limits(dir)?;
    let before = servers.clone();
    change(&mut servers);
    if servers == before {
        return Ok(());
    }
    if damaged {
        // Keep the damaged file for inspection; if it cannot be moved, nothing is written over it.
        let path = dir.join(LIMITS_FILE);
        std::fs::rename(&path, path.with_extension("json.bad")).map_err(|_| {
            "The saved realm limits are damaged and couldn't be set aside.".to_string()
        })?;
    }
    write_limits(dir, &servers)
}

/// The limits saved for the selected server, or the defaults when none were saved.
fn selected_limits(app: &AppHandle) -> RealmHostOptions {
    let server_id = active_target(app).server.id;
    paths::config_dir(app)
        .ok()
        .and_then(|dir| read_limits(&dir).ok())
        .and_then(|(mut servers, _)| servers.remove(&server_id))
        .unwrap_or_else(default_options)
}

/// Saves `options` for the selected server. A failure is logged by the caller; it never stops a start.
fn save_limits(app: &AppHandle, options: RealmHostOptions) -> Result<(), String> {
    let server_id = active_target(app).server.id;
    let dir = paths::config_dir(app)?;
    update_limits_in(&dir, |servers| {
        servers.insert(server_id, options);
    })
}

/// Removes a server's saved limits (called when that server leaves the list, from `commands/servers.rs`).
pub(crate) fn forget_realm_host_limits(app: &AppHandle, server_id: &str) {
    if let Ok(dir) = paths::config_dir(app) {
        if let Err(error) = update_limits_in(&dir, |servers| {
            servers.remove(server_id);
        }) {
            realm_log(&format!("removing the saved realm limits failed: {error}"));
        }
    }
}

// ---- the joiner's notice -----------------------------------------------------------------------------------------

/// The Tauri event a Home banner listens for (`realm-notice` in src/api/tauri.ts).
pub(crate) const REALM_NOTICE_EVENT: &str = "realm-notice";

/// What a member of a realm is told when a session of the realm ended for a reason worth a word. Plain text, as written.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RealmNotice {
    pub reason: &'static str,
    pub message: &'static str,
}

/// The notice for a `REALM_SESSION_LEAVE` reason. The host's lease running out, and the host stopping the realm, both read
/// as the host going offline; a travel to a realm hunt needs no word, and neither do the other end reasons.
pub(super) fn leave_notice(reason: &str) -> Option<RealmNotice> {
    let (reason, message) = match reason {
        "HOST_OFFLINE" | "HOST_LEASE_LOST" | "HOST_STOPPED" => {
            ("HOST_OFFLINE", "The realm host went offline.")
        }
        "KICKED" => ("KICKED", "You were removed from the realm."),
        "BANNED" => ("BANNED", "You were banned from this realm."),
        _ => return None,
    };
    Some(RealmNotice { reason, message })
}

/// Emits the notice for a leave, if it has one. The game keeps running: this never ends it.
pub(super) fn notify_session_leave(app: &AppHandle, reason: &str) {
    if let Some(notice) = leave_notice(reason) {
        let _ = app.emit(REALM_NOTICE_EVENT, notice);
    }
}

// ---- the status snapshot ---------------------------------------------------------------------------------------------

/// [2026-10-15] The session the host's own game is in, among the sessions the panel lists (the Ramsgate hub, Training and
/// the realm hunts), or None. The launcher cannot ask the game where it is. What it does see is the transport admitting
/// this PC's own client to a session (`ADMISSION_ACCEPTED role=host source=local`, kept as `local_since`): the game
/// connects to a session when it enters it, so the session with the latest such admission is the one it is in. A plain
/// hunt is not listed by the panel and is never chosen. Nothing is looked for while the realm's own game is not running
/// on this PC (`client_running`): then nothing here holds it. A realm client joins only this realm's servers, and the
/// server choice is fenced while its game runs, so the latest admission is the place.
fn host_place(sessions: &[HostedSession], client_running: bool) -> Option<&HostedSession> {
    if !client_running {
        return None;
    }
    sessions
        .iter()
        .filter(|session| session.kind == SessionKind::HubHost || session.realm)
        .filter(|session| session.live.local_since.is_some())
        .max_by(|left, right| left.live.local_since.cmp(&right.live.local_since))
}

/// [2026-10-15] The place of a listed session, named as the panel names it (Ramsgate, Training or a realm hunt).
fn place_of(session: &HostedSession) -> Location {
    let (kind, hunt_id) = if session.kind != SessionKind::HubHost {
        (LocationKind::Hunt, Some(session.live.hunt_id.clone()))
    } else if session.hub_kind == Some(HubKind::Training) {
        (LocationKind::Training, None)
    } else {
        (LocationKind::Hub, None)
    };
    Location {
        kind,
        session_id: session.session_id.clone(),
        hunt_id,
    }
}

/// [2026-10-15] The host's own row: the signed-in account, in the session its game is in, since the admission that put it there.
fn host_player(session: &HostedSession, account: &HostAccount) -> PlayerSummary {
    PlayerSummary {
        account_id: account.account_id.clone(),
        display_name: account.display_name.clone(),
        location: place_of(session),
        since: session.live.local_since.clone(),
        route: None,
    }
}

fn players_of(
    location: LocationKind,
    session_id: &str,
    hunt_id: Option<&str>,
    peers: &BTreeMap<String, PeerLive>,
    names: &HashMap<String, String>,
) -> Vec<PlayerSummary> {
    peers
        .iter()
        .map(|(account_id, peer)| PlayerSummary {
            account_id: account_id.clone(),
            display_name: names.get(account_id).cloned(),
            location: Location {
                kind: location,
                session_id: session_id.to_string(),
                hunt_id: hunt_id.map(str::to_string),
            },
            since: Some(peer.since.clone()),
            route: peer.route.clone(),
        })
        .collect()
}

/// [2026-10-14] `pub(super)`: the session tests read the status the panel gets (the registry-to-status regression test).
pub(super) fn snapshot(app: Option<&AppHandle>, refresh: bool) -> RealmHostStatus {
    let hosted = cached_hosted(app, refresh);
    let (state, notice, running_options, hub, host_account) = {
        let host = lock(host_state());
        (
            host.state,
            host.notice.clone(),
            host.options,
            host.hub.clone(),
            host.account.clone(),
        )
    };
    // Stopped: the limits saved for the selected server (so they are shown again after a restart). Otherwise the limits the
    // realm runs with.
    let options = match (state, app) {
        (HostState::Stopped, Some(app)) => selected_limits(app),
        (HostState::Stopped, None) => default_options(),
        _ => running_options,
    };
    let sessions = hosted_sessions();
    // [2026-10-15] The host's own game is listed in the session it is in, with the signed-in account. Its count is the
    // session's, so the summaries and the rows agree.
    let client_running = crate::launch::process::game_process_id().is_some();
    let host_session_id = host_account
        .as_ref()
        .and_then(|_| host_place(&sessions, client_running))
        .map(|session| session.session_id.clone());
    let names: HashMap<String, String> = hosted
        .as_ref()
        .map(|realm| {
            realm
                .members
                .iter()
                .filter_map(|member| {
                    member
                        .display_name
                        .clone()
                        .map(|name| (member.account_id.clone(), name))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut hub_summary: Option<HubSummary> = None;
    let mut training: Option<TrainingSummary> = None;
    let mut hunts = Vec::new();
    let mut players = Vec::new();
    for session in &sessions {
        let host_row = host_account
            .as_ref()
            .filter(|_| host_session_id.as_deref() == Some(session.session_id.as_str()))
            .map(|account| host_player(session, account));
        let players_here = session.live.peers.len() as u32 + u32::from(host_row.is_some());
        if session.kind == SessionKind::HubHost {
            if session.hub_kind == Some(HubKind::Training) {
                players.extend(host_row);
                players.extend(players_of(
                    LocationKind::Training,
                    &session.session_id,
                    None,
                    &session.live.peers,
                    &names,
                ));
                if training.is_none() {
                    training = Some(TrainingSummary {
                        session_id: session.session_id.clone(),
                        state: "RUNNING",
                        players: players_here,
                    });
                }
            } else {
                players.extend(host_row);
                players.extend(players_of(
                    LocationKind::Hub,
                    &session.session_id,
                    None,
                    &session.live.peers,
                    &names,
                ));
                let word = hub
                    .as_ref()
                    .filter(|run| run.session_id == session.session_id)
                    .map_or("RUNNING", |run| run.word);
                hub_summary = Some(HubSummary {
                    session_id: session.session_id.clone(),
                    state: word,
                    started_at: session.live.started_at.clone(),
                    players: players_here,
                });
            }
        } else if session.realm {
            players.extend(host_row);
            players.extend(players_of(
                LocationKind::Hunt,
                &session.session_id,
                Some(&session.live.hunt_id),
                &session.live.peers,
                &names,
            ));
            hunts.push(HuntSummary {
                session_id: session.session_id.clone(),
                hunt_id: session.live.hunt_id.clone(),
                state: "RUNNING",
                players: players_here,
            });
        }
    }
    // A hub the launcher still holds without a live bundle (restarting, or stopping): show its word.
    if hub_summary.is_none() {
        if let Some(run) = hub.as_ref() {
            hub_summary = Some(HubSummary {
                session_id: run.session_id.clone(),
                state: run.word,
                started_at: None,
                players: 0,
            });
        }
    }

    let serving = state == HostState::Online
        && hub_summary
            .as_ref()
            .is_some_and(|summary| summary.state == "RUNNING");
    let (free_mib, _) = control::memory_status();
    RealmHostStatus {
        state,
        notice_kind: notice
            .as_ref()
            .map_or(NoticeKind::Info, |notice| notice.kind),
        notice: notice.map(|notice| notice.text),
        realm: hosted.as_ref().map(|realm| RealmSummary {
            name: realm.name.clone(),
            serving,
            join_policy: realm.join_policy.clone(),
            join_request_count: realm.join_request_count,
        }),
        hub: hub_summary,
        training,
        hunts,
        players,
        bans: hosted
            .as_ref()
            .map(|realm| {
                realm
                    .bans
                    .iter()
                    .map(|ban| BanSummary {
                        account_id: ban.account_id.clone(),
                        display_name: ban.display_name.clone(),
                        reason: ban.reason.clone(),
                        at: ban.at.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        capacity: CapacitySummary {
            max_servers: options.max_servers,
            active_servers: sessions.len() as u32,
            max_players: options.max_players,
            afk_seconds: options.afk_seconds,
            free_mem_mib: free_mib,
            total_mem_mib: physical_total_mib(),
        },
    }
}

/// Runs blocking work off Tauri's UI thread. A panic in the work still yields a status, with a notice.
async fn run(
    app: AppHandle,
    work: impl FnOnce(&AppHandle) -> RealmHostStatus + Send + 'static,
) -> RealmHostStatus {
    match tauri::async_runtime::spawn_blocking(move || work(&app)).await {
        Ok(status) => status,
        Err(_) => {
            let mut status = snapshot(None, false);
            status.notice = Some("The realm host request stopped unexpectedly.".to_string());
            status.notice_kind = NoticeKind::Error;
            status
        }
    }
}

// ---- the commands --------------------------------------------------------------------------------------------------

/// [2026-10-14] The panel's status, written to the realm-host log whenever the counts it shows change. Counts only, no
/// account ids. When the players look wrong, this says what the panel was given: its places, players and sessions.
fn log_status_change(status: &RealmHostStatus) {
    static LAST: Mutex<String> = Mutex::new(String::new());
    let place = |kind: LocationKind| {
        status
            .players
            .iter()
            .filter(|player| player.location.kind == kind)
            .count()
    };
    let line = format!(
        "panel status state={:?} sessions={} players={} hub={} training={} hunt={}",
        status.state,
        status.capacity.active_servers,
        status.players.len(),
        place(LocationKind::Hub),
        place(LocationKind::Training),
        place(LocationKind::Hunt),
    );
    let mut last = lock(&LAST);
    if *last != line {
        realm_log(&line);
        *last = line;
    }
}

/// The realm panel's status. Cheap: the realm and its bans come from a cache at most ten seconds old.
#[tauri::command]
pub async fn realm_host_status(app: AppHandle) -> RealmHostStatus {
    run(app, |app| {
        let status = snapshot(Some(app), false);
        log_status_change(&status);
        status
    })
    .await
}

#[tauri::command]
pub async fn realm_host_start(app: AppHandle, options: RealmHostOptions) -> RealmHostStatus {
    run(app, move |app| {
        match start_realm(app, options) {
            Ok(()) => set_notice(None),
            Err(message) => set_error(message),
        }
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_stop(app: AppHandle) -> RealmHostStatus {
    run(app, |app| {
        {
            let _lifecycle = lock(lifecycle());
            if lock(host_state()).state != HostState::Stopped {
                stop_locked(app, None);
            }
        }
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_kick(app: AppHandle, account_id: String) -> RealmHostStatus {
    run(app, move |app| {
        member_action(
            app,
            &account_id,
            "kick",
            json!({}),
            "The player was removed from the realm.",
        );
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_ban(
    app: AppHandle,
    account_id: String,
    reason: Option<String>,
) -> RealmHostStatus {
    run(app, move |app| {
        match ban_reason(reason) {
            Ok(reason) => {
                let body = reason.map_or_else(|| json!({}), |reason| json!({ "reason": reason }));
                member_action(
                    app,
                    &account_id,
                    "ban",
                    body,
                    "The player was banned from the realm.",
                );
            }
            Err(message) => set_error(message),
        }
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_unban(app: AppHandle, account_id: String) -> RealmHostStatus {
    run(app, move |app| {
        member_action(app, &account_id, "unban", json!({}), "The ban was lifted.");
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_set_limits(app: AppHandle, options: RealmHostOptions) -> RealmHostStatus {
    run(app, move |app| {
        if let Err(message) = set_limits(app, options) {
            set_error(message);
        }
        snapshot(Some(app), true)
    })
    .await
}

// ---- join requests and adding players [2026-10-15] -------------------------------------------------------------------

/// The longest username the host may type (the backend's limit).
const USERNAME_LIMIT: usize = 64;

/// The players waiting for the host (`GET .../mine/requests`). Its own answer: a failed read is `error`, not a panel notice.
#[tauri::command]
pub async fn realm_host_join_requests(app: AppHandle) -> JoinRequestsStatus {
    match tauri::async_runtime::spawn_blocking(move || join_requests(&app)).await {
        Ok(status) => status,
        Err(_) => JoinRequestsStatus {
            requests: Vec::new(),
            error: Some("The request list stopped unexpectedly.".to_string()),
        },
    }
}

fn join_requests(app: &AppHandle) -> JoinRequestsStatus {
    let read = get(app, &format!("{MINE}/requests")).and_then(|response| {
        response
            .json::<JoinRequestsView>()
            .map_err(|_| Failure::local("The server's answer could not be read.".to_string()))
    });
    match read {
        Ok(view) => JoinRequestsStatus {
            requests: view.requests,
            error: None,
        },
        Err(failure) => JoinRequestsStatus {
            requests: Vec::new(),
            error: Some(failure.readable()),
        },
    }
}

#[tauri::command]
pub async fn realm_host_approve_request(app: AppHandle, account_id: String) -> RealmHostStatus {
    run(app, move |app| {
        request_action(
            app,
            &account_id,
            "approve",
            "The player can join your realm now.",
        );
        snapshot(Some(app), true)
    })
    .await
}

#[tauri::command]
pub async fn realm_host_deny_request(app: AppHandle, account_id: String) -> RealmHostStatus {
    run(app, move |app| {
        request_action(app, &account_id, "deny", "The request was denied.");
        snapshot(Some(app), true)
    })
    .await
}

/// [2026-10-16] Invites a player by launcher username: they join only after accepting in their own launcher.
#[tauri::command]
pub async fn realm_host_invite_player(app: AppHandle, username: String) -> RealmHostStatus {
    run(app, move |app| {
        invite_player(app, &username);
        snapshot(Some(app), true)
    })
    .await
}

/// [2026-10-16] Withdraws an invite the player has not answered.
#[tauri::command]
pub async fn realm_host_cancel_invite(app: AppHandle, account_id: String) -> RealmHostStatus {
    run(app, move |app| {
        if !valid_account_id(&account_id) {
            set_error("That is not a player id.".to_string());
        } else {
            match post(
                app,
                &format!("{MINE}/player-invites/{account_id}/cancel"),
                &json!({}),
            ) {
                Ok(_) => {
                    realm_log("realm player invite cancelled");
                    set_notice(Some("The invite was cancelled.".to_string()));
                }
                Err(failure) => set_error(failure.readable()),
            }
        }
        snapshot(Some(app), true)
    })
    .await
}

/// [2026-10-16] The host's allowed players (the members, without the host) and unanswered invites (`GET .../mine`). Its own
/// answer, like the request list: a failed read is `error`, not a panel notice.
#[tauri::command]
pub async fn realm_host_people(app: AppHandle) -> RealmPeopleStatus {
    match tauri::async_runtime::spawn_blocking(move || people(&app)).await {
        Ok(status) => status,
        Err(_) => RealmPeopleStatus {
            members: Vec::new(),
            invites: Vec::new(),
            error: Some("The player list stopped unexpectedly.".to_string()),
        },
    }
}

#[tauri::command]
pub async fn realm_host_set_join_policy(app: AppHandle, join_policy: String) -> RealmHostStatus {
    run(app, move |app| {
        set_join_policy(app, &join_policy);
        snapshot(Some(app), true)
    })
    .await
}

/// Approves or denies a waiting player. The account id is checked before it reaches a URL; no name is logged.
fn request_action(app: &AppHandle, account_id: &str, action: &str, done: &str) {
    if !valid_account_id(account_id) {
        set_error("That is not a player id.".to_string());
        return;
    }
    let path = format!("{MINE}/requests/{account_id}/{action}");
    match post(app, &path, &json!({})) {
        Ok(_) => {
            realm_log(&format!("realm join request {action} done"));
            set_notice(Some(done.to_string()));
        }
        Err(failure) => set_error(failure.readable()),
    }
}

/// [2026-10-16] Invites a player by launcher username; the backend looks the name up. A player who had asked to join is let in
/// at once (`status: MEMBER`). The notice names the player as the server knows them.
fn invite_player(app: &AppHandle, username: &str) {
    let name = username.trim();
    if name.is_empty()
        || name.chars().count() > USERNAME_LIMIT
        || name.chars().any(char::is_control)
    {
        set_error(format!(
            "Enter a username of 1 to {USERNAME_LIMIT} characters."
        ));
        return;
    }
    match post(
        app,
        &format!("{MINE}/player-invites"),
        &json!({ "username": name }),
    ) {
        Ok(response) => {
            let answer: Value = response.json().unwrap_or(Value::Null);
            set_notice(Some(invite_sentence(&answer, name)));
            realm_log("realm player invited by username");
        }
        Err(failure) => set_error(failure.readable()),
    }
}

/// The notice for an invite answer: a waiting invite, or a player who is in already (or was let in because they had asked).
fn invite_sentence(answer: &Value, typed: &str) -> String {
    let shown = answer["displayName"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or(typed);
    if answer["status"].as_str() == Some("MEMBER") {
        format!("{shown} can join your realm.")
    } else {
        format!("Invite sent to {shown}. They can join once they accept it in their launcher.")
    }
}

/// One allowed player or one unanswered invite, as the host's lists show them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmPersonSummary {
    pub account_id: String,
    pub display_name: Option<String>,
    /// When they joined (an allowed player) or were invited (an invite).
    pub at: Option<String>,
}

/// The host's allowed players and unanswered invites, or why they could not be read (then both lists are empty).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmPeopleStatus {
    pub members: Vec<RealmPersonSummary>,
    pub invites: Vec<RealmPersonSummary>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct PeopleMineView {
    hosted: Option<PeopleHostedView>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeopleHostedView {
    #[serde(default)]
    members: Vec<PeopleMemberView>,
    #[serde(default)]
    player_invites: Vec<RealmPersonSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeopleMemberView {
    account_id: String,
    display_name: Option<String>,
    role: String,
    joined_at: Option<String>,
}

fn people(app: &AppHandle) -> RealmPeopleStatus {
    let read = get(app, MINE).and_then(|response| {
        response
            .bytes()
            .map_err(|_| Failure::local("The server's answer could not be read.".to_string()))
    });
    match read.map(|body| parse_people(&body)) {
        Ok(Ok(status)) => status,
        Ok(Err(message)) => RealmPeopleStatus {
            members: Vec::new(),
            invites: Vec::new(),
            error: Some(message),
        },
        Err(failure) => RealmPeopleStatus {
            members: Vec::new(),
            invites: Vec::new(),
            error: Some(failure.readable()),
        },
    }
}

/// Reads `GET .../mine`: the members without the host (newest first) and the invites (the backend sends them newest first).
fn parse_people(body: &[u8]) -> Result<RealmPeopleStatus, String> {
    let view: PeopleMineView = serde_json::from_slice(body)
        .map_err(|_| "The server's answer could not be read.".to_string())?;
    let Some(hosted) = view.hosted else {
        return Ok(RealmPeopleStatus {
            members: Vec::new(),
            invites: Vec::new(),
            error: None,
        });
    };
    let mut members: Vec<RealmPersonSummary> = hosted
        .members
        .into_iter()
        .filter(|member| member.role == "MEMBER")
        .map(|member| RealmPersonSummary {
            account_id: member.account_id,
            display_name: member.display_name,
            at: member.joined_at,
        })
        .collect();
    members.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(RealmPeopleStatus {
        members,
        invites: hosted.player_invites,
        error: None,
    })
}

/// Who may join, through the backend's settings route: `SOLO` (Solo mode, the host alone; [2026-10-16]), `INVITE_ONLY`
/// (Allowlisted mode, approved players) or `PUBLIC` (Public mode, anyone).
fn set_join_policy(app: &AppHandle, join_policy: &str) {
    let sentence = match join_policy {
        "SOLO" => "Your realm is in solo mode now: only you can enter. Players already inside stay until they leave.",
        "PUBLIC" => "Anyone can join your realm now.",
        "INVITE_ONLY" => "Only players you approve can join your realm now.",
        _ => {
            set_error("Choose who can join: solo, allowlisted or public.".to_string());
            return;
        }
    };
    match post(
        app,
        &format!("{MINE}/settings"),
        &json!({ "joinPolicy": join_policy }),
    ) {
        Ok(_) => {
            realm_log(&format!("realm join policy set to {join_policy}"));
            set_notice(Some(sentence.to_string()));
        }
        Err(failure) => set_error(failure.readable()),
    }
}

fn member_action(app: &AppHandle, account_id: &str, action: &str, body: Value, done: &str) {
    if !valid_account_id(account_id) {
        set_error("That is not a player id.".to_string());
        return;
    }
    let path = format!("/launcher/v1/realms/mine/members/{account_id}/{action}");
    match post(app, &path, &body) {
        Ok(_) => {
            realm_log(&format!("realm member {action} done"));
            set_notice(Some(done.to_string()));
        }
        Err(failure) => set_error(failure.readable()),
    }
}

/// Changes the limits. The server cap applies at once; the player and AFK limits belong to the running hub, so they
/// apply at its next start (said in the notice). The new limits are saved for the selected server either way.
fn set_limits(app: &AppHandle, options: RealmHostOptions) -> Result<(), String> {
    validate_options(&options)?;
    if let Err(error) = save_limits(app, options) {
        realm_log(&format!("saving the realm limits failed: {error}"));
    }
    let _lifecycle = lock(lifecycle());
    let (running, changed_live) = {
        let mut host = lock(host_state());
        let running = matches!(host.state, HostState::Online | HostState::Restarting);
        let changed_live = running
            && (host.options.max_players != options.max_players
                || host.options.afk_seconds != options.afk_seconds);
        host.options = options;
        (running, changed_live)
    };
    set_hub_afk_seconds(options.afk_seconds);
    if running {
        if let Err(failure) = post(app, HEARTBEAT, &heartbeat_body(options)) {
            realm_log(&format!(
                "realm limits heartbeat failed: {}",
                failure.readable()
            ));
        }
    }
    set_notice(
        changed_live
            .then(|| "The player and AFK limits apply when the hub next starts.".to_string()),
    );
    Ok(())
}

// ---- start and stop ------------------------------------------------------------------------------------------------

/// The start sequence (design 6.2): preconditions, the transport without a Play, the realm heartbeat, then the hub.
/// Returns Ok once the hub is RUNNING. On failure the realm is closed again and the state is back to stopped.
fn start_realm(app: &AppHandle, options: RealmHostOptions) -> Result<(), String> {
    validate_options(&options)?;
    let _lifecycle = lock(lifecycle());
    if lock(host_state()).state != HostState::Stopped {
        return Err("The realm host is already running.".to_string());
    }
    // The limits the player starts with are the ones this PC shows next time, whatever the start then does.
    if let Err(error) = save_limits(app, options) {
        realm_log(&format!("saving the realm limits failed: {error}"));
    }
    if coop_artifacts().is_none() {
        return Err(
            "Co-op hunts are off on this server, so this PC cannot host a realm.".to_string(),
        );
    }
    let target = active_target(app);
    if !target.uses_official_feed() {
        return Err("Select the official server or a Paradox realm to host a realm.".to_string());
    }
    let (free_mib, _) = control::memory_status();
    if free_mib < HOST_MEMORY_FLOOR_MIB {
        return Err(format!(
            "Hosting needs {HOST_MEMORY_FLOOR_MIB} MiB of free memory; {free_mib} MiB is free."
        ));
    }
    ensure_host_transport(app)?;
    // Before the hub start, not after it: the backend's refusal waits for a report that says the transport is ready.
    report_host_presence(app);

    {
        let mut host = lock(host_state());
        host.state = HostState::Starting;
        host.notice = None;
        host.options = options;
        host.hub = None;
    }
    set_hub_afk_seconds(options.afk_seconds);
    realm_log(&format!(
        "realm host starting maxPlayers={} maxServers={} afkSeconds={}",
        options.max_players,
        options.max_servers,
        options
            .afk_seconds
            .map_or("default".to_string(), |value| value.to_string())
    ));
    let (heartbeat_tx, heartbeat_rx) = mpsc::channel();
    lock(host_state()).heartbeat_stop = Some(heartbeat_tx);
    spawn_heartbeat(app.clone(), heartbeat_rx);

    match start_hub(app, options.max_players) {
        Ok(session_id) => {
            let (supervisor_tx, supervisor_rx) = mpsc::channel();
            {
                let mut host = lock(host_state());
                host.state = HostState::Online;
                host.hub = Some(HubRun {
                    session_id: session_id.clone(),
                    started: Some(Instant::now()),
                    word: "RUNNING",
                });
                host.supervisor_stop = Some(supervisor_tx);
            }
            spawn_supervisor(app.clone(), supervisor_rx);
            realm_log(&format!("realm host online hub={session_id}"));
            Ok(())
        }
        Err(error) => {
            let mut host = lock(host_state());
            host.heartbeat_stop = None;
            host.state = HostState::Stopped;
            realm_log(&format!("realm host start failed: {error}"));
            Err(error)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubStarted {
    session_id: String,
}

/// Loads the co-op transport module from the selected server's game folder (a no-op when it is loaded). The launcher
/// unloads it when its last session ends with no game running, so every hub start - the first and each restart - asks
/// for it again (14 Oct repro: restarts failed with "needs the co-op transport module with sessions by handle").
fn ensure_host_transport(app: &AppHandle) -> Result<(), String> {
    let exe = active_target(app)
        .exe_path
        .clone()
        .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
    let game_dir = paths::game_dir(&exe)?;
    start_host_transport(&game_dir)
        .map_err(|error| format!("The co-op connection could not start: {error}"))
}

/// Sends this PC's presence right after the transport was loaded, so the backend holds a report that says it is ready
/// before `hubs/start`. The 14 Oct repro waited up to 20 s for the periodic report, and the backend keeps only the last
/// one. A failed report is logged, not shown: `start_hub` still retries the refusals in `is_report_pending`.
fn report_host_presence(app: &AppHandle) {
    match control::submit_presence_now(app) {
        Ok(true) => realm_log("host presence reported with the co-op connection ready"),
        Ok(false) => realm_log("host presence reported without the co-op connection ready"),
        Err(error) => realm_log(&format!(
            "host presence report before the hub start failed: {error}"
        )),
    }
}

/// The eligibility refusals that only mean "the backend has not seen this PC's next report yet": the transport was
/// just loaded and its ready report has not reached the backend. Retried, not shown. `report_host_presence` sends that
/// report first; the retry covers a slow one.
fn is_report_pending(failure: &Failure) -> bool {
    failure.code == "REALM_HOST_INELIGIBLE"
        && matches!(
            failure.reason.as_deref(),
            Some("HOST_RUNTIME_UNVERIFIED" | "HOST_PRESENCE_MISSING" | "HOST_PRESENCE_STALE")
        )
}

const REPORT_WAIT_STEP: Duration = Duration::from_secs(5);
const REPORT_WAIT_LIMIT: Duration = Duration::from_secs(30);

/// One hub start: `hubs/start`, then the host bundle (which fetches the bootstrap, starts the server and the transport,
/// and sends route-ready). Returns the hub's session id once it is RUNNING.
fn start_hub(app: &AppHandle, max_players: u32) -> Result<String, String> {
    let body = json!({ "hubKind": "RAMSGATE", "maxPlayers": max_players });
    let waited_from = Instant::now();
    let started = loop {
        let attempt = match post(app, HUB_START, &body) {
            Err(failure) if failure.code == "REALM_HUB_EXISTS" => {
                // The backend still holds the previous hub (its lease has not lapsed): end it, then start again once.
                let _ = post(app, HUB_STOP, &json!({ "hubKind": "RAMSGATE" }));
                post(app, HUB_START, &body)
            }
            other => other,
        };
        match attempt {
            Err(failure)
                if is_report_pending(&failure) && waited_from.elapsed() < REPORT_WAIT_LIMIT =>
            {
                realm_log(&format!(
                    "hub start waits for this PC's next host report reason={}",
                    failure.reason.as_deref().unwrap_or("-")
                ));
                std::thread::sleep(REPORT_WAIT_STEP);
            }
            other => break other,
        }
    };
    let response = started.map_err(|failure| failure.readable())?;
    let hub: HubStarted = response
        .json()
        .map_err(|_| "The server returned an invalid hub answer.".to_string())?;
    let session = refresh_native_session(app)?;
    // [2026-10-15] The signed-in account is the host's own player (its name, and the row for its own game).
    lock(host_state()).account = Some(HostAccount {
        account_id: session.account.user_id.clone(),
        display_name: Some(session.account.display_name.clone())
            .filter(|name| !name.trim().is_empty()),
    });
    let mut token = session.access_token;
    match start_host_bundle(app, &mut token, &hub.session_id) {
        Ok(_) => {
            realm_log(&format!("realm hub RUNNING session={}", hub.session_id));
            Ok(hub.session_id)
        }
        Err(error) => {
            // A hub bootstrap the control loop ran first holds the session id: the hub is up, so count it.
            if is_session_running(&hub.session_id) {
                realm_log(&format!(
                    "realm hub already registered session={}",
                    hub.session_id
                ));
                return Ok(hub.session_id);
            }
            let _ = post(app, HUB_STOP, &json!({ "hubKind": "RAMSGATE" }));
            Err(format!("The realm hub did not start. {error}"))
        }
    }
}

/// Ends everything this realm host runs. The caller holds `lifecycle`. The backend is told first, so it stops routing
/// to the hub; then the local bundles are stopped and waited for. Returns nothing: problems become the notice.
fn stop_locked(app: &AppHandle, notice: Option<Notice>) {
    {
        let mut host = lock(host_state());
        host.state = HostState::Stopping;
        host.supervisor_stop = None;
        // Dropping the heartbeat's sender lets its loop close the realm.
        host.heartbeat_stop = None;
        if let Some(run) = host.hub.as_mut() {
            run.word = "STOPPING";
        }
    }
    let mut warning: Option<Notice> = None;
    if let Err(failure) = post(app, HUB_STOP, &json!({ "hubKind": "RAMSGATE" })) {
        warning = Some(error_notice(format!(
            "The server could not be told the hub stopped: {}",
            failure.readable()
        )));
    }
    if let Err(failure) = post(app, HUB_STOP, &json!({ "hubKind": "TRAINING" })) {
        realm_log(&format!("training hub stop: {}", failure.readable()));
    }
    let owned = realm_sessions();
    let ids: Vec<String> = owned
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    for session in &owned {
        let _ = stop_session_generation(&session.session_id, session.generation);
    }
    if !wait_for_sessions(&ids, SESSION_WAIT) && warning.is_none() {
        warning = Some(info_notice(
            "Some of the realm's servers are still closing.",
        ));
    }
    let mut host = lock(host_state());
    host.state = HostState::Stopped;
    host.hub = None;
    host.account = None;
    host.notice = notice.or(warning);
    realm_log("realm host stopped");
}

/// The sessions this launcher hosts for the realm: its hubs (Ramsgate and Training) and its realm hunts.
fn realm_sessions() -> Vec<HostedSession> {
    hosted_sessions()
        .into_iter()
        .filter(|session| session.kind == SessionKind::HubHost || session.realm)
        .collect()
}

fn wait_for_sessions(ids: &[String], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ids.iter().all(|id| !is_session_running(id)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Ends one Ramsgate hub (for a scheduled restart): the backend first, then the local bundle, then the wait.
fn end_hub(app: &AppHandle, session_id: &str) {
    let _ = post(app, HUB_STOP, &json!({ "hubKind": "RAMSGATE" }));
    if let Some(session) = realm_sessions()
        .into_iter()
        .find(|session| session.session_id == session_id)
    {
        let _ = stop_session_generation(&session.session_id, session.generation);
    }
    wait_for_sessions(&[session_id.to_string()], SESSION_WAIT);
}

// ---- the heartbeat -------------------------------------------------------------------------------------------------

/// Keeps the realm listed: `hosting` every 30 s with the current limits. When the stop sender is dropped, it closes the
/// realm (`online: false`) unless a newer run has started in the meantime.
fn spawn_heartbeat(app: AppHandle, stop: Receiver<()>) {
    std::thread::spawn(move || {
        loop {
            let options = lock(host_state()).options;
            if let Err(failure) = post(&app, HEARTBEAT, &heartbeat_body(options)) {
                realm_log(&format!("realm heartbeat failed: {}", failure.readable()));
            }
            if !matches!(
                stop.recv_timeout(HEARTBEAT_INTERVAL),
                Err(RecvTimeoutError::Timeout)
            ) {
                break;
            }
        }
        if lock(host_state()).heartbeat_stop.is_none() {
            match post(&app, HEARTBEAT, &json!({ "online": false })) {
                Ok(_) => realm_log("realm closed"),
                Err(failure) => realm_log(&format!(
                    "realm could not be closed: {}",
                    failure.readable()
                )),
            }
        }
    });
}

// ---- the supervisor ------------------------------------------------------------------------------------------------

fn spawn_supervisor(app: AppHandle, stop: Receiver<()>) {
    std::thread::spawn(move || supervise(app, stop));
}

fn mark_restarting(notice: Option<String>) {
    let mut host = lock(host_state());
    host.state = HostState::Restarting;
    host.notice = notice.map(info_notice);
    if let Some(run) = host.hub.as_mut() {
        run.word = "RESTARTING";
    }
}

/// Watches the hub every few seconds while the realm is online or restarting. An unexpected end is restarted with the
/// backoff of `restart_backoff`, at most five times in ten minutes; a scheduled restart is silent.
fn supervise(app: AppHandle, stop: Receiver<()>) {
    let mut attempts: Vec<Instant> = Vec::new();
    let mut due: Option<Instant> = None;
    let mut relay_check_at = Instant::now() + RELAY_CHECK_INTERVAL;
    let mut idle: HashMap<String, Instant> = HashMap::new();
    loop {
        if !matches!(
            stop.recv_timeout(SUPERVISOR_TICK),
            Err(RecvTimeoutError::Timeout)
        ) {
            return;
        }
        let _lifecycle = lock(lifecycle());
        // A stop that began while this tick waited for the lock dropped our sender: this run is over.
        if !matches!(stop.try_recv(), Err(TryRecvError::Empty)) {
            return;
        }
        let now = Instant::now();
        let (state, hub, max_players) = {
            let host = lock(host_state());
            (host.state, host.hub.clone(), host.options.max_players)
        };
        match state {
            HostState::Online => {
                // Online always has a hub record; without one, treat it as a lost hub and take the restart path.
                let Some(run) = hub else {
                    realm_log("realm online without a hub record; restarting the hub");
                    mark_restarting(Some(
                        "The realm hub stopped. Starting it again.".to_string(),
                    ));
                    due = Some(now);
                    continue;
                };
                if !is_session_running(&run.session_id) {
                    realm_log(&format!(
                        "realm hub ended without a stop request session={}",
                        run.session_id
                    ));
                    mark_restarting(Some(
                        "The realm hub stopped. Starting it again.".to_string(),
                    ));
                    due = Some(now + restart_backoff(attempts_in_window(&attempts, now)));
                    continue;
                }
                let uptime = run
                    .started
                    .map_or(Duration::ZERO, |at| now.saturating_duration_since(at));
                let present = hosted_sessions()
                    .iter()
                    .find(|session| session.session_id == run.session_id)
                    .is_some_and(|session| !session.live.peers.is_empty());
                if scheduled_restart_due(uptime, present) {
                    realm_log(&format!(
                        "scheduled hub restart uptimeSeconds={}",
                        uptime.as_secs()
                    ));
                    end_hub(&app, &run.session_id);
                    mark_restarting(None);
                    due = Some(now);
                    continue;
                }
                let relay_left = hosted_sessions()
                    .iter()
                    .find(|session| session.session_id == run.session_id)
                    .and_then(|session| session.live.relay_expires_at.clone())
                    .and_then(|at| seconds_until(&at, time::OffsetDateTime::now_utc()));
                if relay_restart_due(relay_left) {
                    realm_log(&format!(
                        "hub restart before the relay credential expires secondsLeft={}",
                        relay_left.unwrap_or_default()
                    ));
                    end_hub(&app, &run.session_id);
                    mark_restarting(None);
                    due = Some(now);
                    continue;
                }
                if now >= relay_check_at {
                    relay_check_at = now + RELAY_CHECK_INTERVAL;
                    check_relay(&app, &run.session_id);
                }
                training_sweep(&app, &mut idle, now);
            }
            HostState::Restarting => {
                training_sweep(&app, &mut idle, now);
                let Some(at) = due else {
                    due = Some(now);
                    continue;
                };
                if now < at {
                    continue;
                }
                if !restart_allowed(&attempts, now) {
                    realm_log("realm hub kept stopping; hosting stopped");
                    stop_locked(
                        &app,
                        Some(error_notice("The realm hub kept stopping, so hosting was stopped. Start it again when this PC is steady.")),
                    );
                    return;
                }
                attempts.retain(|at| now.saturating_duration_since(*at) < RESTART_WINDOW);
                attempts.push(now);
                let attempt = attempts.len();
                // End whatever hub the backend still holds (idempotent) before each retry.
                let _ = post(&app, HUB_STOP, &json!({ "hubKind": "RAMSGATE" }));
                // The transport may have been unloaded with the hub's last session: load it again first, and report it.
                match ensure_host_transport(&app).and_then(|()| {
                    report_host_presence(&app);
                    start_hub(&app, max_players)
                }) {
                    Ok(session_id) => {
                        let mut host = lock(host_state());
                        host.state = HostState::Online;
                        host.notice = None;
                        host.hub = Some(HubRun {
                            session_id: session_id.clone(),
                            started: Some(Instant::now()),
                            word: "RUNNING",
                        });
                        due = None;
                        realm_log(&format!(
                            "realm hub restarted attempt={attempt} session={session_id}"
                        ));
                    }
                    Err(error) => {
                        realm_log(&format!(
                            "realm hub restart attempt={attempt} failed: {error}"
                        ));
                        lock(host_state()).notice = Some(error_notice(format!(
                            "Restarting the realm hub failed: {error}"
                        )));
                        due = Some(now + restart_backoff(attempts_in_window(&attempts, now)));
                    }
                }
            }
            _ => return,
        }
    }
}

/// Reads the hub's relay credential expiry again, for the log. ABI 3 cannot take a new credential into a running session,
/// so the supervisor restarts the hub `RELAY_RESTART_MARGIN` before the one it started with expires (the backend mints hub
/// credentials for the hub's life, up to 24 h, so normally the scheduled restart comes first). Applying a fresh
/// credential without a restart would need an ABI 4 call (`UpdateSecretsH`).
fn check_relay(app: &AppHandle, session_id: &str) {
    let Some((generation, running_expiry)) = hosted_sessions()
        .into_iter()
        .find(|session| session.session_id == session_id)
        .map(|session| (session.generation, session.live.relay_expires_at))
    else {
        return;
    };
    let running = running_expiry.unwrap_or_else(|| "unknown".to_string());
    match refresh_relay_expiry(app, session_id, generation) {
        Ok(Some(fresh)) => realm_log(&format!(
            "hub relay credential: running {running}, fresh {fresh} (the fresh one is not applied to the running hub)"
        )),
        Ok(None) => realm_log(&format!("hub relay credential: running {running}, fresh has no expiry")),
        Err(error) => realm_log(&format!("hub relay credential check failed: {error}")),
    }
}

/// Stops Training hubs that have had nobody present for five minutes. Runs over every hosted Training hub, including
/// the ones the backend started on demand (HUNT_BOOTSTRAP), not only the ones this module started.
fn training_sweep(app: &AppHandle, idle: &mut HashMap<String, Instant>, now: Instant) {
    let training: Vec<HostedSession> = hosted_sessions()
        .into_iter()
        .filter(|session| {
            session.kind == SessionKind::HubHost && session.hub_kind == Some(HubKind::Training)
        })
        .collect();
    idle.retain(|id, _| training.iter().any(|session| &session.session_id == id));
    for session in training {
        let since = next_idle_since(
            idle.get(&session.session_id).copied(),
            session.live.peers.len(),
            now,
        );
        match since {
            Some(at) => {
                idle.insert(session.session_id.clone(), at);
            }
            None => {
                idle.remove(&session.session_id);
            }
        }
        if training_should_stop(since, now) {
            realm_log(&format!(
                "training hub idle for five minutes; stopping session={}",
                session.session_id
            ));
            let _ = post(app, HUB_STOP, &json!({ "hubKind": "TRAINING" }));
            let _ = stop_session_generation(&session.session_id, session.generation);
            idle.remove(&session.session_id);
        }
    }
}

// ---- hunt offers (control.rs) --------------------------------------------------------------------------------------

/// `Some(reason)` when this PC, hosting a realm, must refuse a hunt offer now (free memory under the floor, or no server
/// slot left). `None` accepts the offer as before, which is also the answer while no realm is online.
pub(super) fn offer_refusal() -> Option<&'static str> {
    let (state, max_servers) = {
        let host = lock(host_state());
        (host.state, host.options.max_servers)
    };
    if state != HostState::Online {
        return None;
    }
    let (free_mib, _) = control::memory_status();
    let active = hosted_sessions().len() as u32;
    match capacity_decision(free_mib, active, max_servers) {
        CapacityDecision::Accept => None,
        CapacityDecision::Refuse { reason } => Some(reason),
    }
}

// ---- tests -------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // [2026-10-16] The host's allowed players and invites, and the invite notice.
    #[test]
    fn the_people_lists_keep_members_without_the_host_newest_first_and_the_invites() {
        let body = br#"{"hosted":{"members":[
            {"accountId":"host-1","displayName":"Hosty","role":"HOST","joinedAt":"2026-10-01T00:00:00.000Z"},
            {"accountId":"a","displayName":"Old","role":"MEMBER","joinedAt":"2026-10-02T00:00:00.000Z"},
            {"accountId":"b","displayName":null,"role":"MEMBER","joinedAt":"2026-10-05T00:00:00.000Z"}],
            "playerInvites":[{"accountId":"c","displayName":"Guest","at":"2026-10-06T00:00:00.000Z"}]},"memberOf":[]}"#;
        let status = parse_people(body).unwrap();
        assert_eq!(
            status
                .members
                .iter()
                .map(|m| m.account_id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(status.members[1].display_name.as_deref(), Some("Old"));
        assert_eq!(status.invites.len(), 1);
        assert_eq!(status.invites[0].display_name.as_deref(), Some("Guest"));
        assert_eq!(status.error, None);

        // No realm hosted, and an older backend without invites.
        let none = parse_people(br#"{"hosted":null,"memberOf":[]}"#).unwrap();
        assert!(none.members.is_empty() && none.invites.is_empty());
        let old = parse_people(br#"{"hosted":{"members":[]}}"#).unwrap();
        assert!(old.invites.is_empty());
        assert!(parse_people(b"<html>").is_err());
    }

    #[test]
    fn the_invite_notice_says_whether_the_player_waits_or_is_in() {
        let invited = json!({ "accountId": "a", "displayName": "Lyra", "status": "INVITED" });
        assert_eq!(
            invite_sentence(&invited, "lyra"),
            "Invite sent to Lyra. They can join once they accept it in their launcher."
        );
        let member = json!({ "accountId": "a", "displayName": "Lyra", "status": "MEMBER" });
        assert_eq!(
            invite_sentence(&member, "lyra"),
            "Lyra can join your realm."
        );
        assert_eq!(
            invite_sentence(&json!({}), "typed"),
            "Invite sent to typed. They can join once they accept it in their launcher."
        );
    }

    #[test]
    fn default_max_servers_follows_the_formula_and_clamps() {
        assert_eq!(default_max_servers(0), 1);
        assert_eq!(default_max_servers(2), 1);
        assert_eq!(default_max_servers(4), 1); // (4 - 4) / 1.5 = 0, clamped up
        assert_eq!(default_max_servers(6), 1); // 2 / 1.5 = 1.33, floor 1
        assert_eq!(default_max_servers(8), 2); // 4 / 1.5 = 2.67, floor 2
        assert_eq!(default_max_servers(10), 4); // 6 / 1.5 = 4
        assert_eq!(default_max_servers(16), 6); // 12 / 1.5 = 8, clamped to 6
        assert_eq!(default_max_servers(64), 6);
        assert_eq!(default_max_servers(128), 6);
    }

    #[test]
    fn capacity_refuses_below_the_memory_floor_and_at_the_server_limit() {
        assert_eq!(capacity_decision(3072, 0, 1), CapacityDecision::Accept);
        assert_eq!(
            capacity_decision(3071, 0, 1),
            CapacityDecision::Refuse {
                reason: "HOST_BUSY"
            }
        );
        assert_eq!(
            capacity_decision(3072, 1, 1),
            CapacityDecision::Refuse {
                reason: "HOST_BUSY"
            }
        );
        assert_eq!(capacity_decision(3072, 1, 2), CapacityDecision::Accept);
        assert_eq!(
            capacity_decision(0, 0, 6),
            CapacityDecision::Refuse {
                reason: "HOST_BUSY"
            }
        );
    }

    #[test]
    fn restart_backoff_is_five_fifteen_then_sixty_seconds() {
        assert_eq!(restart_backoff(0), Duration::from_secs(5));
        assert_eq!(restart_backoff(1), Duration::from_secs(15));
        assert_eq!(restart_backoff(2), Duration::from_secs(60));
        assert_eq!(restart_backoff(3), Duration::from_secs(60));
        assert_eq!(restart_backoff(9), Duration::from_secs(60));
    }

    #[test]
    fn at_most_five_restarts_in_any_ten_minutes() {
        let t0 = Instant::now();
        let attempts: Vec<Instant> = (0..5).map(|i| t0 + Duration::from_secs(i * 60)).collect();
        // Five attempts in the first five minutes: no sixth may start while they are all inside the window.
        assert!(!restart_allowed(
            &attempts,
            t0 + Duration::from_secs(5 * 60)
        ));
        // The first attempt is 601 s old: it leaves the window, so one more is allowed.
        assert!(restart_allowed(&attempts, t0 + Duration::from_secs(601)));
        assert_eq!(
            attempts_in_window(&attempts, t0 + Duration::from_secs(601)),
            4
        );
        assert_eq!(attempts_in_window(&[], t0), 0);
    }

    #[test]
    fn training_hub_stops_at_exactly_five_idle_minutes() {
        let t0 = Instant::now();
        let idle = next_idle_since(None, 0, t0);
        assert_eq!(idle, Some(t0));
        assert!(!training_should_stop(idle, t0 + Duration::from_secs(299)));
        assert!(training_should_stop(idle, t0 + Duration::from_secs(300)));
        // Someone arrives: the idle clock stops and starts again later.
        assert_eq!(
            next_idle_since(idle, 1, t0 + Duration::from_secs(200)),
            None
        );
        let later = next_idle_since(None, 0, t0 + Duration::from_secs(400));
        assert!(!training_should_stop(later, t0 + Duration::from_secs(600)));
        assert!(!training_should_stop(None, t0 + Duration::from_secs(9999)));
    }

    #[test]
    fn the_hub_restarts_fifteen_minutes_before_its_relay_credential_expires() {
        let now = time::OffsetDateTime::parse(
            "2026-10-14T10:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        assert_eq!(seconds_until("2026-10-14T13:00:00Z", now), Some(3 * 3600));
        assert_eq!(seconds_until("2026-10-14T09:59:00Z", now), Some(-60));
        assert_eq!(seconds_until("not a date", now), None);
        assert!(!relay_restart_due(Some(16 * 60)));
        assert!(relay_restart_due(Some(15 * 60)));
        assert!(relay_restart_due(Some(-60)));
        assert!(!relay_restart_due(None), "no known expiry: no restart");
    }

    #[test]
    fn scheduled_restart_at_twenty_hours_idle_or_twenty_three_regardless() {
        assert!(!scheduled_restart_due(
            Duration::from_secs(20 * 3600),
            false
        ));
        assert!(scheduled_restart_due(
            Duration::from_secs(20 * 3600 + 1),
            false
        ));
        assert!(!scheduled_restart_due(Duration::from_secs(21 * 3600), true));
        assert!(scheduled_restart_due(Duration::from_secs(23 * 3600), true));
    }

    #[test]
    fn only_the_presence_refusals_are_retried_while_a_report_is_pending() {
        let refusal = |code: &str, reason: Option<&str>| Failure {
            status: 409,
            code: code.to_string(),
            message: String::new(),
            reason: reason.map(str::to_string),
        };
        for reason in [
            "HOST_RUNTIME_UNVERIFIED",
            "HOST_PRESENCE_MISSING",
            "HOST_PRESENCE_STALE",
        ] {
            assert!(
                is_report_pending(&refusal("REALM_HOST_INELIGIBLE", Some(reason))),
                "{reason}"
            );
        }
        // A real reason (memory, CPU, cooldown) or another code is answered at once.
        assert!(!is_report_pending(&refusal(
            "REALM_HOST_INELIGIBLE",
            Some("HOST_MEMORY_LOW")
        )));
        assert!(!is_report_pending(&refusal("REALM_HOST_INELIGIBLE", None)));
        assert!(!is_report_pending(&refusal("REALM_HUB_EXISTS", None)));
    }

    #[test]
    fn options_are_checked_at_their_limits() {
        let ok = RealmHostOptions {
            max_players: 1,
            max_servers: 1,
            afk_seconds: None,
        };
        assert!(validate_options(&ok).is_ok());
        let top = RealmHostOptions {
            max_players: 64,
            max_servers: 8,
            afk_seconds: Some(7200),
        };
        assert!(validate_options(&top).is_ok());
        assert!(validate_options(&RealmHostOptions {
            max_players: 0,
            ..ok
        })
        .is_err());
        assert!(validate_options(&RealmHostOptions {
            max_players: 65,
            ..ok
        })
        .is_err());
        assert!(validate_options(&RealmHostOptions {
            max_servers: 0,
            ..ok
        })
        .is_err());
        assert!(validate_options(&RealmHostOptions {
            max_servers: 9,
            ..ok
        })
        .is_err());
        assert!(validate_options(&RealmHostOptions {
            afk_seconds: Some(0),
            ..ok
        })
        .is_ok());
        assert!(validate_options(&RealmHostOptions {
            afk_seconds: Some(7201),
            ..ok
        })
        .is_err());
    }

    #[test]
    fn account_ids_are_plain_tokens() {
        assert!(valid_account_id("5f3c9a0e-12ab-4c7d-9e11-0a0b0c0d0e0f"));
        assert!(valid_account_id("a"));
        assert!(!valid_account_id(""));
        assert!(valid_account_id(&"a".repeat(128)));
        assert!(!valid_account_id(&"a".repeat(129)));
        // The backend's AccountIdPattern also allows '.', '_' and ':'.
        assert!(valid_account_id("a.b_c:d-e"));
        assert!(!valid_account_id("a/b"));
        assert!(!valid_account_id("a b"));
        assert!(!valid_account_id("a\u{e9}"));
    }

    #[test]
    fn heartbeat_hosting_carries_afk_only_when_set() {
        let set = heartbeat_body(RealmHostOptions {
            max_players: 16,
            max_servers: 3,
            afk_seconds: Some(0),
        });
        assert_eq!(set["online"], json!(true));
        assert_eq!(set["hosting"]["maxServers"], json!(3));
        assert_eq!(set["hosting"]["maxPlayers"], json!(16));
        assert_eq!(set["hosting"]["afkSeconds"], json!(0));
        let unset = heartbeat_body(RealmHostOptions {
            max_players: 16,
            max_servers: 3,
            afk_seconds: None,
        });
        assert!(unset["hosting"].get("afkSeconds").is_none());
    }

    #[test]
    fn ban_reasons_are_trimmed_limited_and_plain() {
        assert_eq!(ban_reason(None), Ok(None));
        assert_eq!(ban_reason(Some("   ".into())), Ok(None));
        assert_eq!(
            ban_reason(Some("  griefing ".into())),
            Ok(Some("griefing".into()))
        );
        assert!(ban_reason(Some("a".repeat(201))).is_err());
        assert!(ban_reason(Some("a\nb".into())).is_err());
        assert!(ban_reason(Some("a".repeat(200))).is_ok());
    }

    #[test]
    fn the_status_and_options_wire_shape_is_the_contract() {
        let status = RealmHostStatus {
            state: HostState::Online,
            notice: Some("Refused.".into()),
            notice_kind: NoticeKind::Error,
            realm: Some(RealmSummary {
                name: "tempest".into(),
                serving: true,
                join_policy: "INVITE_ONLY".into(),
                join_request_count: 2,
            }),
            hub: Some(HubSummary {
                session_id: "s".into(),
                state: "RUNNING",
                started_at: None,
                players: 1,
            }),
            training: None,
            hunts: Vec::new(),
            players: vec![PlayerSummary {
                account_id: "a1".into(),
                display_name: None,
                location: Location {
                    kind: LocationKind::Hub,
                    session_id: "s".into(),
                    hunt_id: None,
                },
                since: Some("t".into()),
                route: None,
            }],
            bans: Vec::new(),
            capacity: CapacitySummary {
                max_servers: 2,
                active_servers: 1,
                max_players: 16,
                afk_seconds: None,
                free_mem_mib: 9000,
                total_mem_mib: 16000,
            },
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["state"], json!("online"));
        assert_eq!(value["realm"]["serving"], json!(true));
        assert_eq!(value["hub"]["sessionId"], json!("s"));
        assert_eq!(value["players"][0]["where"]["kind"], json!("HUB"));
        assert_eq!(value["players"][0]["where"]["sessionId"], json!("s"));
        assert_eq!(value["capacity"]["freeMemMiB"], json!(9000));
        assert_eq!(value["capacity"]["totalMemMiB"], json!(16000));
        assert_eq!(value["capacity"]["maxServers"], json!(2));
        assert_eq!(value["notice"], json!("Refused."));
        assert_eq!(value["noticeKind"], json!("error"));
        let options: RealmHostOptions =
            serde_json::from_value(json!({ "maxPlayers": 16, "maxServers": 2 })).unwrap();
        assert_eq!(options.afk_seconds, None);
    }

    #[test]
    fn a_notice_says_whether_it_is_information_or_a_refusal() {
        assert_eq!(
            serde_json::to_value(NoticeKind::Info).unwrap(),
            json!("info")
        );
        assert_eq!(
            serde_json::to_value(NoticeKind::Error).unwrap(),
            json!("error")
        );
        assert_eq!(NoticeKind::default(), NoticeKind::Info);
        assert_eq!(info_notice("a").kind, NoticeKind::Info);
        assert_eq!(error_notice("b").kind, NoticeKind::Error);
    }

    #[test]
    fn a_member_is_told_about_a_host_that_went_away_or_a_kick_or_ban_only() {
        for reason in ["HOST_OFFLINE", "HOST_LEASE_LOST", "HOST_STOPPED"] {
            assert_eq!(
                leave_notice(reason),
                Some(RealmNotice {
                    reason: "HOST_OFFLINE",
                    message: "The realm host went offline."
                }),
                "{reason}"
            );
        }
        assert_eq!(
            leave_notice("KICKED"),
            Some(RealmNotice {
                reason: "KICKED",
                message: "You were removed from the realm."
            })
        );
        assert_eq!(
            leave_notice("BANNED"),
            Some(RealmNotice {
                reason: "BANNED",
                message: "You were banned from this realm."
            })
        );
        // A travel to a realm hunt, a plain leave and the other end reasons need no banner.
        for reason in ["TRAVEL", "LEFT", "REALM_RELEASED", "UNKNOWN", ""] {
            assert_eq!(leave_notice(reason), None, "{reason}");
        }
    }

    /// [2026-10-15] The host's own row goes to the listed session its game last connected to, and only while the game runs
    /// on this PC. A plain hunt is never chosen, and a session with no local admission is not the host's place.
    #[test]
    fn the_host_is_listed_where_its_own_game_last_connected() {
        use crate::p2p::session::SessionLive;
        let session = |session_id: &str,
                       kind: SessionKind,
                       hub_kind: Option<HubKind>,
                       realm: bool,
                       local: Option<&str>| HostedSession {
            session_id: session_id.to_string(),
            generation: 1,
            kind,
            hub_kind,
            realm,
            live: SessionLive {
                hunt_id: "Adventure_IslandA".to_string(),
                local_since: local.map(str::to_string),
                ..Default::default()
            },
        };
        let sessions = vec![
            session(
                "hub",
                SessionKind::HubHost,
                Some(HubKind::Ramsgate),
                true,
                Some("2026-10-15T10:00:00.000Z"),
            ),
            session(
                "training",
                SessionKind::HubHost,
                Some(HubKind::Training),
                true,
                Some("2026-10-15T09:00:00.000Z"),
            ),
            session(
                "realm-hunt",
                SessionKind::HuntHost,
                None,
                true,
                Some("2026-10-15T10:05:00.000Z"),
            ),
            session(
                "plain-hunt",
                SessionKind::HuntHost,
                None,
                false,
                Some("2026-10-15T10:09:00.000Z"),
            ),
            session("empty-hunt", SessionKind::HuntHost, None, true, None),
        ];
        // The latest admission among the listed sessions: the realm hunt (the plain hunt is not listed).
        assert_eq!(
            host_place(&sessions, true).map(|found| found.session_id.as_str()),
            Some("realm-hunt")
        );
        // The game is not running on this PC: nothing is listed for the host.
        assert!(host_place(&sessions, false).is_none());
        // No local admission at all: the host is not placed anywhere.
        let unseen = vec![session(
            "hub",
            SessionKind::HubHost,
            Some(HubKind::Ramsgate),
            true,
            None,
        )];
        assert!(host_place(&unseen, true).is_none());

        // Named as the panel names places: a hunt by its hunt, Ramsgate and Training by their hub.
        let hunt = place_of(host_place(&sessions, true).expect("placed"));
        assert_eq!(hunt.kind, LocationKind::Hunt);
        assert_eq!(hunt.hunt_id.as_deref(), Some("Adventure_IslandA"));
        assert_eq!(hunt.session_id, "realm-hunt");
        assert_eq!(place_of(&sessions[0]).kind, LocationKind::Hub);
        assert_eq!(place_of(&sessions[1]).kind, LocationKind::Training);

        // The row: the signed-in account, since its admission, and no route (the game has none to report).
        let account = HostAccount {
            account_id: "acc-host".to_string(),
            display_name: Some("Host".to_string()),
        };
        let row = host_player(&sessions[2], &account);
        assert_eq!(row.account_id, "acc-host");
        assert_eq!(row.display_name.as_deref(), Some("Host"));
        assert_eq!(row.since.as_deref(), Some("2026-10-15T10:05:00.000Z"));
        assert_eq!(row.location.kind, LocationKind::Hunt);
        assert!(row.route.is_none());
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-realm-limits-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn limits(max_players: u32, max_servers: u32, afk: Option<u32>) -> RealmHostOptions {
        RealmHostOptions {
            max_players,
            max_servers,
            afk_seconds: afk,
        }
    }

    #[test]
    fn the_limits_of_each_server_are_saved_and_come_back() {
        let dir = scratch_dir("roundtrip");
        // Nothing saved yet: nothing is read back, and nothing is written.
        assert!(read_limits(&dir).unwrap().0.is_empty());
        update_limits_in(&dir, |_| {}).unwrap();
        assert!(!dir.join(LIMITS_FILE).exists());

        update_limits_in(&dir, |servers| {
            servers.insert("official".into(), limits(24, 3, Some(1200)));
            servers.insert("s-aaaaaaaaaaaa".into(), limits(8, 2, None));
        })
        .unwrap();
        assert!(!dir.join("realm-host-limits.json.tmp").exists());
        let (saved, damaged) = read_limits(&dir).unwrap();
        assert!(!damaged);
        assert_eq!(saved.get("official"), Some(&limits(24, 3, Some(1200))));
        assert_eq!(saved.get("s-aaaaaaaaaaaa"), Some(&limits(8, 2, None)));

        // Removing a server removes only its entry; removing a missing one writes nothing.
        let before = std::fs::read_to_string(dir.join(LIMITS_FILE)).unwrap();
        update_limits_in(&dir, |servers| {
            servers.remove("nobody");
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(LIMITS_FILE)).unwrap(),
            before
        );
        update_limits_in(&dir, |servers| {
            servers.remove("s-aaaaaaaaaaaa");
        })
        .unwrap();
        let (saved, _) = read_limits(&dir).unwrap();
        assert_eq!(saved.len(), 1);
        assert!(saved.contains_key("official"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn limits_that_fail_their_checks_are_not_restored() {
        let dir = scratch_dir("invalid");
        std::fs::write(
            dir.join(LIMITS_FILE),
            r#"{"version":1,"servers":{
                "good":{"maxPlayers":16,"maxServers":3,"afkSeconds":0},
                "too-many":{"maxPlayers":65,"maxServers":3},
                "no-servers":{"maxPlayers":16,"maxServers":0},
                "afk-too-long":{"maxPlayers":16,"maxServers":3,"afkSeconds":7201}
            }}"#,
        )
        .unwrap();
        let (saved, damaged) = read_limits(&dir).unwrap();
        assert!(!damaged);
        assert_eq!(
            saved.keys().map(String::as_str).collect::<Vec<_>>(),
            ["good"]
        );
        assert_eq!(saved.get("good"), Some(&limits(16, 3, Some(0))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_limits_file_is_set_aside_before_the_next_write() {
        let dir = scratch_dir("damaged");
        std::fs::write(dir.join(LIMITS_FILE), "{ not json").unwrap();
        assert!(read_limits(&dir).unwrap().1, "reported as damaged");
        update_limits_in(&dir, |servers| {
            servers.insert("official".into(), limits(16, 2, None));
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("realm-host-limits.json.bad")).unwrap(),
            "{ not json"
        );
        let (saved, damaged) = read_limits(&dir).unwrap();
        assert!(!damaged);
        assert_eq!(saved.get("official"), Some(&limits(16, 2, None)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_limits_file_is_written_in_the_wire_shape() {
        let dir = scratch_dir("shape");
        update_limits_in(&dir, |servers| {
            servers.insert("official".into(), limits(16, 3, None));
        })
        .unwrap();
        let text = std::fs::read_to_string(dir.join(LIMITS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], json!(1));
        assert_eq!(value["servers"]["official"]["maxPlayers"], json!(16));
        assert_eq!(value["servers"]["official"]["maxServers"], json!(3));
        assert_eq!(value["servers"]["official"]["afkSeconds"], json!(null));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failures_read_as_the_backend_said_them() {
        let failure = Failure {
            status: 403,
            code: "REALM_HOST_INELIGIBLE".into(),
            message: String::new(),
            reason: Some("HOST_MEMORY_LOW".into()),
        };
        assert_eq!(
            failure.readable(),
            "This PC cannot host the realm right now: it has too little free memory."
        );
        let other = Failure {
            status: 503,
            code: "P2P_DISABLED".into(),
            message: "Realm hosting is switched off on this server.".into(),
            reason: None,
        };
        assert_eq!(
            other.readable(),
            "Realm hosting is switched off on this server."
        );
    }
}
