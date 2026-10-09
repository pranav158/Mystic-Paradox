use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows_sys::Win32::System::Diagnostics::Debug::CheckRemoteDebuggerPresent;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use zeroize::Zeroize;

use crate::commands::auth::{api_base_url, http_client, safe_api_error};
use crate::install::{paths, verify};
use crate::launch::logs::{format_epoch_rfc3339, iso8601_now as iso_now};

const KEY_ID: &str = "runtime-2026-01";
const PUBLIC_KEY_B64: &str = "3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=";
const TARGET_CHANGELIST: u32 = 647472;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_MANIFEST_LIFETIME_DAYS: i64 = 365;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuardEnvelope {
    schema: u32,
    key_id: String,
    payload_base64: String,
    signature: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuardPayload {
    schema: u32,
    manifest_id: String,
    sequence: u64,
    channel: String,
    platform: String,
    target_changelist: u32,
    minimum_launcher_version: String,
    issued_at: String,
    expires_at: String,
    pub(crate) artifacts: Vec<GuardArtifact>,
    // Integrity-check policy, read only by a P2P build (p2p/guard_checks.rs).
    #[cfg(feature = "p2p")]
    pub(crate) executable_memory_policy: crate::p2p::guard_checks::ExecutableMemoryPolicy,
}

#[derive(Clone, Deserialize)]
pub(crate) struct GuardArtifact {
    pub(crate) name: String,
    role: String,
    size: u64,
    pub(crate) sha256: String,
    required: bool,
    #[cfg(feature = "p2p")]
    #[serde(default)]
    pub(crate) protected_regions: Vec<crate::p2p::guard_checks::ProtectedRegion>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GuardSignals {
    game_process_id: u32,
    game_started_at: String,
    module_count: usize,
    module_set_digest: String,
    private_executable_bytes: usize,
    writable_executable_bytes: usize,
    unexpected_module_count: usize,
    protected_page_mismatch_count: usize,
    debugger_present: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    role: String,
    guard_session_id: String,
    challenge: String,
    manifest_id: String,
    manifest_sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    status: String,
    risk_score: u32,
    next_challenge: String,
}

#[derive(Clone)]
struct ActiveGuard {
    role: String,
    guard_session_id: String,
    signing_key: [u8; 32],
    challenge: String,
    sequence: u64,
    payload: GuardPayload,
    process_id: u32,
    process_started_at: Option<String>,
    risk_score: u32,
    healthy: bool,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.signing_key.zeroize();
        self.challenge.zeroize();
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RollbackState {
    maximum_manifest_sequence: u64,
}

fn active() -> &'static Mutex<HashMap<String, ActiveGuard>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, ActiveGuard>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Couldn't resolve Guard storage.".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't create Guard storage.".to_string())?;
    Ok(dir.join("guard-rollback.json"))
}

fn load_floor(app: &AppHandle) -> u64 {
    state_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<RollbackState>(&json).ok())
        .map(|state| state.maximum_manifest_sequence)
        .unwrap_or(0)
}

fn commit_floor(app: &AppHandle, sequence: u64) -> Result<(), String> {
    let path = state_path(app)?;
    let current = load_floor(app);
    if sequence < current {
        return Err("Guard manifest rollback was rejected.".to_string());
    }
    if sequence == current {
        return Ok(());
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&RollbackState {
            maximum_manifest_sequence: sequence,
        })
        .map_err(|_| "Couldn't encode Guard state.".to_string())?,
    )
    .map_err(|_| "Couldn't stage Guard state.".to_string())?;
    std::fs::rename(temporary, path).map_err(|_| "Couldn't commit Guard state.".to_string())
}

