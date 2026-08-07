use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::AppHandle;

use crate::commands::auth::refresh_native_session;
use crate::install::{paths, verify};
use crate::launch::process;

// "stable" manifests/downloads stay unauthenticated server-side; "beta"/"dev" now require a
// signed-in tester (see requireTesterForNonStableChannel in ParadoxBackend's
// routes/launcherUpdates.ts), so fetch a bearer token for those channels only.
// refresh_native_session is blocking (reqwest::blocking), so it runs on a blocking thread
// even though this file otherwise uses the async reqwest client.
async fn bearer_token_for_channel(
    app: &AppHandle,
    channel: &str,
) -> Result<Option<String>, String> {
    if channel == "stable" {
        return Ok(None);
    }
    let app = app.clone();
    let session = tauri::async_runtime::spawn_blocking(move || refresh_native_session(&app))
        .await
        .map_err(|_| "The account session task stopped unexpectedly.".to_string())??;
    Ok(Some(session.access_token))
}

const DEFAULT_RUNTIME_ENDPOINT: &str = "https://paradox.mysticfox.dev/launcher/v1/runtime";
const DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64: &str = "3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=";
const TARGET_CHANGELIST: u32 = 392819;

fn runtime_endpoint() -> &'static str {
    option_env!("MYSTPAX_RUNTIME_ENDPOINT").unwrap_or(DEFAULT_RUNTIME_ENDPOINT)
}

fn runtime_update_public_key_b64() -> &'static str {
    option_env!("MYSTPAX_RUNTIME_PUBLIC_KEY_B64").unwrap_or(DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64)
}

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
pub(crate) const RUNTIME_DLL_NAME: &str = "MystPaxInternalServer.dll";

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

fn manifest_url(channel: &str) -> Result<String, String> {
    if !matches!(channel, "stable" | "beta" | "dev") {
        return Err("Invalid runtime update channel.".to_string());
    }
    Ok(format!(
        "{}/{channel}/windows-x86_64",
        runtime_endpoint().trim_end_matches('/')
    ))
}

async fn fetch_manifest(
    channel: &str,
    token: Option<&str>,
) -> Result<Option<RuntimeManifest>, String> {
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
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[runtime update] server returned {status} for {url}");
        return Err("The update server is temporarily unavailable. Try again later.".to_string());
    }
    response.json().await.map(Some).map_err(|e| {
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
    let token = bearer_token_for_channel(&app, &channel).await?;
    let Some(manifest) = fetch_manifest(&channel, token.as_deref()).await? else {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: None,
            current_sha256: None,
            latest_sha256: None,
            size: None,
        });
    };
    let directory = install_dir(&app)?;
    let current_path = directory.join(RUNTIME_DLL_NAME);
    let current_hash = current_path
        .is_file()
        .then(|| verify::hash_file_sha256(&current_path))
        .transpose()?;
    let mut available = current_hash.as_deref() != Some(manifest.sha256.as_str());
    if !available {
        for extra in &manifest.extra_files {
            let extra_path = directory.join(&extra.name);
            let up_to_date = extra_path.is_file()
                && verify::hash_file_sha256(&extra_path)
                    .map(|h| h.eq_ignore_ascii_case(&extra.sha256))
                    .unwrap_or(false);
            if !up_to_date {
                available = true;
                break;
            }
        }
    }
    Ok(RuntimeUpdateStatus {
        available,
        version: Some(manifest.version),
        current_sha256: current_hash,
        latest_sha256: Some(manifest.sha256),
        size: Some(manifest.size),
    })
}

#[tauri::command]
pub async fn install_runtime_update(
    app: AppHandle,
    channel: String,
) -> Result<RuntimeUpdateStatus, String> {
    if process::is_dauntless_process_running()? {
        return Err(
            "Close Dauntless and its dedicated server before updating the runtime.".to_string(),
        );
    }
    let token = bearer_token_for_channel(&app, &channel).await?;
    let Some(manifest) = fetch_manifest(&channel, token.as_deref()).await? else {
        return Err("No runtime update is published for this channel.".to_string());
    };
    let directory = install_dir(&app)?;
    let current_path = directory.join(RUNTIME_DLL_NAME);
    let current_hash = current_path
        .is_file()
        .then(|| verify::hash_file_sha256(&current_path))
        .transpose()?;

    // Install extra files first — they must be fetched even when the main DLL is current.
    // Each install_extra_file already skips when the target file matches the published hash.
    for extra in &manifest.extra_files {
        install_extra_file(&directory, extra, token.as_deref()).await?;
    }

    // If the main DLL is already current and all extras are installed, we are done.
    if current_hash.as_deref() == Some(manifest.sha256.as_str()) {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: Some(manifest.version),
            current_sha256: current_hash,
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

fn is_safe_extra_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name != "."
        && name.to_ascii_lowercase().ends_with(".dll")
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
    use super::{is_approved_runtime_url_for, is_safe_extra_name, RUNTIME_DLL_NAME};

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
    }

    #[test]
    fn runtime_extra_files_remain_flat_dll_names() {
        assert!(is_safe_extra_name("winmm.dll"));
        assert!(!is_safe_extra_name("../winmm.dll"));
        assert!(!is_safe_extra_name("nested/winmm.dll"));
        assert!(!is_safe_extra_name("notes.txt"));
        assert!(!is_safe_extra_name(RUNTIME_DLL_NAME));
        assert!(!is_safe_extra_name("mystpaxinternalserver.dll"));
        assert!(!is_safe_extra_name("MYSTPAXINTERNALSERVER.DLL"));
    }
}
