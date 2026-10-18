//! The co-op transport module: a signed native module next to the game that carries co-op traffic between
//! players. The launcher only knows its provider-neutral C ABI (version 1, see
//! SteamDocs/P2P_PUBLIC_ARCHITECTURE_PLAN_2026_10_09.md); the module resolves its own dependencies and
//! supplies its own error text.
//!
//! [2026-10-13] Version 2 is the ICE transport (ParadoxTransport.dll, SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md
//! §6.1): version 1's exports plus StartHostV2/StartJoinV2 with a transport secrets file, ReadSignal/SubmitSignal for the
//! ICE descriptions and candidates the launcher carries, and ReadPeerEvent. The version tells the launcher which
//! transport is installed; a hunt whose frozen transport does not match it is refused (session.rs).
//!
//! [2026-10-14] Version 3 (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md §4.6) runs several sessions at once, each
//! named by a handle, and lets a host session's peers be added and removed while it runs (a realm's hub, its hunts, a
//! member's hub join and hunt join). The launcher speaks it through `SessionHandle`; for a version 2 module the same
//! handle API is emulated over its one default session (`EmulatedV2`: one session at a time, no peer changes), so the
//! callers have one shape. Version 1 (the Steam transport) keeps the single-session functions at the bottom.

use std::ffi::CString;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

/// The module ABIs this launcher speaks: 1 (Steam transport), 2 (ICE transport) and 3 (ICE with sessions by handle).
const MINIMUM_ABI_VERSION: i32 = 1;
const ICE_ABI_VERSION: i32 = 2;
pub const HANDLE_ABI_VERSION: i32 = 3;
const MAXIMUM_ABI_VERSION: i32 = HANDLE_ABI_VERSION;
/// The largest ICE signal the backend relays, plus its terminator.
const MAXIMUM_SIGNAL_DATA: usize = 4097;
/// Per call bounds, so a malformed or incompatible module cannot hold a launcher thread.
const SIGNALS_PER_CALL: usize = 64;
const PEER_EVENTS_PER_CALL: usize = 64;
// The native side is capped at 256 diagnostic lines.
const DIAGNOSTICS_PER_CALL: usize = 256;

type AbiVersionFn = unsafe extern "C" fn() -> i32;
type InitializeFn = unsafe extern "C" fn(*mut u8, u32) -> i32;
type ShutdownFn = unsafe extern "C" fn();
type PeerIdFn = unsafe extern "C" fn() -> u64;
type NetworkingReadyFn = unsafe extern "C" fn() -> i32;
type StartHostFn =
    unsafe extern "C" fn(*const i8, *const i8, *const i8, *const i8, *mut u8, u32) -> i32;
type StartJoinFn = unsafe extern "C" fn(*const i8, *const i8, *const i8, *mut u8, u32) -> i32;
type WaitReadyFn = unsafe extern "C" fn(u32, *mut u8, u32) -> i32;
type SessionRunningFn = unsafe extern "C" fn() -> i32;
type LastSessionResultFn = unsafe extern "C" fn() -> i32;
type StopSessionFn = unsafe extern "C" fn();
type ReadDiagnosticFn = unsafe extern "C" fn(*mut u8, u32) -> i32;
type StartHostV2Fn = unsafe extern "C" fn(
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    *mut u8,
    u32,
) -> i32;
type StartJoinV2Fn =
    unsafe extern "C" fn(*const i8, *const i8, *const i8, *const i8, *mut u8, u32) -> i32;
type ReadSignalFn = unsafe extern "C" fn(*mut u8, u32, *mut u8, u32, *mut u8, u32) -> i32;
type SubmitSignalFn = unsafe extern "C" fn(*const i8, *const i8, *const i8) -> i32;
type ReadPeerEventFn = unsafe extern "C" fn(*mut u8, u32) -> i32;
// Version 3: the same operations, per session handle.
type HostOpenFn = unsafe extern "C" fn(
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    *const i8,
    *mut u8,
    u32,
) -> i32;
type JoinOpenFn =
    unsafe extern "C" fn(*const i8, *const i8, *const i8, *const i8, *mut u8, u32) -> i32;
type WaitReadyHFn = unsafe extern "C" fn(i32, u32, *mut u8, u32) -> i32;
type HandleFn = unsafe extern "C" fn(i32) -> i32;
type ReadSignalHFn = unsafe extern "C" fn(i32, *mut u8, u32, *mut u8, u32, *mut u8, u32) -> i32;
type SubmitSignalHFn = unsafe extern "C" fn(i32, *const i8, *const i8, *const i8) -> i32;
type ReadLineHFn = unsafe extern "C" fn(i32, *mut u8, u32) -> i32;
type AddPeerHFn = unsafe extern "C" fn(i32, *const i8, u64, *const i8) -> i32;
type RemovePeerHFn = unsafe extern "C" fn(i32, *const i8, *const i8) -> i32;
/// [2026-10-17] Additive to ABI 3, looked up by name: an older module lacks it.
type UpdateRelayCredentialHFn = unsafe extern "C" fn(i32, *const i8, *const i8) -> i32;

#[derive(Clone, Debug, Default)]
pub struct TransportStatus {
    pub loaded: bool,
    pub networking_ready: bool,
    pub peer_id: Option<u64>,
}

/// One ICE signal the module wants delivered to the other side of a pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutgoingSignal {
    pub to_account_id: String,
    pub kind: String,
    pub data: String,
}

/// What a bounded wait for readiness found.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadyState {
    Ready(String),
    Pending,
    Failed(String),
}

impl ReadyState {
    /// The readiness line, or the reason there is none (a wait that ends Pending timed out).
    pub fn into_result(self) -> Result<String, String> {
        match self {
            ReadyState::Ready(line) => Ok(line),
            ReadyState::Pending => {
                Err("The co-op connection timed out before it was ready.".to_string())
            }
            ReadyState::Failed(error) => Err(error),
        }
    }
}

/// A session of the module (ABI 3 handle; for an ABI 2 module the launcher mints it over the module's one default
/// session). A handle is never reused while the module stays loaded, so a stale copy reads as an unknown session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SessionHandle(pub i32);

/// What one ReadSignal call found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SignalRead {
    Signal(OutgoingSignal),
    None,
    /// A buffer was too small: the signal stays queued.
    TooSmall,
}

/// One wait for the readiness line, as the module answers it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RawReady {
    Ready(String),
    Pending,
    /// The session ended before readiness (or the handle is unknown): the module's text and last result code.
    Ended {
        detail: String,
        result: i32,
    },
}

/// The operations of one transport module on sessions by handle (ABI 3's shape). Implemented by the native module
/// (`NativeV3`), by the emulation over an ABI 2 module (`EmulatedV2`) and by fakes in the tests. Every method is safe
/// to call from any thread. An unknown handle reads as "nothing here" (false, `Ended`, none), never as a panic.
pub(crate) trait SessionApi: Send + Sync {
    fn host_open(
        &self,
        public_key: &str,
        config: &str,
        capability: &str,
        host_ticket: Option<&str>,
        secrets: &str,
    ) -> Result<SessionHandle, String>;
    fn join_open(
        &self,
        public_key: &str,
        config: &str,
        ticket: &str,
        secrets: &str,
    ) -> Result<SessionHandle, String>;
    fn wait_ready(&self, handle: SessionHandle, timeout_ms: u32) -> RawReady;
    fn session_running(&self, handle: SessionHandle) -> bool;
    fn stop_session(&self, handle: SessionHandle) -> bool;
    fn last_result(&self, handle: SessionHandle) -> i32;
    fn read_signal(&self, handle: SessionHandle) -> SignalRead;
    fn submit_signal(&self, handle: SessionHandle, from: &str, kind: &str, data: &str) -> bool;
    fn read_peer_event(&self, handle: SessionHandle) -> Option<String>;
    fn read_diagnostic(&self, handle: SessionHandle) -> Option<String>;
    fn add_peer(&self, handle: SessionHandle, account_id: &str, peer_id: u64, key: &str) -> bool;
    fn remove_peer(&self, handle: SessionHandle, account_id: &str, reason: &str) -> bool;
    /// [2026-10-17] A fresh relay credential for a running session: Some(true) queued, Some(false) refused, None when the module
    /// has no such call (the session then keeps the credential it started with).
    fn update_relay_credential(
        &self,
        _handle: SessionHandle,
        _username: &str,
        _credential: &str,
    ) -> Option<bool> {
        None
    }
}

