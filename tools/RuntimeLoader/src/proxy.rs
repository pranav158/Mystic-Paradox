use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, atomic::AtomicPtr};
use winapi::shared::minwindef::HMODULE;
use winapi::um::libloaderapi::{FreeLibrary, GetProcAddress, LoadLibraryA};
use winapi::um::sysinfoapi::GetSystemDirectoryA;

static SYSTEM_DLL: OnceLock<AtomicPtr<HMODULE>> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn load_proxied_dll(dll_name: &str) -> Option<HMODULE> {
    if let Some(dll) = SYSTEM_DLL.get() {
        return Some(unsafe { *dll.load(Ordering::Relaxed) });
    }

    let mut system_path = [0u8; 260];
    let len = unsafe { GetSystemDirectoryA(system_path.as_mut_ptr() as *mut i8, 260) };

    if len == 0 {
        return None;
    }

    let dll_path = format!(
        "{}\\{}\0",
        unsafe { std::str::from_utf8_unchecked(&system_path[..len as usize]) },
        dll_name
    );

    let dll = unsafe { LoadLibraryA(dll_path.as_ptr() as *const i8) };
    if !dll.is_null() {
        SYSTEM_DLL
            .set(AtomicPtr::new(Box::into_raw(Box::new(dll))))
            .ok();
        Some(dll)
    } else {
        None
    }
}

pub fn cleanup_proxied_dll() {
    if SHUTTING_DOWN.swap(true, Ordering::Relaxed) {
        return;
    }

    if let Some(dll) = SYSTEM_DLL.get() {
        unsafe { FreeLibrary(*dll.load(Ordering::Relaxed)) };
        SYSTEM_DLL
            .set(AtomicPtr::new(Box::into_raw(
                Box::new(std::ptr::null_mut()),
            )))
            .ok();
    }
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
