use std::collections::HashMap;
use std::ffi::{CString, OsString};
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use winapi::shared::minwindef::HMODULE;
use winapi::um::libloaderapi::{GetProcAddress, LoadLibraryW};
use winapi::um::sysinfoapi::GetSystemDirectoryW;

static SYSTEM_DLLS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

fn load_proxied_dll(dll_name: &str) -> Option<HMODULE> {
    let modules = SYSTEM_DLLS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut modules = modules.lock().ok()?;
    let cache_key = dll_name.to_ascii_lowercase();

    if let Some(handle) = modules.get(&cache_key) {
        return Some(*handle as HMODULE);
    }

    let mut system_path = vec![0u16; 32_768];
    let len = unsafe { GetSystemDirectoryW(system_path.as_mut_ptr(), system_path.len() as u32) };
    if len == 0 || len as usize >= system_path.len() {
        return None;
    }

    let mut dll_path = PathBuf::from(OsString::from_wide(&system_path[..len as usize]));
    dll_path.push(dll_name);
    let dll_path: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let dll = unsafe { LoadLibraryW(dll_path.as_ptr()) };
    if dll.is_null() {
        return None;
    }

    modules.insert(cache_key, dll as usize);
    Some(dll)
}

pub fn get_proxied_func(dll_name: &str, func_name: &str) -> Option<unsafe extern "system" fn()> {
    let dll = load_proxied_dll(dll_name)?;
    let func_name_cstr = CString::new(func_name).ok()?;
    let proc_addr = unsafe { GetProcAddress(dll, func_name_cstr.as_ptr()) };

    if proc_addr.is_null() {
        None
    } else {
        Some(unsafe {
            std::mem::transmute::<
                *mut winapi::shared::minwindef::__some_function,
                unsafe extern "system" fn(),
            >(proc_addr)
        })
    }
}

#[macro_export]
macro_rules! proxy_function {
    // Basic proxy function with default fallback
    ($dll:literal, $name:ident, ($($param:ident: $param_type:ty),*), $ret_type:ty, $default:expr) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "system" fn $name($($param: $param_type),*) -> $ret_type {
            type FuncType = unsafe extern "system" fn($($param_type),*) -> $ret_type;

            if let Some(func) = proxy::get_proxied_func($dll, stringify!($name)) {
                let func: FuncType = unsafe { std::mem::transmute(func) };
                unsafe { func($($param),*) }
            } else {
                $default
            }
        }
    };

    // Proxy function with custom fallback function call
    ($dll:literal, $name:ident, ($($param:ident: $param_type:ty),*), $ret_type:ty, fallback: $fallback_fn:ident($($fallback_arg:ident),*)) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "system" fn $name($($param: $param_type),*) -> $ret_type {
            type FuncType = unsafe extern "system" fn($($param_type),*) -> $ret_type;

            if let Some(func) = proxy::get_proxied_func($dll, stringify!($name)) {
                let func: FuncType = unsafe { std::mem::transmute(func) };
                unsafe { func($($param),*) }
            } else {
                unsafe { $fallback_fn($($fallback_arg),*) }
            }
        }
    };
}
