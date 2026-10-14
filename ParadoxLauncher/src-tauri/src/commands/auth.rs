use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::auth::scope::{self, AuthScope};
use crate::auth::{consent, secure_store, session_epoch};
use crate::commands::account::{
    deactivated_message, ConsentRequest, NativeConsentInput, DEACTIVATED_WITHOUT_DATE,
};
use crate::servers;

// [2026-10-13 realms S5] Every session call below belongs to an `AuthScope` (`auth/scope.rs`): the OFFICIAL backend
// with the original saved session (official server and Paradox realms), or a LOCAL server's own backend with a session
// saved under that server's id. The scope fixes the base URL, the token store, the access-token cache, the refresh
// lock and the session epoch, so nothing of one scope can reach another:
//   * an official token, exchange code or account id is never sent to a local server;
//   * a local server's tokens are never sent to the official backend.
// The functions that keep their old names (`current_access_token`, `send_authorized`, `refresh_native_session`,
// `fetch_policy*`, `api_base_url`) are the OFFICIAL scope's: Guard, the runtime feed, the log upload and the co-op
// module (`p2p/`) belong to our network and call them unchanged. Calls that follow the selected server take a scope.

/// Where a scope's refresh token lives, and what a session that ended must stop. The launcher uses the Credential
/// Manager / DPAPI (`AppHost`); the tests use memory.
pub(crate) trait SessionHost {
    fn load_token(&self, scope: &AuthScope) -> Result<Option<String>, String>;
    fn save_token(&self, scope: &AuthScope, token: &str) -> Result<(), String>;
    fn clear_token(&self, scope: &AuthScope) -> Result<(), String>;
    /// The scope's session ended or was replaced (sign-out, expiry, a new sign-in).
    fn session_ended(&self, scope: &AuthScope);
}

pub(crate) struct AppHost<'a>(pub(crate) &'a AppHandle);

impl SessionHost for AppHost<'_> {
    fn load_token(&self, scope: &AuthScope) -> Result<Option<String>, String> {
        secure_store::load(self.0, scope)
    }

    fn save_token(&self, scope: &AuthScope, token: &str) -> Result<(), String> {
        secure_store::save(self.0, scope, token)
    }

    fn clear_token(&self, scope: &AuthScope) -> Result<(), String> {
        secure_store::clear(self.0, scope)
    }

    fn session_ended(&self, scope: &AuthScope) {
        revoke_local_guard_state(scope);
    }
}

/// Whether a session ending in `scope` must stop the running game: only a game that belongs to that scope.
/// `client_scope` is the scope the running client was launched under (`None`: no client runs, so only a P2P host -
/// which is always on the official network - could be in the job).
fn ends_running_game(scope: &AuthScope, client_scope: Option<&str>) -> bool {
    match client_scope {
        Some(key) => key == scope.key(),
        None => scope.is_official(),
    }
}

/// Revoke all launcher-owned P2P state whenever the local account identity of a scope changes.
/// Guard sessions and protected game/host processes are account-bound; retaining either across
/// logout or account switch could let a later heartbeat or presence tick submit the old session
/// with a new bearer token. The Job Object is the hard boundary for any process that does not
/// stop cleanly. Guard and co-op sessions belong to the official network, so only the official scope touches them;
/// a game is stopped only by the session it was launched under.
fn revoke_local_guard_state(scope: &AuthScope) {
    if scope.is_official() {
        #[cfg(mystic_p2p)]
        crate::p2p::stop_all_sessions();
        crate::launch::guard_loop::clear();
    }
    if ends_running_game(
        scope,
        crate::launch::process::running_client_scope().as_deref(),
    ) {
        let _ = crate::launch::supervisor::terminate_all(0xE304);
    }
}

// Refresh tokens are single-use and rotated by the backend. Several launcher services begin
// together after startup (session restore, policy, and P2P presence), so two concurrent refreshes
// could previously submit the same token. The backend correctly treats that as token reuse and
// revokes the entire session family, which looked like the launcher signed itself out every time.
// Serialize the complete load -> rotate -> save operation so each caller observes the latest token.
// One lock per scope: a slow local server never holds up the official session.
fn refresh_lock(scope: &AuthScope) -> Arc<Mutex<()>> {
    static LOCKS: Mutex<BTreeMap<String, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(scope.key().to_string())
        .or_default()
        .clone()
}

fn hold(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The OFFICIAL backend. Built-in: `MYSTICPARADOX_API_BASE_URL` at build time, else `127.0.0.1:3000` in debug builds.
/// A local server's address is its scope's (`AuthScope::base_url`), never this.
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

/// The client for a local server: the same timeouts, and no redirects. A launcher API call that is redirected is
/// refused instead of followed, so a server cannot bounce a sign-in (its password and tokens in the body) elsewhere.
fn own_server_client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())?;
    let _ = CLIENT.set(client.clone());
    Ok(CLIENT.get().cloned().unwrap_or(client))
}

/// The HTTP client for `scope`'s backend.
pub(crate) fn http_client_for(scope: &AuthScope) -> Result<reqwest::blocking::Client, String> {
    if scope.is_official() {
        http_client()
    } else {
        own_server_client()
    }
}

pub(crate) async fn run_auth_task<T, F>(operation: F) -> Result<T, String>
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

/// The launcher error code in a refusal body (`{ "error": { "code": ... } }`), when it has one.
pub(crate) fn error_code_of(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.code)
}

/// [2026-10-14] The sentence for a consent or deletion step the player must take before playing on.
pub(crate) const LAUNCHER_UPDATE_REQUIRED: &str =
    "Update the launcher to read and accept the current Terms of Use and Privacy Policy, then try again.";

pub(crate) fn safe_api_error(response: reqwest::blocking::Response, fallback: &str) -> String {
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    // [2026-10-14] Every route answers a deactivated account the same way: the sentence with the deletion day.
    if let Some(message) = deactivated_message(&body) {
        return message;
    }
    api_error_message(status, error_code_of(&body).as_deref(), fallback)
}

