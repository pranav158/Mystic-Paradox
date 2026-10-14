//! Fence in-flight work at local account transitions without holding a lock over HTTP.
//!
//! [2026-10-13 realms S5] One epoch per auth scope (`auth/scope.rs`): signing in or out of one server never
//! invalidates what is in flight for another. One lock covers every scope, as it always covered the single epoch, so
//! a critical section that holds it (Play's spawn) still excludes every transition.
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, MutexGuard};

static EPOCHS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// The lock, narrowed to one scope's counter: read it with `*guard`, bump it with `*guard += 1`.
pub(crate) struct EpochGuard {
    epochs: MutexGuard<'static, BTreeMap<String, u64>>,
    key: String,
}

impl Deref for EpochGuard {
    type Target = u64;

    fn deref(&self) -> &u64 {
        self.epochs.get(&self.key).unwrap_or(&0)
    }
}

impl DerefMut for EpochGuard {
    fn deref_mut(&mut self) -> &mut u64 {
        self.epochs.entry(self.key.clone()).or_insert(0)
    }
}

pub(crate) fn lock(scope_key: &str) -> EpochGuard {
    EpochGuard {
        epochs: EPOCHS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        key: scope_key.to_string(),
    }
}

pub(crate) fn current(scope_key: &str) -> u64 {
    *lock(scope_key)
}

pub(crate) fn check(expected: u64, actual: u64) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err("Your account session changed. Please try again.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_prevents_an_in_flight_refresh_from_committing() {
        let state = Mutex::new((0u64, Some("old token")));
        let refresh_epoch = state.lock().unwrap().0;
        {
            let mut state = state.lock().unwrap();
            state.0 += 1;
            state.1 = None;
        }
        let mut state = state.lock().unwrap();
        if check(refresh_epoch, state.0).is_ok() {
            state.1 = Some("rotated token");
        }
        assert_eq!(state.1, None);
        assert!(check(refresh_epoch, state.0).is_err());
        assert!(check(state.0, state.0).is_ok());
    }

    #[test]
    fn each_scope_has_its_own_epoch() {
        let (official_like, local_a, local_b) =
            ("s-epoch-test-official", "s-epoch-test-a", "s-epoch-test-b");
        let before = (current(official_like), current(local_a), current(local_b));
        assert_eq!(before, (0, 0, 0), "an unseen scope starts at zero");

        // An in-flight call of scope A captured its epoch, then scope B signed out.
        let in_flight_a = current(local_a);
        *lock(local_b) += 1;
        assert!(check(in_flight_a, current(local_a)).is_ok());
        assert_eq!(current(local_b), 1);
        assert_eq!(current(official_like), 0);

        // A sign-out of scope A does invalidate scope A's own in-flight call.
        *lock(local_a) += 1;
        assert!(check(in_flight_a, current(local_a)).is_err());
        assert_eq!(current(local_b), 1, "the other scope is untouched");
    }
}
