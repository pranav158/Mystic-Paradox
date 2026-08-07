use std::error::Error;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::{Path, PathBuf};

use winapi::shared::minwindef::{BOOL, DWORD, HMODULE, LPVOID, TRUE};
use winapi::um::libloaderapi::{GetModuleFileNameW, LoadLibraryW};
use winapi::um::winnt::DLL_PROCESS_ATTACH;

mod exports;
pub mod proxy;

const DLLS: [&str; 1] = ["MystPaxInternalServer.dll"];

/// Optional additional-DLL list placed next to the proxy DLL.
const INI_FILE: &str = "mystic_loader.ini";

#[unsafe(no_mangle)]
#[allow(non_snake_case)]
unsafe extern "system" fn DllMain(module: HMODULE, call_reason: DWORD, _reserved: LPVOID) -> BOOL {
    if call_reason == DLL_PROCESS_ATTACH
        && let Some(dll_path) = module_directory(module)
    {
        initialize(&dll_path);
    }

    TRUE
}

fn module_directory(module: HMODULE) -> Option<PathBuf> {
    // Windows supports paths longer than MAX_PATH when long-path handling is
    // enabled. Keep the path in UTF-16/OsString form so no Unicode data is lost.
    let mut buffer = vec![0u16; 32_768];
    let len = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
    if len == 0 || len as usize >= buffer.len() {
        return None;
    }

    let module_path = PathBuf::from(OsString::from_wide(&buffer[..len as usize]));
    module_path.parent().map(Path::to_path_buf)
}

fn initialize(dll_path: &Path) {
    for dll in DLLS {
        let dll = dll_path.join(dll);
        if dll.exists() {
            let _ = load_dll(&dll);
        }
    }

    // INI entries are additional libraries; they never replace the required
    // runtime above.
    if let Some(dlls) = read_dll_list_from_ini(&dll_path.join(INI_FILE)) {
        for dll in dlls {
            if DLLS
                .iter()
                .any(|required| required.eq_ignore_ascii_case(&dll))
            {
                continue;
            }

            let dll = dll_path.join(dll);
            if dll.exists() {
                let _ = load_dll(&dll);
            }
        }
    }
}

/// Reads additional DLL names/paths from `mystic_loader.ini`.
///
/// The format is intentionally forgiving:
///   - one DLL per line
///   - blank lines and comments (starting with `;` or `#`) are ignored
///   - section headers (`[...]`) are ignored
///   - `key = value` lines use the value
///
/// Paths resolve relative to the proxy DLL's directory. Returns `None` when
/// the file is missing or unreadable.
fn read_dll_list_from_ini(ini_path: &Path) -> Option<Vec<String>> {
    let contents = std::fs::read_to_string(ini_path).ok()?;

    let mut dlls = Vec::new();
    for line in contents.lines() {
        let line = line.split([';', '#']).next().unwrap_or("").trim();

        if line.is_empty() || line.starts_with('[') {
            continue;
        }

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
