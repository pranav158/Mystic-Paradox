use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, TerminateProcess, WaitForSingleObject, PROCESS_INFORMATION,
    STARTF_USESHOWWINDOW, STARTUPINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
use zeroize::Zeroize;

use crate::commands::auth::{
    api_base_url, fetch_policy, http_client, refresh_native_session, safe_api_error,
};
use crate::install::{paths, verify};
use crate::launch::process;
use crate::p2p::transport;
use crate::p2p::P2PStartResult;

mod host;
mod hub;
mod ice;

pub(crate) use host::start_host_bundle;
use hub::SyncCommand;
pub(crate) use hub::{
    set_hub_afk_seconds, HubKind, PeerLive, SessionKind, SessionLive, SharedLive,
};
use transport::SessionHandle;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
/// The switches every DeployServer game server gets after its positional arguments (`STANDARD_GAMESERVER_ARGS`,
/// ParadoxDirector/src/controllers/gameservers.ts); keep both lists equal. Without `LogLoad Off` the headless
/// 1.14.7 client build fills its log past 500 MB with "WorldContext requested with invalid context object" - on
/// the player's PC here.
const DIRECTOR_SERVER_SWITCHES: [&str; 7] = [
    "-EpicPortal",
    "-server",
    "-nullrhi",
    "-warp",
    "-nosound",
    "-RepDriverEnable",
    "-LogCmds=\"LogPhoenixCharacter VeryVerbose, LogOnline Verbose, LogLoad Off\"",
];
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_READY_MESSAGE: usize = 512;
const MAX_BRIDGE_LOG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactHashes {
    game_exe: String,
    internal_server: String,
    winmm_proxy: String,
    transport_module: String,
    transport_runtime: String,
    admission_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommonBootstrap {
    key_id: String,
    session_id: String,
    party_id: String,
    party_revision: u64,
    hunt_definition_id: String,
    guard_completion_mode: String,
    generation: u32,
    build: u32,
    bridge_protocol: u16,
    virtual_port: u16,
    host_peer_id: String,
    bridge_instance_id: String,
    metadata_nonce: String,
    force_relay: bool,
    artifacts: ArtifactHashes,
    /// False when the server has no anti-cheat module: no process is opted into hunt evidence. Older servers
    /// always collected it.
    #[serde(default = "collects_evidence_by_default")]
    evidence_collection: bool,
    /// [2026-10-13] The hunt's frozen co-op transport: "ICE" (session/ice.rs) or "STEAM_EXPERIMENTAL". Servers
    /// before the ICE transport do not send it; their hunts are Steam.
    #[serde(default = "steam_transport_by_default")]
    coop_transport: String,
    /// [2026-10-14] `REALM_HUB` for a realm's hub; `HUNT` (or absent: an older backend) for every hunt.
    #[serde(default = "hunt_session_kind_by_default")]
    session_kind: String,
    /// `RAMSGATE` or `TRAINING` for a hub.
    #[serde(default)]
    hub_kind: Option<String>,
    #[serde(default)]
    hub_room_id: Option<String>,
    /// The hub's player cap (`maxPlayers`).
    #[serde(default)]
    max_players: Option<u32>,
    /// False for a realm hunt the host does not take part in: no host ticket, no local client, no route-ready.
    #[serde(default = "true_by_default")]
    host_participates: bool,
    /// Whether the host PC's own client plays this session through a local bridge (a hub always does).
    #[serde(default = "true_by_default")]
    host_local_client: bool,
    /// [2026-10-14] A realm hunt's realm, when the backend names one. Absent for a plain hunt (and an older backend).
    #[serde(default)]
    realm_id: Option<String>,
}

fn collects_evidence_by_default() -> bool {
    true
}

fn steam_transport_by_default() -> String {
    "STEAM_EXPERIMENTAL".to_string()
}

fn hunt_session_kind_by_default() -> String {
    "HUNT".to_string()
}

fn true_by_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostBootstrap {
    #[serde(flatten)]
    common: CommonBootstrap,
    /// The server process authenticates with it whether or not the host's own client plays the session.
    #[serde(default)]
    capability: String,
    /// Empty when the host's client does not play this session.
    #[serde(default)]
    host_ticket: String,
    backend_url: String,
    server_udp_port: u16,
    maximum_peers: usize,
    matchmaker_hunt_id: String,
    map_path: String,
    behemoth_path: String,
    expected_players: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBootstrap {
    #[serde(flatten)]
    common: CommonBootstrap,
    ticket: String,
    lobby_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteReadyRequest<'a> {
    generation: u32,
    bridge_instance_id: &'a str,
    local_host: &'static str,
    local_port: u16,
}

enum SupervisorCommand {
    Stop,
    /// [2026-10-16] A hunt join's member entered a realm hub: end once the game has left the hunt (`hunt_join_leave_outcome`),
    /// not at once. A loop that does not tell the commands apart treats it as `Stop`.
    StopWhenGameLeaves,
}

/// [2026-10-16] How long the game must send nothing to a hunt it is leaving before the hunt's join ends, and the longest a join
/// waits for that. The transport writes `UDP_STATS` every 2 s, so 6 s is three lines without a new packet from the game.
pub(super) const GAME_LEFT_IDLE: Duration = Duration::from_secs(6);
pub(super) const HUNT_JOIN_LEAVE_MAX: Duration = Duration::from_secs(120);

/// The game's packets into a join (`localRx` of the transport's `UDP_STATS` line), and when that count last grew.
pub(super) struct GameTrafficWatch {
    local_rx: Option<u64>,
    last_change: Instant,
}

impl GameTrafficWatch {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            local_rx: None,
            last_change: now,
        }
    }

    /// One diagnostic line: a `UDP_STATS` line with a larger `localRx` than the last one moves `last_change` to `now`.
    pub(super) fn observe(&mut self, line: &str, now: Instant) {
        if let Some(rx) = udp_stats_local_rx(line) {
            let grew = match self.local_rx {
                Some(previous) => rx > previous,
                None => true,
            };
            if grew {
                self.last_change = now;
            }
            self.local_rx = Some(rx);
        }
    }

    /// Restarts the idle clock (when the leave is asked: the game may not have sent anything for a while before).
    pub(super) fn restart(&mut self, now: Instant) {
        self.last_change = now;
    }

    pub(super) fn idle(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_change)
    }
}

/// `localRx` of a transport `UDP_STATS` line (`UDP_STATS role=join path=remote localRx=1184 ...`), or None.
pub(super) fn udp_stats_local_rx(line: &str) -> Option<u64> {
    if !line.contains("UDP_STATS") {
        return None;
    }
    line.split_whitespace()
        .find_map(|field| field.strip_prefix("localRx="))
        .and_then(|value| value.parse::<u64>().ok())
}

/// [2026-10-16] Whether a hunt join asked to end when its game leaves may end now: "game_left" once the game has sent nothing for
/// `GAME_LEFT_IDLE`, "timeout" after `HUNT_JOIN_LEAVE_MAX`. The hub's entry (JOIN_RENDEZVOUS) comes when the airship's matchmaking
/// starts, before the game travels: ending the hunt's join there cut the link the game still needed, and the game timed out to the
/// login screen (16 Oct 09:29 UTC).
pub(super) fn hunt_join_leave_outcome(
    asked_at: Instant,
    traffic: &GameTrafficWatch,
    now: Instant,
) -> Option<&'static str> {
    if traffic.idle(now) >= GAME_LEFT_IDLE {
        Some("game_left")
    } else if now.saturating_duration_since(asked_at) >= HUNT_JOIN_LEAVE_MAX {
        Some("timeout")
    } else {
        None
    }
}

/// One supervised session. `kind`, `hub_kind`, `handle` and `live` are set once the bootstrap says what the session is
/// (before that, a registration only reserves the session id). `peer_sync` exists for a hub host only.
#[derive(Clone)]
struct SupervisorRegistration {
    sender: mpsc::Sender<SupervisorCommand>,
    monitored_pid: Option<u32>,
    generation: Option<u32>,
    kind: Option<SessionKind>,
    hub_kind: Option<HubKind>,
    /// A realm hunt (the host's launcher counts it as a realm session).
    realm: bool,
    handle: Option<SessionHandle>,
    live: Option<SharedLive>,
    peer_sync: Option<mpsc::Sender<SyncCommand>>,
}

