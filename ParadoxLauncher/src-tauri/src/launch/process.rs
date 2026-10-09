use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

const GAME_EXE_NAME: &str = "Dauntless-Win64-Shipping.exe";
static CLIENT_GAME_PID: AtomicU32 = AtomicU32::new(0);
/// Emitted with the exit code when the launcher's own game client exits.
pub const GAME_EXITED_EVENT: &str = "game-exited";

fn active_session_log_dir() -> &'static Mutex<Option<PathBuf>> {
    static ACTIVE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

pub fn current_session_log_dir() -> Option<PathBuf> {
    active_session_log_dir()
        .lock()
        .ok()
        .and_then(|active| active.clone())
}

pub fn set_active_session_log_dir(path: Option<&Path>) {
    if let Ok(mut active) = active_session_log_dir().lock() {
        *active = path.map(Path::to_path_buf);
    }
}

pub fn append_active_session_log(line: &str) {
    let path = current_session_log_dir();
    if let Some(path) = path {
        super::logs::append_launcher_log(&path, line);
    }
}

/// Releases resources a Play attempt started, on every exit path once nothing needs them.
fn release_play_resources() {
    // A P2P build releases the transport it started for Play.
    #[cfg(feature = "p2p")]
    crate::p2p::release_play_transport();
}

pub fn game_process_id() -> Option<u32> {
    match CLIENT_GAME_PID.load(Ordering::Acquire) {
        0 => None,
        pid => Some(pid),
    }
}

// A Win32 process handle has no thread affinity (unlike some GUI handles), so it's sound to
// hand off to another thread as long as exactly one thread owns and closes it. windows-sys'
// HANDLE (*mut c_void) isn't Send by default; this newtype asserts that it's fine here.
struct SendableHandle(windows_sys::Win32::Foundation::HANDLE);
unsafe impl Send for SendableHandle {}

pub fn is_game_running() -> Result<bool, String> {
    // The retained process handle monitor clears this only after exit. Skip the process scan
    // for every status check while our own client is alive.
    if game_process_id().is_some() {
        return Ok(true);
    }
    // Ramsgate and Training Dojo are dedicated-server processes using the same executable as
    // the client, so the image name alone would make a healthy local hub look like a running
    // game client. Read each command line and exclude UE's explicit `-server` launch mode.
    // An unreadable command line counts as a client, as the earlier PowerShell/CIM query did.
    Ok(dauntless_processes()?
        .iter()
        .any(|command_line| !command_line.as_deref().is_some_and(is_server_command_line)))
}

/// Runtime DLL updates must wait for both client and dedicated-server
/// processes because either one can have the DLL mapped and locked.
pub fn is_dauntless_process_running() -> Result<bool, String> {
    Ok(!dauntless_processes()?.is_empty())
}

fn is_server_command_line(command_line: &str) -> bool {
    command_line
        .split_whitespace()
        .any(|argument| argument.eq_ignore_ascii_case("-server"))
}

/// The command line of every running Dauntless process (`None` where Windows refuses it).
/// Native Toolhelp + NtQueryInformationProcess: the previous PowerShell/CIM query took 0.5-1.4 s
/// per check and failed Play outright wherever PowerShell was blocked.
fn dauntless_processes() -> Result<Vec<Option<String>>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Couldn't check running processes.".to_string());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = Vec::new();
        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            if name.eq_ignore_ascii_case(GAME_EXE_NAME) {
                found.push(process_command_line(entry.th32ProcessID));
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        Ok(found)
    }
}

fn process_command_line(process_id: u32) -> Option<String> {
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, UNICODE_STRING};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }
        // The result is a UNICODE_STRING header followed by its own buffer; u64 storage keeps
        // the header aligned.
        let mut buffer = vec![0u64; 512];
        let mut needed = 0u32;
        let mut status = NtQueryInformationProcess(
            process,
            ProcessCommandLineInformation,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
            &mut needed,
        );
        if status == STATUS_INFO_LENGTH_MISMATCH && needed as usize <= 64 * 1024 {
            buffer = vec![0u64; (needed as usize).div_ceil(8)];
            status = NtQueryInformationProcess(
                process,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            );
        }
        CloseHandle(process);
        if status < 0 {
            return None;
        }
        let header = &*(buffer.as_ptr() as *const UNICODE_STRING);
        let start = buffer.as_ptr() as usize;
        let end = start + buffer.len() * 8;
        let text = header.Buffer as usize;
        let bytes = header.Length as usize;
        // The string must lie inside the buffer the kernel filled.
        if header.Buffer.is_null() || text < start || text + bytes > end {
            return None;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(
            header.Buffer,
            bytes / 2,
        )))
    }
}

pub struct LaunchIdentity {
    pub account_id: String,
    pub display_name: String,
}

