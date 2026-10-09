use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::commands::auth::{current_access_token, fetch_policy_cached, invalidate_access_token};
use crate::install::{paths, verify};
use crate::launch::process;

// "stable" manifests/downloads stay unauthenticated server-side; "beta"/"dev" now require a
// signed-in tester (see requireTesterForNonStableChannel in ParadoxBackend's
// routes/launcherUpdates.ts), so fetch a bearer token for those channels only.
// current_access_token may refresh with reqwest::blocking, so it runs on a blocking thread
// even though this file otherwise uses the async reqwest client.
async fn bearer_token_for_channel(
    app: &AppHandle,
    channel: &str,
) -> Result<Option<String>, String> {
    if channel == "stable" {
        return Ok(None);
    }
    let app = app.clone();
    let token = tauri::async_runtime::spawn_blocking(move || current_access_token(&app))
        .await
        .map_err(|_| "The account session task stopped unexpectedly.".to_string())??;
    Ok(Some(token))
}

/// The channel manifest plus the bearer token that fetched it (reused for the downloads).
/// A cached access token can be rejected after a sign-out elsewhere; drop it and retry once.
async fn fetch_channel_manifest(
    app: &AppHandle,
    channel: &str,
) -> Result<(Option<RuntimeManifest>, Option<String>), String> {
    let token = bearer_token_for_channel(app, channel).await?;
    match fetch_manifest(channel, token.as_deref()).await? {
        ManifestFetch::Found(manifest) => Ok((Some(manifest), token)),
        ManifestFetch::Missing => Ok((None, token)),
        ManifestFetch::Unauthorized => {
            invalidate_access_token();
            let token = bearer_token_for_channel(app, channel).await?;
            match fetch_manifest(channel, token.as_deref()).await? {
                ManifestFetch::Found(manifest) => Ok((Some(manifest), token)),
                ManifestFetch::Missing => Ok((None, token)),
                ManifestFetch::Unauthorized => {
                    Err("Your session expired. Sign in again.".to_string())
                }
            }
        }
    }
}

const DEFAULT_RUNTIME_ENDPOINT: &str = "https://paradox.mysticfox.dev/launcher/v1/runtime";
pub(crate) const TARGET_CHANGELIST: u32 = 647472;
// Public key only. The matching private key is kept outside the repository and
// is used exclusively by scripts/publish-runtime-update.mjs.
const DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64: &str = "3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=";

/// The runtime feed. A self-hosted build sets MYSTICPARADOX_RUNTIME_ENDPOINT at build time.
fn runtime_endpoint() -> &'static str {
    option_env!("MYSTICPARADOX_RUNTIME_ENDPOINT").unwrap_or(DEFAULT_RUNTIME_ENDPOINT)
}

/// The Ed25519 key runtime updates are signed with (MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64 at build time).
fn runtime_update_public_key_b64() -> &'static str {
    option_env!("MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64")
        .unwrap_or(DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64)
}

/// Downloads must come over HTTPS from the feed's own host and port.
fn is_approved_runtime_url_for(endpoint: &str, candidate: &str) -> bool {
    let (Ok(endpoint), Ok(candidate)) = (Url::parse(endpoint), Url::parse(candidate)) else {
        return false;
    };
    candidate.scheme() == "https"
        && endpoint.scheme() == "https"
        && candidate.host_str() == endpoint.host_str()
        && candidate.port_or_known_default() == endpoint.port_or_known_default()
}

fn is_approved_runtime_url(candidate: &str) -> bool {
    is_approved_runtime_url_for(runtime_endpoint(), candidate)
}
const MAX_RUNTIME_BYTES: usize = 200 * 1024 * 1024;
pub(crate) const RUNTIME_DLL_NAME: &str = "MysticParadox.dll";

pub(crate) fn runtime_install_lock() -> &'static std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCK: OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
}