fn verify_envelope(
    envelope: GuardEnvelope,
    expected_channel: &str,
) -> Result<GuardPayload, String> {
    if envelope.schema != 1 || envelope.key_id != KEY_ID {
        return Err("Unknown Guard manifest signing key.".to_string());
    }
    let payload_bytes = BASE64
        .decode(&envelope.payload_base64)
        .map_err(|_| "Invalid Guard manifest encoding.".to_string())?;
    if payload_bytes.is_empty() || payload_bytes.len() > MAX_MANIFEST_BYTES {
        return Err("Guard manifest is outside its size limit.".to_string());
    }
    let public: [u8; 32] = BASE64
        .decode(PUBLIC_KEY_B64)
        .map_err(|_| "Invalid Guard public key.".to_string())?
        .try_into()
        .map_err(|_| "Invalid Guard public key size.".to_string())?;
    let signature = Signature::from_slice(
        &BASE64
            .decode(&envelope.signature)
            .map_err(|_| "Invalid Guard signature.".to_string())?,
    )
    .map_err(|_| "Invalid Guard signature size.".to_string())?;
    VerifyingKey::from_bytes(&public)
        .map_err(|_| "Invalid Guard public key.".to_string())?
        .verify(&payload_bytes, &signature)
        .map_err(|_| "Guard manifest signature verification failed.".to_string())?;
    let payload: GuardPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "Invalid Guard manifest payload.".to_string())?;
    if payload.schema != 1
        || payload.sequence == 0
        || payload.channel != expected_channel
        || payload.platform != "windows-x86_64"
        || payload.target_changelist != TARGET_CHANGELIST
        || !version_at_least(env!("CARGO_PKG_VERSION"), &payload.minimum_launcher_version)
        || payload.manifest_id.len() != 36
        || payload.artifacts.is_empty()
        || payload.artifacts.len() > 128
        || !integrity_policy_is_valid(&payload)
    {
        return Err("Guard manifest does not match this launcher runtime.".to_string());
    }
    validate_manifest_window(
        &payload.issued_at,
        &payload.expires_at,
        OffsetDateTime::now_utc(),
    )?;
    Ok(payload)
}

/// The integrity-check policy a P2P build reads from the manifest (p2p/guard_checks.rs).
#[cfg(feature = "p2p")]
fn integrity_policy_is_valid(payload: &GuardPayload) -> bool {
    crate::p2p::guard_checks::policy_is_valid(&payload.executable_memory_policy)
}

#[cfg(not(feature = "p2p"))]
fn integrity_policy_is_valid(_payload: &GuardPayload) -> bool {
    true
}

fn validate_manifest_window(
    issued_at: &str,
    expires_at: &str,
    now: OffsetDateTime,
) -> Result<(), String> {
    let issued = OffsetDateTime::parse(issued_at, &Rfc3339)
        .map_err(|_| "Guard manifest issuedAt is invalid.".to_string())?;
    let expires = OffsetDateTime::parse(expires_at, &Rfc3339)
        .map_err(|_| "Guard manifest expiresAt is invalid.".to_string())?;
    if expires <= issued {
        return Err("Guard manifest expiry is not after its issue time.".to_string());
    }
    if expires - issued > TimeDuration::days(MAX_MANIFEST_LIFETIME_DAYS) {
        return Err("Guard manifest lifetime exceeds the maximum allowed window.".to_string());
    }
    if issued > now + TimeDuration::minutes(5) {
        return Err("Guard manifest issue time is too far in the future.".to_string());
    }
    if expires <= now {
        return Err("Guard manifest has expired.".to_string());
    }
    Ok(())
}

fn version_at_least(current: &str, minimum: &str) -> bool {
    fn parse(value: &str) -> Option<([u64; 3], Option<Vec<&str>>)> {
        let without_build = value.split_once('+').map(|parts| parts.0).unwrap_or(value);
        let (core, prerelease) = match without_build.split_once('-') {
            Some((core, prerelease)) if !prerelease.is_empty() => {
                (core, Some(prerelease.split('.').collect::<Vec<_>>()))
            }
            Some(_) => return None,
            None => (without_build, None),
        };
        let parts = core
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        (parts.len() == 3).then(|| ([parts[0], parts[1], parts[2]], prerelease))
    }
    fn prerelease_at_least(current: &[&str], minimum: &[&str]) -> bool {
        for index in 0..current.len().max(minimum.len()) {
            let (Some(left), Some(right)) = (current.get(index), minimum.get(index)) else {
                return current.len() >= minimum.len();
            };
            if left == right {
                continue;
            }
            let left_numeric = left.parse::<u64>();
            let right_numeric = right.parse::<u64>();
            return match (left_numeric, right_numeric) {
                (Ok(left), Ok(right)) => left > right,
                (Ok(_), Err(_)) => false,
                (Err(_), Ok(_)) => true,
                (Err(_), Err(_)) => left > right,
            };
        }
        true
    }
    match (parse(current), parse(minimum)) {
        (Some((current_core, current_pre)), Some((minimum_core, minimum_pre))) => {
            if current_core != minimum_core {
                return current_core > minimum_core;
            }
            match (current_pre, minimum_pre) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(current), Some(minimum)) => prerelease_at_least(&current, &minimum),
            }
        }
        _ => false,
    }
}

