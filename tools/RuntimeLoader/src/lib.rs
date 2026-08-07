use std::error::Error;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use winapi::shared::minwindef::{BOOL, DWORD, HMODULE, LPVOID, TRUE};
use winapi::um::libloaderapi::{GetModuleFileNameW, LoadLibraryW};
use winapi::um::winnt::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH};

mod exports;
pub mod proxy;

const DLLS: [&str; 1] = ["MystPaxInternalServer.dll"];

/// Optional override file placed next to the proxy DLL. When present (and it
/// lists at least one DLL) it fully replaces the hardcoded `DLLS` defaults.
const INI_FILE: &str = "mystic_loader.ini";

static DLL_PATH: OnceLock<PathBuf> = OnceLock::new();

#[unsafe(no_mangle)]
#[allow(non_snake_case)]
unsafe extern "system" fn DllMain(module: HMODULE, call_reason: DWORD, _reserved: LPVOID) -> BOOL {
    match call_reason {
        DLL_PROCESS_ATTACH => {
            let dll_path = {
                let mut buffer = [0u16; 1024];
                let len =
                    unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
                let path = OsString::from_wide(&buffer[..len as usize])
                    .into_string()
                    .unwrap();
                let path = Path::new(&path);
                path.parent().unwrap().to_owned()
            };

            DLL_PATH.set(dll_path).ok();

            initialize();

            TRUE
        }
        DLL_PROCESS_DETACH => {
            proxy::cleanup_proxied_dll();
            TRUE
        }
        _ => TRUE,
    }
}

fn initialize() {
    let dll_path = DLL_PATH.get().expect("DLL_PATH not set");

    // Prefer a DLL list from `mystic_loader.ini` if it exists next to the proxy;
    // otherwise fall back to the hardcoded defaults.
    match read_dll_list_from_ini(&dll_path.join(INI_FILE)) {
        Some(dlls) if !dlls.is_empty() => {
            for dll in dlls {
                let dll = dll_path.join(dll);
                if dll.exists() {
                    let _ = load_dll(&dll);
                }
            }
        }
        _ => {
            for dll in DLLS {
                let dll = dll_path.join(dll);
                if dll.exists() {
                    let _ = load_dll(&dll);
                }
            }
        }
    }
}

/// Reads a list of DLL names/paths from `mystic_loader.ini`.
///
/// The format is intentionally forgiving:
///   - one DLL per line
///   - blank lines and comments (starting with `;` or `#`) are ignored
///   - section headers (`[...]`) are ignored
///   - `key = value` lines use the value (e.g. `dll = mystic/mystic.dll`)
///
/// Paths are resolved relative to the proxy DLL's directory (absolute paths are
/// also honored). Returns `None` when the file is missing or unreadable so the
/// caller can fall back to the hardcoded defaults; returns an empty `Vec` when
/// the file exists but lists nothing usable.
fn read_dll_list_from_ini(ini_path: &Path) -> Option<Vec<String>> {
    let contents = std::fs::read_to_string(ini_path).ok()?;

    let mut dlls = Vec::new();
    for line in contents.lines() {
        // Strip inline comments introduced by ';' or '#'.
        let line = line.split([';', '#']).next().unwrap_or("").trim();

        if line.is_empty() || line.starts_with('[') {
            continue;
        }

        // Support both `key = value` and bare `value` forms.
        let value = match line.split_once('=') {
            Some((_key, value)) => value.trim(),
            None => line,
        };

        if !value.is_empty() {
            dlls.push(value.to_string());
        }
    }

    Some(dlls)
}

fn load_dll(dll_path: &Path) -> Result<(), Box<dyn Error>> {
    let path_wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let lib = unsafe { LoadLibraryW(path_wide.as_ptr()) };
    if lib.is_null() {
        return Err("Failed to load library".into());
    }

    Ok(())
}