/// The sentence for a refused launcher call: the code's own sentence, or `fallback` with the status. Every launcher
/// refusal is read through this table (`safe_api_error`, the consent and deletion commands).
pub(crate) fn api_error_message(status: u16, code: Option<&str>, fallback: &str) -> String {
    match code {
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
        Some("LEGAL_VERSION_OUTDATED") | Some("CONSENT_REQUIRED") => {
            LAUNCHER_UPDATE_REQUIRED.to_string()
        }
        Some("CONSENT_AGE_REQUIRED") => {
            "You must meet the minimum age in the Terms of Use to create an account.".to_string()
        }
        Some("DELETION_CONFIRMATION_MISMATCH") => {
            "Type your username exactly as it is shown to confirm.".to_string()
        }
        Some("ACCOUNT_DEACTIVATED") => DEACTIVATED_WITHOUT_DATE.to_string(),
        Some("DELETION_HOLD_EXPIRED") => "This account can no longer be restored.".to_string(),
        _ => format!("{fallback} (server status {status})"),
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
    /// [2026-10-14] The official backend refuses a registration without it (CONSENT_REQUIRED). Absent on a local server.
    #[serde(skip_serializing_if = "Option::is_none")]
    consent: Option<&'a ConsentRequest>,
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
// on its next use. The cache is bound to the scope's account epoch, so login/logout/forget drop it, and it holds
// one entry per scope: a token is only ever served to the scope that earned it.
struct CachedAccess {
    epoch: u64,
    access_token: String,
    reuse_until: Instant,
}

static ACCESS_CACHE: Mutex<BTreeMap<String, CachedAccess>> = Mutex::new(BTreeMap::new());

// Stop reusing a token this long before it expires, so a request never races its expiry.
const ACCESS_TOKEN_REUSE_MARGIN: Duration = Duration::from_secs(90);
// Never trust a lifetime longer than this, whatever the token claims.
const ACCESS_TOKEN_MAX_REUSE: Duration = Duration::from_secs(15 * 60);

fn access_cache() -> MutexGuard<'static, BTreeMap<String, CachedAccess>> {
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

pub(crate) fn cache_access(scope: &AuthScope, epoch: u64, session: &NativeSession) {
    let usable = access_token_lifetime(&session.access_token)
        .and_then(|lifetime| lifetime.checked_sub(ACCESS_TOKEN_REUSE_MARGIN));
    let mut cache = access_cache();
    match usable {
        Some(usable) => {
            cache.insert(
                scope.key().to_string(),
                CachedAccess {
                    epoch,
                    access_token: session.access_token.clone(),
                    reuse_until: Instant::now() + usable,
                },
            );
        }
        None => {
            cache.remove(scope.key());
        }
    }
}

fn cached_access(scope: &AuthScope) -> Option<String> {
    let epoch = session_epoch::current(scope.key());
    access_cache()
        .get(scope.key())
        .filter(|entry| entry.epoch == epoch && Instant::now() < entry.reuse_until)
        .map(|entry| entry.access_token.clone())
}

pub(crate) fn invalidate_access_token_for(scope: &AuthScope) {
    access_cache().remove(scope.key());
}

/// The official scope's cached access token.
pub(crate) fn invalidate_access_token() {
    invalidate_access_token_for(&AuthScope::Official);
}

/// A usable access token for `scope`: the cached one while it has life left, otherwise one refresh.
/// Play still refreshes directly so every launch re-checks admission.
fn access_token_with(host: &dyn SessionHost, scope: &AuthScope) -> Result<String, String> {
    if let Some(token) = cached_access(scope) {
        return Ok(token);
    }
    let lock = refresh_lock(scope);
    let _refresh_guard = hold(&lock);
    // Another caller may have refreshed while this one waited for the lock.
    if let Some(token) = cached_access(scope) {
        return Ok(token);
    }
    refresh_locked(host, scope).map(|session| session.access_token)
}

/// A usable access token for the OFFICIAL scope (Guard, the runtime feed, the co-op module).
pub(crate) fn current_access_token(app: &AppHandle) -> Result<String, String> {
    access_token_with(&AppHost(app), &AuthScope::Official)
}

/// Sends an authenticated request with `scope`'s current access token. On 401/403 the token is
/// dropped and the session refreshed once: the refresh path owns sign-out for expired,
/// unapproved, disabled and banned accounts, exactly as when every call refreshed.
pub(crate) fn send_authorized_with<F>(
    host: &dyn SessionHost,
    scope: &AuthScope,
    send: F,
) -> Result<reqwest::blocking::Response, String>
where
    F: Fn(&str) -> Result<reqwest::blocking::Response, String>,
{
    let token = access_token_with(host, scope)?;
    let response = send(&token)?;
    if !matches!(response.status().as_u16(), 401 | 403) {
        return Ok(response);
    }
    invalidate_access_token_for(scope);
    let session = refresh_session_with(host, scope)?;
    send(&session.access_token)
}

/// `send_authorized_with` for the selected server's scope.
pub(crate) fn send_authorized_for<F>(
    app: &AppHandle,
    scope: &AuthScope,
    send: F,
) -> Result<reqwest::blocking::Response, String>
where
    F: Fn(&str) -> Result<reqwest::blocking::Response, String>,
{
    send_authorized_with(&AppHost(app), scope, send)
}

/// `send_authorized_for` on the OFFICIAL scope (the log upload, the co-op module).
pub(crate) fn send_authorized<F>(
    app: &AppHandle,
    send: F,
) -> Result<reqwest::blocking::Response, String>
where
    F: Fn(&str) -> Result<reqwest::blocking::Response, String>,
{
    send_authorized_for(app, &AuthScope::Official, send)
}

fn refresh_session_with(
    host: &dyn SessionHost,
    scope: &AuthScope,
) -> Result<NativeSession, String> {
    let lock = refresh_lock(scope);
    let _refresh_guard = hold(&lock);
    refresh_locked(host, scope)
}

/// Rotates `scope`'s refresh token. Play uses this so every launch re-checks admission.
pub(crate) fn refresh_session_for(
    app: &AppHandle,
    scope: &AuthScope,
) -> Result<NativeSession, String> {
    refresh_session_with(&AppHost(app), scope)
}

/// `refresh_session_for` on the OFFICIAL scope (the held co-op bootstraps).
#[cfg_attr(not(mystic_p2p), allow(dead_code))]
pub(crate) fn refresh_native_session(app: &AppHandle) -> Result<NativeSession, String> {
    refresh_session_for(app, &AuthScope::Official)
}

/// Rotates the refresh token. The caller holds the scope's refresh lock.
fn refresh_locked(host: &dyn SessionHost, scope: &AuthScope) -> Result<NativeSession, String> {
    let (epoch, token) = {
        let epoch = session_epoch::lock(scope.key());
        let token = host
            .load_token(scope)?
            .ok_or_else(|| "Your session expired. Sign in again.".to_string())?;
        (*epoch, token)
    };
    let response = http_client_for(scope)?
        .post(format!("{}/launcher/v1/auth/refresh", scope.base_url()))
        .json(&RefreshRequest {
            refresh_token: &token,
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
        })
        .send()
        .map_err(|_| {
            scope
                .pick(
                    "Couldn't reach the Mystic Paradox account server.",
                    "Couldn't reach this server.",
                )
                .to_string()
        })?;
    let parsed =
        parse_success::<NativeSession>(response, "Couldn't restore your launcher session.");
    let mut current_epoch = session_epoch::lock(scope.key());
    session_epoch::check(epoch, *current_epoch)?;
    let session = match parsed {
        Ok(session) => session,
        Err(error) => {
            invalidate_access_token_for(scope);
            if error.contains("expired")
                || error.contains("approval")
                || error.contains("approved")
                || error.contains("disabled")
                || error.contains("banned")
            {
                *current_epoch += 1;
                let _ = host.clear_token(scope);
                host.session_ended(scope);
            }
            return Err(error);
        }
    };
    host.save_token(scope, &session.refresh_token)?;
    cache_access(scope, *current_epoch, &session);
    Ok(session)
}

/// Commits a fresh sign-in of `scope`: nothing else may have changed the scope's account meanwhile, the old session's
/// dependants stop, and the new refresh token is saved under the scope that asked.
fn commit_sign_in(
    host: &dyn SessionHost,
    scope: &AuthScope,
    expected_epoch: u64,
    session: NativeSession,
) -> Result<NativeAccount, String> {
    let mut epoch = session_epoch::lock(scope.key());
    session_epoch::check(expected_epoch, *epoch)?;
    *epoch += 1;
    host.session_ended(scope);
    host.save_token(scope, &session.refresh_token)?;
    cache_access(scope, *epoch, &session);
    Ok(session.account)
}

fn login_with(
    host: &dyn SessionHost,
    scope: &AuthScope,
    expected_epoch: u64,
    email: &str,
    password: &str,
) -> Result<NativeAccount, String> {
    let response = http_client_for(scope)?
        .post(format!("{}/launcher/v1/auth/login", scope.base_url()))
        .json(&LoginRequest {
            email,
            password,
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
        })
        .send()
        .map_err(|_| {
            scope
                .pick(
                    "Can't reach the Mystic Paradox server right now.",
                    "Can't reach this server right now.",
                )
                .to_string()
        })?;
    let session: NativeSession = parse_success(response, "Sign-in failed.")?;
    commit_sign_in(host, scope, expected_epoch, session)
}

fn restore_with(
    host: &dyn SessionHost,
    scope: &AuthScope,
) -> Result<Option<NativeAccount>, String> {
    if host.load_token(scope)?.is_none() {
        return Ok(None);
    }
    refresh_session_with(host, scope).map(|session| Some(session.account))
}

/// Local sign-out of `scope`: the epoch moves on, the access token is dropped, the scope's dependants stop and its
/// saved session is cleared before anything is said to the server. Returns the refresh token to revoke there, if one
/// was saved.
fn sign_out_locally(host: &dyn SessionHost, scope: &AuthScope) -> Result<Option<String>, String> {
    let mut epoch = session_epoch::lock(scope.key());
    *epoch += 1;
    invalidate_access_token_for(scope);
    // Revoke local Guard state before propagating any secure-store error. If the
    // credential store is temporarily unavailable, a protected game/host must
    // still be stopped and its account-bound sessions invalidated immediately.
    let refresh_token = host.load_token(scope);
    host.session_ended(scope);
    let refresh_token = refresh_token?;
    host.clear_token(scope)?;
    drop(epoch);
    Ok(refresh_token)
}

/// Rotates the refresh token and revokes the resulting session family on `scope`'s own backend.
fn revoke_remote_session(scope: &AuthScope, refresh_token: &str) -> Result<(), String> {
    let client = http_client_for(scope)?;
    let response = client
        .post(format!("{}/launcher/v1/auth/refresh", scope.base_url()))
        .json(&RefreshRequest {
            refresh_token,
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
        })
        .send()
        .map_err(|_| "Couldn't reach the account server.".to_string())?;
    let session: NativeSession = parse_success(response, "Couldn't revoke the launcher session.")?;
    let response = client
        .post(format!("{}/launcher/v1/auth/logout", scope.base_url()))
        .bearer_auth(&session.access_token)
        .send()
        .map_err(|_| "Couldn't reach the account server.".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(safe_api_error(response, "Sign-out failed."))
    }
}

// ---- which scope a command works on -----------------------------------------------------------------------------

/// The scope of the selected server (`server_id`, when the UI names one, must be it), without the warning check.
fn selected_scope(app: &AppHandle, server_id: Option<&str>) -> Result<AuthScope, String> {
    scope::scope_for(&servers::store::load(app), server_id)
}

/// Whether the player has accepted `scope`'s warning: official-network scopes need none.
fn warning_accepted(app: &AppHandle, scope: &AuthScope) -> bool {
    match scope {
        AuthScope::Official => true,
        AuthScope::Local { id, .. } => consent::is_accepted(app, id),
    }
}

/// The scope a command that CONTACTS a server works on: the selected server's, and for a local server only once its
/// LOCAL SERVER WARNING was accepted. Nothing is sent to a local server before that.
pub(crate) fn command_scope(app: &AppHandle, server_id: Option<&str>) -> Result<AuthScope, String> {
    let scope = selected_scope(app, server_id)?;
    if !warning_accepted(app, &scope) {
        return Err(consent::NOT_ACCEPTED.to_string());
    }
    Ok(scope)
}

#[tauri::command]
pub async fn native_restore_session(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<Option<NativeAccount>, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        restore_with(&AppHost(&app), &scope)
    })
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeServerStatus {
    pub online: bool,
    pub supported_build_changelist: u32,
}

/// `GET /launcher/v1/status` of `scope`'s backend.
pub(crate) fn fetch_status(scope: &AuthScope) -> Result<NativeServerStatus, String> {
    let response = http_client_for(scope)?
        .get(format!("{}/launcher/v1/status", scope.base_url()))
        .send()
        .map_err(|_| {
            scope
                .pick(
                    "Can't reach the Mystic Paradox service right now.",
                    "Can't reach this server right now.",
                )
                .to_string()
        })?;
    parse_success(response, "Couldn't check the service health.")
}

#[tauri::command]
pub async fn native_get_server_status(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativeServerStatus, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        fetch_status(&scope)
    })
    .await
}

