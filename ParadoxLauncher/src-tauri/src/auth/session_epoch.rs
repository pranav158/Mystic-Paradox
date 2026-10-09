//! Fence in-flight work at local account transitions without holding a lock over HTTP.
use std::sync::{Mutex, MutexGuard};

static EPOCH: Mutex<u64> = Mutex::new(0);

pub(crate) fn lock() -> MutexGuard<'static, u64> {
    EPOCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn current() -> u64 {
    *lock()
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
}
