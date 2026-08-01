use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

const GAME_EXE_NAME: &str = "Dauntless-Win64-Shipping.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// A Win32 process handle has no thread affinity (unlike some GUI handles), so it's sound to
// hand off to another thread as long as exactly one thread owns and closes it. windows-sys'
// HANDLE (*mut c_void) isn't Send by default; this newtype asserts that it's fine here.
struct SendableHandle(windows_sys::Win32::Foundation::HANDLE);
unsafe impl Send for SendableHandle {}

pub fn is_game_running() -> Result<bool, String> {
    // Ramsgate and Training Dojo are dedicated-server processes using the same
    // executable as the client. `tasklist` only exposes the image name, so it
    // makes a healthy server look like a running game client. Inspect the
    // command line and exclude UE's explicit `-server` launch mode instead.
    let query = format!(
        "$processes = Get-CimInstance Win32_Process -Filter \"Name='{GAME_EXE_NAME}'\"; \
         $client = $processes | Where-Object {{ $_.CommandLine -notmatch '(^|\\s)-server(\\s|$)' }}; \
         if ($null -ne $client) {{ 'true' }} else {{ 'false' }}"
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't check running processes: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Couldn't check running processes: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
    match stdout.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(format!(
            "Couldn't determine whether Dauntless is running: {other}"
        )),
    }
}

/// Runtime DLL updates must wait for both client and dedicated-server
/// processes because either one can have the DLL mapped and locked.
pub fn is_dauntless_process_running() -> Result<bool, String> {
    let query = format!(
        "$processes = Get-CimInstance Win32_Process -Filter \"Name='{GAME_EXE_NAME}'\"; if ($null -ne $processes) {{ 'true' }} else {{ 'false' }}"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't check Dauntless processes: {e}"))?;
    if !output.status.success() {
        return Err("Couldn't check Dauntless processes.".to_string());
    }
    match String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase()
        .as_str()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(format!(
            "Couldn't determine Dauntless process state: {other}"
        )),
    }
}

pub struct LaunchIdentity {
    pub account_id: String,
    pub display_name: String,
}

/// Phase 2 (in-process redirect): the game is launched with NO proxy env vars. The injected
/// DLL's FCurlHttpRequest::SetURL hook rewrites backend URLs straight to paradox.mysticfox.dev,
/// so the old WinDivert interceptor / HTTP_PROXY path is no longer used (matches
/// start-client-direct.bat). epicapp/epicenv/epicsandboxid/epicdeploymentid stay fixed
/// constants matching routes/eos.ts's EOS-compat values; the epic* identity args carry the
/// authenticated player's real account id/display name.
pub fn spawn_game(
    exe_path: &Path,
    exchange_code: &str,
    identity: &LaunchIdentity,
    session_dir: &Path,
    mut metadata: super::logs::SessionMetadata,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use std::time::SystemTime;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        PROCESS_CREATE_PROCESS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
        STARTUPINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    use super::logs;

    let game_dir = exe_path
        .parent()
        .ok_or_else(|| "Invalid installation path.".to_string())?;
    let launch_started_at = SystemTime::now();

    // Root cause of "no audio only when launched by the launcher" (confirmed: non-elevated, launcher
    // rebuilt with a detached spawn, still silent; `start` from a separate cmd = audio): the game
    // inherits the launcher's process context. Under Parallels that inherited context breaks UE4's
    // audio-device init. The fix is to REPARENT the game under Explorer (the shell) via the
    // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS attribute, so it launches in a clean interactive context
    // exactly like a double-click — no inherited job/session from the launcher. If the shell handle
    // can't be obtained, we fall back to a plain CreateProcess (still launches; may lack audio).
    let args: [String; 12] = [
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

        // Build the attribute list carrying the parent-process handle. Kept in scope until after
        // CreateProcessW so the pointers stay valid.
        let mut attr_buf: Vec<u8> = Vec::new();
        let mut have_attr = false;
        let parent_for_attr = parent_handle;
        if !parent_handle.is_null() {
            let mut size: usize = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
            if size > 0 {
                attr_buf.resize(size, 0);
                let list = attr_buf.as_mut_ptr() as *mut core::ffi::c_void;
                if InitializeProcThreadAttributeList(list, 1, 0, &mut size) != 0 {
                    let ok = UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                        &parent_for_attr as *const HANDLE as *const core::ffi::c_void,
                        std::mem::size_of::<HANDLE>(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    );
                    if ok != 0 {
                        si.lpAttributeList = list;
                        have_attr = true;
                    }
                }
            }
        }

        let mut flags = CREATE_NEW_PROCESS_GROUP;
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
            ptr::null(),
            dir_w.as_ptr(),
            &mut si as *mut STARTUPINFOEXW as *mut _,
            &mut pi,
        );

        if have_attr {
            DeleteProcThreadAttributeList(si.lpAttributeList);
        }
        if !parent_handle.is_null() {
            CloseHandle(parent_handle);
        }

        if created == 0 {
            let err = GetLastError();
            logs::append_launcher_log(session_dir, &format!("CreateProcess failed (error {err})"));
            return Err(format!(
                "Couldn't start Dauntless (CreateProcess error {err})."
            ));
        }
        logs::append_launcher_log(
            session_dir,
            &format!("process created (pid {})", pi.dwProcessId),
        );

        // Wait briefly to catch immediate crashes (missing DLL, wrong working dir, etc.).
        let wait = WaitForSingleObject(pi.hProcess, 500);
        if wait == WAIT_OBJECT_0 {
            let mut code: u32 = 0;
            GetExitCodeProcess(pi.hProcess, &mut code);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            logs::append_launcher_log(session_dir, &format!("exited immediately (code {code})"));
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
        let session_dir_owned = session_dir.to_path_buf();
        let game_dir_owned = game_dir.to_path_buf();
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
            logs::append_launcher_log(&session_dir_owned, &format!("exited (code {code})"));
            metadata.exit_code = Some(code);
            metadata.exited_at = Some(logs::iso8601_now());
            logs::write_metadata(&session_dir_owned, &metadata);
            logs::copy_runtime_logs_best_effort(
                &game_dir_owned,
                &session_dir_owned,
                launch_started_at,
            );
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dedicated_server_arguments_are_distinct_from_client_arguments() {
        let server = "Dauntless-Win64-Shipping.exe key 8790 map -EpicPortal -server -nullrhi";
        let client = "Dauntless-Win64-Shipping.exe -EpicPortal -NoEAC -AUTH_TYPE=exchangecode";

        assert!(server.contains("-server"));
        assert!(!client.contains("-server"));
    }
}
