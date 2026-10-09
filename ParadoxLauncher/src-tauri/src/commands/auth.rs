use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::auth::secure_store;
use crate::auth::session_epoch;

/// Revoke all launcher-owned P2P state whenever the local account identity changes.
/// Guard sessions and protected game/host processes are account-bound; retaining either across
/// logout or account switch could let a later heartbeat or presence tick submit the old session
/// with a new bearer token. The Job Object is the hard boundary for any process that does not
/// stop cleanly.
fn revoke_local_guard_state() {
    #[cfg(feature = "p2p")]
    crate::p2p::stop_all_sessions();
    let _ = crate::launch::supervisor::terminate_all(0xE304);
    crate::launch::guard_loop::clear();
}

// Refresh tokens are single-use and rotated by the backend. Several launcher services begin
// together after startup (session restore, policy, and P2P presence), so two concurrent refreshes
// could previously submit the same token. The backend correctly treats that as token reuse and
// revokes the entire session family, which looked like the launcher signed itself out every time.
// Serialize the complete load -> rotate -> save operation so each caller observes the latest token.
static REFRESH_SESSION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn api_base_url() -> &'static str {
    if cfg!(debug_assertions) {
        option_env!("MYSTICPARADOX_API_BASE_URL").unwrap_or("http://127.0.0.1:3000")
    } else {
        option_env!("MYSTICPARADOX_API_BASE_URL").unwrap_or("https://paradox.mysticfox.dev")
    }
}

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())?;
    let _ = CLIENT.set(client.clone());
    Ok(CLIENT.get().cloned().unwrap_or(client))
}

async fn run_auth_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "The launcher authentication task stopped unexpectedly.".to_string())?
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
}

pub(crate) fn safe_api_error(response: reqwest::blocking::Response, fallback: &str) -> String {
    let status = response.status();
    let code = response
        .json::<ErrorEnvelope>()
        .ok()
        .and_then(|body| body.error)
        .and_then(|error| error.code);
    match code.as_deref() {
        Some("AUTH_APPROVAL_PENDING") => {
            "Your closed-test access request is waiting for approval.".to_string()
        }
        Some("AUTH_APPROVAL_REJECTED") => {
            "Your closed-test access request was not approved.".to_string()
        }
        Some("AUTH_ACCOUNT_DISABLED") => "This account has been disabled.".to_string(),
        Some("AUTH_ACCOUNT_BANNED") => "This account has been banned.".to_string(),
        Some("AUTH_EMAIL_TAKEN") => "That email is already registered.".to_string(),
        Some("AUTH_DISPLAY_NAME_TAKEN") => "That username is already taken.".to_string(),
        Some("AUTH_INVALID_CREDENTIALS") => "The email or password is incorrect.".to_string(),
        Some("AUTH_REFRESH_INVALID") | Some("AUTH_UNAUTHORIZED") => {
            "Your session expired. Sign in again.".to_string()
        }
        Some("AUTH_TESTER_REQUIRED") => "Tester access is required for this.".to_string(),
        Some("AUTH_RATE_LIMITED") => "Too many attempts. Wait a moment and try again.".to_string(),
        Some("AUTH_USERNAME_REQUIRED") => {
            "Choose your launcher username before playing.".to_string()
        }
        Some("GAME_BUILD_UNSUPPORTED") => {
            "This Dauntless installation is not approved. Verify or repair it.".to_string()
        }
        Some("GUARD_REPORT_INVALID") => {
            "Launcher Guard rejected an invalid heartbeat report.".to_string()
        }
        Some("GUARD_SESSION_INVALID") => {
            "Launcher Guard rejected an expired or mismatched session.".to_string()
        }
        Some("GUARD_SIGNATURE_INVALID") => {
            "Launcher Guard rejected the heartbeat signature.".to_string()
        }
        Some("GUARD_MANIFEST_UNAVAILABLE") => {
            "No current signed Launcher Guard manifest is available.".to_string()
        }
        Some("GUARD_MANIFEST_MISMATCH") => {
            "Launcher Guard rejected a manifest or runtime binding mismatch.".to_string()
        }
        Some("GUARD_SEQUENCE_CONFLICT") => {
            "Launcher Guard rejected a superseded heartbeat sequence.".to_string()
        }
        Some("GUARD_REQUIRED") | Some("HOST_GUARD_UNVERIFIED") => {
            "The backend did not verify the required Launcher Guard session.".to_string()
        }
        _ => format!("{fallback} (server status {})", status.as_u16()),
    }
}