#[derive(Deserialize, Serialize)]
pub struct NativeUsernameCheck {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The registration screen's availability check, answered by the SELECTED server's backend (a local server's
/// usernames are its own).
#[tauri::command]
pub async fn native_check_username(
    app: AppHandle,
    server_id: Option<String>,
    name: String,
) -> Result<NativeUsernameCheck, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        let response = http_client_for(&scope)?
            .get(format!("{}/launcher/v1/username", scope.base_url()))
            .query(&[("name", name.as_str())])
            .send()
            .map_err(|_| {
                scope
                    .pick(
                        "Can't reach the Mystic Paradox server right now.",
                        "Can't reach this server right now.",
                    )
                    .to_string()
            })?;
        parse_success(response, "Couldn't check that username.")
    })
    .await
}

#[tauri::command]
pub async fn native_login(
    app: AppHandle,
    server_id: Option<String>,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        let expected_epoch = session_epoch::current(scope.key());
        login_with(&AppHost(&app), &scope, expected_epoch, &email, &password)
    })
    .await
}

/// [2026-10-14] `consent` is the player's acceptance of the Terms of Use and Privacy Policy. The official backend (the
/// official server and Paradox realms) requires it; a local server keeps its own rules, so nothing is sent to it.
#[tauri::command]
pub async fn native_register(
    app: AppHandle,
    server_id: Option<String>,
    display_name: String,
    email: String,
    password: String,
    consent: Option<NativeConsentInput>,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        let expected_epoch = session_epoch::current(scope.key());
        let consent = match (&scope, consent) {
            (AuthScope::Official, Some(input)) => Some(input.into_request()?),
            (AuthScope::Official, None) => {
                return Err(
                    "Accept the Terms of Use and the Privacy Policy to create an account."
                        .to_string(),
                )
            }
            (AuthScope::Local { .. }, _) => None,
        };
        let response = http_client_for(&scope)?
            .post(format!("{}/launcher/v1/auth/register", scope.base_url()))
            .json(&RegisterRequest {
                display_name: &display_name,
                email: &email,
                password: &password,
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
                consent: consent.as_ref(),
            })
            .send()
            .map_err(|_| {
                scope
                    .pick(
                        "Can't reach the Mystic Paradox server right now.",
                        "Can't reach this server right now.",
                    )
                    .to_string()
            })?;
        let pending: PendingRegistration = parse_success(response, "Registration failed.")?;
        let host = AppHost(&app);
        let mut epoch = session_epoch::lock(scope.key());
        session_epoch::check(expected_epoch, *epoch)?;
        *epoch += 1;
        let _ = host.clear_token(&scope);
        host.session_ended(&scope);
        Ok(pending.account)
    })
    .await
}

