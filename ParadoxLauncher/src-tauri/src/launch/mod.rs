pub mod flags;
pub mod guard;
pub mod guard_loop;
pub mod logs;
pub mod process;
pub mod supervisor;

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "p2p")]
use std::time::Duration;
use std::time::Instant;

/// How long launcher exit waits for owned player-host supervisors to fence their server, stop
/// their Steam session and reap their child before the Job Object is used as the hard boundary.
/// The supervisor's own graceful window is six seconds, so the first drain has to cover it.
#[cfg(feature = "p2p")]
const SESSION_DRAIN_TIMEOUT: Duration = Duration::from_secs(7);
/// A second, shorter drain after the Job Object is terminated: a killed child lets its supervisor
/// finish unregistering almost immediately.
#[cfg(feature = "p2p")]
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
/// (bounded) to release their child and Steam session and runs the native Steam shutdown, which
/// joins the transport worker before the DLL is unloaded. Order matters: new work is refused
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
    #[cfg(feature = "p2p")]
    timed("control_loop_stop", crate::p2p::stop_control_loop);

    // Ask every launcher-owned supervisor to stop, then wait for the registry to drain. A
    // supervisor only unregisters after it has fenced its server, stopped its Steam session and
    // reaped its child, so an empty registry means that work really is finished.
    #[cfg(feature = "p2p")]
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
    #[cfg(feature = "p2p")]
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