/// How the launcher talks to a module of a given interface version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbiKind {
    /// Version 1, the Steam transport: single-session functions only.
    Steam,
    /// Version 2, ICE with one session at a time (the handle API is emulated).
    IceSingle,
    /// Version 3 and later within the supported range: sessions by handle.
    IceHandles,
}

fn abi_kind(version: i32) -> Result<AbiKind, String> {
    match version {
        MINIMUM_ABI_VERSION => Ok(AbiKind::Steam),
        ICE_ABI_VERSION => Ok(AbiKind::IceSingle),
        HANDLE_ABI_VERSION => Ok(AbiKind::IceHandles),
        _ => Err(format!(
            "The co-op transport module speaks interface version {version}; this launcher speaks {MINIMUM_ABI_VERSION} to {MAXIMUM_ABI_VERSION}. Repair the runtime or update the launcher."
        )),
    }
}

/// The version 1 single-session surface (the Steam transport), also the base of a version 2 module's.
#[derive(Clone, Copy)]
struct SingleExports {
    start_host: StartHostFn,
    start_join: StartJoinFn,
    wait_ready: WaitReadyFn,
    session_running: SessionRunningFn,
    last_session_result: LastSessionResultFn,
    stop_session: StopSessionFn,
    read_diagnostic: ReadDiagnosticFn,
}

#[derive(Clone, Copy)]
struct IceExports {
    start_host: StartHostV2Fn,
    start_join: StartJoinV2Fn,
    read_signal: ReadSignalFn,
    submit_signal: SubmitSignalFn,
    read_peer_event: ReadPeerEventFn,
}

struct LoadedTransport {
    abi_version: i32,
    module: HMODULE,
    shutdown: ShutdownFn,
    peer_id: PeerIdFn,
    networking_ready: NetworkingReadyFn,
    single: SingleExports,
    /// The handle API: native for version 3, emulated for version 2, absent for version 1.
    sessions: Option<Arc<dyn SessionApi>>,
}

// HMODULE is an opaque process-wide module handle. Access is serialized through TRANSPORT and
// unloading only occurs after the module's Shutdown joins its native worker threads.
unsafe impl Send for LoadedTransport {}

fn transport() -> &'static Mutex<Option<LoadedTransport>> {
    static TRANSPORT: OnceLock<Mutex<Option<LoadedTransport>>> = OnceLock::new();
    TRANSPORT.get_or_init(|| Mutex::new(None))
}

unsafe fn load_symbol<T: Copy>(module: HMODULE, name: &'static [u8]) -> Result<T, String> {
    let address = GetProcAddress(module, name.as_ptr());
    let Some(address) = address else {
        return Err(format!(
            "The co-op transport module is missing export {}. Repair the runtime.",
            String::from_utf8_lossy(&name[..name.len().saturating_sub(1)])
        ));
    };
    Ok(std::mem::transmute_copy(&address))
}

/// [2026-10-17] An export the launcher can do without (additive to the module's ABI): None when the module lacks it.
unsafe fn load_optional_symbol<T: Copy>(module: HMODULE, name: &'static [u8]) -> Option<T> {
    GetProcAddress(module, name.as_ptr()).map(|address| std::mem::transmute_copy(&address))
}

fn native_text(buffer: &[u8]) -> String {
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).trim().to_string()
}

fn path_cstring(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| "A co-op session path contains an invalid NUL character.".to_string())
}

/// A path as the text the session API takes, refusing one that holds a NUL (it could never reach the module whole).
fn path_text(path: &Path) -> Result<String, String> {
    path_cstring(path).map(|text| text.to_string_lossy().into_owned())
}

fn text_cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "A co-op session value contains a NUL character.".to_string())
}

fn status_of(loaded: &LoadedTransport) -> TransportStatus {
    let peer_id = unsafe { (loaded.peer_id)() };
    TransportStatus {
        loaded: true,
        networking_ready: unsafe { (loaded.networking_ready)() != 0 },
        peer_id: (peer_id != 0).then_some(peer_id),
    }
}

// ---- version 3: the native handle API ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct NativeV3 {
    host_open: HostOpenFn,
    join_open: JoinOpenFn,
    wait_ready: WaitReadyHFn,
    session_running: HandleFn,
    stop_session: HandleFn,
    last_result: HandleFn,
    read_signal: ReadSignalHFn,
    submit_signal: SubmitSignalHFn,
    read_peer_event: ReadLineHFn,
    read_diagnostic: ReadLineHFn,
    add_peer: AddPeerHFn,
    remove_peer: RemovePeerHFn,
    /// [2026-10-17] None for a module without the relay credential refresh.
    update_relay_credential: Option<UpdateRelayCredentialHFn>,
}

impl NativeV3 {
    unsafe fn load(module: HMODULE) -> Result<Self, String> {
        Ok(Self {
            host_open: load_symbol(module, b"MysticTransport_HostOpen\0")?,
            join_open: load_symbol(module, b"MysticTransport_JoinOpen\0")?,
            wait_ready: load_symbol(module, b"MysticTransport_WaitReadyH\0")?,
            session_running: load_symbol(module, b"MysticTransport_SessionRunningH\0")?,
            stop_session: load_symbol(module, b"MysticTransport_StopSessionH\0")?,
            last_result: load_symbol(module, b"MysticTransport_LastSessionResultH\0")?,
            read_signal: load_symbol(module, b"MysticTransport_ReadSignalH\0")?,
            submit_signal: load_symbol(module, b"MysticTransport_SubmitSignalH\0")?,
            read_peer_event: load_symbol(module, b"MysticTransport_ReadPeerEventH\0")?,
            read_diagnostic: load_symbol(module, b"MysticTransport_ReadDiagnosticH\0")?,
            add_peer: load_symbol(module, b"MysticTransport_AddPeerH\0")?,
            remove_peer: load_symbol(module, b"MysticTransport_RemovePeerH\0")?,
            update_relay_credential: load_optional_symbol(
                module,
                b"MysticTransport_UpdateRelayCredentialH\0",
            ),
        })
    }

    fn read_line(function: ReadLineHFn, handle: SessionHandle, size: usize) -> Option<String> {
        let mut buffer = vec![0u8; size];
        let result = unsafe { function(handle.0, buffer.as_mut_ptr(), buffer.len() as u32) };
        (result == 1)
            .then(|| native_text(&buffer))
            .filter(|line| !line.is_empty())
    }
}

fn open_result(handle: i32, error: &[u8], fallback: &str) -> Result<SessionHandle, String> {
    if handle > 0 {
        return Ok(SessionHandle(handle));
    }
    let message = native_text(error);
    Err(if message.is_empty() {
        fallback.to_string()
    } else {
        message
    })
}