/// Discord sign-in belongs to the official account system: it always completes on the OFFICIAL scope, whichever
/// server is selected. (The UI offers it on official servers only.)
#[tauri::command]
pub async fn native_discord_complete(
    app: AppHandle,
    code: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CompleteRequest<'a> {
            code: &'a str,
            device_id: &'a str,
            device_name: &'a str,
        }
        let scope = AuthScope::Official;
        let expected_epoch = session_epoch::current(scope.key());
        let response = http_client()?
            .post(format!(
                "{}/launcher/v1/auth/discord/complete",
                scope.base_url()
            ))
            .json(&CompleteRequest {
                code: &code,
                device_id: "native-windows-launcher",
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Couldn't complete Discord sign-in.".to_string())?;
        let session: NativeSession = parse_success(response, "Discord sign-in failed.")?;
        commit_sign_in(&AppHost(&app), &scope, expected_epoch, session)
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
    server_id: Option<String>,
    username: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        #[derive(Serialize)]
        struct UsernameRequest<'a> {
            username: &'a str,
        }
        let scope = command_scope(&app, server_id.as_deref())?;
        let response = send_authorized_for(&app, &scope, |token| {
            http_client_for(&scope)?
                .post(format!("{}/launcher/v1/username", scope.base_url()))
                .bearer_auth(token)
                .json(&UsernameRequest {
                    username: &username,
                })
                .send()
                .map_err(|_| "Couldn't set your username.".to_string())
        })?;
        let account: NativeAccount = parse_success(response, "Couldn't set your username.")?;
        // The cached token still carries the pre-username account view.
        invalidate_access_token_for(&scope);
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
    /// The server's half of the co-op switch (p2p/mod.rs); absent on a dedicated-only server.
    #[serde(default)]
    pub coop_hunts: bool,
}

