pub mod flags;
pub mod game_settings;
pub mod guard;
pub mod guard_checks;
pub mod guard_loop;
pub mod logs;
pub mod module_signer;
pub mod process;
pub mod supervisor;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// The launcher window's label (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";
/// How many times one launcher process rebuilds a window it lost while a game runs. A window that keeps dying
/// (an injected overlay can take WebView2 down again) is not rebuilt forever.
const MAX_WINDOW_REBUILDS: u32 = 5;
const WINDOW_REBUILD_RETRY: Duration = Duration::from_secs(2);
static WINDOW_REBUILDS: AtomicU32 = AtomicU32::new(0);
static WINDOW_RESTORE_RUNNING: AtomicBool = AtomicBool::new(false);
/// Set when the main window receives a close request (Alt+F4, the taskbar), so the exit log tells a closed
/// window from one that disappeared by itself.
static CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// How long launcher exit waits for owned player-host supervisors to fence their server, stop
/// their transport session and reap their child before the Job Object is used as the hard boundary.
/// The supervisor's own graceful window is six seconds, so the first drain has to cover it.
#[cfg(mystic_p2p)]
const SESSION_DRAIN_TIMEOUT: Duration = Duration::from_secs(7);
/// A second, shorter drain after the Job Object is terminated: a killed child lets its supervisor
/// finish unregistering almost immediately.
#[cfg(mystic_p2p)]
const POST_KILL_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// Set as soon as an orderly launcher exit begins. Every entry point that would start new work
/// checks this first, so shutdown can never race a fresh Play attempt into a half-torn-down
/// launcher.
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

pub fn is_shutting_down() -> bool {
    SHUTDOWN_STARTED.load(Ordering::Acquire)
}

/// Writes one cleanup stage to the always-available exit log and to the active session log (when a
/// Play attempt owns one). A stalled exit then names the stage it stopped in instead of dying
/// silently.
fn stage(name: &str, detail: &str) {
    let line = format!("shutdown stage={name} {detail}");
    logs::append_shutdown_log(&line);
    process::append_active_session_log(&line);
}

/// The processes this launcher protects: its own game client and, in a P2P build, a player-host server.
pub(crate) fn protected_process_running() -> bool {
    #[cfg(mystic_p2p)]
    let host = crate::p2p::guarded_host_process_id();
    #[cfg(not(mystic_p2p))]
    let host = None::<u32>;
    process::game_process_id().is_some() || host.is_some()
}

/// Whether an exit request must be refused to keep a running game alive. Every deliberate exit (the title-bar
/// close) calls `exit` with a code; a request without one means the last window went away, and with Steam loaded
/// in this process the WebView2 window can vanish by itself. Ending the launcher then would end the game with
/// 0xE302 under a windowless launcher.
fn keeps_running_for_game(code: Option<i32>, protected_running: bool, shutting_down: bool) -> bool {
    code.is_none() && protected_running && !shutting_down
}

fn window_log(line: &str) {
    logs::append_shutdown_log(line);
    process::append_active_session_log(line);
}

/// [2026-10-16] How long a hidden main window may wait for its page before it is shown anyway.
const WINDOW_REVEAL_FALLBACK: Duration = Duration::from_secs(4);

/// [2026-10-16] The main window is created hidden (`tauri.conf.json` `visible: false`, dark `backgroundColor`): WebView2
/// painted white before the page loaded, and the window-state plugin then moved the window to its saved place, which
/// showed as a white flash and a jump at every start. The page shows the window after its first frame
/// (`src/lib/windowReveal.ts`). This is the safety net: should the page never do so (a script error), the window is shown
/// after `WINDOW_REVEAL_FALLBACK`, so the launcher can never stay invisible.
pub fn reveal_main_window_fallback(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WINDOW_REVEAL_FALLBACK);
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        if window.is_visible().unwrap_or(true) {
            return;
        }
        window_log("launcher window shown by the fallback: the page did not show it in time");
        let _ = window.show();
        let _ = window.set_focus();
    });
}

/// `RunEvent::WindowEvent` close request on the main window.
pub fn note_close_requested() {
    CLOSE_REQUESTED.store(true, Ordering::Release);
}

/// `RunEvent::ExitRequested`: true when the exit must be prevented, in which case the main window is rebuilt and
/// the game keeps running. Otherwise the orderly shutdown runs (`shutdown_all`).
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
    let protected_running = protected_process_running();
    if !keeps_running_for_game(code, protected_running, is_shutting_down()) {
        return false;
    }
    window_log(&format!(
        "launcher exit refused: the window went away without an explicit exit while a game runs \
         (closeRequested={}); keeping the game and rebuilding the window",
        CLOSE_REQUESTED.swap(false, Ordering::AcqRel)
    ));
    restore_main_window(app);
    true
}