/// Best-effort first-pass repair started from native launcher setup. This intentionally has no
/// user-visible failure state: if the account/session, saved install, network, or update server is
/// unavailable during startup, Play performs the authoritative second verification/repair pass.
/// We resolve the signed-in account's current policy first so tester accounts do not briefly
/// install the stable runtime before Home/Play switches them back to beta/dev.
pub fn start_runtime_prefetch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if paths::load_saved_exe_path(&app).is_none() {
            return;
        }
        let policy_app = app.clone();
        let channel = match tauri::async_runtime::spawn_blocking(move || {
            fetch_policy_cached(&policy_app).map(|policy| policy.channel)
        })
        .await
        {
            Ok(Ok(channel)) => channel,
            _ => return,
        };

        if let Err(error) = install_runtime_update(app, channel).await {
            eprintln!("[runtime prefetch] deferred until Play: {error}");
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    version: String,
    target_changelist: u32,
    size: usize,
    sha256: String,
    signature: String,
    url: String,
    #[serde(default)]
    extra_files: Vec<ExtraFile>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExtraFile {
    name: String,
    size: usize,
    sha256: String,
    signature: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_sha256: Option<String>,
    pub latest_sha256: Option<String>,
    pub size: Option<usize>,
}

struct InstalledRuntimeState {
    current_hash: Option<String>,
    main_current: bool,
    all_current: bool,
}

fn installed_runtime_state(
    directory: &Path,
    manifest: &RuntimeManifest,
) -> Result<InstalledRuntimeState, String> {
    let current_path = directory.join(RUNTIME_DLL_NAME);
    let current_hash = current_path
        .is_file()
        .then(|| verify::hash_file_sha256(&current_path))
        .transpose()?;
    let main_current = current_path
        .metadata()
        .map(|metadata| metadata.len() == manifest.size as u64)
        .unwrap_or(false)
        && current_hash
            .as_deref()
            .map(|hash| hash.eq_ignore_ascii_case(&manifest.sha256))
            .unwrap_or(false);
    let mut all_current = main_current;

    for extra in &manifest.extra_files {
        if !is_installed_extra(&extra.name) {
            continue;
        }
        if !is_safe_extra_name(&extra.name) {
            return Err(format!("Rejected unsafe extra file name: {}", extra.name));
        }
        let path = directory.join(&extra.name);
        let current = path
            .metadata()
            .map(|metadata| metadata.len() == extra.size as u64)
            .unwrap_or(false)
            && verify::hash_file_sha256(&path)
                .map(|hash| hash.eq_ignore_ascii_case(&extra.sha256))
                .unwrap_or(false);
        if !current {
            all_current = false;
        }
    }

    Ok(InstalledRuntimeState {
        current_hash,
        main_current,
        all_current,
    })
}

fn manifest_url(channel: &str) -> Result<String, String> {
    if !matches!(channel, "stable" | "beta" | "dev") {
        return Err("Invalid runtime update channel.".to_string());
    }
    Ok(format!(
        "{}/{channel}/windows-x86_64",
        runtime_endpoint().trim_end_matches('/')
    ))
}

enum ManifestFetch {
    Found(RuntimeManifest),
    Missing,
    Unauthorized,
}

async fn fetch_manifest(channel: &str, token: Option<&str>) -> Result<ManifestFetch, String> {
    let url = manifest_url(channel)?;
    let mut request = Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] client build failed: {e}");
            "Can't reach the update server. Check your connection.".to_string()
        })?
        .get(&url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| {
        eprintln!("[runtime update] fetch failed for {url}: {e}");
        "Can't reach the update server. Check your connection.".to_string()
    })?;
    if response.status().as_u16() == 404 || response.status().as_u16() == 204 {
        return Ok(ManifestFetch::Missing);
    }
    if response.status().as_u16() == 401 && token.is_some() {
        return Ok(ManifestFetch::Unauthorized);
    }
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[runtime update] server returned {status} for {url}");
        return Err("The update server is temporarily unavailable. Try again later.".to_string());
    }
    response
        .json()
        .await
        .map(ManifestFetch::Found)
        .map_err(|e| {
            eprintln!("[runtime update] manifest parse failed: {e}");
            "Couldn't read the update manifest. Try again later.".to_string()
        })
}

fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = paths::load_saved_exe_path(app)
        .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
    if !exe.is_file() {
        return Err("Your Dauntless installation is missing.".to_string());
    }
    paths::game_dir(&exe)
}