// Shared by native_get_policy (badge/channel, exposed to JS) and secure_launch's flag
// reconciliation (Rust-internal, right before spawn_game) so both reuse a single already
//-fetched access token instead of each rotating the refresh token separately.
/// `GET /launcher/v1/policy` of `scope`'s backend with `access_token` (which must be that scope's own).
pub(crate) fn fetch_policy_from(
    scope: &AuthScope,
    access_token: &str,
) -> Result<NativePolicy, String> {
    let response = http_client_for(scope)?
        .get(format!("{}/launcher/v1/policy", scope.base_url()))
        .bearer_auth(access_token)
        .send()
        .map_err(|_| {
            scope
                .pick(
                    "Can't reach the Mystic Paradox server right now.",
                    "Can't reach this server right now.",
                )
                .to_string()
        })?;
    parse_success(response, "Couldn't refresh your account policy.")
}

/// `fetch_policy_from` on the OFFICIAL scope (the held co-op bootstraps).
#[cfg_attr(not(mystic_p2p), allow(dead_code))]
pub(crate) fn fetch_policy(access_token: &str) -> Result<NativePolicy, String> {
    fetch_policy_from(&AuthScope::Official, access_token)
}

fn fetch_policy_cached_with(
    host: &dyn SessionHost,
    scope: &AuthScope,
) -> Result<NativePolicy, String> {
    let response = send_authorized_with(host, scope, |token| {
        http_client_for(scope)?
            .get(format!("{}/launcher/v1/policy", scope.base_url()))
            .bearer_auth(token)
            .send()
            .map_err(|_| {
                scope
                    .pick(
                        "Can't reach the Mystic Paradox server right now.",
                        "Can't reach this server right now.",
                    )
                    .to_string()
            })
    })?;
    parse_success(response, "Couldn't refresh your account policy.")
}

/// `fetch_policy_from` with the cached access token, for callers that do not already hold one (OFFICIAL scope).
pub(crate) fn fetch_policy_cached(app: &AppHandle) -> Result<NativePolicy, String> {
    fetch_policy_cached_with(&AppHost(app), &AuthScope::Official)
}

// Called after login, after session restore, and immediately before Play — the runtime
// caches several flags for the process lifetime, so this must run before spawn_game(),
// not just periodically in the background. secure_launch re-fetches it with a fresh session.
#[tauri::command]
pub async fn native_get_policy(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativePolicy, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        fetch_policy_cached_with(&AppHost(&app), &scope)
    })
    .await
}

/// The periodic account-status check. It reads `/launcher/v1/me` with the cached access token
/// instead of rotating the refresh token every two minutes; the backend still re-checks the
/// session family and account admission on every request.
#[tauri::command]
pub async fn native_refresh_account(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let scope = command_scope(&app, server_id.as_deref())?;
        let response = send_authorized_for(&app, &scope, |token| {
            http_client_for(&scope)?
                .get(format!("{}/launcher/v1/me", scope.base_url()))
                .bearer_auth(token)
                .send()
                .map_err(|_| {
                    scope
                        .pick(
                            "Couldn't reach the Mystic Paradox account server.",
                            "Couldn't reach this server.",
                        )
                        .to_string()
                })
        })?;
        parse_success(response, "Couldn't refresh your account status.")
    })
    .await
}

#[tauri::command]
pub async fn native_logout(app: AppHandle, server_id: Option<String>) -> Result<(), String> {
    run_auth_task(move || {
        // Signing out needs no warning check: it clears this PC's saved session. The server is told only when it may
        // be contacted.
        let scope = selected_scope(&app, server_id.as_deref())?;
        let may_contact = warning_accepted(&app, &scope);
        logout_local_session(&app, &scope, may_contact)
    })
    .await
}