/// Rebuilds the main window from its configuration when it is gone (a lost window, or a second launcher start
/// while windowless). After `MAX_WINDOW_REBUILDS` rebuilds the launcher stays windowless until the game ends and
/// then exits normally.
pub fn restore_main_window(app: &AppHandle) {
    if WINDOW_RESTORE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    // Never on the event-loop thread: creating a WebView2 window there can deadlock.
    std::thread::spawn(move || {
        while !is_shutting_down() && app.get_webview_window(MAIN_WINDOW).is_none() {
            let rebuild = WINDOW_REBUILDS.fetch_add(1, Ordering::AcqRel) + 1;
            if rebuild <= MAX_WINDOW_REBUILDS {
                let result = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == MAIN_WINDOW)
                    .ok_or_else(|| "the configuration has no main window".to_string())
                    .and_then(|config| {
                        tauri::WebviewWindowBuilder::from_config(&app, config)
                            .and_then(|builder| builder.build())
                            .map_err(|error| error.to_string())
                    });
                match result {
                    Ok(_) => {
                        window_log(&format!("launcher window rebuilt (rebuild={rebuild})"));
                        // Built hidden from the same configuration: its page shows it, or the fallback does.
                        reveal_main_window_fallback(&app);
                        break;
                    }
                    Err(error) => window_log(&format!(
                        "launcher window rebuild failed (rebuild={rebuild}): {error}"
                    )),
                }
            } else if !protected_process_running() {
                window_log(
                    "launcher window not rebuilt and the game has ended; exiting the launcher",
                );
                app.exit(0);
                break;
            }
            std::thread::sleep(WINDOW_REBUILD_RETRY);
        }
        WINDOW_RESTORE_RUNNING.store(false, Ordering::Release);
    });
}

fn timed<T>(name: &str, action: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    stage(name, "begin");
    let value = action();
    stage(
        name,
        &format!("done elapsedMs={}", started.elapsed().as_millis()),
    );
    value
}

/// Explicit launcher-exit cleanup. The Windows Job Object remains the hard kill boundary even if
/// the launcher crashes. Every stage is logged, so a stalled exit is attributable; ephemeral Guard
/// material is cleared last.
///
/// In a P2P build this coordinator also tells launcher-owned supervisors to stop, waits for them
/// (bounded) to release their child and transport session and runs the transport module's shutdown,
/// which joins its worker before the module is unloaded. Order matters: new work is refused
/// first, owned sessions are drained next, and only then is the shared transport allowed to go away.
pub fn shutdown_all() {
    if SHUTDOWN_STARTED.swap(true, Ordering::AcqRel) {
        stage(
            "duplicate",
            "cleanup already ran for this process; ignoring the repeated exit event",
        );
        return;
    }
    let started = Instant::now();
    stage(
        "exit",
        &format!(
            "launcher version={} pid={}",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );

    // Stop accepting new work before anything is torn down.
    timed("guard_loop_stop", guard_loop::stop);
    // The control loop must not issue a fresh bootstrap whose transport is about to be unloaded.
    #[cfg(mystic_p2p)]
    timed("control_loop_stop", crate::p2p::stop_control_loop);

    // Ask every launcher-owned supervisor to stop, then wait for the registry to drain. A
    // supervisor only unregisters after it has fenced its server, stopped its transport session and
    // reaped its child, so an empty registry means that work really is finished.
    #[cfg(mystic_p2p)]
    {
        let requested = timed("stop_sessions", crate::p2p::stop_all_sessions);
        stage("stop_sessions", &format!("requested={requested}"));
        let drained = crate::p2p::drain_sessions(SESSION_DRAIN_TIMEOUT);
        stage("drain_sessions", &format!("drained={drained}"));
    }

    // The Job Object is the hard boundary for anything that ignored its stop request.
    timed("terminate_job", || {
        if let Err(error) = supervisor::terminate_all(0xE302) {
            stage("terminate_job", &format!("error={error}"));
        }
    });
    #[cfg(mystic_p2p)]
    {
        let drained_after_kill = crate::p2p::drain_sessions(POST_KILL_DRAIN_TIMEOUT);
        stage("drain_after_kill", &format!("drained={drained_after_kill}"));

        // The P2P transport shutdown must run after the sessions above, never before them.
        timed("transport_shutdown", crate::p2p::shutdown_transport);
    }

    // Ephemeral Guard material last. The heartbeat path no longer holds the Guard map lock across
    // network I/O, so this cannot wait behind an in-flight request.
    timed("guard_clear", guard_loop::clear);

    stage(
        "complete",
        &format!("elapsedMs={}", started.elapsed().as_millis()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_lost_window_with_a_running_game_keeps_the_launcher() {
        // The window went away by itself while the game runs: keep both.
        assert!(keeps_running_for_game(None, true, false));
        // An explicit exit (the title-bar close) still ends the launcher and the game.
        assert!(!keeps_running_for_game(Some(0), true, false));
        // Nothing to protect: the last window closing exits as before.
        assert!(!keeps_running_for_game(None, false, false));
        // An orderly shutdown already began: never resurrect the launcher.
        assert!(!keeps_running_for_game(None, true, true));
        // A restart request carries its own code.
        assert!(!keeps_running_for_game(
            Some(tauri::RESTART_EXIT_CODE),
            true,
            false
        ));
    }
}
