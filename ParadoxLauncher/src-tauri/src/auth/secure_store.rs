use keyring::Entry;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use windows_sys::Win32::Foundation::LocalFree;
#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const SERVICE: &str = "dev.mysticfox.launcher";
const USERNAME: &str = "refresh-token";
const FALLBACK_FILE: &str = "session.dpapi";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USERNAME).map_err(|e| e.to_string())
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(FALLBACK_FILE))
}

pub fn save(app: &AppHandle, token: &str) -> Result<(), String> {
    let keyring_result =
        entry().and_then(|item| item.set_password(token).map_err(|e| e.to_string()));
    let fallback_result = save_fallback(app, token);

    match (keyring_result, fallback_result) {
        (Ok(()), _) | (_, Ok(())) => Ok(()),
        (Err(keyring_error), Err(fallback_error)) => Err(format!(
            "Windows secure storage failed (Credential Manager: {keyring_error}; encrypted fallback: {fallback_error})"
        )),
    }
}

pub fn load(app: &AppHandle) -> Result<Option<String>, String> {
    let keyring_error =
        match entry().and_then(|item| item.get_password().map_err(|e| e.to_string())) {
            Ok(token) => return Ok(Some(token)),
            Err(error) => Some(error),
        };

    match load_fallback(app) {
        Ok(Some(token)) => {
            // Heal Credential Manager when only the encrypted standalone-file
            // copy survived. Failure is harmless because DPAPI remains valid.
            let _ = entry().and_then(|item| item.set_password(&token).map_err(|e| e.to_string()));
            Ok(Some(token))
        }
        Ok(None) => {
            // Missing in both stores is a normal first-run state. Credential
            // Manager reports this as an error string, so do not surface it.
            Ok(None)
        }
        Err(fallback_error) => Err(format!(
            "Could not read saved session (Credential Manager: {}; encrypted fallback: {fallback_error})",
            keyring_error.unwrap_or_else(|| "not found".to_string())
        )),
    }
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let keyring_result = match entry() {
        Ok(item) => match item.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        },
        Err(error) => Err(error),
    };

    let fallback_result = match fallback_path(app) {
        Ok(path) => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
        Err(error) => Err(error),
    };

    match (keyring_result, fallback_result) {
        (Ok(()), _) | (_, Ok(())) => Ok(()),
        (Err(keyring_error), Err(fallback_error)) => Err(format!(
            "Could not clear saved session (Credential Manager: {keyring_error}; encrypted fallback: {fallback_error})"
        )),
    }
}

#[cfg(windows)]
fn protect_for_current_user(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data
            .len()
            .try_into()
            .map_err(|_| "Session is too large.".to_string())?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(protected)
}

#[cfg(windows)]
fn unprotect_for_current_user(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data
            .len()
            .try_into()
            .map_err(|_| "Saved session is too large.".to_string())?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let clear =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(clear)
}

#[cfg(windows)]
fn save_fallback(app: &AppHandle, token: &str) -> Result<(), String> {
    let protected = protect_for_current_user(token.as_bytes())?;
    std::fs::write(fallback_path(app)?, protected).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn load_fallback(app: &AppHandle) -> Result<Option<String>, String> {
    let path = fallback_path(app)?;
    let protected = match std::fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let clear = unprotect_for_current_user(&protected)?;
    String::from_utf8(clear)
        .map(Some)
        .map_err(|_| "Saved session is not valid UTF-8.".to_string())
}

#[cfg(not(windows))]
fn save_fallback(_app: &AppHandle, _token: &str) -> Result<(), String> {
    Err("Encrypted fallback is only available on Windows.".to_string())
}

#[cfg(not(windows))]
fn load_fallback(_app: &AppHandle) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trip_uses_current_windows_user() {
        let value = b"standalone-launcher-refresh-token";
        let protected = protect_for_current_user(value).unwrap();
        assert_ne!(protected, value);
        assert_eq!(unprotect_for_current_user(&protected).unwrap(), value);
    }
}