/// How a session's transport module is reached: the Steam transport's one session, or an ICE session by handle.
#[derive(Clone, Copy)]
pub(super) enum Link {
    Steam,
    Ice(SessionHandle),
}

impl Link {
    fn wait_ready(self, timeout: Duration) -> Result<String, String> {
        match self {
            Link::Steam => transport::wait_ready(timeout),
            Link::Ice(handle) => handle.wait_ready(timeout).into_result(),
        }
    }

    fn session_running(self) -> bool {
        match self {
            Link::Steam => transport::session_running(),
            Link::Ice(handle) => handle.session_running(),
        }
    }

    fn stop(self) {
        match self {
            Link::Steam => transport::stop_session(),
            Link::Ice(handle) => {
                handle.stop();
            }
        }
    }

    fn drain_diagnostics(self) -> Vec<String> {
        match self {
            Link::Steam => transport::drain_diagnostics(),
            Link::Ice(handle) => handle.drain_diagnostics(),
        }
    }
}

fn registry() -> &'static Mutex<HashMap<String, SupervisorRegistration>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, SupervisorRegistration>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PipeHandle(HANDLE);
unsafe impl Send for PipeHandle {}
impl Drop for PipeHandle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            value.as_mut_ptr(),
            value.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err("Windows could not create secure session randomness.".to_string());
    }
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn regular_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "A required player-host runtime artifact is missing.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.len() == 0
    {
        return Err("A player-host runtime artifact is not a regular file.".to_string());
    }
    Ok(())
}

fn verify_hash(path: &Path, expected: &str) -> Result<(), String> {
    regular_file(path)?;
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The backend returned an invalid runtime hash policy.".to_string());
    }
    let actual = verify::hash_file_sha256(path)?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!(
            "Player-host runtime verification failed for {}.",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("artifact")
        ));
    }
    Ok(())
}

struct RuntimePaths {
    game_exe: PathBuf,
    admission_key: PathBuf,
}

fn verified_runtime(app: &AppHandle, hashes: &ArtifactHashes) -> Result<RuntimePaths, String> {
    let game_exe = paths::load_saved_exe_path(app)
        .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
    let game_dir = paths::game_dir(&game_exe)?;
    let coop = crate::p2p::coop_artifacts()
        .ok_or_else(|| "Co-op is off for this launcher.".to_string())?;
    // The runtime DLL and its loader by Guard role, like the co-op files: the signed manifest names them.
    let internal_server = game_dir.join(&coop.internal_server);
    let winmm = game_dir.join(&coop.udp_proxy);
    let transport = game_dir.join(&coop.transport_module);
    let transport_runtime = game_dir.join(&coop.transport_runtime);
    let admission_key = game_dir.join(&coop.admission_key);
    for (path, expected) in [
        (&game_exe, &hashes.game_exe),
        (&internal_server, &hashes.internal_server),
        (&winmm, &hashes.winmm_proxy),
        (&transport, &hashes.transport_module),
        (&transport_runtime, &hashes.transport_runtime),
        (&admission_key, &hashes.admission_public_key),
    ] {
        verify_hash(path, expected)?;
    }
    Ok(RuntimePaths {
        game_exe,
        admission_key,
    })
}

fn session_directory(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Couldn't resolve launcher session storage.".to_string())?
        .join("p2p-sessions");
    std::fs::create_dir_all(&root)
        .map_err(|_| "Couldn't create player-host session storage.".to_string())?;
    let directory = root.join(format!("{session_id}-{generation}-{}", random_hex(8)?));
    std::fs::create_dir(&directory)
        .map_err(|_| "Couldn't create private player-host session storage.".to_string())?;
    Ok(directory)
}

struct BoundedLog {
    file: File,
    written: u64,
}

type SharedLog = Arc<Mutex<BoundedLog>>;