fn process_identity_matches(
    bound_process_id: u32,
    bound_started_at: Option<&str>,
    observed_process_id: u32,
    observed_started_at: &str,
) -> bool {
    bound_process_id == observed_process_id
        && bound_started_at.is_some_and(|value| value == observed_started_at)
}

fn fetch_manifest(
    app: &AppHandle,
    channel: &str,
    access_token: &str,
) -> Result<GuardPayload, String> {
    let mut request = http_client()?.get(format!(
        "{}/launcher/v1/guard-manifests/{channel}/windows-x86_64",
        api_base_url()
    ));
    if channel != "stable" {
        request = request.bearer_auth(access_token);
    }
    let response = request
        .send()
        .map_err(|_| "Couldn't fetch the signed Guard manifest.".to_string())?;
    if !response.status().is_success() {
        return Err(safe_api_error(
            response,
            "No signed Guard manifest is available.",
        ));
    }
    let payload = verify_envelope(
        response
            .json::<GuardEnvelope>()
            .map_err(|_| "The Guard manifest envelope was malformed.".to_string())?,
        channel,
    )?;
    if payload.sequence < load_floor(app) {
        return Err("Guard manifest rollback was rejected.".to_string());
    }
    commit_floor(app, payload.sequence)?;
    Ok(payload)
}

fn artifact_path(app: &AppHandle, artifact: &GuardArtifact) -> Result<PathBuf, String> {
    if Path::new(&artifact.name)
        .file_name()
        .and_then(|n| n.to_str())
        != Some(artifact.name.as_str())
    {
        return Err("Guard manifest contains an unsafe artifact path.".to_string());
    }
    if artifact.role == "LAUNCHER" {
        return std::env::current_exe()
            .map_err(|_| "Couldn't locate the launcher executable.".to_string());
    }
    let game = paths::load_saved_exe_path(app)
        .ok_or_else(|| "Locate Dauntless before starting Guard.".to_string())?;
    Ok(paths::game_dir(&game)?.join(&artifact.name))
}

fn verify_artifacts(app: &AppHandle, payload: &GuardPayload) -> Result<(), String> {
    for artifact in &payload.artifacts {
        if !artifact.required {
            continue;
        }
        if artifact.size == 0
            || artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Guard manifest contains an invalid artifact record.".to_string());
        }
        let path = artifact_path(app, artifact)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|_| format!("Required Guard artifact {} is missing.", artifact.name))?;
        if !metadata.is_file()
            || metadata.len() != artifact.size
            || !verify::hash_file_sha256(&path)?.eq_ignore_ascii_case(&artifact.sha256)
        {
            return Err(format!(
                "Guard artifact {} failed verification.",
                artifact.name
            ));
        }
    }
    Ok(())
}

