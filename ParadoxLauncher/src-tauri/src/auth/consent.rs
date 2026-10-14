// [2026-10-13 realms S5] The LOCAL SERVER WARNING: which local servers the player has accepted.
//
// Nothing is sent to a local server (no sign-in, no token, no status request, no ticket) until its warning has been
// accepted. Acceptance has two lengths, both per server id:
//   * this launcher run only (the player pressed "I agree");
//   * remembered ("Don't show again" ticked): saved in `local-server-consent.json` next to `servers.json`.
// The popup comes back on the next run for a server that was not remembered. The file is a convenience and fails
// closed: unreadable or damaged means "not remembered", so the player is asked again.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

use crate::install::paths;

/// What a command that would contact a local server answers while its warning has not been accepted.
pub const NOT_ACCEPTED: &str = "Read and accept the local server warning first.";

const CONSENT_FILE: &str = "local-server-consent.json";
const CONSENT_FILE_VERSION: u32 = 1;

/// Serialises every read-modify-write of the file, and holds this run's acceptances.
static STATE: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredConsent {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    remembered: Vec<String>,
}

/// The remembered ids in `dir`. A missing, unreadable or damaged file is "none".
pub fn read_remembered(dir: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(dir.join(CONSENT_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<StoredConsent>(&text).ok())
        .map(|stored| stored.remembered.into_iter().collect())
        .unwrap_or_default()
}

fn write_remembered(dir: &Path, remembered: &BTreeSet<String>) -> Result<(), String> {
    let path = dir.join(CONSENT_FILE);
    let temporary = path.with_extension("json.tmp");
    let stored = StoredConsent {
        version: CONSENT_FILE_VERSION,
        remembered: remembered.iter().cloned().collect(),
    };
    let contents = serde_json::to_vec_pretty(&stored)
        .map_err(|_| "Couldn't encode the server warning choices.".to_string())?;
    std::fs::write(&temporary, contents)
        .map_err(|_| "Couldn't save your server warning choice.".to_string())?;
    std::fs::rename(&temporary, &path)
        .map_err(|_| "Couldn't save your server warning choice.".to_string())
}

fn session_state() -> std::sync::MutexGuard<'static, BTreeSet<String>> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn file_lock() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether `id`'s warning has been accepted: in this run, or remembered.
pub fn is_accepted_in(dir: &Path, id: &str) -> bool {
    session_state().contains(id) || read_remembered(dir).contains(id)
}

/// Whether `id`'s warning is remembered ("Don't show again").
pub fn is_remembered_in(dir: &Path, id: &str) -> bool {
    read_remembered(dir).contains(id)
}

/// Records the player's "I agree" for `id`. `remember` saves it ("Don't show again"); without it a previously
/// remembered choice is withdrawn, so the box in the popup always means what it shows.
pub fn accept_in(dir: &Path, id: &str, remember: bool) -> Result<(), String> {
    let _file = file_lock();
    let mut remembered = read_remembered(dir);
    let changed = if remember {
        remembered.insert(id.to_string())
    } else {
        remembered.remove(id)
    };
    // The file first: when it cannot be written the player is told, and nothing is recorded for this run either.
    if changed {
        write_remembered(dir, &remembered)?;
    }
    session_state().insert(id.to_string());
    Ok(())
}

/// Forgets everything about `id` (the server was removed).
pub fn forget_in(dir: &Path, id: &str) {
    let _file = file_lock();
    session_state().remove(id);
    let mut remembered = read_remembered(dir);
    if remembered.remove(id) {
        let _ = write_remembered(dir, &remembered);
    }
}

pub fn is_accepted(app: &AppHandle, id: &str) -> bool {
    paths::config_dir(app)
        .map(|dir| is_accepted_in(&dir, id))
        .unwrap_or_else(|_| session_state().contains(id))
}

pub fn is_remembered(app: &AppHandle, id: &str) -> bool {
    paths::config_dir(app)
        .map(|dir| is_remembered_in(&dir, id))
        .unwrap_or(false)
}

pub fn accept(app: &AppHandle, id: &str, remember: bool) -> Result<(), String> {
    accept_in(&paths::config_dir(app)?, id, remember)
}

pub fn forget(app: &AppHandle, id: &str) {
    match paths::config_dir(app) {
        Ok(dir) => forget_in(&dir, id),
        Err(_) => {
            session_state().remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-consent-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The session set is process-wide, so every test uses ids of its own.

    #[test]
    fn nothing_is_accepted_until_the_player_agrees() {
        let dir = scratch("none");
        assert!(!is_accepted_in(&dir, "s-consent-none"));
        assert!(!is_remembered_in(&dir, "s-consent-none"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agreeing_without_the_box_lasts_only_this_run() {
        let dir = scratch("session");
        accept_in(&dir, "s-consent-session", false).unwrap();
        assert!(is_accepted_in(&dir, "s-consent-session"));
        assert!(!is_remembered_in(&dir, "s-consent-session"));
        assert!(
            !dir.join("local-server-consent.json").exists(),
            "nothing is written for a one-run acceptance"
        );
        // A new launcher run: the in-memory set is empty and the file says nothing.
        session_state().remove("s-consent-session");
        assert!(!is_accepted_in(&dir, "s-consent-session"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dont_show_again_is_saved_per_server_and_survives_a_new_run() {
        let dir = scratch("remember");
        accept_in(&dir, "s-consent-remember-a", true).unwrap();
        assert!(is_remembered_in(&dir, "s-consent-remember-a"));
        let text = fs::read_to_string(dir.join("local-server-consent.json")).unwrap();
        assert!(text.contains("s-consent-remember-a"), "{text}");
        // Another server is not covered by it.
        assert!(!is_accepted_in(&dir, "s-consent-remember-b"));
        // New run.
        session_state().remove("s-consent-remember-a");
        assert!(is_accepted_in(&dir, "s-consent-remember-a"));
        assert!(!dir.join("local-server-consent.json.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agreeing_with_the_box_cleared_withdraws_a_remembered_choice() {
        let dir = scratch("withdraw");
        accept_in(&dir, "s-consent-withdraw", true).unwrap();
        accept_in(&dir, "s-consent-withdraw", false).unwrap();
        assert!(!is_remembered_in(&dir, "s-consent-withdraw"));
        // Still accepted for this run: the player has just agreed.
        assert!(is_accepted_in(&dir, "s-consent-withdraw"));
        session_state().remove("s-consent-withdraw");
        assert!(!is_accepted_in(&dir, "s-consent-withdraw"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removing_a_server_forgets_its_choice() {
        let dir = scratch("forget");
        accept_in(&dir, "s-consent-forget", true).unwrap();
        accept_in(&dir, "s-consent-keep", true).unwrap();
        forget_in(&dir, "s-consent-forget");
        assert!(!is_accepted_in(&dir, "s-consent-forget"));
        assert!(is_accepted_in(&dir, "s-consent-keep"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_file_fails_closed() {
        let dir = scratch("damaged");
        fs::write(dir.join("local-server-consent.json"), b"{ not json").unwrap();
        assert!(!is_accepted_in(&dir, "s-consent-damaged"));
        // A new choice replaces it.
        accept_in(&dir, "s-consent-damaged", true).unwrap();
        assert!(is_remembered_in(&dir, "s-consent-damaged"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_save_records_nothing() {
        let dir = scratch("unwritable");
        // A directory where the file belongs makes the rename fail.
        fs::create_dir_all(dir.join("local-server-consent.json")).unwrap();
        assert!(accept_in(&dir, "s-consent-unwritable", true).is_err());
        assert!(!session_state().contains("s-consent-unwritable"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
