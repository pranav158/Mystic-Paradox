use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::auth::secure_store;

pub(crate) fn api_base_url() -> &'static str {
    if cfg!(debug_assertions) {
        option_env!("MYSTPAX_API_BASE_URL").unwrap_or("http://127.0.0.1:3000")
    } else {
        option_env!("MYSTPAX_API_BASE_URL").unwrap_or("https://paradox.mysticfox.dev")
    }
}

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())
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

pub(crate) fn refresh_native_session(app: &AppHandle) -> Result<NativeSession, String> {
    let token = secure_store::load(app)?
        .ok_or_else(|| "Your session expired. Sign in again.".to_string())?;
    let response = http_client()?
        .post(format!("{}/launcher/v1/auth/refresh", api_base_url()))
        .json(&RefreshRequest {
            refresh_token: &token,
            device_id: "native-windows-launcher",
            device_name: "Windows PC",
        })
        .send()
        .map_err(|_| "Couldn't reach the Mystic Paradox account server.".to_string())?;
    let session: NativeSession =
        parse_success(response, "Couldn't restore your launcher session.")?;
    secure_store::save(app, &session.refresh_token)?;
    Ok(session)
}

#[tauri::command]
pub async fn native_restore_session(app: AppHandle) -> Result<Option<NativeAccount>, String> {
    run_auth_task(move || {
        if secure_store::load(&app)?.is_none() {
            return Ok(None);
        }
        match refresh_native_session(&app) {
            Ok(session) => Ok(Some(session.account)),
            Err(error) => {
                if error.contains("expired")
                    || error.contains("approval")
                    || error.contains("approved")
                    || error.contains("disabled")
                    || error.contains("banned")
                {
                    let _ = secure_store::clear(&app);
                }
                Err(error)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn native_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
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
        secure_store::save(&app, &session.refresh_token)?;
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
        let _ = secure_store::clear(&app);
        Ok(pending.account)
    })
    .await
}

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
        secure_store::save(&app, &session.refresh_token)?;
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
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/username", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&UsernameRequest {
                username: &username,
            })
            .send()
            .map_err(|_| "Couldn't set your username.".to_string())?;
        parse_success(response, "Couldn't set your username.")
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

// Called after login, after session restore, and immediately before Play — the runtime
// caches several flags for the process lifetime, so this must run before spawn_game(),
// not just periodically in the background.
#[tauri::command]
pub async fn native_get_policy(app: AppHandle) -> Result<NativePolicy, String> {
    run_auth_task(move || {
        let session = refresh_native_session(&app)?;
        fetch_policy(&session.access_token)
    })
    .await
}

#[tauri::command]
pub fn native_logout(app: AppHandle) -> Result<(), String> {
    let refresh_token = secure_store::load(&app)?;
    secure_store::clear(&app)?;

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
pub fn native_forget_session(app: AppHandle) -> Result<(), String> {
    secure_store::clear(&app)
}