fn verify_manifest(manifest: &RuntimeManifest, bytes: &[u8]) -> Result<(), String> {
    if manifest.target_changelist != TARGET_CHANGELIST
        || manifest.size != bytes.len()
        || bytes.len() > MAX_RUNTIME_BYTES
    {
        return Err("Runtime update does not match the supported game build.".to_string());
    }
    let digest = Sha256::digest(bytes);
    let actual_hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !actual_hash.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("Runtime update hash verification failed.".to_string());
    }
    let public_bytes = BASE64
        .decode(runtime_update_public_key_b64())
        .map_err(|_| "Runtime update public key is invalid.".to_string())?;
    let public_array: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| "Runtime update public key has the wrong size.".to_string())?;
    let key = VerifyingKey::from_bytes(&public_array)
        .map_err(|_| "Runtime update public key is invalid.".to_string())?;
    let signature_bytes = BASE64
        .decode(&manifest.signature)
        .map_err(|_| "Runtime update signature is invalid.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Runtime update signature is invalid.".to_string())?;
    key.verify(bytes, &signature)
        .map_err(|_| "Runtime update signature verification failed.".to_string())
}

#[tauri::command]
pub async fn check_runtime_update(
    app: AppHandle,
    channel: String,
) -> Result<RuntimeUpdateStatus, String> {
    let (manifest, _token) = fetch_channel_manifest(&app, &channel).await?;
    let Some(manifest) = manifest else {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: None,
            current_sha256: None,
            latest_sha256: None,
            size: None,
        });
    };
    let directory = install_dir(&app)?;
    let installed = installed_runtime_state(&directory, &manifest)?;
    Ok(RuntimeUpdateStatus {
        available: !installed.all_current,
        version: Some(manifest.version),
        current_sha256: installed.current_hash,
        latest_sha256: Some(manifest.sha256),
        size: Some(manifest.size),
    })
}

#[tauri::command]
pub async fn install_runtime_update(
    app: AppHandle,
    channel: String,
) -> Result<RuntimeUpdateStatus, String> {
    // Startup prefetch, Home/Locate, manual Repair and Play all converge here. Serialize them so
    // two callers can never race the shared .new/.bak atomic replacement files.
    let _install_guard = runtime_install_lock().lock().await;
    let (manifest, token) = fetch_channel_manifest(&app, &channel).await?;
    let Some(manifest) = manifest else {
        return Err("No runtime update is published for this channel.".to_string());
    };
    let directory = install_dir(&app)?;
    let current_path = directory.join(RUNTIME_DLL_NAME);
    let installed = installed_runtime_state(&directory, &manifest)?;

    // Central Ramsgate/Dojo may legitimately be running from this installation while the local
    // launcher starts a player client. If every signed runtime artifact is already byte-for-byte
    // current, this operation is read-only and must not be blocked by those server processes.
    if installed.all_current {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: Some(manifest.version),
            current_sha256: installed.current_hash,
            latest_sha256: Some(manifest.sha256),
            size: Some(manifest.size),
        });
    }

    // A real replacement is still unsafe while either client or dedicated-server processes have
    // DLLs mapped from this installation, so retain the process fence for every mutating path.
    if process::is_dauntless_process_running()? {
        return Err(
            "Close Dauntless and its dedicated server before updating the runtime.".to_string(),
        );
    }

    // Install extra files first — they must be fetched even when the main DLL is current.
    // Each install_extra_file already skips when the target file matches the published hash.
    for extra in manifest
        .extra_files
        .iter()
        .filter(|extra| is_installed_extra(&extra.name))
    {
        install_extra_file(&directory, extra, token.as_deref()).await?;
    }

    // If the main DLL is already current and all extras are installed, we are done.
    if installed.main_current {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: Some(manifest.version),
            current_sha256: installed.current_hash,
            latest_sha256: Some(manifest.sha256),
            size: Some(manifest.size),
        });
    }

    if !is_approved_runtime_url(&manifest.url) {
        return Err("Runtime update URL is not an approved HTTPS endpoint.".to_string());
    }
    let mut download_request = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] download client build failed: {e}");
            "Couldn't prepare the download. Try again.".to_string()
        })?
        .get(manifest.url.clone());
    if let Some(token) = token.as_deref() {
        download_request = download_request.bearer_auth(token);
    }
    let response = download_request.send().await.map_err(|e| {
        eprintln!("[runtime update] download failed for {}: {e}", manifest.url);
        "Runtime download failed. Check your connection.".to_string()
    })?;
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[runtime update] download returned {status}");
        return Err("Runtime download failed. Check your connection.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| {
            eprintln!("[runtime update] read response bytes failed: {e}");
            "Runtime download failed. Check your connection.".to_string()
        })?
        .to_vec();
    verify_manifest(&manifest, &bytes)?;

    let staged = directory.join(format!("{RUNTIME_DLL_NAME}.new"));
    let backup = directory.join(format!("{RUNTIME_DLL_NAME}.bak"));
    std::fs::write(&staged, &bytes).map_err(|e| format!("Couldn't stage runtime update: {e}"))?;
    if current_path.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&current_path, &backup)
            .map_err(|e| format!("Couldn't prepare runtime replacement: {e}"))?;
    }
    if let Err(error) = std::fs::rename(&staged, &current_path) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &current_path);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Couldn't install runtime update: {error}"));
    }
    Ok(RuntimeUpdateStatus {
        available: false,
        version: Some(manifest.version),
        current_sha256: Some(manifest.sha256.clone()),
        latest_sha256: Some(manifest.sha256),
        size: Some(manifest.size),
    })
}