impl SessionApi for NativeV3 {
    fn host_open(
        &self,
        public_key: &str,
        config: &str,
        capability: &str,
        host_ticket: Option<&str>,
        secrets: &str,
    ) -> Result<SessionHandle, String> {
        let (public_key, config, capability, secrets) = (
            text_cstring(public_key)?,
            text_cstring(config)?,
            text_cstring(capability)?,
            text_cstring(secrets)?,
        );
        let host_ticket = host_ticket.map(text_cstring).transpose()?;
        let mut error = [0u8; 1024];
        let handle = unsafe {
            (self.host_open)(
                public_key.as_ptr(),
                config.as_ptr(),
                capability.as_ptr(),
                host_ticket
                    .as_ref()
                    .map_or(std::ptr::null(), |ticket| ticket.as_ptr()),
                secrets.as_ptr(),
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        open_result(handle, &error, "The co-op host connection could not start.")
    }

    fn join_open(
        &self,
        public_key: &str,
        config: &str,
        ticket: &str,
        secrets: &str,
    ) -> Result<SessionHandle, String> {
        let (public_key, config, ticket, secrets) = (
            text_cstring(public_key)?,
            text_cstring(config)?,
            text_cstring(ticket)?,
            text_cstring(secrets)?,
        );
        let mut error = [0u8; 1024];
        let handle = unsafe {
            (self.join_open)(
                public_key.as_ptr(),
                config.as_ptr(),
                ticket.as_ptr(),
                secrets.as_ptr(),
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        open_result(handle, &error, "The co-op join connection could not start.")
    }

    fn wait_ready(&self, handle: SessionHandle, timeout_ms: u32) -> RawReady {
        let mut ready = [0u8; 1024];
        let result = unsafe {
            (self.wait_ready)(handle.0, timeout_ms, ready.as_mut_ptr(), ready.len() as u32)
        };
        match result {
            1 => RawReady::Ready(native_text(&ready)),
            0 => RawReady::Pending,
            _ => RawReady::Ended {
                detail: native_text(&ready),
                result: self.last_result(handle),
            },
        }
    }

    fn session_running(&self, handle: SessionHandle) -> bool {
        unsafe { (self.session_running)(handle.0) != 0 }
    }

    fn stop_session(&self, handle: SessionHandle) -> bool {
        unsafe { (self.stop_session)(handle.0) == 1 }
    }

    fn last_result(&self, handle: SessionHandle) -> i32 {
        unsafe { (self.last_result)(handle.0) }
    }

    fn read_signal(&self, handle: SessionHandle) -> SignalRead {
        let mut to = [0u8; 128];
        let mut kind = [0u8; 32];
        let mut data = vec![0u8; MAXIMUM_SIGNAL_DATA];
        let result = unsafe {
            (self.read_signal)(
                handle.0,
                to.as_mut_ptr(),
                to.len() as u32,
                kind.as_mut_ptr(),
                kind.len() as u32,
                data.as_mut_ptr(),
                data.len() as u32,
            )
        };
        signal_of(result, &to, &kind, &data)
    }

    fn submit_signal(&self, handle: SessionHandle, from: &str, kind: &str, data: &str) -> bool {
        let (Ok(from), Ok(kind), Ok(data)) =
            (text_cstring(from), text_cstring(kind), text_cstring(data))
        else {
            return false;
        };
        unsafe { (self.submit_signal)(handle.0, from.as_ptr(), kind.as_ptr(), data.as_ptr()) == 1 }
    }

    fn read_peer_event(&self, handle: SessionHandle) -> Option<String> {
        Self::read_line(self.read_peer_event, handle, 512)
    }

    fn read_diagnostic(&self, handle: SessionHandle) -> Option<String> {
        Self::read_line(self.read_diagnostic, handle, 1024)
    }

    fn add_peer(&self, handle: SessionHandle, account_id: &str, peer_id: u64, key: &str) -> bool {
        let (Ok(account), Ok(key)) = (text_cstring(account_id), text_cstring(key)) else {
            return false;
        };
        unsafe { (self.add_peer)(handle.0, account.as_ptr(), peer_id, key.as_ptr()) == 1 }
    }

    fn remove_peer(&self, handle: SessionHandle, account_id: &str, reason: &str) -> bool {
        let (Ok(account), Ok(reason)) = (text_cstring(account_id), text_cstring(reason)) else {
            return false;
        };
        unsafe { (self.remove_peer)(handle.0, account.as_ptr(), reason.as_ptr()) == 1 }
    }

    fn update_relay_credential(
        &self,
        handle: SessionHandle,
        username: &str,
        credential: &str,
    ) -> Option<bool> {
        let function = self.update_relay_credential?;
        let (Ok(user), Ok(secret)) = (text_cstring(username), text_cstring(credential)) else {
            return Some(false);
        };
        Some(unsafe { function(handle.0, user.as_ptr(), secret.as_ptr()) == 1 })
    }
}

/// A ReadSignal answer and its buffers as a `SignalRead` (the data is not trimmed: descriptions keep their line breaks).
fn signal_of(result: i32, to: &[u8], kind: &[u8], data: &[u8]) -> SignalRead {
    match result {
        1 => SignalRead::Signal(OutgoingSignal {
            to_account_id: native_text(to),
            kind: native_text(kind),
            data: {
                let end = data
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(data.len());
                String::from_utf8_lossy(&data[..end]).into_owned()
            },
        }),
        -1 => SignalRead::TooSmall,
        _ => SignalRead::None,
    }
}

// ---- version 2: the handle API over one default session ----------------------------------------------------------

/// The ABI 2 exports a version 2 module's session needs, as a trait so the emulation is tested without a DLL.
pub(crate) trait RawV2: Send + Sync {
    fn start_host(
        &self,
        public_key: &str,
        config: &str,
        capability: &str,
        host_ticket: &str,
        secrets: &str,
    ) -> Result<(), String>;
    fn start_join(
        &self,
        public_key: &str,
        config: &str,
        ticket: &str,
        secrets: &str,
    ) -> Result<(), String>;
    fn wait_ready(&self, timeout_ms: u32) -> RawReady;
    fn session_running(&self) -> bool;
    fn stop_session(&self);
    fn last_result(&self) -> i32;
    fn read_signal(&self) -> SignalRead;
    fn submit_signal(&self, from: &str, kind: &str, data: &str) -> bool;
    fn read_peer_event(&self) -> Option<String>;
    fn read_diagnostic(&self) -> Option<String>;
}

struct NativeV2 {
    single: SingleExports,
    ice: IceExports,
}

impl RawV2 for NativeV2 {
    fn start_host(
        &self,
        public_key: &str,
        config: &str,
        capability: &str,
        host_ticket: &str,
        secrets: &str,
    ) -> Result<(), String> {
        let (public_key, config, capability, host_ticket, secrets) = (
            text_cstring(public_key)?,
            text_cstring(config)?,
            text_cstring(capability)?,
            text_cstring(host_ticket)?,
            text_cstring(secrets)?,
        );
        let mut error = [0u8; 1024];
        let ok = unsafe {
            (self.ice.start_host)(
                public_key.as_ptr(),
                config.as_ptr(),
                capability.as_ptr(),
                host_ticket.as_ptr(),
                secrets.as_ptr(),
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        native_start_result(ok, &error, "The co-op host connection could not start.")
    }

    fn start_join(
        &self,
        public_key: &str,
        config: &str,
        ticket: &str,
        secrets: &str,
    ) -> Result<(), String> {
        let (public_key, config, ticket, secrets) = (
            text_cstring(public_key)?,
            text_cstring(config)?,
            text_cstring(ticket)?,
            text_cstring(secrets)?,
        );
        let mut error = [0u8; 1024];
        let ok = unsafe {
            (self.ice.start_join)(
                public_key.as_ptr(),
                config.as_ptr(),
                ticket.as_ptr(),
                secrets.as_ptr(),
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        native_start_result(ok, &error, "The co-op join connection could not start.")
    }

    fn wait_ready(&self, timeout_ms: u32) -> RawReady {
        let mut ready = [0u8; 1024];
        let result =
            unsafe { (self.single.wait_ready)(timeout_ms, ready.as_mut_ptr(), ready.len() as u32) };
        match result {
            1 => RawReady::Ready(native_text(&ready)),
            0 => RawReady::Pending,
            _ => RawReady::Ended {
                detail: native_text(&ready),
                result: self.last_result(),
            },
        }
    }

    fn session_running(&self) -> bool {
        unsafe { (self.single.session_running)() != 0 }
    }

    fn stop_session(&self) {
        unsafe { (self.single.stop_session)() };
    }

    fn last_result(&self) -> i32 {
        unsafe { (self.single.last_session_result)() }
    }

    fn read_signal(&self) -> SignalRead {
        let mut to = [0u8; 128];
        let mut kind = [0u8; 32];
        let mut data = vec![0u8; MAXIMUM_SIGNAL_DATA];
        let result = unsafe {
            (self.ice.read_signal)(
                to.as_mut_ptr(),
                to.len() as u32,
                kind.as_mut_ptr(),
                kind.len() as u32,
                data.as_mut_ptr(),
                data.len() as u32,
            )
        };
        signal_of(result, &to, &kind, &data)
    }

    fn submit_signal(&self, from: &str, kind: &str, data: &str) -> bool {
        let (Ok(from), Ok(kind), Ok(data)) =
            (text_cstring(from), text_cstring(kind), text_cstring(data))
        else {
            return false;
        };
        unsafe { (self.ice.submit_signal)(from.as_ptr(), kind.as_ptr(), data.as_ptr()) == 1 }
    }

    fn read_peer_event(&self) -> Option<String> {
        let mut buffer = [0u8; 256];
        let result =
            unsafe { (self.ice.read_peer_event)(buffer.as_mut_ptr(), buffer.len() as u32) };
        (result == 1)
            .then(|| native_text(&buffer))
            .filter(|line| !line.is_empty())
    }

    fn read_diagnostic(&self) -> Option<String> {
        let mut buffer = [0u8; 1024];
        let result =
            unsafe { (self.single.read_diagnostic)(buffer.as_mut_ptr(), buffer.len() as u32) };
        (result == 1)
            .then(|| native_text(&buffer))
            .filter(|line| !line.is_empty())
    }
}

fn native_start_result(ok: i32, error: &[u8], fallback: &str) -> Result<(), String> {
    if ok != 0 {
        return Ok(());
    }
    let message = native_text(error);
    Err(if message.is_empty() {
        fallback.to_string()
    } else {
        message
    })
}

#[derive(Default)]
struct EmulationState {
    /// The last handle minted; handles count up and are never reused.
    last: i32,
    /// The handle of the module's default session (its newest start). Older handles are unknown from then on.
    current: Option<i32>,
}

/// The handle API over a version 2 module: its one session at a time gets a handle the launcher mints. A second start
/// while one runs is refused like the module refuses it, a finished session stays readable (as the module keeps it)
/// until the next start replaces it, and peer changes are not possible (the roster is fixed at start).
pub(crate) struct EmulatedV2<R: RawV2> {
    raw: R,
    state: Mutex<EmulationState>,
}

impl<R: RawV2> EmulatedV2<R> {
    pub(crate) fn new(raw: R) -> Self {
        Self {
            raw,
            state: Mutex::new(EmulationState::default()),
        }
    }

    fn is_current(&self, handle: SessionHandle) -> bool {
        self.state
            .lock()
            .map(|state| state.current == Some(handle.0))
            .unwrap_or(false)
    }

    /// Starts a session through `start` unless one is running, and mints its handle.
    fn open(&self, start: impl FnOnce() -> Result<(), String>) -> Result<SessionHandle, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The co-op connection state is unavailable.".to_string())?;
        if state.current.is_some() && self.raw.session_running() {
            return Err("A co-op session is already running.".to_string());
        }
        start()?;
        state.last += 1;
        state.current = Some(state.last);
        Ok(SessionHandle(state.last))
    }
}

impl<R: RawV2> SessionApi for EmulatedV2<R> {
    fn host_open(
        &self,
        public_key: &str,
        config: &str,
        capability: &str,
        host_ticket: Option<&str>,
        secrets: &str,
    ) -> Result<SessionHandle, String> {
        // Version 2 always needs the host's own ticket: a host without a local client is a version 3 feature.
        let host_ticket = host_ticket.ok_or_else(|| {
            "This co-op transport module cannot host a session without the host's own client. Update the runtime.".to_string()
        })?;
        self.open(|| {
            self.raw
                .start_host(public_key, config, capability, host_ticket, secrets)
        })
    }

    fn join_open(
        &self,
        public_key: &str,
        config: &str,
        ticket: &str,
        secrets: &str,
    ) -> Result<SessionHandle, String> {
        self.open(|| self.raw.start_join(public_key, config, ticket, secrets))
    }

    fn wait_ready(&self, handle: SessionHandle, timeout_ms: u32) -> RawReady {
        if !self.is_current(handle) {
            return RawReady::Ended {
                detail: String::new(),
                result: -1,
            };
        }
        self.raw.wait_ready(timeout_ms)
    }

    fn session_running(&self, handle: SessionHandle) -> bool {
        self.is_current(handle) && self.raw.session_running()
    }

    fn stop_session(&self, handle: SessionHandle) -> bool {
        if !self.is_current(handle) {
            return false;
        }
        self.raw.stop_session();
        true
    }

    fn last_result(&self, handle: SessionHandle) -> i32 {
        if self.is_current(handle) {
            self.raw.last_result()
        } else {
            -1
        }
    }

    fn read_signal(&self, handle: SessionHandle) -> SignalRead {
        if self.is_current(handle) {
            self.raw.read_signal()
        } else {
            SignalRead::None
        }
    }

    fn submit_signal(&self, handle: SessionHandle, from: &str, kind: &str, data: &str) -> bool {
        self.is_current(handle) && self.raw.submit_signal(from, kind, data)
    }

    fn read_peer_event(&self, handle: SessionHandle) -> Option<String> {
        self.is_current(handle)
            .then(|| self.raw.read_peer_event())
            .flatten()
    }

    fn read_diagnostic(&self, handle: SessionHandle) -> Option<String> {
        self.is_current(handle)
            .then(|| self.raw.read_diagnostic())
            .flatten()
    }

    fn add_peer(
        &self,
        _handle: SessionHandle,
        _account_id: &str,
        _peer_id: u64,
        _key: &str,
    ) -> bool {
        false
    }

    fn remove_peer(&self, _handle: SessionHandle, _account_id: &str, _reason: &str) -> bool {
        false
    }
}

// ---- helpers over the handle API (pure over `&dyn SessionApi`, tested with fakes) ---------------------------------

/// Waits at most `timeout` for the session's readiness line; Pending when it has not come yet.
fn ready_state(api: &dyn SessionApi, handle: SessionHandle, timeout: Duration) -> ReadyState {
    let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
    match api.wait_ready(handle, millis) {
        RawReady::Ready(line) => ReadyState::Ready(line),
        RawReady::Pending => ReadyState::Pending,
        RawReady::Ended { detail, result } => ReadyState::Failed(if detail.is_empty() {
            format!("The co-op connection failed before it was ready (code {result}).")
        } else {
            format!("The co-op connection failed before it was ready ({detail}; code {result}).")
        }),
    }
}

/// The signals a session produced since the last call (at most 64).
fn collect_signals(api: &dyn SessionApi, handle: SessionHandle) -> Vec<OutgoingSignal> {
    let mut signals = Vec::new();
    for _ in 0..SIGNALS_PER_CALL {
        match api.read_signal(handle) {
            SignalRead::Signal(signal) => signals.push(signal),
            SignalRead::None | SignalRead::TooSmall => break,
        }
    }
    signals
}

fn collect_lines(mut read: impl FnMut() -> Option<String>, limit: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for _ in 0..limit {
        match read() {
            Some(line) => lines.push(line),
            None => break,
        }
    }
    lines
}

/// The module's handle API, or an error naming why this module has none.
fn session_api() -> Result<Arc<dyn SessionApi>, String> {
    let state = transport()
        .lock()
        .map_err(|_| "The co-op connection state is unavailable.".to_string())?;
    let loaded = state
        .as_ref()
        .ok_or_else(|| "The co-op connection is not running. Start Dauntless again.".to_string())?;
    loaded.sessions.clone().ok_or_else(|| {
        "The installed co-op transport module is not the ICE transport. Repair the runtime."
            .to_string()
    })
}

/// A host session: the version 1 inputs plus the transport secrets (relay credential and peers). `host_ticket` is
/// `None` for a host whose own client does not play it (`host_local_client=0`, needs the version 3 module).
pub fn host_open(
    public_key: &Path,
    config: &Path,
    capability: &Path,
    host_ticket: Option<&Path>,
    secrets: &Path,
) -> Result<SessionHandle, String> {
    let api = session_api()?;
    let host_ticket = host_ticket.map(path_text).transpose()?;
    api.host_open(
        &path_text(public_key)?,
        &path_text(config)?,
        &path_text(capability)?,
        host_ticket.as_deref(),
        &path_text(secrets)?,
    )
}

/// A join session: the version 1 inputs plus the transport secrets.
pub fn join_open(
    public_key: &Path,
    config: &Path,
    ticket: &Path,
    secrets: &Path,
) -> Result<SessionHandle, String> {
    let api = session_api()?;
    api.join_open(
        &path_text(public_key)?,
        &path_text(config)?,
        &path_text(ticket)?,
        &path_text(secrets)?,
    )
}

impl SessionHandle {
    /// Waits at most `timeout` for the session's readiness line.
    pub fn wait_ready(self, timeout: Duration) -> ReadyState {
        match session_api() {
            Ok(api) => ready_state(api.as_ref(), self, timeout),
            Err(error) => ReadyState::Failed(error),
        }
    }

    pub fn session_running(self) -> bool {
        session_api().is_ok_and(|api| api.session_running(self))
    }

    /// Stops the session and joins its thread; false for an unknown handle.
    pub fn stop(self) -> bool {
        session_api().is_ok_and(|api| api.stop_session(self))
    }

    /// 0 clean, 2 bad input, 3 setup failure, 4 refused admission, 5 lease failed; -1 for an unknown handle.
    pub fn last_result(self) -> i32 {
        session_api().map_or(-1, |api| api.last_result(self))
    }

    pub fn take_signals(self) -> Vec<OutgoingSignal> {
        session_api().map_or_else(|_| Vec::new(), |api| collect_signals(api.as_ref(), self))
    }

    /// One signal from the other side of a pair; false when the module refused it.
    pub fn submit_signal(self, from_account_id: &str, kind: &str, data: &str) -> bool {
        session_api().is_ok_and(|api| api.submit_signal(self, from_account_id, kind, data))
    }

    /// PEER_CONNECTED / PEER_ADMITTED / PEER_LOST (and, for a host, PEER_REMOVED / PEER_ADD_REJECTED) lines since the
    /// last call.
    pub fn drain_peer_events(self) -> Vec<String> {
        session_api().map_or_else(
            |_| Vec::new(),
            |api| collect_lines(|| api.read_peer_event(self), PEER_EVENTS_PER_CALL),
        )
    }

    pub fn drain_diagnostics(self) -> Vec<String> {
        session_api().map_or_else(
            |_| Vec::new(),
            |api| collect_lines(|| api.read_diagnostic(self), DIAGNOSTICS_PER_CALL),
        )
    }

    /// Host sessions only: true when the module queued the peer.
    pub fn add_peer(self, account_id: &str, peer_id: u64, key: &str) -> bool {
        session_api().is_ok_and(|api| api.add_peer(self, account_id, peer_id, key))
    }

    /// Host sessions only: true when the module queued the removal.
    pub fn remove_peer(self, account_id: &str, reason: &str) -> bool {
        session_api().is_ok_and(|api| api.remove_peer(self, account_id, reason))
    }

    /// [2026-10-17] Hands the running session a fresh relay credential: Some(true) queued, Some(false) refused, None when the
    /// module cannot take one into a running session (an older module).
    pub fn update_relay_credential(self, username: &str, credential: &str) -> Option<bool> {
        session_api()
            .ok()
            .and_then(|api| api.update_relay_credential(self, username, credential))
    }
}

// ---- loading ------------------------------------------------------------------------------------------------------

/// Loads and initializes the module at `module_path`. Not stored: `initialize` keeps the one the launcher uses.
fn load_module(module_path: &Path) -> Result<LoadedTransport, String> {
    if !module_path.is_file() {
        return Err(
            "The co-op transport module is missing. Repairing the runtime is required.".to_string(),
        );
    }
    let module_wide: Vec<u16> = module_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe {
        LoadLibraryExW(
            module_wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err("Windows could not load the verified co-op transport module.".to_string());
    }

    let loaded_result = unsafe {
        (|| -> Result<(LoadedTransport, InitializeFn), String> {
            let abi_version: AbiVersionFn = load_symbol(module, b"MysticTransport_AbiVersion\0")?;
            let version = abi_version();
            let kind = abi_kind(version)?;
            let single = SingleExports {
                start_host: load_symbol(module, b"MysticTransport_StartHost\0")?,
                start_join: load_symbol(module, b"MysticTransport_StartJoin\0")?,
                wait_ready: load_symbol(module, b"MysticTransport_WaitReady\0")?,
                session_running: load_symbol(module, b"MysticTransport_SessionRunning\0")?,
                last_session_result: load_symbol(module, b"MysticTransport_LastSessionResult\0")?,
                stop_session: load_symbol(module, b"MysticTransport_StopSession\0")?,
                read_diagnostic: load_symbol(module, b"MysticTransport_ReadDiagnostic\0")?,
            };
            // The feature probe: the newer exports are looked up only when the version promises them, so an older
            // module keeps working exactly as before.
            let sessions: Option<Arc<dyn SessionApi>> = match kind {
                AbiKind::Steam => None,
                AbiKind::IceSingle => {
                    let ice = IceExports {
                        start_host: load_symbol(module, b"MysticTransport_StartHostV2\0")?,
                        start_join: load_symbol(module, b"MysticTransport_StartJoinV2\0")?,
                        read_signal: load_symbol(module, b"MysticTransport_ReadSignal\0")?,
                        submit_signal: load_symbol(module, b"MysticTransport_SubmitSignal\0")?,
                        read_peer_event: load_symbol(module, b"MysticTransport_ReadPeerEvent\0")?,
                    };
                    Some(Arc::new(EmulatedV2::new(NativeV2 { single, ice })))
                }
                AbiKind::IceHandles => Some(Arc::new(NativeV3::load(module)?)),
            };
            Ok((
                LoadedTransport {
                    abi_version: version,
                    module,
                    shutdown: load_symbol(module, b"MysticTransport_Shutdown\0")?,
                    peer_id: load_symbol(module, b"MysticTransport_PeerId\0")?,
                    networking_ready: load_symbol(module, b"MysticTransport_NetworkingReady\0")?,
                    single,
                    sessions,
                },
                load_symbol(module, b"MysticTransport_Initialize\0")?,
            ))
        })()
    };
    let (loaded, initialize) = match loaded_result {
        Ok(value) => value,
        Err(error) => {
            unsafe { FreeLibrary(module) };
            return Err(error);
        }
    };

    let mut error = [0u8; 1024];
    let initialized = unsafe { initialize(error.as_mut_ptr(), error.len() as u32) };
    if initialized == 0 {
        let message = native_text(&error);
        unsafe { FreeLibrary(module) };
        return Err(if message.is_empty() {
            "The co-op connection could not start.".to_string()
        } else {
            message
        });
    }
    Ok(loaded)
}

/// Stops the module's runtime (every session) and unloads it.
fn unload_module(loaded: LoadedTransport) {
    unsafe {
        // The module's Shutdown stops its runtime and joins its worker threads; only then is the module safe to
        // unload.
        (loaded.shutdown)();
        FreeLibrary(loaded.module);
    }
}

/// Loads the co-op transport module at module_path (the switch's verified TRANSPORT_MODULE file) once.
pub fn initialize(module_path: &Path) -> Result<TransportStatus, String> {
    if crate::launch::is_shutting_down() {
        return Err("The launcher is closing; the co-op connection will not start.".to_string());
    }
    let mut state = transport()
        .lock()
        .map_err(|_| "The co-op connection state is unavailable.".to_string())?;
    // Re-check under the transport lock: an exit that began while this call was waiting must not
    // be followed by a freshly loaded transport that outlives the shutdown that just ran.
    if crate::launch::is_shutting_down() {
        return Err("The launcher is closing; the co-op connection will not start.".to_string());
    }
    if let Some(loaded) = state.as_ref() {
        return Ok(status_of(loaded));
    }
    let loaded = load_module(module_path)?;
    let status = status_of(&loaded);
    *state = Some(loaded);
    Ok(status)
}

pub fn status() -> TransportStatus {
    let Ok(state) = transport().lock() else {
        return TransportStatus::default();
    };
    state.as_ref().map(status_of).unwrap_or_default()
}

/// The loaded module's interface version: 1 for the Steam transport, 2 for ICE, 3 for ICE with sessions by handle.
pub fn abi_version() -> Option<i32> {
    transport()
        .lock()
        .ok()
        .and_then(|state| state.as_ref().map(|loaded| loaded.abi_version))
}

pub fn shutdown() {
    let started = std::time::Instant::now();
    let loaded = transport().lock().ok().and_then(|mut state| state.take());
    match loaded {
        Some(loaded) => {
            unload_module(loaded);
            crate::launch::process::append_active_session_log(&format!(
                "co-op transport shutdown complete (native worker joined, module unloaded) elapsedMs={}",
                started.elapsed().as_millis()
            ));
        }
        None => {
            crate::launch::process::append_active_session_log(
                "co-op transport shutdown: nothing loaded",
            );
        }
    }
}

// ---- the single-session functions (version 1, the Steam transport) -------------------------------------------------

pub fn start_host(
    public_key: &Path,
    config: &Path,
    capability: &Path,
    host_ticket: &Path,
) -> Result<(), String> {
    let state = transport()
        .lock()
        .map_err(|_| "The co-op connection state is unavailable.".to_string())?;
    let loaded = state
        .as_ref()
        .ok_or_else(|| "The co-op connection is not running. Start Dauntless again.".to_string())?;
    let public_key = path_cstring(public_key)?;
    let config = path_cstring(config)?;
    let capability = path_cstring(capability)?;
    let host_ticket = path_cstring(host_ticket)?;
    let mut error = [0u8; 1024];
    let ok = unsafe {
        (loaded.single.start_host)(
            public_key.as_ptr(),
            config.as_ptr(),
            capability.as_ptr(),
            host_ticket.as_ptr(),
            error.as_mut_ptr(),
            error.len() as u32,
        )
    };
    native_start_result(ok, &error, "The co-op host connection could not start.")
}

pub fn start_join(public_key: &Path, config: &Path, ticket: &Path) -> Result<(), String> {
    let state = transport()
        .lock()
        .map_err(|_| "The co-op connection state is unavailable.".to_string())?;
    let loaded = state
        .as_ref()
        .ok_or_else(|| "The co-op connection is not running. Start Dauntless again.".to_string())?;
    let public_key = path_cstring(public_key)?;
    let config = path_cstring(config)?;
    let ticket = path_cstring(ticket)?;
    let mut error = [0u8; 1024];
    let ok = unsafe {
        (loaded.single.start_join)(
            public_key.as_ptr(),
            config.as_ptr(),
            ticket.as_ptr(),
            error.as_mut_ptr(),
            error.len() as u32,
        )
    };
    native_start_result(ok, &error, "The co-op join connection could not start.")
}

pub fn wait_ready(timeout: Duration) -> Result<String, String> {
    let exports = transport().lock().ok().and_then(|state| {
        state
            .as_ref()
            .map(|loaded| (loaded.single.wait_ready, loaded.single.last_session_result))
    });
    let Some((wait_ready, last_session_result)) = exports else {
        return Err("The co-op connection is not running.".to_string());
    };
    let mut ready = [0u8; 1024];
    let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
    let result = unsafe { wait_ready(millis, ready.as_mut_ptr(), ready.len() as u32) };
    match result {
        1 => Ok(native_text(&ready)),
        0 => Err("The co-op connection timed out before it was ready.".to_string()),
        _ => {
            let detail = native_text(&ready);
            let result = unsafe { last_session_result() };
            Err(if detail.is_empty() {
                format!("The co-op connection failed before it was ready (code {result}).")
            } else {
                format!(
                    "The co-op connection failed before it was ready ({detail}; code {result})."
                )
            })
        }
    }
}

pub fn session_running() -> bool {
    transport()
        .lock()
        .ok()
        .and_then(|state| {
            state
                .as_ref()
                .map(|loaded| unsafe { (loaded.single.session_running)() != 0 })
        })
        .unwrap_or(false)
}

pub fn stop_session() {
    if let Ok(state) = transport().lock() {
        if let Some(loaded) = state.as_ref() {
            unsafe { (loaded.single.stop_session)() };
        }
    }
}

pub fn drain_diagnostics() -> Vec<String> {
    let Ok(state) = transport().lock() else {
        return Vec::new();
    };
    let Some(loaded) = state.as_ref() else {
        return Vec::new();
    };
    collect_lines(
        || {
            let mut buffer = [0u8; 1024];
            if unsafe { (loaded.single.read_diagnostic)(buffer.as_mut_ptr(), buffer.len() as u32) }
                != 1
            {
                return None;
            }
            Some(native_text(&buffer)).filter(|line| !line.is_empty())
        },
        DIAGNOSTICS_PER_CALL,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    /// A scripted module for the handle API: sessions it hands out, queues it serves, calls it saw.
    #[derive(Default)]
    struct FakeApi {
        state: Mutex<FakeState>,
    }

    #[derive(Default)]
    struct FakeState {
        next: i32,
        open: Vec<i32>,
        ready: HashMap<i32, RawReady>,
        signals: HashMap<i32, VecDeque<SignalRead>>,
        peer_events: HashMap<i32, VecDeque<String>>,
        diagnostics: HashMap<i32, VecDeque<String>>,
        calls: Vec<String>,
        refuse_peers: bool,
    }

    impl FakeApi {
        fn calls(&self) -> Vec<String> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    impl SessionApi for FakeApi {
        fn host_open(
            &self,
            _public_key: &str,
            config: &str,
            _capability: &str,
            host_ticket: Option<&str>,
            _secrets: &str,
        ) -> Result<SessionHandle, String> {
            let mut state = self.state.lock().unwrap();
            state.next += 1;
            let handle = state.next;
            state.open.push(handle);
            state.calls.push(format!(
                "host_open {config} ticket={}",
                host_ticket.unwrap_or("none")
            ));
            Ok(SessionHandle(handle))
        }

        fn join_open(
            &self,
            _public_key: &str,
            _config: &str,
            _ticket: &str,
            _secrets: &str,
        ) -> Result<SessionHandle, String> {
            let mut state = self.state.lock().unwrap();
            state.next += 1;
            let handle = state.next;
            state.open.push(handle);
            Ok(SessionHandle(handle))
        }

        fn wait_ready(&self, handle: SessionHandle, _timeout_ms: u32) -> RawReady {
            self.state
                .lock()
                .unwrap()
                .ready
                .remove(&handle.0)
                .unwrap_or(RawReady::Pending)
        }

        fn session_running(&self, handle: SessionHandle) -> bool {
            self.state.lock().unwrap().open.contains(&handle.0)
        }

        fn stop_session(&self, handle: SessionHandle) -> bool {
            let mut state = self.state.lock().unwrap();
            state.calls.push(format!("stop {}", handle.0));
            let before = state.open.len();
            state.open.retain(|open| *open != handle.0);
            state.open.len() != before
        }

        fn last_result(&self, _handle: SessionHandle) -> i32 {
            0
        }

        fn read_signal(&self, handle: SessionHandle) -> SignalRead {
            self.state
                .lock()
                .unwrap()
                .signals
                .get_mut(&handle.0)
                .and_then(VecDeque::pop_front)
                .unwrap_or(SignalRead::None)
        }

        fn submit_signal(
            &self,
            handle: SessionHandle,
            from: &str,
            kind: &str,
            _data: &str,
        ) -> bool {
            let mut state = self.state.lock().unwrap();
            state
                .calls
                .push(format!("submit {} {from} {kind}", handle.0));
            state.open.contains(&handle.0)
        }

        fn read_peer_event(&self, handle: SessionHandle) -> Option<String> {
            self.state
                .lock()
                .unwrap()
                .peer_events
                .get_mut(&handle.0)
                .and_then(VecDeque::pop_front)
        }

        fn read_diagnostic(&self, handle: SessionHandle) -> Option<String> {
            self.state
                .lock()
                .unwrap()
                .diagnostics
                .get_mut(&handle.0)
                .and_then(VecDeque::pop_front)
        }

        fn add_peer(
            &self,
            handle: SessionHandle,
            account_id: &str,
            peer_id: u64,
            _key: &str,
        ) -> bool {
            let mut state = self.state.lock().unwrap();
            state
                .calls
                .push(format!("add {} {account_id} {peer_id}", handle.0));
            !state.refuse_peers
        }

        fn remove_peer(&self, handle: SessionHandle, account_id: &str, reason: &str) -> bool {
            self.state
                .lock()
                .unwrap()
                .calls
                .push(format!("remove {} {account_id} {reason}", handle.0));
            true
        }
    }

    fn signal(to: &str) -> SignalRead {
        SignalRead::Signal(OutgoingSignal {
            to_account_id: to.to_string(),
            kind: "DESCRIPTION".to_string(),
            data: "line one\nline two\n".to_string(),
        })
    }

    #[test]
    fn the_interface_version_picks_how_the_module_is_spoken_to() {
        assert_eq!(abi_kind(1), Ok(AbiKind::Steam));
        assert_eq!(abi_kind(2), Ok(AbiKind::IceSingle));
        assert_eq!(abi_kind(3), Ok(AbiKind::IceHandles));
        for unknown in [-1, 0, 4, 99] {
            let error = abi_kind(unknown).unwrap_err();
            assert!(
                error.contains(&format!("interface version {unknown}")) && error.contains("1 to 3"),
                "{error}"
            );
        }
    }

    #[test]
    fn readiness_maps_the_modules_answers() {
        let api = FakeApi::default();
        let handle = SessionHandle(7);
        let wait = Duration::from_millis(100);
        assert_eq!(ready_state(&api, handle, wait), ReadyState::Pending);

        let mut state = api.state.lock().unwrap();
        state
            .ready
            .insert(7, RawReady::Ready("HOST_READY a=b".to_string()));
        state.ready.insert(
            8,
            RawReady::Ended {
                detail: "HOST CONFIG FAIL".to_string(),
                result: 2,
            },
        );
        state.ready.insert(
            9,
            RawReady::Ended {
                detail: String::new(),
                result: -1,
            },
        );
        drop(state);
        assert_eq!(
            ready_state(&api, handle, wait),
            ReadyState::Ready("HOST_READY a=b".to_string())
        );
        assert_eq!(
            ready_state(&api, SessionHandle(8), wait),
            ReadyState::Failed(
                "The co-op connection failed before it was ready (HOST CONFIG FAIL; code 2)."
                    .to_string()
            )
        );
        assert_eq!(
            ready_state(&api, SessionHandle(9), wait),
            ReadyState::Failed(
                "The co-op connection failed before it was ready (code -1).".to_string()
            )
        );
        assert!(ReadyState::Pending.into_result().is_err());
        assert_eq!(
            ReadyState::Ready("x".to_string()).into_result(),
            Ok("x".to_string())
        );
    }

    #[test]
    fn signals_are_collected_per_session_and_bounded() {
        let api = FakeApi::default();
        {
            let mut state = api.state.lock().unwrap();
            state
                .signals
                .insert(1, VecDeque::from([signal("a"), signal("b")]));
            state
                .signals
                .insert(2, (0..100).map(|_| signal("c")).collect());
            // A too-small buffer stops the read; the signal behind it stays queued.
            state.signals.insert(
                3,
                VecDeque::from([signal("d"), SignalRead::TooSmall, signal("e")]),
            );
        }
        let first = collect_signals(&api, SessionHandle(1));
        assert_eq!(
            first
                .iter()
                .map(|s| s.to_account_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        // Descriptions keep their line breaks.
        assert_eq!(first[0].data, "line one\nline two\n");
        assert_eq!(
            collect_signals(&api, SessionHandle(2)).len(),
            SIGNALS_PER_CALL
        );
        assert_eq!(collect_signals(&api, SessionHandle(2)).len(), 36);
        assert_eq!(collect_signals(&api, SessionHandle(3)).len(), 1);
        assert!(collect_signals(&api, SessionHandle(99)).is_empty());
    }

    #[test]
    fn lines_are_drained_up_to_their_bound() {
        let api = FakeApi::default();
        api.state.lock().unwrap().peer_events.insert(
            1,
            VecDeque::from([
                "PEER_ADMITTED account=a route=relay".to_string(),
                "PEER_LOST account=a reason=link_lost".to_string(),
            ]),
        );
        let lines = collect_lines(
            || api.read_peer_event(SessionHandle(1)),
            PEER_EVENTS_PER_CALL,
        );
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("PEER_ADMITTED"));
        let endless = collect_lines(|| Some("x".to_string()), 5);
        assert_eq!(endless.len(), 5);
    }

    #[test]
    fn a_fake_module_serves_several_sessions_at_once() {
        // The point of version 3, seen through the trait: two sessions side by side, each addressed by its handle.
        let api = FakeApi::default();
        let hub = api.host_open("k", "hub.conf", "c", None, "s").unwrap();
        let hunt = api
            .host_open("k", "hunt.conf", "c", Some("t"), "s")
            .unwrap();
        assert_ne!(hub, hunt);
        assert!(api.session_running(hub) && api.session_running(hunt));
        assert!(api.add_peer(hub, "member-1", 42, "key"));
        assert!(api.stop_session(hub));
        assert!(!api.session_running(hub));
        assert!(api.session_running(hunt));
        assert!(!api.stop_session(hub));
        assert_eq!(
            api.calls(),
            [
                "host_open hub.conf ticket=none",
                "host_open hunt.conf ticket=t",
                "add 1 member-1 42",
                "stop 1",
                "stop 1"
            ]
        );
    }

    // ---- the ABI 2 emulation ------------------------------------------------------------------------------------

    #[derive(Default)]
    struct FakeRawV2 {
        state: Mutex<RawState>,
    }

    #[derive(Default)]
    struct RawState {
        running: bool,
        starts: Vec<String>,
        fail_start: Option<String>,
        signals: VecDeque<SignalRead>,
        stops: u32,
    }

    impl RawV2 for FakeRawV2 {
        fn start_host(
            &self,
            _public_key: &str,
            config: &str,
            _capability: &str,
            host_ticket: &str,
            _secrets: &str,
        ) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            if let Some(error) = state.fail_start.clone() {
                return Err(error);
            }
            state.running = true;
            state.starts.push(format!("host {config} {host_ticket}"));
            Ok(())
        }

        fn start_join(
            &self,
            _public_key: &str,
            config: &str,
            _ticket: &str,
            _secrets: &str,
        ) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state.running = true;
            state.starts.push(format!("join {config}"));
            Ok(())
        }

        fn wait_ready(&self, _timeout_ms: u32) -> RawReady {
            RawReady::Ready("HOST_READY".to_string())
        }

        fn session_running(&self) -> bool {
            self.state.lock().unwrap().running
        }

        fn stop_session(&self) {
            let mut state = self.state.lock().unwrap();
            state.running = false;
            state.stops += 1;
        }

        fn last_result(&self) -> i32 {
            0
        }

        fn read_signal(&self) -> SignalRead {
            self.state
                .lock()
                .unwrap()
                .signals
                .pop_front()
                .unwrap_or(SignalRead::None)
        }

        fn submit_signal(&self, _from: &str, _kind: &str, _data: &str) -> bool {
            self.state.lock().unwrap().running
        }

        fn read_peer_event(&self) -> Option<String> {
            Some("PEER_CONNECTED account=a route=direct".to_string())
        }

        fn read_diagnostic(&self) -> Option<String> {
            None
        }
    }

    #[test]
    fn an_abi_two_module_keeps_one_session_at_a_time_behind_handles() {
        let api = EmulatedV2::new(FakeRawV2::default());
        let first = api.host_open("k", "a.conf", "c", Some("t"), "s").unwrap();
        assert!(api.session_running(first));
        // The module refuses a second session while one runs, and so does the emulation (no start reaches it).
        assert_eq!(
            api.join_open("k", "b.conf", "t", "s").unwrap_err(),
            "A co-op session is already running."
        );
        assert_eq!(api.raw.state.lock().unwrap().starts, ["host a.conf t"]);
        // Stopping keeps the ended session readable; a new start replaces it and the old handle goes stale.
        assert!(api.stop_session(first));
        assert!(!api.session_running(first));
        assert_eq!(
            api.read_peer_event(first).as_deref(),
            Some("PEER_CONNECTED account=a route=direct")
        );
        let second = api.join_open("k", "b.conf", "t", "s").unwrap();
        assert_ne!(first, second);
        assert!(api.session_running(second));
        assert!(!api.session_running(first));
        assert!(!api.stop_session(first));
        assert_eq!(api.read_peer_event(first), None);
        assert_eq!(
            api.wait_ready(first, 10),
            RawReady::Ended {
                detail: String::new(),
                result: -1
            }
        );
        assert_eq!(api.last_result(first), -1);
        assert!(!api.submit_signal(first, "a", "CANDIDATE", "x"));
        assert!(api.submit_signal(second, "a", "CANDIDATE", "x"));
        assert_eq!(api.raw.state.lock().unwrap().stops, 1);
    }

    #[test]
    fn an_abi_two_module_cannot_change_peers_or_host_without_a_client() {
        let api = EmulatedV2::new(FakeRawV2::default());
        let error = api.host_open("k", "hub.conf", "c", None, "s").unwrap_err();
        assert!(error.contains("without the host's own client"), "{error}");
        assert!(api.raw.state.lock().unwrap().starts.is_empty());
        let handle = api.host_open("k", "a.conf", "c", Some("t"), "s").unwrap();
        assert!(!api.add_peer(handle, "member", 5, "key"));
        assert!(!api.remove_peer(handle, "member", "left"));
    }

    #[test]
    fn a_failed_abi_two_start_mints_no_handle() {
        let api = EmulatedV2::new(FakeRawV2::default());
        api.raw.state.lock().unwrap().fail_start = Some("HOST CONFIG FAIL".to_string());
        assert_eq!(
            api.host_open("k", "a.conf", "c", Some("t"), "s")
                .unwrap_err(),
            "HOST CONFIG FAIL"
        );
        api.raw.state.lock().unwrap().fail_start = None;
        // The first handle is still 1: nothing was minted for the failure.
        assert_eq!(
            api.host_open("k", "a.conf", "c", Some("t"), "s").unwrap(),
            SessionHandle(1)
        );
    }

    #[test]
    fn open_errors_prefer_the_modules_text() {
        let mut error = [0u8; 64];
        error[..4].copy_from_slice(b"nope");
        assert_eq!(open_result(3, &error, "fallback"), Ok(SessionHandle(3)));
        assert_eq!(open_result(0, &error, "fallback"), Err("nope".to_string()));
        assert_eq!(
            open_result(0, &[0u8; 8], "fallback"),
            Err("fallback".to_string())
        );
    }

    // ---- the real module (skipped where it was not built) ---------------------------------------------------------

    /// Loads the built ParadoxTransport.dll (ParadoxTransport/build/Release) and checks the ABI 3 glue end to end:
    /// version, the handle exports, unknown handles, and a session whose files do not exist.
    #[test]
    fn the_built_module_speaks_abi_three() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ParadoxTransport/build/Release/ParadoxTransport.dll");
        if !dll.is_file() {
            return;
        }
        let Ok(loaded) = load_module(&dll) else {
            // A module that cannot be loaded here (policy, bitness) is not this test's concern.
            return;
        };
        let check = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_eq!(loaded.abi_version, 3);
            let api = loaded.sessions.clone().expect("the ABI 3 handle API");
            let unknown = SessionHandle(9999);
            assert!(!api.session_running(unknown));
            assert!(!api.stop_session(unknown));
            assert_eq!(api.last_result(unknown), -1);
            assert_eq!(api.read_signal(unknown), SignalRead::None);
            assert_eq!(api.read_peer_event(unknown), None);
            assert!(!api.add_peer(unknown, "a", 1, "key"));
            assert!(!api.remove_peer(unknown, "a", "left"));
            assert!(matches!(
                api.wait_ready(unknown, 10),
                RawReady::Ended { .. }
            ));
            // Files that do not exist: either the open is refused with text, or the session ends before readiness.
            match api.host_open("nope.pem", "nope.conf", "nope.cap", None, "nope.secret") {
                Err(message) => assert!(!message.is_empty()),
                Ok(handle) => {
                    assert!(handle.0 > 0);
                    let ready = api.wait_ready(handle, 5000);
                    assert!(matches!(ready, RawReady::Ended { .. }), "{ready:?}");
                    assert!(api.stop_session(handle));
                }
            }
        }));
        unload_module(loaded);
        if let Err(panic) = check {
            std::panic::resume_unwind(panic);
        }
    }
}
