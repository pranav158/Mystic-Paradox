use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const DISCORD_AUTH_COMPLETE_EVENT: &str = "discord-auth-complete";
const DISCORD_AUTH_ERROR_EVENT: &str = "discord-auth-error";
// [2026-10-15] Linking Discord in Settings comes back as `mysticparadox://link/done` or `link/error?code=...`.
const DISCORD_LINK_DONE_EVENT: &str = "discord-link-done";
const DISCORD_LINK_ERROR_EVENT: &str = "discord-link-error";

/// How a Discord link started in Settings ended (`mysticparadox://link/...`).
#[derive(Debug, PartialEq, Eq)]
pub enum LinkResult {
    Done,
    /// The launcher error code (`AUTH_DISCORD_ALREADY_LINKED`, ...), or "UNKNOWN" when the link carries none.
    Failed(String),
}

/// Cold-start / macOS path: the deep-link plugin fires this directly when the
/// app is launched (or already running, on macOS) via `mysticparadox://...`.
pub fn listen(app: AppHandle) {
    let handler_app = app.clone();

    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_url(&handler_app, &url);
        }
    });
}

/// Cold launch on Windows/Linux: if the OS started this process BECAUSE of the
/// URL (the app wasn't already running), that URL arrived as argv before
/// `listen`'s handler existed to catch it. Tauri's deep-link docs recommend
/// checking `get_current()` once at startup for exactly this case, in addition
/// to the ongoing `on_open_url` listener above.
pub fn check_startup_url(app: &AppHandle) {
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_url(app, &url);
        }
    }
}

/// Warm-instance path on Windows/Linux: re-invoking the protocol while the app
/// is already running spawns a new process whose argv carries the URL, caught
/// by the single-instance plugin callback in `lib.rs` rather than `on_open_url`.
pub fn handle_url(app: &AppHandle, url: &Url) {
    if let Some(code) = extract_discord_completion_code(url) {
        let _ = app.emit(DISCORD_AUTH_COMPLETE_EVENT, code);
        return;
    }

    if let Some(code) = extract_discord_error_code(url) {
        let _ = app.emit(DISCORD_AUTH_ERROR_EVENT, code);
        return;
    }

    match extract_discord_link_result(url) {
        Some(LinkResult::Done) => {
            let _ = app.emit(DISCORD_LINK_DONE_EVENT, ());
        }
        Some(LinkResult::Failed(code)) => {
            let _ = app.emit(DISCORD_LINK_ERROR_EVENT, code);
        }
        None => {}
    }
}

fn is_mysticparadox_auth_path(url: &Url, path: &str) -> bool {
    url.scheme() == "mysticparadox" && url.host_str() == Some("auth") && url.path() == path
}

fn is_mysticparadox_link_path(url: &Url, path: &str) -> bool {
    url.scheme() == "mysticparadox" && url.host_str() == Some("link") && url.path() == path
}

/// `mysticparadox://link/done`, or `mysticparadox://link/error?code=<code>`: the end of a Discord link started in Settings.
pub fn extract_discord_link_result(url: &Url) -> Option<LinkResult> {
    if is_mysticparadox_link_path(url, "/done") {
        return Some(LinkResult::Done);
    }
    if is_mysticparadox_link_path(url, "/error") {
        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| "UNKNOWN".to_string());
        return Some(LinkResult::Failed(code));
    }
    None
}

pub fn extract_discord_completion_code(url: &Url) -> Option<String> {
    if !is_mysticparadox_auth_path(url, "/complete") {
        return None;
    }

    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
}

/// `mysticparadox://auth/error?code=<LauncherErrorCode>` — the backend's Discord
/// callback redirects here (instead of /complete) when the flow fails server-side
/// (expired state, Discord denied consent, etc.) — see routes/launcherAuth.ts's
/// GET /launcher/v1/auth/discord/callback handler.
pub fn extract_discord_error_code(url: &Url) -> Option<String> {
    if !is_mysticparadox_auth_path(url, "/error") {
        return None;
    }

    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_code_from_valid_completion_url() {
        let url = Url::parse("mysticparadox://auth/complete?code=abc123").unwrap();
        assert_eq!(
            extract_discord_completion_code(&url),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn rejects_wrong_scheme() {
        let url = Url::parse("https://auth/complete?code=abc123").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn rejects_wrong_path() {
        let url = Url::parse("mysticparadox://auth/other?code=abc123").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn rejects_missing_code() {
        let url = Url::parse("mysticparadox://auth/complete").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn extracts_code_from_valid_error_url() {
        let url = Url::parse("mysticparadox://auth/error?code=AUTH_DISCORD_CANCELLED").unwrap();
        assert_eq!(
            extract_discord_error_code(&url),
            Some("AUTH_DISCORD_CANCELLED".to_string())
        );
    }

    #[test]
    fn error_extractor_rejects_complete_path() {
        let url = Url::parse("mysticparadox://auth/complete?code=abc123").unwrap();
        assert_eq!(extract_discord_error_code(&url), None);
    }

    #[test]
    fn a_finished_discord_link_is_read_from_its_deep_link() {
        let done = Url::parse("mysticparadox://link/done").unwrap();
        assert_eq!(extract_discord_link_result(&done), Some(LinkResult::Done));

        let refused =
            Url::parse("mysticparadox://link/error?code=AUTH_DISCORD_ALREADY_LINKED").unwrap();
        assert_eq!(
            extract_discord_link_result(&refused),
            Some(LinkResult::Failed(
                "AUTH_DISCORD_ALREADY_LINKED".to_string()
            ))
        );

        let bare = Url::parse("mysticparadox://link/error").unwrap();
        assert_eq!(
            extract_discord_link_result(&bare),
            Some(LinkResult::Failed("UNKNOWN".to_string()))
        );
    }

    #[test]
    fn the_link_reader_ignores_other_paths_and_the_sign_in_routes() {
        let sign_in = Url::parse("mysticparadox://auth/complete?code=abc123").unwrap();
        assert_eq!(extract_discord_link_result(&sign_in), None);
        let other = Url::parse("mysticparadox://link/other").unwrap();
        assert_eq!(extract_discord_link_result(&other), None);
        let wrong_scheme = Url::parse("https://link/done").unwrap();
        assert_eq!(extract_discord_link_result(&wrong_scheme), None);
    }
}