/// The feed extras this build installs: the winmm proxy, and in a P2P build the P2P files. The feed
/// can list more; a build skips the rest and leaves copies already on disk alone.
fn is_installed_extra(name: &str) -> bool {
    if name.eq_ignore_ascii_case("winmm.dll") {
        return true;
    }
    #[cfg(feature = "p2p")]
    if crate::p2p::RUNTIME_ARTIFACT_NAMES
        .iter()
        .any(|p2p| p2p.eq_ignore_ascii_case(name))
    {
        return true;
    }
    false
}

/// A flat file name this build installs, and never the runtime DLL itself.
fn is_safe_extra_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name != "."
        && is_installed_extra(name)
        && !name.eq_ignore_ascii_case(RUNTIME_DLL_NAME)
}

async fn install_extra_file(
    directory: &std::path::Path,
    extra: &ExtraFile,
    token: Option<&str>,
) -> Result<(), String> {
    if !is_safe_extra_name(&extra.name) {
        return Err(format!("Rejected unsafe extra file name: {}", extra.name));
    }
    if !is_approved_runtime_url(&extra.url) {
        return Err("Extra file URL is not an approved HTTPS endpoint.".to_string());
    }
    let target = directory.join(&extra.name);
    // Already up to date? skip.
    if target.is_file() {
        if let Ok(existing) = verify::hash_file_sha256(&target) {
            if existing.eq_ignore_ascii_case(&extra.sha256) {
                return Ok(());
            }
        }
    }
    let mut extra_request = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] extra download client build failed: {e}");
            "Couldn't prepare the download. Try again.".to_string()
        })?
        .get(&extra.url);
    if let Some(token) = token {
        extra_request = extra_request.bearer_auth(token);
    }
    let response = extra_request.send().await.map_err(|e| {
        eprintln!("[runtime update] download of {} failed: {e}", extra.name);
        "Runtime download failed. Check your connection.".to_string()
    })?;
    if !response.status().is_success() {
        let status = response.status();
        eprintln!(
            "[runtime update] download of {} returned {status}",
            extra.name
        );
        return Err("Runtime download failed. Check your connection.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| {
            eprintln!("[runtime update] read of {} failed: {e}", extra.name);
            "Runtime download failed. Check your connection.".to_string()
        })?
        .to_vec();
    if bytes.len() != extra.size || bytes.len() > MAX_RUNTIME_BYTES {
        return Err(format!("Extra file {} size mismatch.", extra.name));
    }
    let digest = Sha256::digest(&bytes);
    let actual_hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !actual_hash.eq_ignore_ascii_case(&extra.sha256) {
        return Err(format!(
            "Extra file {} hash verification failed.",
            extra.name
        ));
    }
    let public_bytes = BASE64
        .decode(runtime_update_public_key_b64())
        .map_err(|_| "Runtime update public key is invalid.".to_string())?;
    let public_array: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| "Runtime update public key has the wrong size.".to_string())?;
    let key = VerifyingKey::from_bytes(&public_array)
        .map_err(|_| "Runtime update public key is invalid.".to_string())?;
    let signature_bytes = BASE64
        .decode(&extra.signature)
        .map_err(|_| format!("Extra file {} signature is invalid.", extra.name))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| format!("Extra file {} signature is invalid.", extra.name))?;
    key.verify(&bytes, &signature)
        .map_err(|_| format!("Extra file {} signature verification failed.", extra.name))?;

    let staged = directory.join(format!("{}.new", extra.name));
    let backup = directory.join(format!("{}.bak", extra.name));
    std::fs::write(&staged, &bytes).map_err(|e| format!("Couldn't stage {}: {e}", extra.name))?;
    if target.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&target, &backup)
            .map_err(|e| format!("Couldn't back up {}: {e}", extra.name))?;
    }
    if let Err(error) = std::fs::rename(&staged, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Couldn't install {}: {error}", extra.name));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn digest(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mystic-launcher-runtime-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn manifest(main: &[u8], extra_name: &str, extra: &[u8]) -> RuntimeManifest {
        RuntimeManifest {
            version: "test".to_string(),
            target_changelist: TARGET_CHANGELIST,
            size: main.len(),
            sha256: digest(main),
            signature: "test".to_string(),
            url: "https://paradox.mysticfox.dev/test".to_string(),
            extra_files: vec![ExtraFile {
                name: extra_name.to_string(),
                size: extra.len(),
                sha256: digest(extra),
                signature: "test".to_string(),
                url: "https://paradox.mysticfox.dev/test-extra".to_string(),
            }],
        }
    }

    #[test]
    fn exact_runtime_set_is_a_read_only_no_op() {
        let directory = temporary_directory("current");
        let main = b"main-runtime";
        let extra = b"winmm-proxy";
        std::fs::write(directory.join(RUNTIME_DLL_NAME), main).unwrap();
        std::fs::write(directory.join("winmm.dll"), extra).unwrap();

        let state =
            installed_runtime_state(&directory, &manifest(main, "winmm.dll", extra)).unwrap();
        assert!(state.main_current);
        assert!(state.all_current);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_extra_keeps_the_mutating_process_fence() {
        let directory = temporary_directory("stale-extra");
        let main = b"main-runtime";
        let extra = b"winmm-proxy";
        std::fs::write(directory.join(RUNTIME_DLL_NAME), main).unwrap();
        std::fs::write(directory.join("winmm.dll"), b"old").unwrap();

        let state =
            installed_runtime_state(&directory, &manifest(main, "winmm.dll", extra)).unwrap();
        assert!(state.main_current);
        assert!(!state.all_current);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn extras_this_build_does_not_install_are_ignored() {
        let directory = temporary_directory("feed-only-extra");
        let main = b"main-runtime";
        std::fs::write(directory.join(RUNTIME_DLL_NAME), main).unwrap();

        let state = installed_runtime_state(&directory, &manifest(main, "feed-only.bin", b"other"))
            .unwrap();
        assert!(state.main_current);
        assert!(state.all_current);
        assert!(!is_installed_extra("feed-only.bin"));
        assert!(is_installed_extra("winmm.dll"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn p2p_builds_install_the_p2p_extras() {
        for name in crate::p2p::RUNTIME_ARTIFACT_NAMES {
            assert!(is_installed_extra(name));
            assert!(is_installed_extra(&name.to_ascii_uppercase()));
        }
    }

    #[test]
    fn runtime_downloads_must_use_the_configured_https_origin() {
        let endpoint = "https://community.example/launcher/v1/runtime";
        assert!(is_approved_runtime_url_for(
            endpoint,
            "https://community.example/launcher/v1/runtime/stable/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "https://attacker.example/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "http://community.example/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "https://community.example.evil.test/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "https://community.example:8443/runtime.dll"
        ));
    }

    #[test]
    fn runtime_extra_files_remain_flat_installed_names() {
        assert!(is_safe_extra_name("winmm.dll"));
        assert!(is_safe_extra_name("WINMM.DLL"));
        assert!(!is_safe_extra_name("../winmm.dll"));
        assert!(!is_safe_extra_name("nested/winmm.dll"));
        assert!(!is_safe_extra_name("nested\\winmm.dll"));
        assert!(!is_safe_extra_name("notes.txt"));
        assert!(!is_safe_extra_name(RUNTIME_DLL_NAME));
        assert!(!is_safe_extra_name("mysticparadox.dll"));
        assert!(!is_safe_extra_name("MYSTICPARADOX.DLL"));
    }
}
