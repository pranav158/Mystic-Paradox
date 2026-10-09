//! Launcher Guard heartbeats for the processes this launcher protects, on their own loop.
//!
//! Guard used to run inside the P2P presence cycle, so every launcher carried the P2P control loop,
//! and under ENFORCE three failed cycles killed the game with 0xE301 - network and backend outages
//! included. The launcher side of Guard is now observe-only: it runs the signed-manifest check and
//! sends signed heartbeats for each protected process, records the backend's verdict and never ends
//! a game. The backend acts on the verdict (a P2P build whose Guard is unhealthy cannot host).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::commands::auth::{current_access_token, fetch_policy_cached};
use crate::launch::{guard, process};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// Consecutive failures back off to this interval, so a missing or stale manifest costs one small
/// request every few minutes instead of one every 20 s.
const MAX_FAILURE_INTERVAL: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The backend's latest verdict for one protected role. P2P host presence reports it.
#[derive(Clone)]
#[cfg_attr(not(feature = "p2p"), allow(dead_code))]
pub struct GuardVerdict {
    pub session_id: String,
    pub sequence: u64,
    pub healthy: bool,
}

static STARTED: AtomicBool = AtomicBool::new(false);
static STOPPED: AtomicBool = AtomicBool::new(false);

fn verdicts() -> &'static Mutex<HashMap<&'static str, GuardVerdict>> {
    static VERDICTS: OnceLock<Mutex<HashMap<&'static str, GuardVerdict>>> = OnceLock::new();
    VERDICTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_verdict(role: &'static str, verdict: Option<GuardVerdict>) {
    if let Ok(mut map) = verdicts().lock() {
        match verdict {
            Some(verdict) => {
                map.insert(role, verdict);
            }
            None => {
                map.remove(role);
            }
        }
    }
}

/// The latest verdict for `client` or `host`, if that process has a live Guard session.
#[cfg_attr(not(feature = "p2p"), allow(dead_code))]
pub fn latest_verdict(role: &str) -> Option<GuardVerdict> {
    verdicts()
        .lock()
        .ok()
        .and_then(|map| map.get(role).cloned())
}

/// Drops every Guard session and verdict (sign-out, launcher exit).
pub fn clear() {
    if let Ok(mut map) = verdicts().lock() {
        map.clear();
    }
    guard::clear();
}

fn protected_processes() -> [(&'static str, Option<u32>); 2] {
    #[cfg(feature = "p2p")]
    let host = crate::p2p::guarded_host_process_id();
    #[cfg(not(feature = "p2p"))]
    let host = None;
    [("client", process::game_process_id()), ("host", host)]
}

/// 20, 40, 80, 160, then 300 s.
fn failure_interval(consecutive_failures: u32) -> Duration {
    let factor = 1u32 << consecutive_failures.saturating_sub(1).min(4);
    (HEARTBEAT_INTERVAL * factor).min(MAX_FAILURE_INTERVAL)
}

/// One heartbeat per running protected process. Returns false if any heartbeat failed; an unhealthy
/// verdict is a result, not a failure.
fn run_cycle(app: &AppHandle, processes: &[(&'static str, Option<u32>)]) -> bool {
    let prepared = fetch_policy_cached(app)
        .and_then(|policy| current_access_token(app).map(|token| (policy, token)));
    let (policy, token) = match prepared {
        Ok(value) => value,
        Err(error) => {
            process::append_active_session_log(&format!(
                "guard cycle skipped (observe only, the game keeps running): {error}"
            ));
            for (role, pid) in processes {
                if pid.is_some() {
                    set_verdict(role, None);
                }
            }
            return false;
        }
    };
    let mut all_ok = true;
    for (role, pid) in processes {
        let Some(pid) = pid else { continue };
        // guard::heartbeat writes the verdict, risk score and signals to the session log itself.
        match guard::heartbeat(app, &token, *pid, &policy.channel, role) {
            Ok((session_id, sequence, healthy, _risk_score)) => set_verdict(
                role,
                Some(GuardVerdict {
                    session_id,
                    sequence,
                    healthy,
                }),
            ),
            Err(error) => {
                all_ok = false;
                set_verdict(role, None);
                process::append_active_session_log(&format!(
                    "guard heartbeat error role={role} policy={} (observe only, the game keeps running): {error}",
                    policy.guard_enforcement
                ));
            }
        }
    }
    all_ok
}

fn run(app: AppHandle) {
    let mut next_cycle = Instant::now();
    let mut consecutive_failures = 0u32;
    while !STOPPED.load(Ordering::Acquire) {
        let processes = protected_processes();
        for (role, pid) in processes {
            if pid.is_none() {
                guard::clear_role(role);
                set_verdict(role, None);
            }
        }
        if processes.iter().all(|(_, pid)| pid.is_none()) {
            // Nothing to protect: the next process gets a heartbeat as soon as it appears.
            consecutive_failures = 0;
            next_cycle = Instant::now();
        } else if Instant::now() >= next_cycle {
            let succeeded = run_cycle(&app, &processes);
            consecutive_failures = if succeeded {
                0
            } else {
                consecutive_failures.saturating_add(1)
            };
            next_cycle = Instant::now()
                + if succeeded {
                    HEARTBEAT_INTERVAL
                } else {
                    failure_interval(consecutive_failures)
                };
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

pub fn start(app: AppHandle) {
    if STOPPED.load(Ordering::Acquire) || STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || run(app));
}

/// Launcher exit: no new heartbeats after this. An in-flight one finishes on its own.
pub fn stop() {
    STOPPED.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_back_off_to_five_minutes() {
        assert_eq!(failure_interval(1), Duration::from_secs(20));
        assert_eq!(failure_interval(2), Duration::from_secs(40));
        assert_eq!(failure_interval(4), Duration::from_secs(160));
        assert_eq!(failure_interval(5), Duration::from_secs(300));
        assert_eq!(failure_interval(50), Duration::from_secs(300));
    }

    #[test]
    fn verdicts_are_per_role_and_cleared_together() {
        set_verdict(
            "host",
            Some(GuardVerdict {
                session_id: "s".into(),
                sequence: 3,
                healthy: true,
            }),
        );
        assert_eq!(
            latest_verdict("host").map(|verdict| verdict.sequence),
            Some(3)
        );
        assert!(latest_verdict("client").is_none());
        clear();
        assert!(latest_verdict("host").is_none());
    }
}