fn is_sanitized_runtime_env_name(name: &str) -> bool {
    [
        "MYSTICPARADOX_RUNTIME_PROFILE",
        "MYSTICPARADOX_ALLOW_DAMAGE_DEBUG",
        "MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER",
    ]
    .iter()
    .any(|blocked| name.eq_ignore_ascii_case(blocked))
}

fn build_game_environment(runtime_profile: &str) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;

    if runtime_profile != "production" && runtime_profile != "development" {
        return Err("Invalid centrally authorized runtime profile.".to_string());
    }

    // Build a private Unicode environment block instead of mutating the launcher's process-wide
    // environment. That avoids races with concurrent host/join supervisors and guarantees that
    // local MYSTICPARADOX_* mutation switches cannot leak into the protected game process.
    let mut entries = std::env::vars_os()
        .filter_map(|(key, value)| {
            let key_lossy = key.to_string_lossy();
            if is_sanitized_runtime_env_name(&key_lossy) {
                return None;
            }
            let mut encoded = key.encode_wide().collect::<Vec<_>>();
            encoded.push('=' as u16);
            encoded.extend(value.encode_wide());
            encoded.push(0);
            Some((key_lossy.to_lowercase(), encoded))
        })
        .collect::<Vec<_>>();

    let profile = format!("MYSTICPARADOX_RUNTIME_PROFILE={runtime_profile}");
    let mut profile_encoded = profile.encode_utf16().collect::<Vec<_>>();
    profile_encoded.push(0);
    entries.push(("mysticparadox_runtime_profile".to_string(), profile_encoded));
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut block = Vec::new();
    for (_, entry) in entries {
        block.extend(entry);
    }
    block.push(0);
    Ok(block)
}

