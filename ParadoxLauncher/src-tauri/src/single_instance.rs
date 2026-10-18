//! [2026-10-18] One launcher per Windows session, checked before Tauri starts.
//!
//! The single-instance plugin lets a second start go on whenever it finds the plugin's mutex but not its message window,
//! and several launchers on one PC then refreshed the same saved session at once and signed the player out (the game
//! ended with it). This check runs first: when another launcher already runs, the new process hands its arguments
//! (a Discord sign-in link) to it in the plugin's own message format, so the running launcher comes to the front, and
//! exits. If that launcher cannot be reached, a message box says it is already running. A second launcher never opens.
#![cfg(windows)]

use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
    System::{
        DataExchange::COPYDATASTRUCT,
        Threading::{CreateMutexW, OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
    },
    UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, FindWindowW, GetWindowThreadProcessId, MessageBoxW,
        SendMessageTimeoutW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
        SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_COPYDATA,
    },
};

/// This launcher's own instance mutex (session-local).
const INSTANCE_MUTEX: &str = "Local\\dev.mysticfox.launcher-instance";
/// The single-instance plugin's names for the app identifier `dev.mysticfox.launcher` (tauri-plugin-single-instance 2.4,
/// no `semver` feature): its mutex, which launchers before 0.1.78 hold too, and its message window.
const PLUGIN_MUTEX: &str = "dev.mysticfox.launcher-sim";
const PLUGIN_WINDOW_CLASS: &str = "dev.mysticfox.launcher-sic";
const PLUGIN_WINDOW_NAME: &str = "dev.mysticfox.launcher-siw";
/// The plugin's `WM_COPYDATA` tag.
const PLUGIN_COPYDATA_TAG: usize = 1542;
/// How long to look for the running launcher's window: it may still be starting, or (an update) just closing.
const FIND_WINDOW_WAIT: Duration = Duration::from_secs(6);
/// How long the running launcher has to take the message; a hung one fails it.
const SEND_TIMEOUT_MS: u32 = 5_000;

const ALREADY_RUNNING_TITLE: &str = "Mystic Paradox Launcher";
const ALREADY_RUNNING_TEXT: &str = "Mystic Paradox Launcher is already running.\n\n\
It may be minimized or still starting. Use the window that is already open, or close it before starting the launcher again.";

/// Keeps this process's instance mutex for its whole life (Windows releases it when the process ends).
pub struct InstanceGuard(#[allow(dead_code)] HANDLE);

// The handle is only held, never used across threads.
unsafe impl Send for InstanceGuard {}
unsafe impl Sync for InstanceGuard {}

/// Returns the guard when this is the only launcher. Otherwise forwards this start to the running launcher, or shows the
/// "already running" message, and ends the process.
pub fn ensure_single_instance() -> InstanceGuard {
    let started = Instant::now();
    loop {
        if let Some(guard) = take_instance() {
            return guard;
        }
        if let Some(window) = find_plugin_window() {
            if forward_to(window) {
                std::process::exit(0);
            }
            break;
        }
        if started.elapsed() >= FIND_WINDOW_WAIT {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    already_running_message();
    std::process::exit(0);
}

/// Creates this launcher's mutex. `None` while another launcher (this version's mutex, or the plugin's mutex an older
/// version holds) exists.
fn take_instance() -> Option<InstanceGuard> {
    let name = wide(INSTANCE_MUTEX);
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // No mutex at all (should not happen): never block the launcher on it.
        return Some(InstanceGuard(handle));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return None;
    }
    let plugin = wide(PLUGIN_MUTEX);
    let older = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, plugin.as_ptr()) };
    if !older.is_null() {
        // A launcher before 0.1.78 runs (it holds only the plugin's mutex).
        unsafe {
            CloseHandle(older);
            CloseHandle(handle);
        }
        return None;
    }
    Some(InstanceGuard(handle))
}

fn find_plugin_window() -> Option<windows_sys::Win32::Foundation::HWND> {
    let class = wide(PLUGIN_WINDOW_CLASS);
    let name = wide(PLUGIN_WINDOW_NAME);
    let window = unsafe { FindWindowW(class.as_ptr(), name.as_ptr()) };
    (!window.is_null()).then_some(window)
}

/// The plugin's message: `"{cwd}|{args joined by |}\0"`.
fn copydata_payload(cwd: &str, args: &[String]) -> Vec<u8> {
    format!("{cwd}|{}\0", args.join("|")).into_bytes()
}

/// Sends this start's arguments to the running launcher, which focuses its window and opens a sign-in link. False when
/// it did not take the message in time.
fn forward_to(window: windows_sys::Win32::Foundation::HWND) -> bool {
    let cwd = std::env::current_dir().unwrap_or_default();
    let args: Vec<String> = std::env::args().collect();
    let payload = copydata_payload(cwd.to_str().unwrap_or_default(), &args);
    let data = COPYDATASTRUCT {
        dwData: PLUGIN_COPYDATA_TAG,
        cbData: payload.len() as u32,
        lpData: payload.as_ptr() as *mut _,
    };
    unsafe {
        // This process was just started by the player, so it may hand the foreground to the running launcher.
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id != 0 {
            AllowSetForegroundWindow(process_id);
        }
        let mut result = 0usize;
        let sent = SendMessageTimeoutW(
            window,
            WM_COPYDATA,
            0,
            &data as *const COPYDATASTRUCT as isize,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            SEND_TIMEOUT_MS,
            &mut result,
        );
        sent != 0
    }
}

fn already_running_message() {
    let title = wide(ALREADY_RUNNING_TITLE);
    let text = wide(ALREADY_RUNNING_TEXT);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forwarded_message_matches_the_plugins_format() {
        let args = vec![
            "C:\\Program Files\\Mystic Paradox Launcher\\launcher.exe".to_string(),
            "mysticparadox://auth/discord?code=abc".to_string(),
        ];
        let payload = copydata_payload("C:\\Users\\x", &args);
        assert_eq!(
            payload,
            b"C:\\Users\\x|C:\\Program Files\\Mystic Paradox Launcher\\launcher.exe|mysticparadox://auth/discord?code=abc\0".to_vec()
        );
    }

    #[test]
    fn the_plugin_names_follow_the_app_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let identifier = config["identifier"].as_str().unwrap();
        assert_eq!(PLUGIN_MUTEX, format!("{identifier}-sim"));
        assert_eq!(PLUGIN_WINDOW_CLASS, format!("{identifier}-sic"));
        assert_eq!(PLUGIN_WINDOW_NAME, format!("{identifier}-siw"));
    }
}