fn wide_string(value: &[u16]) -> String {
    let end = value.iter().position(|v| *v == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

fn filetime_to_iso(value: FILETIME) -> String {
    let ticks = ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64;
    let unix_100ns = ticks.saturating_sub(116_444_736_000_000_000);
    format_epoch_rfc3339(
        (unix_100ns / 10_000_000) as i64,
        ((unix_100ns % 10_000_000) / 10_000) as u32,
    )
}

/// A module loaded in the protected process (Toolhelp snapshot). Guard Lite reads only path and size.
#[cfg_attr(not(feature = "p2p"), allow(dead_code))]
pub(crate) struct LoadedModule {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) base: *mut u8,
    pub(crate) size: u32,
}

/// Integrity findings of a heartbeat. A P2P build measures them (p2p/guard_checks.rs); the public
/// dedicated-only build runs Guard Lite, an observer (signed manifest and artifacts, process identity,
/// loaded-module digest, debugger flag) that reports these as zero.
#[derive(Default)]
pub(crate) struct IntegritySignals {
    pub(crate) private_executable_bytes: usize,
    pub(crate) writable_executable_bytes: usize,
    pub(crate) unexpected_module_count: usize,
    pub(crate) protected_page_mismatch_count: usize,
}

#[cfg(feature = "p2p")]
fn integrity_signals(
    process: HANDLE,
    process_id: u32,
    payload: &GuardPayload,
    game_dir: &Path,
    modules: &[LoadedModule],
) -> IntegritySignals {
    // SAFETY: collect_signals passes its open process handle and that process's module snapshot.
    unsafe { crate::p2p::guard_checks::collect(process, process_id, payload, game_dir, modules) }
}

#[cfg(not(feature = "p2p"))]
fn integrity_signals(
    _process: HANDLE,
    _process_id: u32,
    _payload: &GuardPayload,
    _game_dir: &Path,
    _modules: &[LoadedModule],
) -> IntegritySignals {
    IntegritySignals::default()
}

fn collect_signals(
    process_id: u32,
    payload: &GuardPayload,
    game_dir: &Path,
) -> Result<GuardSignals, String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id);
        if process.is_null() {
            return Err("Guard could not open the Dauntless process.".to_string());
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
            CloseHandle(process);
            return Err("Guard could not read process times.".to_string());
        }
        let mut debugger = 0;
        let _ = CheckRemoteDebuggerPresent(process, &mut debugger);
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id);
        if snapshot == INVALID_HANDLE_VALUE {
            CloseHandle(process);
            return Err("Guard could not enumerate process modules.".to_string());
        }
        let mut module: MODULEENTRY32W = std::mem::zeroed();
        module.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        let mut modules = Vec::new();
        let mut ok = Module32FirstW(snapshot, &mut module);
        while ok != 0 {
            modules.push(LoadedModule {
                path: wide_string(&module.szExePath),
                name: wide_string(&module.szModule),
                base: module.modBaseAddr,
                size: module.modBaseSize,
            });
            ok = Module32NextW(snapshot, &mut module);
        }
        CloseHandle(snapshot);
        let integrity = integrity_signals(process, process_id, payload, game_dir, &modules);
        CloseHandle(process);
        let mut entries: Vec<String> = modules
            .iter()
            .map(|m| format!("{}:{}", m.path.to_lowercase(), m.size))
            .collect();
        entries.sort();
        let module_digest = Sha256::digest(entries.join("\n").as_bytes());
        Ok(GuardSignals {
            game_process_id: process_id,
            game_started_at: filetime_to_iso(created),
            module_count: entries.len(),
            module_set_digest: module_digest.iter().map(|b| format!("{b:02x}")).collect(),
            private_executable_bytes: integrity.private_executable_bytes,
            writable_executable_bytes: integrity.writable_executable_bytes,
            unexpected_module_count: integrity.unexpected_module_count,
            protected_page_mismatch_count: integrity.protected_page_mismatch_count,
            debugger_present: debugger != 0,
        })
    }
}

fn start_session(
    app: &AppHandle,
    access_token: &str,
    process_id: u32,
    channel: &str,
    role: &str,
) -> Result<ActiveGuard, String> {
    if !matches!(role, "client" | "host") {
        return Err("Launcher Guard role is invalid.".to_string());
    }
    let payload = fetch_manifest(app, channel, access_token)?;
    verify_artifacts(app, &payload)?;
    let mut signing_key = [0u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            signing_key.as_mut_ptr(),
            signing_key.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } != 0
    {
        return Err("Windows could not create the ephemeral Guard key.".to_string());
    }
    let public_key = BASE64.encode(
        SigningKey::from_bytes(&signing_key)
            .verifying_key()
            .to_bytes(),
    );
    let response = http_client()?.post(format!("{}/launcher/v1/guard/sessions", api_base_url()))
        .bearer_auth(access_token).json(&serde_json::json!({
            "role": role, "channel": channel, "launcherVersion": env!("CARGO_PKG_VERSION"),
            "manifestId": payload.manifest_id, "manifestSequence": payload.sequence, "publicKey": public_key
        })).send().map_err(|_| "Couldn't start Launcher Guard.".to_string())?;
    if !response.status().is_success() {
        return Err(safe_api_error(response, "Launcher Guard was rejected."));
    }
    let started = response
        .json::<StartResponse>()
        .map_err(|_| "Launcher Guard response was malformed.".to_string())?;
    if started.role != role
        || started.manifest_id != payload.manifest_id
        || started.manifest_sequence != payload.sequence
    {
        return Err("Launcher Guard bindings did not match.".to_string());
    }
    Ok(ActiveGuard {
        role: role.to_string(),
        guard_session_id: started.guard_session_id,
        signing_key,
        challenge: started.challenge,
        sequence: 0,
        payload,
        process_id,
        process_started_at: None,
        risk_score: 100,
        healthy: false,
    })
}