/// Phase 2 (in-process redirect): the game is launched with NO proxy env vars. The injected
/// DLL's FCurlHttpRequest::SetURL hook rewrites backend URLs straight to paradox.mysticfox.dev,
/// so the old WinDivert interceptor / HTTP_PROXY path is no longer used (matches
/// start-client-direct.bat). epicapp/epicenv/epicsandboxid/epicdeploymentid stay fixed
/// constants matching routes/eos.ts's EOS-compat values; the epic* identity args carry the
/// authenticated player's real account id/display name.
pub fn spawn_game(
    app: &tauri::AppHandle,
    exe_path: &Path,
    exchange_code: &str,
    identity: &LaunchIdentity,
    runtime_profile: &str,
    session_dir: &Path,
    mut metadata: super::logs::SessionMetadata,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use std::time::SystemTime;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_CREATE_PROCESS,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, STARTUPINFOEXW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        PROCESS_CREATION_MITIGATION_POLICY_DEP_ENABLE,
        PROCESS_CREATION_MITIGATION_POLICY_SEHOP_ENABLE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    use super::logs;

    let game_dir = exe_path
        .parent()
        .ok_or_else(|| "Invalid installation path.".to_string())?;
    let launch_started_at = SystemTime::now();

    // A P2P build starts its co-op transport here, before the game process exists. The default
    // dedicated-only build has none.
    #[cfg(feature = "p2p")]
    crate::p2p::start_play_transport(game_dir, session_dir)?;

    // Root cause of "no audio only when launched by the launcher" (confirmed: non-elevated, launcher
    // rebuilt with a detached spawn, still silent; `start` from a separate cmd = audio): the game
    // inherits the launcher's process context. Under Parallels that inherited context breaks UE4's
    // audio-device init. The fix is to REPARENT the game under Explorer (the shell) via the
    // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS attribute, so it launches in a clean interactive context
    // exactly like a double-click. Parentage is separate from protection: immediately after creation
    // the suspended process is assigned to the launcher's kill-on-close Job Object. If the shell
    // handle can't be obtained, we fall back to a plain parent (still protected; may lack audio).
    let args: [String; 13] = [
        "-DisableEOS".into(),
        "-EpicPortal".into(),
        "-NoEAC".into(),
        "-AUTH_TYPE=exchangecode".into(),
        // UE's MCP/social subsystem uses AUTH_LOGIN as its local account key; the metagame OAuth
        // endpoint authenticates from AUTH_PASSWORD, so the verified UUID here is correct.
        format!("-AUTH_LOGIN={}", identity.account_id),
        format!("-AUTH_PASSWORD={exchange_code}"),
        "-epicapp=Archon".into(),
        "-epicenv=Prod".into(),
        format!("-epicusername={}", identity.display_name),
        format!("-epicuserid={}", identity.account_id),
        format!("-epicaccountid={}", identity.account_id),
        "-epicsandboxid=jackal".into(),
        "-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2".into(),
    ];

    // Build one command line: "exe" arg1 arg2 ... A -key=value whose value has spaces becomes
    // -key="value"; other space-bearing tokens are wrapped whole.
    let mut cmdline = format!("\"{}\"", exe_path.to_string_lossy());
    for a in &args {
        cmdline.push(' ');
        if a.contains(' ') {
            if let Some(eq) = a.find('=') {
                cmdline.push_str(&a[..eq]);
                cmdline.push_str("=\"");
                cmdline.push_str(&a[eq + 1..]);
                cmdline.push('"');
            } else {
                cmdline.push('"');
                cmdline.push_str(a);
                cmdline.push('"');
            }
        } else {
            cmdline.push_str(a);
        }
    }
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let dir_w: Vec<u16> = game_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // A rejected environment returns here. Release per-Play resources through the same path every
    // other spawn failure uses, so a failed Play attempt leaves nothing running behind it.
    let mut environment = match build_game_environment(runtime_profile) {
        Ok(value) => value,
        Err(error) => {
            release_play_resources();
            logs::append_launcher_log(session_dir, &format!("game environment rejected: {error}"));
            return Err(error);
        }
    };

    unsafe {
        // Obtain a handle to the shell (Explorer) process to reparent under.
        let mut parent_handle: HANDLE = ptr::null_mut();
        let shell_hwnd = GetShellWindow();
        if !shell_hwnd.is_null() {
            let mut shell_pid: u32 = 0;
            GetWindowThreadProcessId(shell_hwnd, &mut shell_pid);
            if shell_pid != 0 {
                parent_handle = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
            }
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

        // Build one attribute list carrying the compatible DEP/SEHOP policy and, when available,
        // the Explorer parent. Avoid stronger image/signature policies here: this archived UE4
        // build legitimately loads our signed proxy and InternalServer DLLs.
        let mut attr_buf: Vec<u8> = Vec::new();
        let mut have_attr = false;
        let mut attr_initialized = false;
        let parent_for_attr = parent_handle;
        let mitigation_policy: u64 = (PROCESS_CREATION_MITIGATION_POLICY_DEP_ENABLE
            | PROCESS_CREATION_MITIGATION_POLICY_SEHOP_ENABLE)
            as u64;
        let attribute_count = if parent_handle.is_null() { 1 } else { 2 };
        let mut size: usize = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), attribute_count, 0, &mut size);
        if size > 0 {
            attr_buf.resize(size, 0);
            let list = attr_buf.as_mut_ptr() as *mut core::ffi::c_void;
            if InitializeProcThreadAttributeList(list, attribute_count, 0, &mut size) != 0 {
                attr_initialized = true;
                let mitigation_ok = UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
                    &mitigation_policy as *const u64 as *const core::ffi::c_void,
                    std::mem::size_of::<u64>(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
                let parent_ok = if parent_handle.is_null() {
                    1
                } else {
                    UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                        &parent_for_attr as *const HANDLE as *const core::ffi::c_void,
                        std::mem::size_of::<HANDLE>(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                };
                if mitigation_ok != 0 && parent_ok != 0 {
                    si.lpAttributeList = list;
                    have_attr = true;
                }
            }
        }

        let mut flags = CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        if have_attr {
            flags |= EXTENDED_STARTUPINFO_PRESENT;
        }

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let created = CreateProcessW(
            ptr::null(),
            cmdline_w.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0, // bInheritHandles = FALSE
            flags,
            environment.as_mut_ptr().cast(),
            dir_w.as_ptr(),
            &mut si as *mut STARTUPINFOEXW as *mut _,
            &mut pi,
        );

        if attr_initialized {
            DeleteProcThreadAttributeList(attr_buf.as_mut_ptr() as *mut core::ffi::c_void);
        }
        if !parent_handle.is_null() {
            CloseHandle(parent_handle);
        }

        if created == 0 {
            let err = GetLastError();
            release_play_resources();
            logs::append_launcher_log(session_dir, &format!("CreateProcess failed (error {err})"));
            return Err(format!(
                "Couldn't start Dauntless (CreateProcess error {err})."
            ));
        }
        if let Err(error) = super::supervisor::assign_process_handle(pi.hProcess) {
            TerminateProcess(pi.hProcess, 0xE201);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            release_play_resources();
            logs::append_launcher_log(session_dir, &format!("process protection failed: {error}"));
            return Err(error);
        }
        if ResumeThread(pi.hThread) == u32::MAX {
            let err = GetLastError();
            TerminateProcess(pi.hProcess, 0xE202);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            release_play_resources();
            logs::append_launcher_log(session_dir, &format!("process resume failed (error {err})"));
            return Err(format!(
                "Couldn't resume protected Dauntless (error {err})."
            ));
        }
        logs::append_launcher_log(
            session_dir,
            &format!("process created (pid {})", pi.dwProcessId),
        );
        set_active_session_log_dir(Some(session_dir));
        CLIENT_GAME_PID.store(pi.dwProcessId, Ordering::Release);

        // Wait briefly to catch immediate crashes (missing DLL, wrong working dir, etc.).
        let wait = WaitForSingleObject(pi.hProcess, 500);
        if wait == WAIT_OBJECT_0 {
            let mut code: u32 = 0;
            GetExitCodeProcess(pi.hProcess, &mut code);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            let _ = CLIENT_GAME_PID.compare_exchange(
                pi.dwProcessId,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            release_play_resources();
            logs::append_launcher_log(session_dir, &format!("exited immediately (code {code})"));
            set_active_session_log_dir(None);
            metadata.exit_code = Some(code);
            metadata.exited_at = Some(logs::iso8601_now());
            logs::write_metadata(session_dir, &metadata);
            logs::copy_runtime_logs_best_effort(game_dir, session_dir, launch_started_at);
            return Err(format!("Dauntless exited immediately (code: {code})."));
        }

        // Past the previous behavior of discarding the handle here: retain hProcess (an
        // isize-backed HANDLE, trivially Send/Copy) and hand it to a background thread that
        // blocks until the real exit, then finalizes this session's logs. hThread isn't
        // needed for that and is closed immediately.
        CloseHandle(pi.hThread);
        logs::append_launcher_log(
            session_dir,
            "post-spawn crash check passed; monitoring in background",
        );

        let h_process = SendableHandle(pi.hProcess);
        let process_id = pi.dwProcessId;
        let session_dir_owned = session_dir.to_path_buf();
        let game_dir_owned = game_dir.to_path_buf();
        let app = app.clone();
        std::thread::spawn(move || {
            // `let h_process = h_process;` forces the closure to capture the whole
            // SendableHandle (and use its `unsafe impl Send`) — with 2021 edition disjoint
            // closure captures, going straight to `h_process.0` below would instead capture
            // just the inner *mut c_void field, silently bypassing the Send wrapper.
            let h_process = h_process;
            let h_process = h_process.0;
            let mut code: u32 = 0;
            WaitForSingleObject(h_process, INFINITE);
            GetExitCodeProcess(h_process, &mut code);
            CloseHandle(h_process);
            let _ = CLIENT_GAME_PID.compare_exchange(
                process_id,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            release_play_resources();
            logs::append_launcher_log(&session_dir_owned, &format!("exited (code {code})"));
            set_active_session_log_dir(None);
            metadata.exit_code = Some(code);
            metadata.exited_at = Some(logs::iso8601_now());
            logs::write_metadata(&session_dir_owned, &metadata);
            logs::copy_runtime_logs_best_effort(
                &game_dir_owned,
                &session_dir_owned,
                launch_started_at,
            );
            // Home flips back from "running" to Play without a manual status check.
            use tauri::Emitter;
            let _ = app.emit(GAME_EXITED_EVENT, code);
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_server_arguments_are_distinct_from_client_arguments() {
        let server = "Dauntless-Win64-Shipping.exe key 8790 map -EpicPortal -server -nullrhi";
        let client = "Dauntless-Win64-Shipping.exe -EpicPortal -NoEAC -AUTH_TYPE=exchangecode";

        assert!(is_server_command_line(server));
        assert!(is_server_command_line(
            "Dauntless-Win64-Shipping.exe -SERVER"
        ));
        assert!(!is_server_command_line(client));
        assert!(!is_server_command_line(
            "Dauntless-Win64-Shipping.exe -serverlog"
        ));
    }

    #[test]
    fn native_process_scan_reads_command_lines() {
        // The test runner itself is not Dauntless; the scan must still enumerate cleanly.
        assert!(dauntless_processes().is_ok());
        let own = process_command_line(std::process::id()).expect("own command line");
        assert!(!own.is_empty());
    }

    #[test]
    fn protected_game_environment_sanitizes_local_runtime_mutation_switches() {
        assert!(is_sanitized_runtime_env_name(
            "MYSTICPARADOX_RUNTIME_PROFILE"
        ));
        assert!(is_sanitized_runtime_env_name(
            "mysticparadox_allow_damage_debug"
        ));
        assert!(is_sanitized_runtime_env_name(
            "MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER"
        ));
        assert!(!is_sanitized_runtime_env_name("SystemRoot"));

        let environment = build_game_environment("production").unwrap();
        let flattened = String::from_utf16_lossy(&environment).replace('\0', "\n");
        assert!(flattened
            .lines()
            .any(|line| line == "MYSTICPARADOX_RUNTIME_PROFILE=production"));
        assert!(build_game_environment("local-debug").is_err());
    }
}
