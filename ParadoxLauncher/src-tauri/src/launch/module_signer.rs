// Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
// Licensed under the GNU Affero General Public License v3.0.
// SPDX-License-Identifier: AGPL-3.0-only
// Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.

//! The publisher of a loaded module, read from its Authenticode signature (Guard's unexpected-module report).
//!
//! `WinVerifyTrust` checks the embedded or catalogue signature with no revocation lookup and no dialog. A valid
//! signature gives the display name of the signer's certificate. A file with no signature, or a type Windows does not
//! sign, gives "unsigned". Any other result (a changed file, a broken or untrusted chain) gives "invalid".
//! Chain building may fetch a missing intermediate certificate once, so the caller runs this on the Guard thread and
//! caches the answer (`guard_checks`).

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{
    HANDLE, TRUST_E_NOSIGNATURE, TRUST_E_PROVIDER_UNKNOWN, TRUST_E_SUBJECT_FORM_UNKNOWN,
};
use windows_sys::Win32::Security::Cryptography::{
    CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE,
};
use windows_sys::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
};

/// The publisher of a file with no signature, or of a type Windows does not sign.
pub(crate) const UNSIGNED: &str = "unsigned";
/// The publisher of a signature that does not verify, or of a signed file whose signer has no readable name.
pub(crate) const INVALID: &str = "invalid";
/// The longest signer name the report keeps.
pub(crate) const MAX_SIGNER_CHARS: usize = 128;

/// The publisher of the file at `path`: the signer's display name, "unsigned" or "invalid" (see the module note).
/// Blocking: it reads the file and may fetch a certificate, so it never runs on the UI thread.
pub(crate) fn authenticode_signer(path: &Path) -> String {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwUIContext: WTD_UICONTEXT_EXECUTE,
        ..Default::default()
    };
    let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: `wide` and `file` outlive every call below, `data` points only at `file`, and `action` is our own copy.
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast::<c_void>(),
        )
    };
    let signer = match status {
        // SAFETY: after a successful VERIFY the state handle names the provider data until CLOSE below.
        0 => unsafe { signer_name(data.hWVTStateData) }.unwrap_or_else(|| INVALID.to_string()),
        TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN | TRUST_E_PROVIDER_UNKNOWN => {
            UNSIGNED.to_string()
        }
        _ => INVALID.to_string(),
    };
    // The state opened by VERIFY is released whatever the result was.
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: the same data and file as the VERIFY call; CLOSE only releases the state that call opened.
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast::<c_void>(),
        )
    };
    signer
}

/// The display name of the signer's certificate, read while the state from VERIFY is still open.
///
/// # Safety
/// `state` must be the state handle that a successful `WinVerifyTrust` VERIFY call left in its data.
unsafe fn signer_name(state: HANDLE) -> Option<String> {
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
        return None;
    }
    let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    if signer.is_null() {
        return None;
    }
    // The first certificate of the signer's chain is the signer's own certificate.
    let certificate = WTHelperGetProvCertFromChain(signer, 0);
    if certificate.is_null() || (*certificate).pCert.is_null() {
        return None;
    }
    let context = (*certificate).pCert;
    let length = CertGetNameStringW(
        context,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        std::ptr::null(),
        std::ptr::null_mut(),
        0,
    );
    if length <= 1 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    let written = CertGetNameStringW(
        context,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        std::ptr::null(),
        buffer.as_mut_ptr(),
        length,
    );
    // The count includes the terminating NUL.
    let units = (written as usize).saturating_sub(1).min(buffer.len());
    clean_signer_name(&String::from_utf16_lossy(&buffer[..units]))
}

/// A signer name for the report: control characters removed, trimmed, at most `MAX_SIGNER_CHARS` characters.
/// None when no printable text is left.
pub(crate) fn clean_signer_name(raw: &str) -> Option<String> {
    let kept: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_SIGNER_CHARS)
        .collect();
    let trimmed = kept.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn windows_dir() -> PathBuf {
        std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    }

    #[test]
    fn signer_names_are_cleaned_and_capped() {
        assert_eq!(
            clean_signer_name("  NVIDIA Corporation\r\n").as_deref(),
            Some("NVIDIA Corporation")
        );
        assert_eq!(clean_signer_name("\u{7}\u{0}\t"), None);
        assert_eq!(clean_signer_name("   "), None);
        let long = "a".repeat(300);
        assert_eq!(
            clean_signer_name(&long).map(|name| name.chars().count()),
            Some(MAX_SIGNER_CHARS)
        );
    }

    #[test]
    fn a_windows_binary_reports_its_microsoft_signer() {
        let explorer = windows_dir().join("explorer.exe");
        let signer = authenticode_signer(&explorer);
        assert!(signer.contains("Microsoft"), "signer was {signer:?}");
    }

    #[test]
    fn an_unsigned_executable_reports_unsigned() {
        // The test binary is built by cargo and carries no Authenticode signature.
        let exe = std::env::current_exe().expect("test executable path");
        assert_eq!(authenticode_signer(&exe), UNSIGNED);
    }

    #[test]
    fn a_signed_binary_changed_on_disk_reports_invalid() {
        let source = windows_dir().join("explorer.exe");
        let copy = std::env::temp_dir().join(format!("mp-signer-{}.exe", std::process::id()));
        std::fs::copy(&source, &copy).expect("copy the signed test binary");
        let mut bytes = std::fs::read(&copy).expect("read the copy");
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xFF;
        std::fs::write(&copy, &bytes).expect("write the altered copy");
        let signer = authenticode_signer(&copy);
        let _ = std::fs::remove_file(&copy);
        assert_eq!(signer, INVALID);
    }
}