fn session_log(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
    role: &str,
) -> Result<(PathBuf, SharedLog), String> {
    let root = process::current_session_log_dir()
        .or_else(|| app.path().app_local_data_dir().ok())
        .ok_or_else(|| "Couldn't resolve launcher log storage.".to_string())?
        .join("p2p-logs");
    std::fs::create_dir_all(&root)
        .map_err(|_| "Couldn't create player-host log storage.".to_string())?;
    let path = root.join(format!(
        "{session_id}-{generation}-{role}-{}.log",
        random_hex(6)?
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Couldn't create the player-host session log.".to_string())?;
    let header = format!("Mystic P2P session={session_id} generation={generation} role={role}\n");
    file.write_all(header.as_bytes())
        .map_err(|_| "Couldn't initialize the player-host session log.".to_string())?;
    Ok((
        path,
        Arc::new(Mutex::new(BoundedLog {
            file,
            written: header.len() as u64,
        })),
    ))
}

fn append_log(log: &SharedLog, stream: &str, line: &str) {
    let bounded = line.chars().take(4096).collect::<String>();
    let entry = format!("[{stream}] {bounded}");
    process::append_active_session_log(&sanitize_central_log_line(&entry));
    let Ok(mut state) = log.lock() else { return };
    if state.written >= MAX_BRIDGE_LOG_BYTES {
        return;
    }
    let entry = format!("{entry}\n");
    let remaining = (MAX_BRIDGE_LOG_BYTES - state.written) as usize;
    let bytes = entry.as_bytes();
    let to_write = bytes.len().min(remaining);
    if state.file.write_all(&bytes[..to_write]).is_ok() {
        state.written += to_write as u64;
        let _ = state.file.flush();
    }
}

fn sanitize_central_log_line(line: &str) -> String {
    let mut sanitized = String::with_capacity(line.len().min(2048));
    for (index, part) in line.split_whitespace().enumerate() {
        if index > 0 {
            sanitized.push(' ');
        }
        let lower = part.to_ascii_lowercase();
        let sensitive = [
            "ticket",
            "capability",
            "token",
            "challenge",
            "secret",
            "signature",
            "password",
            "auth_password",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        if sensitive {
            if let Some((key, _)) = part.split_once('=') {
                sanitized.push_str(key);
                sanitized.push_str("=[redacted]");
            } else {
                sanitized.push_str("[redacted]");
            }
        } else {
            sanitized.push_str(part);
        }
        if sanitized.len() >= 2048 {
            sanitized = sanitized.chars().take(2048).collect();
            break;
        }
    }
    sanitized
}

fn log_host_failure(log: &SharedLog, stage: &str, reason: &str) {
    let line = format!("p2p host bootstrap failed stage={stage} reason={reason}");
    append_log(log, "launcher", &line);
}

fn child_exit_reason(child: &mut HostProcess) -> String {
    match child.try_wait() {
        Ok(Some(code)) => format!("child_exit_code={code}"),
        Ok(None) => "child_still_running".to_string(),
        Err(_) => "child_status_unavailable".to_string(),
    }
}

fn drain_transport_diagnostics(log: &SharedLog, link: Link) {
    for line in link.drain_diagnostics() {
        append_log(log, "transport", &line);
    }
}

/// [2026-10-16] A join's diagnostics: logged, and the game's traffic counted (`GameTrafficWatch`).
fn drain_join_diagnostics(log: &SharedLog, link: Link, traffic: &mut GameTrafficWatch) {
    let now = Instant::now();
    for line in link.drain_diagnostics() {
        traffic.observe(&line, now);
        append_log(log, "transport", &line);
    }
}

/// [2026-10-15] A host session's diagnostics: logged, and this PC's own admission (`ADMISSION_ACCEPTED role=host ...
/// source=local`) applied to the session's live state. The transport reports that admission as a diagnostic, not a peer
/// event, so until now the realm panel never saw the host's own game and showed 0 players (15 Oct repro).
fn drain_host_diagnostics(log: &SharedLog, link: Link, live: &hub::SharedLive) {
    for line in link.drain_diagnostics() {
        append_log(log, "transport", &line);
        if hub::is_local_admission(&line) {
            hub::apply_peer_line(live, &line, &crate::launch::logs::iso8601_now());
        }
    }
}

fn write_once(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Couldn't create one-use player-host material.".to_string())?;
    file.write_all(contents)
        .and_then(|_| file.flush())
        .map_err(|_| "Couldn't persist one-use player-host material.".to_string())
}

fn safe_config_value(value: &str, maximum: usize) -> Result<&str, String> {
    if value.is_empty() || value.len() > maximum || value.contains(['\r', '\n', '\0']) {
        return Err("The backend returned unsafe player-host bootstrap data.".to_string());
    }
    Ok(value)
}

fn host_server_arguments(
    server_udp_port: u16,
    map_path: &str,
    behemoth_path: &str,
    matchmaker_hunt_id: &str,
    expected_players: &str,
) -> Vec<String> {
    let mut arguments = vec![
        // DeployServer's first argument is its gameserver API key; a player host has none (it authenticates with
        // its hunt capability), and the runtime requires this placeholder in host mode.
        "-".to_string(),
        server_udp_port.to_string(),
        map_path.to_string(),
        behemoth_path.to_string(),
        matchmaker_hunt_id.to_string(),
        expected_players.to_string(),
        format!("127.0.0.1:{server_udp_port}"),
    ];
    arguments.extend(
        DIRECTOR_SERVER_SWITCHES
            .iter()
            .map(|switch| switch.to_string()),
    );
    // Host only: bind loopback (the runtime refuses host mode without it).
    arguments.push("-MULTIHOME=127.0.0.1".to_string());
    arguments
}

/// The Trials week a Trials hunt is pinned to (`MYSTICPARADOX_TRIALS_WEEK`), read from its matchmaker row as
/// DeployServer does, so a Trial keeps the row it was frozen with even if the weekly rotation moves on.
fn trials_week(matchmaker_hunt_id: &str) -> Option<&str> {
    let week = ["Easy", "Hard", "Elite"].iter().find_map(|tier| {
        matchmaker_hunt_id
            .strip_prefix("Arena_MatchmakerHunt_")?
            .strip_prefix(tier)?
            .strip_prefix('_')
    })?;
    (week.len() == 3 && week.bytes().all(|byte| byte.is_ascii_digit())).then_some(week)
}

/// One Windows command line with the MSVC quoting std's `Command` (and Node's `spawn`, which the Director uses)
/// applies: the program always quoted, an argument with a space or tab quoted, quotes and the backslashes before
/// them escaped.
fn windows_command_line(program: &Path, arguments: &[String]) -> String {
    fn append(line: &mut String, argument: &str, force_quotes: bool) {
        let quote = force_quotes || argument.is_empty() || argument.contains([' ', '\t']);
        if quote {
            line.push('"');
        }
        let mut backslashes = 0usize;
        for character in argument.chars() {
            if character == '\\' {
                backslashes += 1;
            } else {
                if character == '"' {
                    line.extend(std::iter::repeat_n('\\', backslashes + 1));
                }
                backslashes = 0;
            }
            line.push(character);
        }
        if quote {
            line.extend(std::iter::repeat_n('\\', backslashes));
            line.push('"');
        }
    }
    let mut line = String::new();
    append(&mut line, &program.to_string_lossy(), true);
    for argument in arguments {
        line.push(' ');
        append(&mut line, argument, false);
    }
    line
}

/// The host's Unicode environment block: the launcher's environment without `removed`, with `set` applied.
fn host_environment(set: &[(&str, &str)], removed: &[&str]) -> Vec<u16> {
    let replaced = |key: &OsString| {
        let key = key.to_string_lossy();
        removed
            .iter()
            .chain(set.iter().map(|(name, _)| name))
            .any(|name| key.eq_ignore_ascii_case(name))
    };
    let mut entries = std::env::vars_os()
        .filter(|(key, _)| !replaced(key))
        .chain(set.iter().map(|(name, value)| (name.into(), value.into())))
        .collect::<Vec<(OsString, OsString)>>();
    entries.sort_by_cached_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(key.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// The player-host server process. It is created with CreateProcessW because the 1.14.7 game is a GUI program
/// that opens a render window even with `-nullrhi`: `CREATE_NO_WINDOW` does not hide it, and std's `Command`
/// cannot set `wShowWindow` on stable Rust. `STARTF_USESHOWWINDOW` + `SW_HIDE` is what the Director's
/// `windowsHide` does for its dedicated servers.
struct HostProcess {
    handle: HANDLE,
    id: u32,
}

// A process handle has no thread affinity; exactly one owner closes it (Drop).
unsafe impl Send for HostProcess {}

impl HostProcess {
    /// Created suspended, hidden, in its own process group and outside an inherited job, so it can be assigned to
    /// launcher protection before its first instruction runs. Returns the Win32 error on failure.
    fn spawn_suspended_hidden(
        program: &Path,
        arguments: &[String],
        directory: &Path,
        environment: &mut [u16],
    ) -> Result<Self, u32> {
        let program_w = program
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let mut command_line = wide(&windows_command_line(program, arguments));
        let directory_w = directory
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE as u16;
        let mut information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                program_w.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0, // bInheritHandles = FALSE
                CREATE_NO_WINDOW
                    | CREATE_NEW_PROCESS_GROUP
                    | CREATE_SUSPENDED
                    | CREATE_BREAKAWAY_FROM_JOB
                    | CREATE_UNICODE_ENVIRONMENT,
                environment.as_mut_ptr().cast(),
                directory_w.as_ptr(),
                &startup,
                &mut information,
            )
        };
        if created == 0 {
            return Err(unsafe { GetLastError() });
        }
        // The initial thread is resumed by id after the job assignment (supervisor::resume_initial_thread).
        unsafe { CloseHandle(information.hThread) };
        Ok(Self {
            handle: information.hProcess,
            id: information.dwProcessId,
        })
    }

    fn id(&self) -> u32 {
        self.id
    }

    fn raw_handle(&self) -> HANDLE {
        self.handle
    }

    /// The exit code once the process has exited.
    fn try_wait(&mut self) -> std::io::Result<Option<u32>> {
        match unsafe { WaitForSingleObject(self.handle, 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                if unsafe { GetExitCodeProcess(self.handle, &mut code) } == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Some(code))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(std::io::Error::last_os_error()),
        }
    }

    fn kill(&mut self) -> std::io::Result<()> {
        if unsafe { TerminateProcess(self.handle, 1) } != 0
            || matches!(self.try_wait(), Ok(Some(_)))
        {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

fn common_config(common: &CommonBootstrap) -> Result<String, String> {
    for (value, maximum) in [
        (common.key_id.as_str(), 32),
        (common.session_id.as_str(), 36),
        (common.party_id.as_str(), 192),
        (common.hunt_definition_id.as_str(), 128),
        (common.guard_completion_mode.as_str(), 32),
        (common.host_peer_id.as_str(), 20),
        (common.bridge_instance_id.as_str(), 96),
        (common.metadata_nonce.as_str(), 64),
    ] {
        safe_config_value(value, maximum)?;
    }
    Ok(format!(
        "key_id={}\nsession_id={}\nparty_id={}\nparty_revision={}\nhunt_definition_id={}\ngeneration={}\nbuild={}\nbridge_protocol={}\nvirtual_port={}\nhost_peer_id={}\nbridge_instance_id={}\nmetadata_nonce={}\n",
        common.key_id, common.session_id, common.party_id, common.party_revision,
        common.hunt_definition_id, common.generation, common.build, common.bridge_protocol,
        common.virtual_port, common.host_peer_id, common.bridge_instance_id, common.metadata_nonce
    ))
}

fn fetch_bootstrap<T: for<'de> Deserialize<'de>>(
    access_token: &str,
    session_id: &str,
    role: &str,
) -> Result<T, String> {
    let response = http_client()?
        .post(format!(
            "{}/launcher/v1/p2p/hunts/{session_id}/{role}-bootstrap",
            api_base_url()
        ))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Couldn't request the player-host bootstrap.".to_string())?;
    if !response.status().is_success() {
        return Err(safe_api_error(
            response,
            "Player-host bootstrap was rejected.",
        ));
    }
    response
        .json()
        .map_err(|_| "The backend returned an invalid player-host bootstrap.".to_string())
}

// A host bridge can take long enough to cross an access-token boundary. Keep the token owned by
// the control loop mutable so a one-time 401 retry both repairs this request and updates later
// presence/control acknowledgements. The refresh token remains DPAPI-protected and is never
// exposed to the webview or child processes.
fn publish_route_ready(
    app: &AppHandle,
    access_token: &mut String,
    session_id: &str,
    request: &RouteReadyRequest<'_>,
) -> Result<(), String> {
    let send = |token: &str| {
        http_client()?
            .post(format!(
                "{}/launcher/v1/p2p/hunts/{session_id}/route-ready",
                api_base_url()
            ))
            .bearer_auth(token)
            .json(request)
            .send()
            .map_err(|_| "Couldn't publish the local bridge route.".to_string())
    };

    let mut response = send(access_token)?;
    if response.status().as_u16() == 401 {
        let refreshed = refresh_native_session(app)?;
        *access_token = refreshed.access_token;
        response = send(access_token)?;
    }
    if response.status().is_success() {
        Ok(())
    } else {
        Err(safe_api_error(
            response,
            "The local bridge route was rejected.",
        ))
    }
}

/// [2026-10-13 1.14.7] The player-host server can run at Low integrity: an executable in a folder with a Low
/// mandatory label starts at Low (the development PC's checkout has one). A pipe with the default security has a
/// Medium label, and Windows refused the Low host's write with ERROR_ACCESS_DENIED - the first live ICE host failed
/// there. The ready pipe grants SYSTEM and the owner (this user) and carries a Low no-write-up label; the random pipe
/// name and the client process id check stay the gate. ParadoxTransport's Guard event pipe uses the same descriptor.
const READY_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)S:(ML;;NW;;;LW)";

/// A security descriptor from `ConvertStringSecurityDescriptorToSecurityDescriptorW`, freed on drop.
struct PipeSecurity(PSECURITY_DESCRIPTOR);

impl PipeSecurity {
    fn from_sddl(sddl: &str) -> Result<Self, String> {
        let sddl_w = wide(sddl);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_w.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 || descriptor.is_null() {
            return Err("Couldn't prepare the InternalServer readiness pipe security.".to_string());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn create_ready_pipe(name: &str) -> Result<PipeHandle, String> {
    let name_w = wide(name);
    let security = PipeSecurity::from_sddl(READY_PIPE_SDDL)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            name_w.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_READY_MESSAGE as u32,
            MAX_READY_MESSAGE as u32,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("Couldn't create the InternalServer readiness pipe.".to_string());
    }
    Ok(PipeHandle(handle))
}

fn read_ready_pipe(pipe: PipeHandle, expected_pid: u32, expected: String) -> Result<(), String> {
    let connected = unsafe { ConnectNamedPipe(pipe.0, std::ptr::null_mut()) } != 0
        || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
    if !connected {
        return Err("InternalServer did not connect to its readiness pipe.".to_string());
    }
    let mut client_pid = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe.0, &mut client_pid) } == 0
        || client_pid != expected_pid
    {
        unsafe { DisconnectNamedPipe(pipe.0) };
        return Err("InternalServer readiness came from an unexpected process.".to_string());
    }
    let mut bytes = [0u8; MAX_READY_MESSAGE];
    let mut read = 0u32;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::ReadFile(
            pipe.0,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    unsafe { DisconnectNamedPipe(pipe.0) };
    if ok == 0
        || read == 0
        || read as usize >= bytes.len()
        || bytes[..read as usize] != *expected.as_bytes()
    {
        return Err("InternalServer returned an invalid readiness message.".to_string());
    }
    Ok(())
}

fn unblock_pipe(name: &str) {
    let name_w = wide(name);
    let handle = unsafe {
        CreateFileW(
            name_w.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(handle) };
    }
}

fn parse_local_route(line: &str, expected_state: &str, force_relay: bool) -> Result<u16, String> {
    let mut tokens = line.split_whitespace();
    if tokens.next() != Some(expected_state) {
        return Err(
            "The co-op transport module returned an unexpected readiness state.".to_string(),
        );
    }
    let mut fields = HashMap::new();
    for token in tokens {
        let Some((key, value)) = token.split_once('=') else {
            return Err("The co-op transport module returned a malformed local route.".to_string());
        };
        if key.is_empty() || value.is_empty() || fields.insert(key, value).is_some() {
            return Err("The co-op transport module returned a malformed local route.".to_string());
        }
    }
    if fields.get("localHost") != Some(&"127.0.0.1") || fields.get("relayReady") != Some(&"1") {
        return Err(
            "The co-op transport module did not return a verified loopback route.".to_string(),
        );
    }
    let expected_policy = if force_relay {
        "RELAY_ONLY"
    } else {
        "AUTOMATIC"
    };
    let expected_ice = if force_relay { "disabled" } else { "automatic" };
    if fields.get("routePolicy") != Some(&expected_policy)
        || fields.get("ice") != Some(&expected_ice)
    {
        return Err(
            "The co-op transport module returned a route outside the requested transport policy."
                .to_string(),
        );
    }
    fields
        .get("localPort")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "The co-op transport module returned an invalid local route.".to_string())
}

fn send_fence(pipe_name: &str, session_id: &str, generation: u32) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let name_w = wide(pipe_name);
    loop {
        let handle = unsafe {
            CreateFileW(
                name_w.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            let handle = PipeHandle(handle);
            let message = format!("MYS1 FENCE session={session_id} generation={generation}\n");
            let mut written = 0u32;
            let ok = unsafe {
                windows_sys::Win32::Storage::FileSystem::WriteFile(
                    handle.0,
                    message.as_ptr().cast(),
                    message.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            return (ok != 0 && written == message.len() as u32)
                .then_some(())
                .ok_or_else(|| "Couldn't deliver the player-host fence.".to_string());
        }
        if Instant::now() >= deadline {
            return Err("InternalServer control pipe was unavailable.".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct SupervisorReservation {
    session_id: String,
    receiver: Option<mpsc::Receiver<SupervisorCommand>>,
    keep_registered: bool,
}

impl SupervisorReservation {
    fn receiver(&mut self) -> mpsc::Receiver<SupervisorCommand> {
        self.receiver
            .take()
            .expect("supervisor receiver already taken")
    }

    fn commit(&mut self) {
        self.keep_registered = true;
    }
}

impl Drop for SupervisorReservation {
    fn drop(&mut self) {
        if !self.keep_registered {
            unregister(&self.session_id);
        }
    }
}

fn reserve_supervisor(session_id: &str) -> Result<SupervisorReservation, String> {
    // A player-host session reserved while the launcher is exiting would fence its server, start a
    // transport session and then lose the transport underneath it. Refuse instead.
    if crate::launch::is_shutting_down() {
        return Err("The launcher is closing; no new player-host session can start.".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    let mut sessions = registry()
        .lock()
        .map_err(|_| "Player-host registry is unavailable.".to_string())?;
    if sessions.contains_key(session_id) {
        return Err("This player-host session is already running.".to_string());
    }
    sessions.insert(
        session_id.to_string(),
        SupervisorRegistration {
            sender,
            monitored_pid: None,
            generation: None,
            kind: None,
            hub_kind: None,
            realm: false,
            handle: None,
            live: None,
            peer_sync: None,
        },
    );
    Ok(SupervisorReservation {
        session_id: session_id.to_string(),
        receiver: Some(receiver),
        keep_registered: false,
    })
}

fn unregister(session_id: &str) {
    if let Ok(mut sessions) = registry().lock() {
        sessions.remove(session_id);
        if crate::launch::is_shutting_down() {
            crate::launch::logs::append_shutdown_log(&format!(
                "shutdown stage=session_unregistered session={session_id} remaining={}",
                sessions.len()
            ));
        }
        if sessions.is_empty() && process::game_process_id().is_none() {
            transport::shutdown();
        }
    }
}

pub fn shutdown_transport_if_no_sessions() {
    // Keep the registry lock through shutdown. Otherwise a host supervisor can reserve a
    // session after the emptiness check but before the DLL is unloaded, leaving that newly
    // reserved session with a dead shared co-op transport.
    if let Ok(sessions) = registry().lock() {
        if sessions.is_empty() {
            transport::shutdown();
        }
    }
}

fn cleanup_directory(path: &Path) {
    let _ = std::fs::remove_file(path.join("capability.secret"));
    let _ = std::fs::remove_file(path.join("ticket.secret"));
    let _ = std::fs::remove_file(path.join("transport.secret"));
    let _ = std::fs::remove_file(path.join("bridge.conf"));
    let _ = std::fs::remove_dir(path);
}

struct SessionCleanup {
    path: PathBuf,
    handed_to_supervisor: bool,
}

impl SessionCleanup {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            handed_to_supervisor: false,
        }
    }

    fn commit(&mut self) {
        self.handed_to_supervisor = true;
    }
}

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        if !self.handed_to_supervisor {
            cleanup_directory(&self.path);
        }
    }
}

pub fn stop_session_generation(session_id: &str, generation: u32) -> Result<(), String> {
    let sender = registry()
        .lock()
        .map_err(|_| "Player-host registry is unavailable.".to_string())?
        .get(session_id)
        .filter(|entry| entry.generation == Some(generation))
        .map(|entry| entry.sender.clone())
        .ok_or_else(|| "That player-host generation is not running.".to_string())?;
    sender
        .send(SupervisorCommand::Stop)
        .map_err(|_| "The player-host supervisor is no longer available.".to_string())
}

/// Requests every launcher-owned player-host supervisor to stop and reports how many were asked.
/// This only signals; drain_sessions is what waits for the supervisors to release their child and
/// transport session.
pub fn stop_all_sessions() -> usize {
    let senders = registry()
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .map(|entry| entry.sender.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let requested = senders.len();
    for sender in senders {
        let _ = sender.send(SupervisorCommand::Stop);
    }
    requested
}

fn registry_is_empty() -> bool {
    registry()
        .lock()
        .map(|sessions| sessions.is_empty())
        .unwrap_or(true)
}

/// Wait (bounded) until every reserved supervisor has unregistered. Supervisors unregister only
/// after they have fenced their server, stopped their transport session and reaped their child, so an
/// empty registry means the launcher-owned work really is finished. Returns true when drained.
pub fn drain_sessions(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if registry_is_empty() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// [2026-10-13] An `ICE_SIGNAL` control message (control.rs): handed to the transport module only when this launcher
/// runs that session at that generation. False when it was not delivered.
pub fn deliver_ice_signal(
    session_id: &str,
    generation: Option<u32>,
    from_account_id: &str,
    kind: &str,
    data: &str,
) -> bool {
    // Several sessions run at once (a hub and its hunts), so the handle comes from this session's own registration.
    let target = registry().lock().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .map(|entry| (entry.generation, entry.handle))
    });
    let Some((running, Some(handle))) = target else {
        return false;
    };
    running.is_some() && running == generation && handle.submit_signal(from_account_id, kind, data)
}

pub fn is_session_running(session_id: &str) -> bool {
    registry()
        .lock()
        .map(|sessions| sessions.contains_key(session_id))
        .unwrap_or(false)
}

/// The server the Guard host role protects: the realm hub's when one runs, else the first hunt's (one pid per role).
/// (Guard's host role takes one pid per role; further hunts are not protected, design §11.7.)
pub fn guarded_host_process_id() -> Option<u32> {
    let sessions = registry().lock().ok()?;
    let hub = sessions
        .values()
        .find(|entry| entry.kind == Some(SessionKind::HubHost))
        .and_then(|entry| entry.monitored_pid);
    hub.or_else(|| {
        sessions
            .values()
            .find(|entry| entry.kind == Some(SessionKind::HuntHost))
            .and_then(|entry| entry.monitored_pid)
    })
}

/// Applies `update` to the session's registration. False when there is none (the caller decides whether that matters).
fn update_registration(session_id: &str, update: impl FnOnce(&mut SupervisorRegistration)) -> bool {
    if let Ok(mut sessions) = registry().lock() {
        if let Some(entry) = sessions.get_mut(session_id) {
            update(entry);
            return true;
        }
    }
    false
}

fn set_monitored_pid(session_id: &str, process_id: u32) {
    update_registration(session_id, |entry| entry.monitored_pid = Some(process_id));
}

fn set_generation(session_id: &str, generation: u32) {
    update_registration(session_id, |entry| entry.generation = Some(generation));
}

/// What the session is, once its bootstrap says so (a realm hub, a realm hunt or a plain hunt).
fn set_kind(session_id: &str, kind: SessionKind, hub_kind: Option<HubKind>, realm: bool) {
    update_registration(session_id, |entry| {
        entry.kind = Some(kind);
        entry.hub_kind = hub_kind;
        entry.realm = realm;
    });
}

/// [2026-10-15] What a join is, from its bootstrap: a realm hub's join, or a hunt's (a realm hunt when the bootstrap names its realm).
fn set_join_kind(session_id: &str, common: &CommonBootstrap) {
    let hub_join = common.session_kind == hub::HUB_SESSION_KIND;
    set_kind(
        session_id,
        SessionKind::join_of(hub_join),
        common.hub_kind.as_deref().and_then(HubKind::parse),
        hub_join || common.realm_id.is_some(),
    );
}

fn set_handle(session_id: &str, handle: SessionHandle) {
    update_registration(session_id, |entry| entry.handle = Some(handle));
}

/// [2026-10-14] Without a registration the session's peers never reach the realm status, so that is said in the session log
/// (the realm panel then shows nobody for it).
fn set_live(session_id: &str, live: SharedLive) {
    if !update_registration(session_id, |entry| entry.live = Some(live)) {
        process::append_active_session_log(&format!(
            "p2p status: no registration for session={session_id}; its peers are not listed"
        ));
    }
}

fn set_peer_sync(session_id: &str, sender: mpsc::Sender<SyncCommand>) {
    update_registration(session_id, |entry| entry.peer_sync = Some(sender));
}

/// A realm hub's host asked to re-read its roster now (`REALM_PEER_EXPECTED`). Ignored unless that generation runs.
pub fn request_peer_sync(session_id: &str, generation: u32) {
    let sender = registry().lock().ok().and_then(|sessions| {
        sessions
            .get(session_id)
            .filter(|entry| entry.generation == Some(generation))
            .and_then(|entry| entry.peer_sync.clone())
    });
    if let Some(sender) = sender {
        let _ = sender.send(SyncCommand::Now);
    }
}

/// A realm hub's join that is still registered is stopped (its member re-entered), and the call waits up to three
/// seconds for it to unregister so the new join does not meet "already running". False when it did not end in time.
pub fn replace_running_join(session_id: &str) -> bool {
    let sender = registry()
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(session_id).map(|entry| entry.sender.clone()));
    let Some(sender) = sender else {
        return true;
    };
    let _ = sender.send(SupervisorCommand::Stop);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !is_session_running(session_id) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// [2026-10-15] The hunt joins among the registrations, with their senders (pure, tested).
fn hunt_joins(
    sessions: &HashMap<String, SupervisorRegistration>,
) -> Vec<(String, mpsc::Sender<SupervisorCommand>)> {
    sessions
        .iter()
        .filter(|(_, entry)| entry.kind == Some(SessionKind::HuntJoin))
        .map(|(session_id, entry)| (session_id.clone(), entry.sender.clone()))
        .collect()
}

/// [2026-10-15] Ends this launcher's hunt joins when a realm hub join starts. The backend ends a hunt when its member asks for
/// a hub (`NoteHubReturn`) and sends the member's launcher no fence for it, so nothing else stops the hunt's transport session:
/// the game is back in the hub, while the host still lists the member in the hunt. The hub's entry (`JOIN_RENDEZVOUS` with
/// `sessionKind` `REALM_HUB`) is the one signal that the account is leaving its hunt, and one account is in one place.
/// [2026-10-16] That entry comes when the airship's matchmaking starts, while the game still plays the hunt and needs its link
/// to travel: ending the join at once timed the game out to the login screen (16 Oct 09:29 UTC). Each hunt join is now asked to
/// end once its game has left (`SupervisorCommand::StopWhenGameLeaves`: no packet from the game for `GAME_LEFT_IDLE`, at most
/// `HUNT_JOIN_LEAVE_MAX`); the hub join starts alongside, as the transport runs several sessions. Returns at once.
pub fn stop_hunt_joins_for_hub_join() {
    let joins = registry()
        .lock()
        .map(|sessions| hunt_joins(&sessions))
        .unwrap_or_default();
    for (session_id, sender) in &joins {
        process::append_active_session_log(&format!(
            "hunt join ends once the game leaves it: the account is entering a realm hub (session={session_id})"
        ));
        let _ = sender.send(SupervisorCommand::StopWhenGameLeaves);
    }
}

/// The relay credential of a running session, fetched again from the backend (`transport-config`). Transport ABI 3 has
/// no call that takes new secrets into a running session, so this only reports when the fresh credential expires; the
/// running session keeps the credential it started with (TODO: an ABI 4 `UpdateSecretsH` would apply it).
pub(crate) fn refresh_relay_expiry(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
) -> Result<Option<String>, String> {
    let config = ice::fetch_transport_config(app, session_id, generation)?;
    Ok(config.relay_expires_at())
}

/// A hosted session as the realm panel reads it.
#[derive(Clone, Debug)]
pub(crate) struct HostedSession {
    pub session_id: String,
    pub generation: u32,
    pub kind: SessionKind,
    pub hub_kind: Option<HubKind>,
    pub realm: bool,
    pub live: SessionLive,
}

/// The host sessions this launcher runs now (hubs, Training, hunts), with their live peers.
pub(crate) fn hosted_sessions() -> Vec<HostedSession> {
    // [2026-10-14] A lock poisoned by a panic elsewhere still holds the last state: the realm status keeps listing the
    // session's peers instead of dropping the session.
    let sessions = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sessions
        .iter()
        .filter_map(|(session_id, entry)| {
            let kind = entry.kind.filter(|kind| kind.is_host())?;
            let live = entry
                .live
                .as_ref()?
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Some(HostedSession {
                session_id: session_id.clone(),
                generation: entry.generation.unwrap_or(0),
                kind,
                hub_kind: entry.hub_kind,
                realm: entry.realm,
                live,
            })
        })
        .collect()
}

/// `realmHostSessions` in the presence heartbeat: the realm hub and realm hunts this launcher hosts. A realm hunt counts
/// only when its bootstrap names the realm (`CommonBootstrap::realm_id`).
pub(crate) fn realm_host_session_count() -> u32 {
    hosted_sessions()
        .iter()
        .filter(|session| session.kind.is_hub() || session.realm)
        .count() as u32
}

pub fn start_join_bundle(
    app: &AppHandle,
    access_token: &mut String,
    session_id: &str,
) -> Result<P2PStartResult, String> {
    let mut reservation = reserve_supervisor(session_id)?;
    let bootstrap: JoinBootstrap = fetch_bootstrap(access_token, session_id, "join")?;
    if bootstrap.common.coop_transport == "ICE" {
        if bootstrap.common.session_id != session_id || bootstrap.common.generation == 0 {
            return Err("The join bootstrap bindings are invalid.".to_string());
        }
        set_generation(session_id, bootstrap.common.generation);
        return ice::start_join(app, reservation, bootstrap, session_id);
    }
    ice::require_matching_module(false)?;
    if bootstrap.common.session_id != session_id
        || bootstrap.common.generation == 0
        || bootstrap
            .lobby_id
            .parse::<u64>()
            .ok()
            .filter(|value| *value != 0)
            .is_none()
    {
        return Err("The join bootstrap bindings are invalid.".to_string());
    }
    set_generation(session_id, bootstrap.common.generation);
    set_join_kind(session_id, &bootstrap.common);
    let runtime = verified_runtime(app, &bootstrap.common.artifacts)?;
    let session_dir = session_directory(app, session_id, bootstrap.common.generation)?;
    let mut session_cleanup = SessionCleanup::new(session_dir.clone());
    let (log_path, bridge_log) = session_log(app, session_id, bootstrap.common.generation, "join")?;
    let ticket_path = session_dir.join("ticket.secret");
    let config_path = session_dir.join("bridge.conf");
    write_once(&ticket_path, bootstrap.ticket.as_bytes())?;
    let mut config = common_config(&bootstrap.common)?;
    config.push_str(&format!(
        "lobby_id={}\nlocal_udp_port=0\nforce_relay={}\n",
        bootstrap.lobby_id, bootstrap.common.force_relay
    ));
    write_once(&config_path, config.as_bytes())?;
    if !transport::status().loaded {
        cleanup_directory(&session_dir);
        return Err(
            "The co-op connection is not running. Restart Dauntless from the Mystic launcher."
                .to_string(),
        );
    }
    if let Err(error) = transport::start_join(&runtime.admission_key, &config_path, &ticket_path) {
        cleanup_directory(&session_dir);
        return Err(error);
    }
    let ready_result = transport::wait_ready(READY_TIMEOUT);
    drain_transport_diagnostics(&bridge_log, Link::Steam);
    let ready = match ready_result {
        Ok(line) if line.starts_with("ROUTE_READY ") => line,
        Ok(_) => {
            transport::stop_session();
            cleanup_directory(&session_dir);
            return Err(
                "The co-op transport module returned an unexpected join readiness state."
                    .to_string(),
            );
        }
        Err(error) => {
            transport::stop_session();
            cleanup_directory(&session_dir);
            return Err(error);
        }
    };
    append_log(&bridge_log, "transport", &ready);
    let local_port = match parse_local_route(&ready, "ROUTE_READY", bootstrap.common.force_relay) {
        Ok(port) => port,
        Err(error) => {
            transport::stop_session();
            cleanup_directory(&session_dir);
            return Err(error);
        }
    };
    let _ = std::fs::remove_file(&ticket_path);
    let route_ready = RouteReadyRequest {
        generation: bootstrap.common.generation,
        bridge_instance_id: &bootstrap.common.bridge_instance_id,
        local_host: "127.0.0.1",
        local_port,
    };
    if let Err(error) = publish_route_ready(app, access_token, session_id, &route_ready) {
        transport::stop_session();
        cleanup_directory(&session_dir);
        return Err(error);
    }
    append_log(
        &bridge_log,
        "launcher",
        &format!(
            "ROUTE_READY role=join localHost=127.0.0.1 localPort={local_port} routePolicy={}",
            if bootstrap.common.force_relay {
                "RELAY_ONLY"
            } else {
                "AUTOMATIC"
            }
        ),
    );
    let receiver = reservation.receiver();
    let session_owned = session_id.to_string();
    let supervisor_log = Arc::clone(&bridge_log);
    std::thread::spawn(move || {
        loop {
            drain_transport_diagnostics(&supervisor_log, Link::Steam);
            if receiver.try_recv().is_ok() || !transport::session_running() {
                transport::stop_session();
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        drain_transport_diagnostics(&supervisor_log, Link::Steam);
        unregister(&session_owned);
        cleanup_directory(&session_dir);
    });
    reservation.commit();
    session_cleanup.commit();
    Ok(P2PStartResult {
        session_id: session_id.to_string(),
        generation: bootstrap.common.generation,
        role: "join",
        local_host: "127.0.0.1",
        local_port,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATS: &str = "UDP_STATS role=join path=remote localRx=1184 localTx=3467 transportRx=3467 transportTx=1184 \
                         oversized=0 foreign=0";

    /// [2026-10-16] The game's packets into a join are the transport's `localRx`; other lines and fields are not counted.
    #[test]
    fn udp_stats_local_rx_reads_the_games_packet_count() {
        assert_eq!(udp_stats_local_rx(STATS), Some(1184));
        assert_eq!(
            udp_stats_local_rx("ICE_READY role=join stun=1 turn=2 relayOnly=1 peers=1"),
            None
        );
        assert_eq!(udp_stats_local_rx("UDP_STATS role=join localRx=abc"), None);
        assert_eq!(udp_stats_local_rx("localRx=5 without the stats tag"), None);
    }

    /// [2026-10-16] A hunt join asked to end when its game leaves keeps running while the game sends, ends once it has sent
    /// nothing for GAME_LEFT_IDLE, and ends anyway after HUNT_JOIN_LEAVE_MAX (16 Oct: ending it at the hub's entry cut the link
    /// the game still needed to travel, and the airship timed out to the login screen).
    #[test]
    fn a_hunt_join_ends_once_its_game_has_left_or_after_the_limit() {
        let start = Instant::now();
        let mut traffic = GameTrafficWatch::new(start);
        traffic.observe(STATS, start);
        traffic.restart(start);
        // The game keeps sending: a larger localRx every 2 s.
        for (step, rx) in [(2, 1205), (4, 1225), (6, 1245), (8, 1266)] {
            let now = start + Duration::from_secs(step);
            traffic.observe(
                &STATS.replace("localRx=1184", &format!("localRx={rx}")),
                now,
            );
            assert_eq!(
                hunt_join_leave_outcome(start, &traffic, now),
                None,
                "still playing at {step}s"
            );
        }
        // The game travelled: the count stops growing.
        let last_change = start + Duration::from_secs(8);
        traffic.observe(
            &STATS.replace("localRx=1184", "localRx=1266"),
            last_change + Duration::from_secs(2),
        );
        assert_eq!(
            hunt_join_leave_outcome(start, &traffic, last_change + Duration::from_secs(5)),
            None
        );
        assert_eq!(
            hunt_join_leave_outcome(start, &traffic, last_change + GAME_LEFT_IDLE),
            Some("game_left")
        );

        // A game that never stops sending still ends at the limit.
        let mut busy = GameTrafficWatch::new(start);
        let at_limit = start + HUNT_JOIN_LEAVE_MAX;
        busy.observe(STATS, at_limit - Duration::from_secs(1));
        assert_eq!(
            hunt_join_leave_outcome(start, &busy, at_limit),
            Some("timeout")
        );
    }

    /// [2026-10-14] A peer the transport admits to a realm's hub, and one it admits to a realm hunt, both reach the realm
    /// status with their place and route, and each session counts its own. The sessions are registered as
    /// `start_host_bundle` registers them, and the lines are the ones the module queues (`PEER_CONNECTED`, then
    /// `PEER_ADMITTED`); `hub::apply_peer_line` is the step `pump` runs for each of them.
    #[test]
    fn an_admitted_peer_of_a_hub_and_of_a_realm_hunt_reaches_the_realm_status() {
        const ACCOUNT: &str = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
        const NOW: &str = "2026-10-14T05:51:19.873Z";
        const HUB: &str = "status-test-hub";
        const HUNT: &str = "status-test-hunt";
        let hub_live: SharedLive = Arc::new(Mutex::new(SessionLive {
            hunt_id: "ShatteredIsles_ReturnToRamsgate".to_string(),
            started_at: Some(NOW.to_string()),
            ..Default::default()
        }));
        let hunt_live: SharedLive = Arc::new(Mutex::new(SessionLive {
            hunt_id: "Adventure_IslandA".to_string(),
            ..Default::default()
        }));
        for (session_id, kind, hub_kind, live) in [
            (
                HUB,
                SessionKind::HubHost,
                Some(HubKind::Ramsgate),
                &hub_live,
            ),
            (HUNT, SessionKind::HuntHost, None, &hunt_live),
        ] {
            let mut reservation =
                reserve_supervisor(session_id).expect("the test session id is free");
            reservation.commit();
            set_kind(session_id, kind, hub_kind, true);
            set_live(session_id, Arc::clone(live));
        }
        for line in [
            format!("PEER_CONNECTED account={ACCOUNT} route=relay"),
            format!("PEER_ADMITTED account={ACCOUNT} route=relay"),
        ] {
            hub::apply_peer_line(&hub_live, &line, NOW);
        }
        hub::apply_peer_line(
            &hunt_live,
            &format!("PEER_ADMITTED account={ACCOUNT} route=relay"),
            NOW,
        );

        let status = crate::p2p::realm::snapshot(None, false);
        for session_id in [HUB, HUNT] {
            registry().lock().expect("registry").remove(session_id);
        }

        let ours: Vec<_> = status
            .players
            .iter()
            .filter(|player| player.location.session_id.starts_with("status-test-"))
            .collect();
        assert_eq!(ours.len(), 2, "one player in the hub and one in the hunt");
        let in_hub = ours
            .iter()
            .find(|player| player.location.session_id == HUB)
            .expect("the hub's player");
        assert_eq!(in_hub.location.kind, crate::p2p::realm::LocationKind::Hub);
        assert_eq!(in_hub.account_id, ACCOUNT);
        assert_eq!(in_hub.route.as_deref(), Some("relay"));
        assert_eq!(in_hub.since.as_deref(), Some(NOW));
        let in_hunt = ours
            .iter()
            .find(|player| player.location.session_id == HUNT)
            .expect("the hunt's player");
        assert_eq!(in_hunt.location.kind, crate::p2p::realm::LocationKind::Hunt);
        assert_eq!(
            in_hunt.location.hunt_id.as_deref(),
            Some("Adventure_IslandA")
        );
        let hunt_count: u32 = status
            .hunts
            .iter()
            .filter(|hunt| hunt.session_id == HUNT)
            .map(|hunt| hunt.players)
            .sum();
        assert_eq!(hunt_count, 1, "the hunt counts its own peer");
    }

    /// [2026-10-15] A realm hub's entry ends this launcher's hunt joins, and only those: a hub join, a host and a
    /// registration with no kind yet are left alone. The registrations are shaped as `reserve_supervisor` makes them,
    /// in a map of its own, so the test does not share the process-wide registry.
    #[test]
    fn a_hub_entry_ends_the_hunt_joins_and_no_other_session() {
        let registration = |kind: Option<SessionKind>| {
            let (sender, _receiver) = mpsc::channel();
            SupervisorRegistration {
                sender,
                monitored_pid: None,
                generation: Some(1),
                kind,
                hub_kind: None,
                realm: kind == Some(SessionKind::HuntJoin),
                handle: None,
                live: None,
                peer_sync: None,
            }
        };
        let sessions: HashMap<String, SupervisorRegistration> = [
            ("hunt-join", Some(SessionKind::HuntJoin)),
            ("hub-join", Some(SessionKind::HubJoin)),
            ("hunt-host", Some(SessionKind::HuntHost)),
            ("reserved", None),
        ]
        .into_iter()
        .map(|(session_id, kind)| (session_id.to_string(), registration(kind)))
        .collect();
        let joined: Vec<String> = hunt_joins(&sessions)
            .into_iter()
            .map(|(session_id, _)| session_id)
            .collect();
        assert_eq!(joined, vec!["hunt-join".to_string()]);
        assert!(hunt_joins(&HashMap::new()).is_empty());
    }

    #[test]
    fn local_route_parser_requires_loopback_and_forced_relay_policy() {
        assert_eq!(
            parse_local_route(
                "ROUTE_READY localHost=127.0.0.1 localPort=42100 routePolicy=RELAY_ONLY ice=disabled relayReady=1",
                "ROUTE_READY",
                true,
            )
            .unwrap(),
            42100
        );
        assert!(parse_local_route(
            "ROUTE_READY localHost=127.0.0.1 localPort=0 routePolicy=RELAY_ONLY ice=disabled relayReady=1",
            "ROUTE_READY",
            true,
        )
        .is_err());
        assert!(parse_local_route(
            "ROUTE_READY localHost=192.168.1.20 localPort=42100 routePolicy=RELAY_ONLY ice=disabled relayReady=1",
            "ROUTE_READY",
            true,
        )
        .is_err());
        assert!(parse_local_route(
            "ROUTE_READY localHost=127.0.0.1 localPort=42100 routePolicy=AUTOMATIC ice=automatic relayReady=1",
            "ROUTE_READY",
            true,
        )
        .is_err());
        assert!(parse_local_route(
            "LOBBY_READY lobbyId=1 localHost=127.0.0.1 localPort=42100 routePolicy=RELAY_ONLY ice=disabled relayReady=1",
            "ROUTE_READY",
            true,
        )
        .is_err());
    }

    #[test]
    fn bootstraps_read_the_neutral_names_and_ignore_the_older_ones() {
        let hash = |digit: &str| digit.repeat(64);
        let bootstrap = serde_json::json!({
            "keyId": "key", "sessionId": "session", "partyId": "party", "partyRevision": 1,
            "huntDefinitionId": "hunt", "guardCompletionMode": "FIRST_DEFEAT", "generation": 2,
            "build": 647472, "bridgeProtocol": 1, "virtualPort": 7,
            "hostPeerId": "1001", "bridgeInstanceId": "instance", "metadataNonce": "nonce",
            "forceRelay": true,
            "artifacts": {
                "gameExe": hash("a"), "internalServer": hash("b"), "winmmProxy": hash("c"),
                "transportModule": hash("d"), "transportRuntime": hash("e"),
                "admissionPublicKey": hash("f"), "steamBridge": hash("0"), "steamRuntime": hash("0")
            },
            // The backend keeps sending the older names for launchers before plan step 4.2.
            "hostSteamId": "2002", "forceSdr": false,
            "ticket": "ticket", "lobbyId": "lobby"
        });
        let mut without_anticheat = bootstrap.clone();
        without_anticheat["evidenceCollection"] = serde_json::json!(false);
        let join: JoinBootstrap = serde_json::from_value(bootstrap).unwrap();
        assert_eq!(join.common.host_peer_id, "1001");
        assert!(join.common.force_relay);
        assert_eq!(join.common.artifacts.transport_module, hash("d"));
        assert_eq!(join.common.artifacts.transport_runtime, hash("e"));
        // A server that does not say (older ones) always collected evidence.
        assert!(join.common.evidence_collection);
        let join: JoinBootstrap = serde_json::from_value(without_anticheat).unwrap();
        assert!(!join.common.evidence_collection);
    }

    #[test]
    fn configs_reject_line_injection() {
        assert!(safe_config_value("safe-value", 64).is_ok());
        assert!(safe_config_value("unsafe\nkey=value", 64).is_err());
    }

    #[test]
    fn host_launch_uses_the_frozen_dedicated_manifest_verbatim() {
        let args = host_server_arguments(
            8791,
            "/Game/Maps/islands/adventure/Moss_Triforce/adventure_moss_triforce",
            "/Game/Monsters/lerawr/lerawr_beta_bp.lerawr_beta_bp_C",
            "Adventure_IslandA",
            "player-id:ShatteredIsles_IslandA",
        );
        assert_eq!(args[1], "8791");
        assert_eq!(
            args[2],
            "/Game/Maps/islands/adventure/Moss_Triforce/adventure_moss_triforce"
        );
        assert_eq!(
            args[3],
            "/Game/Monsters/lerawr/lerawr_beta_bp.lerawr_beta_bp_C"
        );
        assert_eq!(args[4], "Adventure_IslandA");
        assert_eq!(args[5], "player-id:ShatteredIsles_IslandA");
        assert_eq!(args[0], "-");
        assert_eq!(args[6], "127.0.0.1:8791");
        assert_eq!(args[7..14], DIRECTOR_SERVER_SWITCHES);
        assert_eq!(args[14], "-MULTIHOME=127.0.0.1");
        assert_eq!(args.len(), 15);
    }

    #[test]
    fn host_switches_match_the_director() {
        // Both trees carry the Director; the list there is the reference.
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ParadoxDirector/src/controllers/gameservers.ts");
        let Ok(source) = std::fs::read_to_string(source) else {
            return;
        };
        let start = source
            .find("const STANDARD_GAMESERVER_ARGS = [")
            .expect("STANDARD_GAMESERVER_ARGS");
        let end = start + source[start..].find("];").expect("end of the list");
        let director = source[start..end]
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|line| line.starts_with('"'))
            .map(|line| {
                let literal = line.trim_end_matches(',');
                literal[1..literal.len() - 1].replace("\\\"", "\"")
            })
            .collect::<Vec<_>>();
        assert_eq!(director, DIRECTOR_SERVER_SWITCHES);
    }

    #[test]
    fn trials_hunts_are_pinned_to_their_frozen_week() {
        assert_eq!(trials_week("Arena_MatchmakerHunt_Easy_007"), Some("007"));
        assert_eq!(trials_week("Arena_MatchmakerHunt_Hard_181"), Some("181"));
        assert_eq!(trials_week("Arena_MatchmakerHunt_Elite_042"), Some("042"));
        assert_eq!(trials_week("Arena_MatchmakerHunt_Normal_007"), None);
        assert_eq!(trials_week("Arena_MatchmakerHunt_Easy_07"), None);
        assert_eq!(trials_week("Arena_MatchmakerHunt_Easy_0071"), None);
        assert_eq!(trials_week("Arena_MatchmakerHunt_Easy_00a"), None);
        assert_eq!(trials_week("Adventure_IslandA"), None);
    }

    #[test]
    fn host_command_line_quotes_like_the_director_spawn() {
        let line = windows_command_line(
            Path::new(r"C:\Games\Dauntless\Dauntless-Win64-Shipping.exe"),
            &[
                "-".to_string(),
                "/Game/Maps/a".to_string(),
                DIRECTOR_SERVER_SWITCHES[6].to_string(),
                r"C:\with space\".to_string(),
                String::new(),
            ],
        );
        assert_eq!(
            line,
            r#""C:\Games\Dauntless\Dauntless-Win64-Shipping.exe" - /Game/Maps/a "-LogCmds=\"LogPhoenixCharacter VeryVerbose, LogOnline Verbose, LogLoad Off\"" "C:\with space\\" """#
        );
    }

    #[test]
    fn host_environment_replaces_and_removes_variables() {
        let block = host_environment(
            &[
                ("MYSTICPARADOX_SESSION_ID", "session"),
                ("PATH", "override"),
            ],
            &["MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER", "SystemRoot"],
        );
        assert_eq!(block.last(), Some(&0));
        let flattened = String::from_utf16_lossy(&block);
        let entries = flattened
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>();
        assert!(entries.contains(&"MYSTICPARADOX_SESSION_ID=session"));
        assert!(entries.contains(&"PATH=override"));
        let path_entries = entries
            .iter()
            .filter(|entry| entry.to_ascii_uppercase().starts_with("PATH="))
            .count();
        assert_eq!(path_entries, 1);
        assert!(!entries
            .iter()
            .any(|entry| entry.to_ascii_uppercase().starts_with("SYSTEMROOT=")));
    }

    #[test]
    fn readiness_pipe_binds_message_to_connecting_pid() {
        let name = format!(
            r"\\.\pipe\MysticInternalServer.test.{}",
            random_hex(8).unwrap()
        );
        let pipe = create_ready_pipe(&name).unwrap();
        let expected = "MYS1 READY test\n".to_string();
        let expected_for_thread = expected.clone();
        let server = std::thread::spawn(move || {
            read_ready_pipe(pipe, std::process::id(), expected_for_thread)
        });
        let name_w = wide(&name);
        let client = loop {
            let handle = unsafe {
                CreateFileW(
                    name_w.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break PipeHandle(handle);
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let mut written = 0u32;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::WriteFile(
                client.0,
                expected.as_ptr().cast(),
                expected.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        assert_eq!(written, expected.len() as u32);
        assert!(server.join().unwrap().is_ok());
        drop(client);
    }
}