fn logout_local_session(
    app: &AppHandle,
    scope: &AuthScope,
    may_contact: bool,
) -> Result<(), String> {
    let refresh_token = sign_out_locally(&AppHost(app), scope)?;

    // Local sign-out must never wait for an offline server. If a token existed,
    // rotate it and revoke the resulting session family in the background.
    if let (Some(refresh_token), true) = (refresh_token, may_contact) {
        let scope = scope.clone();
        let _background_revoke = tauri::async_runtime::spawn_blocking(move || {
            revoke_remote_session(&scope, &refresh_token)
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn native_forget_session(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<(), String> {
    run_auth_task(move || {
        let scope = selected_scope(&app, server_id.as_deref())?;
        let host = AppHost(&app);
        let mut epoch = session_epoch::lock(scope.key());
        *epoch += 1;
        invalidate_access_token_for(&scope);
        // Wait for process registration on a blocking worker, never on the UI thread.
        // Revoke protected processes even if the credential store is unavailable.
        let clear_result = host.clear_token(&scope);
        host.session_ended(&scope);
        clear_result
    })
    .await
}

/// A removed local server leaves nothing behind: its saved session (Credential Manager entry and DPAPI file), its
/// cached access token, and the choices made in its warning.
pub(crate) fn forget_server(app: &AppHandle, entry: &servers::ServerEntry) {
    consent::forget(app, &entry.id);
    if let Ok(scope @ AuthScope::Local { .. }) = AuthScope::from_entry(entry) {
        invalidate_access_token_for(&scope);
        let _ = secure_store::clear(app, &scope);
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{access_token, error_json, mock_backend, session_json};
    use super::*;

    // ---- an in-memory host and a mock backend --------------------------------------------------------------

    #[derive(Default)]
    struct TestHost {
        tokens: Mutex<BTreeMap<String, String>>,
        ended: Mutex<Vec<String>>,
    }

    impl TestHost {
        fn with(tokens: &[(&AuthScope, &str)]) -> Self {
            let host = Self::default();
            for (scope, token) in tokens {
                host.tokens
                    .lock()
                    .unwrap()
                    .insert(scope.key().to_string(), token.to_string());
            }
            host
        }

        fn token(&self, scope: &AuthScope) -> Option<String> {
            self.tokens.lock().unwrap().get(scope.key()).cloned()
        }

        fn ended(&self) -> Vec<String> {
            self.ended.lock().unwrap().clone()
        }
    }

    impl SessionHost for TestHost {
        fn load_token(&self, scope: &AuthScope) -> Result<Option<String>, String> {
            Ok(self.token(scope))
        }

        fn save_token(&self, scope: &AuthScope, token: &str) -> Result<(), String> {
            self.tokens
                .lock()
                .unwrap()
                .insert(scope.key().to_string(), token.to_string());
            Ok(())
        }

        fn clear_token(&self, scope: &AuthScope) -> Result<(), String> {
            self.tokens.lock().unwrap().remove(scope.key());
            Ok(())
        }

        fn session_ended(&self, scope: &AuthScope) {
            self.ended.lock().unwrap().push(scope.key().to_string());
        }
    }

    fn local(id: &str, base: &str) -> AuthScope {
        AuthScope::Local {
            id: id.to_string(),
            base_url: base.to_string(),
        }
    }

    // ---- routing: which backend, which store ---------------------------------------------------------------

    #[test]
    fn a_local_refresh_posts_only_the_local_token_to_the_local_backend() {
        let (base, requests) = mock_backend(vec![(200, session_json("local-a", "rotated-local"))]);
        let scope = local("s-auth-refresh", &base);
        let host = TestHost::with(&[
            (&AuthScope::Official, "official-refresh-secret"),
            (&scope, "local-refresh-secret"),
        ]);
        let session = refresh_session_with(&host, &scope).unwrap();
        assert_eq!(session.account.user_id, "user-local-a");

        let request = requests.recv().unwrap();
        assert_eq!(request.method, "post");
        assert_eq!(request.path, "/launcher/v1/auth/refresh");
        assert!(request.text.contains("local-refresh-secret"));
        assert!(
            !request.text.contains("official-refresh-secret"),
            "the official refresh token never reaches a local server"
        );
        // The rotated token went to the local store; the official one is untouched.
        assert_eq!(host.token(&scope).as_deref(), Some("rotated-local"));
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret")
        );
        assert!(requests.try_recv().is_err(), "exactly one request");
    }

    #[test]
    fn the_official_scope_never_reads_a_local_servers_saved_session() {
        let scope = local("s-auth-nofallback", "http://127.0.0.1:9");
        let host = TestHost::with(&[(&scope, "local-refresh-secret")]);
        // No official token: the official scope has no session, whatever the local store holds, and no request is made.
        let error = access_token_with(&host, &AuthScope::Official).unwrap_err();
        assert!(error.contains("expired"), "{error}");
        assert!(restore_with(&host, &AuthScope::Official).unwrap().is_none());
        assert_eq!(host.token(&scope).as_deref(), Some("local-refresh-secret"));
    }

    #[test]
    fn a_local_scope_never_reads_the_official_session() {
        let scope = local("s-auth-nofallback2", "http://127.0.0.1:9");
        let host = TestHost::with(&[(&AuthScope::Official, "official-refresh-secret")]);
        assert!(restore_with(&host, &scope).unwrap().is_none());
        assert!(access_token_with(&host, &scope).is_err());
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret")
        );
    }

    #[test]
    fn access_tokens_are_cached_per_scope() {
        let a = local("s-auth-cache-a", "http://127.0.0.1:9");
        let b = local("s-auth-cache-b", "http://127.0.0.1:9");
        let session = |label: &str| NativeSession {
            access_token: access_token(label),
            refresh_token: "r".into(),
            account: serde_json::from_str::<NativeSession>(&session_json(label, "r"))
                .unwrap()
                .account,
        };
        cache_access(&a, session_epoch::current(a.key()), &session("a"));
        assert_eq!(cached_access(&a), Some(access_token("a")));
        assert_eq!(cached_access(&b), None, "another scope has no token");
        cache_access(&b, session_epoch::current(b.key()), &session("b"));
        assert_eq!(cached_access(&b), Some(access_token("b")));
        assert_eq!(cached_access(&a), Some(access_token("a")));
        invalidate_access_token_for(&a);
        assert_eq!(cached_access(&a), None);
        assert_eq!(
            cached_access(&b),
            Some(access_token("b")),
            "dropping one keeps the other"
        );
        // A sign-out (epoch bump) of one scope drops only its own cache.
        *session_epoch::lock(b.key()) += 1;
        assert_eq!(cached_access(&b), None);
    }

    #[test]
    fn a_rejected_token_refreshes_the_same_scope_and_retries_there() {
        let (base, requests) = mock_backend(vec![
            (401, error_json("AUTH_UNAUTHORIZED")),
            (200, session_json("local-new", "rotated-local")),
            (200, "{}".to_string()),
        ]);
        let scope = local("s-auth-retry", &base);
        let host = TestHost::with(&[
            (&AuthScope::Official, "official-refresh-secret"),
            (&scope, "local-refresh-secret"),
        ]);
        // A cached token for the scope, which the server rejects.
        let stale = NativeSession {
            access_token: access_token("stale"),
            refresh_token: "r".into(),
            account: serde_json::from_str::<NativeSession>(&session_json("s", "r"))
                .unwrap()
                .account,
        };
        cache_access(&scope, session_epoch::current(scope.key()), &stale);

        let sent = Mutex::new(Vec::new());
        let response = send_authorized_with(&host, &scope, |token| {
            sent.lock().unwrap().push(token.to_string());
            http_client_for(&scope)?
                .get(format!("{}/launcher/v1/me", scope.base_url()))
                .bearer_auth(token)
                .send()
                .map_err(|_| "unreachable".to_string())
        })
        .unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            *sent.lock().unwrap(),
            vec![access_token("stale"), access_token("local-new")]
        );

        let first = requests.recv().unwrap();
        assert_eq!(first.path, "/launcher/v1/me");
        assert!(first.text.contains(&access_token("stale").to_lowercase()));
        let second = requests.recv().unwrap();
        assert_eq!(second.path, "/launcher/v1/auth/refresh");
        assert!(second.text.contains("local-refresh-secret"));
        let third = requests.recv().unwrap();
        assert!(third
            .text
            .contains(&access_token("local-new").to_lowercase()));
        for request in [&first, &second, &third] {
            assert!(!request.text.contains("official-refresh-secret"));
        }
        assert_eq!(host.token(&scope).as_deref(), Some("rotated-local"));
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret")
        );
        assert!(host.ended().is_empty());
    }

    #[test]
    fn an_expired_local_session_ends_only_the_local_scope() {
        let (base, requests) = mock_backend(vec![(401, error_json("AUTH_REFRESH_INVALID"))]);
        let scope = local("s-auth-expire", &base);
        let host = TestHost::with(&[
            (&AuthScope::Official, "official-refresh-secret"),
            (&scope, "local-refresh-secret"),
        ]);
        let official_epoch = session_epoch::current(AuthScope::Official.key());
        let local_epoch = session_epoch::current(scope.key());

        let error = refresh_session_with(&host, &scope).err().unwrap();
        assert!(error.contains("expired"), "{error}");
        requests.recv().unwrap();

        assert_eq!(host.token(&scope), None, "the local session is cleared");
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret"),
            "the official session is not"
        );
        assert_eq!(host.ended(), vec![scope.key().to_string()]);
        assert_eq!(session_epoch::current(scope.key()), local_epoch + 1);
        assert_eq!(
            session_epoch::current(AuthScope::Official.key()),
            official_epoch
        );
    }

    #[test]
    fn a_sign_in_is_saved_under_the_scope_that_asked_and_sent_to_its_backend() {
        let (base, requests) =
            mock_backend(vec![(200, session_json("login", "fresh-local-refresh"))]);
        let scope = local("s-auth-login", &base);
        let host = TestHost::with(&[(&AuthScope::Official, "official-refresh-secret")]);
        let expected = session_epoch::current(scope.key());

        let account = login_with(
            &host,
            &scope,
            expected,
            "friend@example.com",
            "hunter2-password",
        )
        .unwrap();
        assert_eq!(account.user_id, "user-login");
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/launcher/v1/auth/login");
        assert!(request.text.contains("friend@example.com"));
        assert!(!request.text.contains("official-refresh-secret"));

        assert_eq!(host.token(&scope).as_deref(), Some("fresh-local-refresh"));
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret")
        );
        assert_eq!(host.ended(), vec![scope.key().to_string()]);
        assert_eq!(session_epoch::current(scope.key()), expected + 1);
    }

    #[test]
    fn a_sign_in_that_lost_a_race_with_a_sign_out_is_not_saved() {
        let (base, requests) = mock_backend(vec![(200, session_json("late", "late-refresh"))]);
        let scope = local("s-auth-race", &base);
        let host = TestHost::default();
        let expected = session_epoch::current(scope.key());
        // The scope's account changed while the sign-in was in flight.
        *session_epoch::lock(scope.key()) += 1;
        assert!(login_with(&host, &scope, expected, "a@example.com", "pw-pw-pw-pw").is_err());
        requests.recv().unwrap();
        assert_eq!(host.token(&scope), None);
        assert!(host.ended().is_empty());
    }

    #[test]
    fn a_sign_in_while_another_scope_changes_still_commits() {
        let (base, requests) = mock_backend(vec![(200, session_json("ok", "ok-refresh"))]);
        let scope = local("s-auth-parallel-a", &base);
        let other = local("s-auth-parallel-b", "http://127.0.0.1:9");
        let host = TestHost::default();
        let expected = session_epoch::current(scope.key());
        *session_epoch::lock(other.key()) += 1;
        login_with(&host, &scope, expected, "a@example.com", "pw-pw-pw-pw").unwrap();
        requests.recv().unwrap();
        assert_eq!(host.token(&scope).as_deref(), Some("ok-refresh"));
    }

    #[test]
    fn signing_out_clears_only_the_scopes_own_session() {
        let scope = local("s-auth-logout", "http://127.0.0.1:9");
        let other = local("s-auth-logout-other", "http://127.0.0.1:9");
        let host = TestHost::with(&[
            (&AuthScope::Official, "official-refresh-secret"),
            (&scope, "local-refresh-secret"),
            (&other, "other-refresh-secret"),
        ]);
        let revoked = sign_out_locally(&host, &scope).unwrap();
        assert_eq!(revoked.as_deref(), Some("local-refresh-secret"));
        assert_eq!(host.token(&scope), None);
        assert_eq!(
            host.token(&AuthScope::Official).as_deref(),
            Some("official-refresh-secret")
        );
        assert_eq!(host.token(&other).as_deref(), Some("other-refresh-secret"));
        assert_eq!(host.ended(), vec![scope.key().to_string()]);
    }

    #[test]
    fn the_remote_revoke_goes_to_the_scopes_own_backend_with_its_own_token() {
        let (base, requests) = mock_backend(vec![
            (200, session_json("revoke", "rotated")),
            (200, "{}".to_string()),
        ]);
        let scope = local("s-auth-revoke", &base);
        revoke_remote_session(&scope, "local-refresh-secret").unwrap();
        let refresh = requests.recv().unwrap();
        assert_eq!(refresh.path, "/launcher/v1/auth/refresh");
        assert!(refresh.text.contains("local-refresh-secret"));
        let logout = requests.recv().unwrap();
        assert_eq!(logout.path, "/launcher/v1/auth/logout");
        assert!(logout.text.contains(&access_token("revoke").to_lowercase()));
    }

    #[test]
    fn a_local_server_that_redirects_is_not_followed() {
        // A redirect from a local server's login would carry the password body elsewhere; it is refused instead.
        let (base, requests) = mock_backend(vec![(307, "{}".to_string())]);
        let scope = local("s-auth-redirect", &base);
        let host = TestHost::default();
        let result = login_with(
            &host,
            &scope,
            session_epoch::current(scope.key()),
            "a@example.com",
            "pw-pw-pw-pw",
        );
        assert!(result.is_err());
        requests.recv().unwrap();
        assert!(
            requests.recv_timeout(Duration::from_millis(300)).is_err(),
            "no second request was made"
        );
        assert_eq!(host.token(&scope), None);
    }

    #[test]
    fn the_policy_is_read_from_the_scopes_backend_with_the_token_it_was_given() {
        let policy = serde_json::json!({
            "policyVersion": "v", "roles": [], "channel": "stable", "managedFeatureIds": [],
            "logUpload": { "auto": false }, "guardEnforcement": "OBSERVE", "diagnosticsProfile": "PRODUCTION"
        })
        .to_string();
        let (base, requests) = mock_backend(vec![(200, policy)]);
        let scope = local("s-auth-policy", &base);
        let policy = fetch_policy_from(&scope, "the-local-access-token").unwrap();
        assert_eq!(policy.channel, "stable");
        assert!(!policy.coop_hunts);
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/launcher/v1/policy");
        assert!(request.text.contains("bearer the-local-access-token"));
    }

    #[test]
    fn the_status_chip_reads_the_selected_servers_backend() {
        let (base, requests) = mock_backend(vec![(
            200,
            r#"{"online":true,"supportedBuildChangelist":647472}"#.to_string(),
        )]);
        let scope = local("s-auth-status", &base);
        let status = fetch_status(&scope).unwrap();
        assert!(status.online);
        assert_eq!(status.supported_build_changelist, 647472);
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/launcher/v1/status");
        assert!(
            !request.text.contains("authorization"),
            "the status call carries no token"
        );
    }

    // ---- what a session ending may stop ------------------------------------------------------------------

    // ---- [2026-10-14] the shared refusal table and the registration's consent ----------------------------------

    #[test]
    fn consent_and_deletion_refusals_read_as_their_sentences() {
        assert_eq!(
            api_error_message(409, Some("LEGAL_VERSION_OUTDATED"), "x"),
            LAUNCHER_UPDATE_REQUIRED
        );
        assert_eq!(
            api_error_message(400, Some("CONSENT_REQUIRED"), "x"),
            LAUNCHER_UPDATE_REQUIRED
        );
        assert!(api_error_message(400, Some("CONSENT_AGE_REQUIRED"), "x").contains("minimum age"));
        assert_eq!(
            api_error_message(403, Some("ACCOUNT_DEACTIVATED"), "x"),
            DEACTIVATED_WITHOUT_DATE
        );
        assert_eq!(
            api_error_message(409, Some("DELETION_HOLD_EXPIRED"), "x"),
            "This account can no longer be restored."
        );
        // A code the table does not know keeps the caller's fallback and the status, as before.
        assert_eq!(
            api_error_message(500, Some("SOMETHING_NEW"), "Couldn't read it."),
            "Couldn't read it. (server status 500)"
        );
        assert_eq!(
            api_error_message(401, None, "Sign-out failed."),
            "Sign-out failed. (server status 401)"
        );
        // The deletion's own mismatch sentence is the one the Account page shows.
        assert_eq!(
            error_code_of(br#"{"error":{"code":"DELETION_CONFIRMATION_MISMATCH"}}"#).as_deref(),
            Some("DELETION_CONFIRMATION_MISMATCH")
        );
        assert_eq!(error_code_of(b"<html>"), None);
    }

    #[test]
    fn the_register_body_carries_consent_only_when_it_is_given() {
        let plain = RegisterRequest {
            display_name: "Slayer",
            email: "slayer@example.com",
            password: "a long password",
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
            consent: None,
        };
        let json = serde_json::to_value(&plain).unwrap();
        assert!(
            json.get("consent").is_none(),
            "a local server gets no consent field"
        );

        let accepted = ConsentRequest {
            terms_version: "2026-10-14".into(),
            privacy_version: "2026-10-14".into(),
            age_confirmed: true,
        };
        let json = serde_json::to_value(&RegisterRequest {
            consent: Some(&accepted),
            ..plain
        })
        .unwrap();
        assert_eq!(json["consent"]["termsVersion"], "2026-10-14");
        assert_eq!(json["consent"]["privacyVersion"], "2026-10-14");
        assert_eq!(json["consent"]["ageConfirmed"], true);
    }

    #[test]
    fn a_session_ending_stops_only_a_game_that_belongs_to_it() {
        let official = AuthScope::Official;
        let local = local("s-auth-ends", "http://127.0.0.1:9");
        // An official or realm client is stopped by the official session, never by a local one.
        assert!(ends_running_game(&official, Some("official")));
        assert!(!ends_running_game(&local, Some("official")));
        // A local client is stopped by its own server's session only.
        assert!(ends_running_game(&local, Some("s-auth-ends")));
        assert!(!ends_running_game(&official, Some("s-auth-ends")));
        assert!(!ends_running_game(
            &self::local("s-other", "http://127.0.0.1:9"),
            Some("s-auth-ends")
        ));
        // No client: only the official scope can have a P2P host in the job.
        assert!(ends_running_game(&official, None));
        assert!(!ends_running_game(&local, None));
    }
}
