use std::error::Error;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::{Path, PathBuf};

use winapi::shared::minwindef::{BOOL, DWORD, HMODULE, LPVOID, TRUE};
use winapi::um::libloaderapi::{GetModuleFileNameW, LoadLibraryW};
use winapi::um::winnt::DLL_PROCESS_ATTACH;

mod exports;
pub mod proxy;

const RUNTIME_DLL_NAMES: [&str; 2] = ["MysticParadox.dll", "MystPaxInternalServer.dll"];
const CANONICAL_RUNTIME_DLL_NAME: &str = RUNTIME_DLL_NAMES[0];

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

fn select_runtime_dll(directory: &Path) -> Option<PathBuf> {
    RUNTIME_DLL_NAMES
        .iter()
        .filter_map(|name| {
            let path = directory.join(name);
            let metadata = std::fs::metadata(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
            let canonical = usize::from(name.eq_ignore_ascii_case(CANONICAL_RUNTIME_DLL_NAME));
            Some((modified, canonical, path))
        })
        .max_by_key(|(modified, canonical, _)| (*modified, *canonical))
        .map(|(_, _, path)| path)
}

fn initialize(dll_path: &Path) {
    if let Some(runtime) = select_runtime_dll(dll_path) {
        let _ = load_dll(&runtime);
    }

    // INI entries are additional libraries; they never replace the required
    // runtime above.
    if let Some(dlls) = read_dll_list_from_ini(&dll_path.join(INI_FILE)) {
        for dll in dlls {
            if RUNTIME_DLL_NAMES
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

#[cfg(test)]
mod tests {
    use super::{CANONICAL_RUNTIME_DLL_NAME, select_runtime_dll};
    use std::fs;

    fn test_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mystic-runtime-loader-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn selects_the_canonical_runtime_when_it_is_the_only_copy() {
        let dir = test_dir("canonical");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CANONICAL_RUNTIME_DLL_NAME), b"runtime").unwrap();

        let selected = select_runtime_dll(&dir).unwrap();
        assert_eq!(selected.file_name().unwrap(), CANONICAL_RUNTIME_DLL_NAME);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn falls_back_to_the_legacy_runtime_name() {
        let dir = test_dir("legacy");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("MystPaxInternalServer.dll"), b"runtime").unwrap();

        let selected = select_runtime_dll(&dir).unwrap();
        assert_eq!(selected.file_name().unwrap(), "MystPaxInternalServer.dll");

        fs::remove_dir_all(dir).ok();
    }
}