fn parse_success<T: DeserializeOwned>(
    response: reqwest::blocking::Response,
    fallback: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(safe_api_error(response, fallback));
    }
    response
        .json::<T>()
        .map_err(|_| "The account server returned an invalid response.".to_string())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccount {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub discord_linked: bool,
    pub status: String,
    pub approval_status: String,
    pub needs_username: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSession {
    pub access_token: String,
    pub refresh_token: String,
    pub account: NativeAccount,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRequest<'a> {
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest<'a> {
    email: &'a str,
    password: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest<'a> {
    display_name: &'a str,
    email: &'a str,
    password: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRegistration {
    account: NativeAccount,
}

// Access tokens are short-lived JWTs (12 minutes on the backend). Routine UI calls reuse the
// current one instead of rotating the refresh token: every rotation is a window in which a lost
// response leaves the stored token already revoked, and the backend then revokes the whole family
// on its next use. The cache is bound to the account epoch, so login/logout/forget drop it.
struct CachedAccess {
    epoch: u64,
    access_token: String,
    reuse_until: Instant,
}

static ACCESS_CACHE: Mutex<Option<CachedAccess>> = Mutex::new(None);

// Stop reusing a token this long before it expires, so a request never races its expiry.
const ACCESS_TOKEN_REUSE_MARGIN: Duration = Duration::from_secs(90);
// Never trust a lifetime longer than this, whatever the token claims.
const ACCESS_TOKEN_MAX_REUSE: Duration = Duration::from_secs(15 * 60);

fn access_cache() -> std::sync::MutexGuard<'static, Option<CachedAccess>> {
    ACCESS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lifetime from the JWT's own `iat`/`exp`, both server times, so a skewed local clock cannot
/// stretch reuse. The signature is the backend's to check; this only decides when to refresh.
fn access_token_lifetime(access_token: &str) -> Option<Duration> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let payload = access_token.split('.').nth(1)?;
    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let issued = claims.get("iat")?.as_u64()?;
    let expires = claims.get("exp")?.as_u64()?;
    let lifetime = Duration::from_secs(expires.checked_sub(issued)?);
    Some(lifetime.min(ACCESS_TOKEN_MAX_REUSE))
}

fn cache_access(epoch: u64, session: &NativeSession) {
    let Some(lifetime) = access_token_lifetime(&session.access_token) else {
        *access_cache() = None;
        return;
    };
    let Some(usable) = lifetime.checked_sub(ACCESS_TOKEN_REUSE_MARGIN) else {
        *access_cache() = None;
        return;
    };
    *access_cache() = Some(CachedAccess {
        epoch,
        access_token: session.access_token.clone(),
        reuse_until: Instant::now() + usable,
    });
}

fn cached_access() -> Option<String> {
    let epoch = session_epoch::current();
    let cache = access_cache();
    cache
        .as_ref()
        .filter(|entry| entry.epoch == epoch && Instant::now() < entry.reuse_until)
        .map(|entry| entry.access_token.clone())
}

pub(crate) fn invalidate_access_token() {
    *access_cache() = None;
}

/// A usable access token: the cached one while it has life left, otherwise one refresh.
/// Play still calls `refresh_native_session` directly so every launch re-checks admission.
pub(crate) fn current_access_token(app: &AppHandle) -> Result<String, String> {
    if let Some(token) = cached_access() {
        return Ok(token);
    }
    let _refresh_guard = lock_refresh();
    // Another caller may have refreshed while this one waited for the lock.
    if let Some(token) = cached_access() {
        return Ok(token);
    }
    refresh_locked(app).map(|session| session.access_token)
}

/// Sends an authenticated request with the current access token. On 401/403 the token is
/// dropped and the session refreshed once: the refresh path owns sign-out for expired,
/// unapproved, disabled and banned accounts, exactly as when every call refreshed.
pub(crate) fn send_authorized<F>(
    app: &AppHandle,
    send: F,
) -> Result<reqwest::blocking::Response, String>
where
    F: Fn(&str) -> Result<reqwest::blocking::Response, String>,
{
    let token = current_access_token(app)?;
    let response = send(&token)?;
    if !matches!(response.status().as_u16(), 401 | 403) {
        return Ok(response);
    }
    invalidate_access_token();
    let session = refresh_native_session(app)?;
    send(&session.access_token)
}

fn lock_refresh() -> std::sync::MutexGuard<'static, ()> {
    REFRESH_SESSION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn refresh_native_session(app: &AppHandle) -> Result<NativeSession, String> {
    let _refresh_guard = lock_refresh();
    refresh_locked(app)
}

/// Rotates the refresh token. The caller holds `REFRESH_SESSION_LOCK`.
fn refresh_locked(app: &AppHandle) -> Result<NativeSession, String> {
    let (epoch, token) = {
        let epoch = session_epoch::lock();
        let token = secure_store::load(app)?
            .ok_or_else(|| "Your session expired. Sign in again.".to_string())?;
        (*epoch, token)
    };
    let response = http_client()?
        .post(format!("{}/launcher/v1/auth/refresh", api_base_url()))
        .json(&RefreshRequest {
            refresh_token: &token,
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
        })
        .send()
        .map_err(|_| "Couldn't reach the Mystic Paradox account server.".to_string())?;
    let parsed =
        parse_success::<NativeSession>(response, "Couldn't restore your launcher session.");
    let mut current_epoch = session_epoch::lock();
    session_epoch::check(epoch, *current_epoch)?;
    let session = match parsed {
        Ok(session) => session,
        Err(error) => {
            invalidate_access_token();
            if error.contains("expired")
                || error.contains("approval")
                || error.contains("approved")
                || error.contains("disabled")
                || error.contains("banned")
            {
                *current_epoch += 1;
                let _ = secure_store::clear(app);
                revoke_local_guard_state();
            }
            return Err(error);
        }
    };
    secure_store::save(app, &session.refresh_token)?;
    cache_access(*current_epoch, &session);
    Ok(session)
}

#[tauri::command]
pub async fn native_restore_session(app: AppHandle) -> Result<Option<NativeAccount>, String> {
    run_auth_task(move || {
        if secure_store::load(&app)?.is_none() {
            return Ok(None);
        }
        refresh_native_session(&app).map(|session| Some(session.account))
    })
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeServerStatus {
    pub online: bool,
    pub supported_build_changelist: u32,
}

#[tauri::command]
pub async fn native_get_server_status() -> Result<NativeServerStatus, String> {
    run_auth_task(|| {
        let response = http_client()?
            .get(format!("{}/launcher/v1/status", api_base_url()))
            .send()
            .map_err(|_| "Can't reach the Mystic Paradox service right now.".to_string())?;
        parse_success(response, "Couldn't check Mystic Paradox service health.")
    })
    .await
}

#[tauri::command]
pub async fn native_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
    let expected_epoch = session_epoch::current();
    run_auth_task(move || {
        let response = http_client()?
            .post(format!("{}/launcher/v1/auth/login", api_base_url()))
            .json(&LoginRequest {
                email: &email,
                password: &password,
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Can't reach the Mystic Paradox server right now.".to_string())?;
        let session: NativeSession = parse_success(response, "Sign-in failed.")?;
        let mut epoch = session_epoch::lock();
        session_epoch::check(expected_epoch, *epoch)?;
        *epoch += 1;
        revoke_local_guard_state();
        secure_store::save(&app, &session.refresh_token)?;
        cache_access(*epoch, &session);
        Ok(session.account)
    })
    .await
}

#[tauri::command]
pub async fn native_register(
    app: AppHandle,
    display_name: String,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
    let expected_epoch = session_epoch::current();
    run_auth_task(move || {
        let response = http_client()?
            .post(format!("{}/launcher/v1/auth/register", api_base_url()))
            .json(&RegisterRequest {
                display_name: &display_name,
                email: &email,
                password: &password,
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Can't reach the Mystic Paradox server right now.".to_string())?;
        let pending: PendingRegistration = parse_success(response, "Registration failed.")?;
        let mut epoch = session_epoch::lock();
        session_epoch::check(expected_epoch, *epoch)?;
        *epoch += 1;
        let _ = secure_store::clear(&app);
        revoke_local_guard_state();
        Ok(pending.account)
    })
    .await
}

#[tauri::command]
pub async fn native_discord_complete(
    app: AppHandle,
    code: String,
) -> Result<NativeAccount, String> {
    let expected_epoch = session_epoch::current();
    run_auth_task(move || {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CompleteRequest<'a> {
            code: &'a str,
            device_id: &'a str,
            device_name: &'a str,
        }
        let response = http_client()?
            .post(format!(
                "{}/launcher/v1/auth/discord/complete",
                api_base_url()
            ))
            .json(&CompleteRequest {
                code: &code,
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Couldn't complete Discord sign-in.".to_string())?;
        let session: NativeSession = parse_success(response, "Discord sign-in failed.")?;
        let mut epoch = session_epoch::lock();
        session_epoch::check(expected_epoch, *epoch)?;
        *epoch += 1;
        revoke_local_guard_state();
        secure_store::save(&app, &session.refresh_token)?;
        cache_access(*epoch, &session);
        Ok(session.account)
    })
    .await
}

#[tauri::command]
pub async fn native_start_discord_login(app: AppHandle) -> Result<(), String> {
    run_auth_task(move || {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StartResponse {
            authorize_url: String,
        }

        let response = http_client()?
            .post(format!("{}/launcher/v1/auth/discord/start", api_base_url()))
            .json(&DeviceRequest {
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Couldn't start Discord sign-in.".to_string())?;
        let start: StartResponse = parse_success(response, "Couldn't start Discord sign-in.")?;
        let parsed = Url::parse(&start.authorize_url)
            .map_err(|_| "Discord returned an invalid URL.".to_string())?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("discord.com") {
            return Err("Refusing to open a non-Discord URL.".to_string());
        }
        app.opener()
            .open_url(start.authorize_url, None::<&str>)
            .map_err(|_| "Couldn't open Discord in your browser.".to_string())
    })
    .await
}

#[tauri::command]
pub async fn native_set_username(
    app: AppHandle,
    username: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        #[derive(Serialize)]
        struct UsernameRequest<'a> {
            username: &'a str,
        }
        let response = send_authorized(&app, |token| {
            http_client()?
                .post(format!("{}/launcher/v1/username", api_base_url()))
                .bearer_auth(token)
                .json(&UsernameRequest {
                    username: &username,
                })
                .send()
                .map_err(|_| "Couldn't set your username.".to_string())
        })?;
        let account: NativeAccount = parse_success(response, "Couldn't set your username.")?;
        // The cached token still carries the pre-username account view.
        invalidate_access_token();
        Ok(account)
    })
    .await
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogUpload {
    pub auto: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePolicy {
    pub policy_version: String,
    pub roles: Vec<String>,
    pub channel: String,
    pub managed_feature_ids: Vec<String>,
    pub log_upload: NativeLogUpload,
    pub guard_enforcement: String,
    pub diagnostics_profile: String,
    pub p2p_emergency_stop: bool,
}

// Shared by native_get_policy (badge/channel, exposed to JS) and secure_launch's flag
// reconciliation (Rust-internal, right before spawn_game) so both reuse a single already
//-fetched access token instead of each rotating the refresh token separately.
pub(crate) fn fetch_policy(access_token: &str) -> Result<NativePolicy, String> {
    let response = http_client()?
        .get(format!("{}/launcher/v1/policy", api_base_url()))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| "Can't reach the Mystic Paradox server right now.".to_string())?;
    parse_success(response, "Couldn't refresh your account policy.")
}

/// `fetch_policy` with the cached access token, for callers that do not already hold one.
pub(crate) fn fetch_policy_cached(app: &AppHandle) -> Result<NativePolicy, String> {
    let response = send_authorized(app, |token| {
        http_client()?
            .get(format!("{}/launcher/v1/policy", api_base_url()))
            .bearer_auth(token)
            .send()
            .map_err(|_| "Can't reach the Mystic Paradox server right now.".to_string())
    })?;
    parse_success(response, "Couldn't refresh your account policy.")
}

// Called after login, after session restore, and immediately before Play — the runtime
// caches several flags for the process lifetime, so this must run before spawn_game(),
// not just periodically in the background. secure_launch re-fetches it with a fresh session.
#[tauri::command]
pub async fn native_get_policy(app: AppHandle) -> Result<NativePolicy, String> {
    run_auth_task(move || fetch_policy_cached(&app)).await
}

/// The periodic account-status check. It reads `/launcher/v1/me` with the cached access token
/// instead of rotating the refresh token every two minutes; the backend still re-checks the
/// session family and account admission on every request.
#[tauri::command]
pub async fn native_refresh_account(app: AppHandle) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let response = send_authorized(&app, |token| {
            http_client()?
                .get(format!("{}/launcher/v1/me", api_base_url()))
                .bearer_auth(token)
                .send()
                .map_err(|_| "Couldn't reach the Mystic Paradox account server.".to_string())
        })?;
        parse_success(response, "Couldn't refresh your account status.")
    })
    .await
}

#[tauri::command]
pub async fn native_logout(app: AppHandle) -> Result<(), String> {
    run_auth_task(move || logout_local_session(app)).await
}

fn logout_local_session(app: AppHandle) -> Result<(), String> {
    let mut epoch = session_epoch::lock();
    *epoch += 1;
    invalidate_access_token();
    // Revoke local Guard state before propagating any secure-store error. If the
    // credential store is temporarily unavailable, a protected game/host must
    // still be stopped and its account-bound sessions invalidated immediately.
    let refresh_token = secure_store::load(&app);
    revoke_local_guard_state();
    let refresh_token = refresh_token?;
    secure_store::clear(&app)?;
    drop(epoch);

    // Local sign-out must never wait for an offline server. If a token existed,
    // rotate it and revoke the resulting session family in the background.
    if let Some(refresh_token) = refresh_token {
        let _background_revoke = tauri::async_runtime::spawn_blocking(move || {
            let response = http_client()?
                .post(format!("{}/launcher/v1/auth/refresh", api_base_url()))
                .json(&RefreshRequest {
                    refresh_token: &refresh_token,
                    device_id: "native-windows-launcher",
                    device_name: "Windows PC",
                })
                .send()
                .map_err(|_| "Couldn't reach the account server.".to_string())?;
            let session: NativeSession =
                parse_success(response, "Couldn't revoke the launcher session.")?;
            let response = http_client()?
                .post(format!("{}/launcher/v1/auth/logout", api_base_url()))
                .bearer_auth(&session.access_token)
                .send()
                .map_err(|_| "Couldn't reach the account server.".to_string())?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(safe_api_error(response, "Sign-out failed."))
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn native_forget_session(app: AppHandle) -> Result<(), String> {
    run_auth_task(move || {
        let mut epoch = session_epoch::lock();
        *epoch += 1;
        invalidate_access_token();
        // Wait for process registration on a blocking worker, never on the UI thread.
        // Revoke protected processes even if the credential store is unavailable.
        let clear_result = secure_store::clear(&app);
        revoke_local_guard_state();
        clear_result
    })
    .await
}