/// Serializes Guard heartbeats. This used to be the Guard map lock itself, which meant the map -
/// and therefore clear() on launcher exit - was held across both session-start requests, the
/// artifact re-hash, process-memory inspection and the heartbeat POST. A heartbeat stalled on a
/// network timeout could hold up shutdown for as long as its HTTP client took. The map lock is now
/// only held for short bookkeeping; this gate preserves the previous one-at-a-time serialization.
fn heartbeat_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

fn remove_role(role: &str) {
    if let Ok(mut state) = active().lock() {
        state.remove(role);
    }
}

pub fn heartbeat(
    app: &AppHandle,
    access_token: &str,
    process_id: u32,
    channel: &str,
    role: &str,
) -> Result<(String, u64, bool, u32), String> {
    if !matches!(role, "client" | "host") {
        return Err("Launcher Guard role is invalid.".to_string());
    }
    // One heartbeat at a time, exactly as before, but never with the Guard map held across I/O.
    let _gate = heartbeat_gate()
        .lock()
        .map_err(|_| "Launcher Guard state is unavailable.".to_string())?;

    let binding_matches = active()
        .lock()
        .map_err(|_| "Launcher Guard state is unavailable.".to_string())?
        .get(role)
        .map(|state| state.process_id == process_id && state.payload.channel == channel)
        .unwrap_or(false);
    if !binding_matches {
        // The manifest fetch and session start are network calls; they run with the map released.
        let started = start_session(app, access_token, process_id, channel, role)?;
        let mut guard = active()
            .lock()
            .map_err(|_| "Launcher Guard state is unavailable.".to_string())?;
        let binding_state = guard.get(role).map(|existing| {
            existing.process_id == process_id && existing.payload.channel == channel
        });
        match binding_state {
            // Another path established this exact binding while the lock was released: keep it.
            Some(true) => {}
            // A different binding, or a clear that raced the start: do not resurrect this role.
            Some(false) => {
                guard.remove(role);
                return Err("Guard manifest identity changed or is invalid.".to_string());
            }
            None => {
                if crate::launch::is_shutting_down() {
                    return Err(
                        "The launcher is closing; the Guard session was not registered."
                            .to_string(),
                    );
                }
                guard.insert(role.to_string(), started);
            }
        }
    }

    let payload = {
        let guard = active()
            .lock()
            .map_err(|_| "Launcher Guard state is unavailable.".to_string())?;
        guard
            .get(role)
            .map(|state| state.payload.clone())
            .ok_or_else(|| "Launcher Guard session is not active.".to_string())?
    };
    let game = paths::load_saved_exe_path(app)
        .ok_or_else(|| "Dauntless is not configured.".to_string())?;
    // Recheck the signed payload's identity and time window on every renewal. A stale or
    // replaced manifest must not keep an active role authorized after its session starts.
    if payload.schema != 1
        || payload.sequence == 0
        || payload.channel != channel
        || payload.platform != "windows-x86_64"
        || payload.target_changelist != TARGET_CHANGELIST
    {
        remove_role(role);
        return Err("Guard manifest identity changed or is invalid.".to_string());
    }
    if let Err(error) = validate_manifest_window(
        &payload.issued_at,
        &payload.expires_at,
        OffsetDateTime::now_utc(),
    ) {
        remove_role(role);
        return Err(error);
    }
    // Artifact binding is checked again on every renewal. A clean first heartbeat must not
    // authorize a runtime that is replaced or modified while the hunt is active.
    if let Err(error) = verify_artifacts(app, &payload) {
        remove_role(role);
        return Err(error);
    }
    let game_dir = match paths::game_dir(&game) {
        Ok(value) => value,
        Err(error) => {
            remove_role(role);
            return Err(error);
        }
    };
    let signals = match collect_signals(process_id, &payload, &game_dir) {
        Ok(value) => value,
        Err(error) => {
            remove_role(role);
            return Err(error);
        }
    };
    // Bookkeeping only: read the identity and sign the next sequence under one short lock, then let
    // the map go before the POST. The gate above means no other heartbeat can interleave.
    let (
        sequence,
        observed_at,
        signature,
        previous_sequence,
        guard_session_id,
        manifest_id,
        manifest_sequence,
    ) = {
        let mut guard = active()
            .lock()
            .map_err(|_| "Launcher Guard state is unavailable.".to_string())?;
        let identity_changed = {
            let state = guard
                .get(role)
                .ok_or_else(|| "Launcher Guard session is not active.".to_string())?;
            state.process_started_at.is_some()
                && !process_identity_matches(
                    state.process_id,
                    state.process_started_at.as_deref(),
                    signals.game_process_id,
                    &signals.game_started_at,
                )
        };
        if identity_changed {
            guard.remove(role);
            return Err(
                "Guard protected process identity changed; session was revoked.".to_string(),
            );
        }
        let state = guard
            .get_mut(role)
            .ok_or_else(|| "Launcher Guard session is not active.".to_string())?;
        if state.process_started_at.is_none() {
            state.process_started_at = Some(signals.game_started_at.clone());
        }
        let sequence = state.sequence + 1;
        let observed_at = iso_now();
        let material = [
            "MYSTIC-GUARD-2".to_string(),
            state.role.clone(),
            state.guard_session_id.clone(),
            sequence.to_string(),
            state.challenge.clone(),
            state.payload.manifest_id.clone(),
            state.payload.sequence.to_string(),
            observed_at.clone(),
            signals.game_process_id.to_string(),
            signals.game_started_at.clone(),
            signals.module_count.to_string(),
            signals.module_set_digest.to_lowercase(),
            signals.private_executable_bytes.to_string(),
            signals.writable_executable_bytes.to_string(),
            signals.unexpected_module_count.to_string(),
            signals.protected_page_mismatch_count.to_string(),
            if signals.debugger_present {
                "1".into()
            } else {
                "0".into()
            },
        ]
        .join("\n");
        let signature = BASE64.encode(
            SigningKey::from_bytes(&state.signing_key)
                .sign(material.as_bytes())
                .to_bytes(),
        );
        (
            sequence,
            observed_at,
            signature,
            state.sequence,
            state.guard_session_id.clone(),
            state.payload.manifest_id.clone(),
            state.payload.sequence,
        )
    };
    let signal_summary = format!(
        "pid={} modules={} unexpected={} private_exec_bytes={} writable_exec_bytes={} protected_page_mismatches={} debugger_present={}",
        signals.game_process_id, signals.module_count, signals.unexpected_module_count,
        signals.private_executable_bytes, signals.writable_executable_bytes,
        signals.protected_page_mismatch_count, signals.debugger_present
    );
    // The POST now runs with the Guard map released. No running Guard session is altered while it
    // is in flight; the snapshot is re-validated below before its verdict is committed.
    let response = http_client()?.post(format!("{}/launcher/v1/guard/heartbeat", api_base_url()))
        .bearer_auth(access_token).json(&serde_json::json!({ "role": role, "guardSessionId": guard_session_id,
            "sequence": sequence, "observedAt": observed_at, "signals": signals, "signature": signature }))
        .send().map_err(|error| {
            let reason = format!("Guard heartbeat transport failed: {error}");
            crate::launch::process::append_active_session_log(&format!(
                "guard heartbeat failed role={role} sequence={sequence} manifest_id={manifest_id} manifest_sequence={manifest_sequence} reason={reason}; {signal_summary}"
            ));
            "Couldn't publish Launcher Guard heartbeat.".to_string()
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let reason = safe_api_error(response, "Launcher Guard heartbeat was rejected.");
        crate::launch::process::append_active_session_log(&format!(
            "guard heartbeat rejected role={role} session_id={guard_session_id} sequence={sequence} manifest_id={manifest_id} manifest_sequence={manifest_sequence} http_status={} reason={reason}; {signal_summary}",
            status.as_u16()
        ));
        remove_role(role);
        return Err(reason);
    }
    let verdict = response.json::<HeartbeatResponse>().map_err(|error| {
        let reason = format!("Guard verdict response was malformed: {error}");
        crate::launch::process::append_active_session_log(&format!(
            "guard verdict parse failed role={role} session_id={guard_session_id} sequence={sequence} manifest_id={manifest_id} manifest_sequence={manifest_sequence} reason={reason}; {signal_summary}"
        ));
        "The Launcher Guard verdict was malformed.".to_string()
    })?;
    // Commit under one short lock, and only if this is still the same Guard session at the same
    // sequence the request was signed for: a clear or a replacement that raced the POST must not be
    // overwritten by a stale verdict.
    {
        let mut guard = active()
            .lock()
            .map_err(|_| "Launcher Guard state is unavailable.".to_string())?;
        let Some(state) = guard.get_mut(role) else {
            return Err(
                "Launcher Guard session was cleared while the heartbeat was in flight.".to_string(),
            );
        };
        if state.guard_session_id != guard_session_id || state.sequence != previous_sequence {
            return Err(
                "Launcher Guard session changed while the heartbeat was in flight.".to_string(),
            );
        }
        state.sequence = sequence;
        state.challenge = verdict.next_challenge;
        state.risk_score = verdict.risk_score;
        state.healthy = verdict.status == "HEALTHY";
    }
    crate::launch::process::append_active_session_log(&format!(
        "guard heartbeat verdict role={role} session_id={guard_session_id} sequence={sequence} manifest_id={manifest_id} manifest_sequence={manifest_sequence} status={} risk_score={}; {signal_summary}",
        verdict.status, verdict.risk_score
    ));
    Ok((
        guard_session_id,
        sequence,
        verdict.status == "HEALTHY",
        verdict.risk_score,
    ))
}

pub fn clear_role(role: &str) {
    if let Ok(mut state) = active().lock() {
        state.remove(role);
    }
}

pub fn clear() {
    if let Ok(mut state) = active().lock() {
        state.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_manifest_key() {
        let result = verify_envelope(
            GuardEnvelope {
                schema: 1,
                key_id: "unknown".into(),
                payload_base64: "AA==".into(),
                signature: "AA==".into(),
            },
            "dev",
        );
        assert!(result.is_err());
    }

    #[test]
    fn version_floor_rejects_prerelease_impersonation() {
        assert!(version_at_least("0.1.35", "0.1.35"));
        assert!(version_at_least("0.1.35+build.7", "0.1.35"));
        assert!(!version_at_least("0.1.35-rc.1", "0.1.35"));
        assert!(version_at_least("0.1.35-rc.2", "0.1.35-rc.1"));
        assert!(!version_at_least("0.1.35-alpha", "0.1.35-rc.1"));
    }

    #[test]
    fn process_identity_requires_start_time_even_when_pid_is_reused() {
        assert!(!process_identity_matches(
            42,
            Some("2026-08-12T00:00:01.000Z"),
            42,
            "2026-08-12T00:00:02.000Z"
        ));
        assert!(process_identity_matches(
            42,
            Some("2026-08-12T00:00:01.000Z"),
            42,
            "2026-08-12T00:00:01.000Z"
        ));
    }

    #[test]
    fn process_identity_does_not_accept_an_unbound_session() {
        assert!(!process_identity_matches(
            42,
            None,
            42,
            "2026-08-12T00:00:01.000Z"
        ));
        assert!(!process_identity_matches(
            42,
            Some("2026-08-12T00:00:01.000Z"),
            43,
            "2026-08-12T00:00:01.000Z"
        ));
    }

    #[test]
    fn manifest_window_requires_valid_order_and_future_expiry() {
        let now = OffsetDateTime::parse("2026-09-09T00:00:00Z", &Rfc3339).unwrap();
        assert!(
            validate_manifest_window("2026-09-08T23:00:00Z", "2026-09-10T00:00:00Z", now).is_ok()
        );
        assert!(
            validate_manifest_window("2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", now).is_err()
        );
        assert!(
            validate_manifest_window("2026-09-08T23:00:00Z", "2026-09-08T22:00:00Z", now).is_err()
        );
    }

    #[test]
    fn manifest_window_rejects_expired_and_malformed_timestamps() {
        let now = OffsetDateTime::parse("2026-09-09T00:00:00Z", &Rfc3339).unwrap();
        assert!(
            validate_manifest_window("2026-09-08T00:00:00Z", "2026-09-08T23:59:59Z", now).is_err()
        );
        assert!(validate_manifest_window("not-a-time", "2026-09-10T00:00:00Z", now).is_err());
        assert!(validate_manifest_window("2026-09-08T00:00:00Z", "not-a-time", now).is_err());
    }

    #[test]
    fn manifest_window_rejects_lifetime_beyond_publisher_bound() {
        let now = OffsetDateTime::parse("2026-09-09T00:00:00Z", &Rfc3339).unwrap();
        assert!(
            validate_manifest_window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00.001Z", now)
                .is_err()
        );
    }
}
