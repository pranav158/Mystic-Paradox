//! [2026-10-14] The joiner side of a Paradox realm (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 6.3). While a
//! game entered through a realm runs, the launcher keeps the member's realm presence alive
//! (`realms/presence/heartbeat` every 30 s) and tells the backend when the game has exited (`realms/presence/leave`).
//!
//! Shared code, not under `p2p/`: a realm member needs it with the co-op switch off. Failures are logged in the game's
//! session log and retried at the next beat; nothing here ever ends or blocks a game. The exit hook is
//! `client_exited()`, called by the game's exit monitor (`launch/process.rs`).

use reqwest::blocking::Response;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, http_client, send_authorized};
use crate::launch::{logs, process};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT: &str = "/launcher/v1/realms/presence/heartbeat";
const LEAVE: &str = "/launcher/v1/realms/presence/leave";

/// `{ realm: { name, serving, hubReady, hostOnline } | null, expiresAt }`.
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PresenceView {
    realm: Option<RealmPresence>,
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RealmPresence {
    name: String,
    serving: bool,
    hub_ready: bool,
    host_online: bool,
}

/// The stop signal of the realm game that runs now. Dropping it ends that game's loop.
fn active() -> &'static Mutex<Option<Sender<()>>> {
    static ACTIVE: OnceLock<Mutex<Option<Sender<()>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the presence loop for a realm game that has just spawned. A loop still running for an earlier realm game
/// is ended first (its leave is sent by that loop).
pub fn start(app: &AppHandle, realm_name: &str) {
    let (stop_tx, stop_rx) = mpsc::channel();
    let previous = lock(active()).replace(stop_tx);
    drop(previous);
    let app = app.clone();
    let realm = realm_name.to_string();
    // The game's session folder, taken now: the exit monitor clears the active one before this loop's leave is sent.
    let session_dir = process::current_session_log_dir();
    std::thread::spawn(move || run(app, realm, session_dir, stop_rx));
}

/// Writes a presence line into the game's session folder, or the active one when the folder was not known.
fn log(session_dir: &Option<PathBuf>, line: &str) {
    match session_dir {
        Some(dir) => logs::append_launcher_log(dir, line),
        None => process::append_active_session_log(line),
    }
}

/// The game exited (`launch/process.rs`): the loop sends its leave now. A no-op when no realm game was started, so an
/// official game's exit does nothing here.
pub fn client_exited() {
    lock(active()).take();
}

fn run(app: AppHandle, realm: String, session_dir: Option<PathBuf>, stop: Receiver<()>) {
    let mut last: Option<String> = None;
    // The game may already have exited between the spawn and this thread: then there is nothing to keep alive.
    if process::game_process_id().is_some() {
        while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(HEARTBEAT_INTERVAL) {
            // The exit hook may not have run yet when the game has already gone: leave on the next check.
            if process::game_process_id().is_none() {
                break;
            }
            heartbeat(&app, &realm, &session_dir, &mut last);
        }
    }
    leave(&app, &session_dir);
}

fn heartbeat(
    app: &AppHandle,
    realm: &str,
    session_dir: &Option<PathBuf>,
    last: &mut Option<String>,
) {
    match presence(app) {
        Ok(view) => {
            let state = describe(&view, realm);
            if last.as_deref() != Some(state.as_str()) {
                log(session_dir, &format!("realm presence: {state}"));
                *last = Some(state);
            }
        }
        Err(error) => log(
            session_dir,
            &format!("realm presence heartbeat failed, retrying in 30 s: {error}"),
        ),
    }
}

fn leave(app: &AppHandle, session_dir: &Option<PathBuf>) {
    match call(app, LEAVE) {
        Ok(_) => log(session_dir, "realm presence: left the realm"),
        Err(error) => log(
            session_dir,
            &format!(
                "realm presence leave failed (the backend expires it in two minutes): {error}"
            ),
        ),
    }
}

/// What the presence log says about the realm, in one line. Changes are logged, not every beat.
fn describe(view: &PresenceView, realm: &str) -> String {
    match &view.realm {
        Some(presence) => format!(
            "{} hostOnline={} serving={} hubReady={}",
            presence.name, presence.host_online, presence.serving, presence.hub_ready
        ),
        None => format!("{realm}: no realm presence yet (the game login binds it)"),
    }
}

fn presence(app: &AppHandle) -> Result<PresenceView, String> {
    let response = call(app, HEARTBEAT)?;
    response
        .json::<PresenceView>()
        .map_err(|_| "The realm presence answer was malformed.".to_string())
}

/// POST with an empty body on the official scope (a realm is our backend). A refused answer is its status only.
fn call(app: &AppHandle, path: &str) -> Result<Response, String> {
    let url = format!("{}{path}", api_base_url());
    let response = send_authorized(app, |token| {
        http_client()?
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({}))
            .send()
            .map_err(|_| "Couldn't reach the realm server.".to_string())
    })?;
    if response.status().is_success() {
        Ok(response)
    } else {
        // [2026-10-14] A deactivated account's presence is refused with the sentence that names its deletion day.
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .unwrap_or_default();
        Err(crate::commands::account::deactivated_message(&body)
            .unwrap_or_else(|| format!("the server answered {status}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_answers_with_and_without_a_realm() {
        let with: PresenceView = serde_json::from_str(
            r#"{"realm":{"name":"tempest","serving":true,"hubReady":true,"hostOnline":true},"expiresAt":"2026-10-14T10:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(
            with.realm,
            Some(RealmPresence {
                name: "tempest".to_string(),
                serving: true,
                hub_ready: true,
                host_online: true,
            })
        );
        let without: PresenceView =
            serde_json::from_str(r#"{"realm":null,"expiresAt":null}"#).unwrap();
        assert_eq!(without.realm, None);
    }

    #[test]
    fn the_log_line_names_the_realm_state() {
        let view = PresenceView {
            realm: Some(RealmPresence {
                name: "tempest".to_string(),
                serving: false,
                hub_ready: false,
                host_online: true,
            }),
        };
        assert_eq!(
            describe(&view, "tempest"),
            "tempest hostOnline=true serving=false hubReady=false"
        );
        assert_eq!(
            describe(&PresenceView { realm: None }, "tempest"),
            "tempest: no realm presence yet (the game login binds it)"
        );
    }
}
