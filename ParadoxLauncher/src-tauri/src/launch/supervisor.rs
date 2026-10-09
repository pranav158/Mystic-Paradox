use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

/// The launcher keeps this handle for its complete lifetime. Windows closes it even after an
/// ungraceful launcher termination; KILL_ON_JOB_CLOSE then terminates every protected game/server
/// process assigned to it. Explorer re-parenting may still be used for audio compatibility because
/// process parentage and Job Object containment are independent.
struct ProtectedJob(HANDLE);
unsafe impl Send for ProtectedJob {}
unsafe impl Sync for ProtectedJob {}

impl Drop for ProtectedJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn protected_job() -> Result<&'static ProtectedJob, String> {
    static JOB: OnceLock<Result<ProtectedJob, String>> = OnceLock::new();
    JOB.get_or_init(|| unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err(format!(
                "Couldn't create the launcher protection job (error {}).",
                GetLastError()
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            let error = GetLastError();
            CloseHandle(handle);
            return Err(format!(
                "Couldn't configure launcher process protection (error {error})."
            ));
        }
        Ok(ProtectedJob(handle))
    })
    .as_ref()
    .map_err(Clone::clone)
}

pub fn assign_process_handle(process: HANDLE) -> Result<(), String> {
    if process.is_null() {
        return Err("Couldn't protect an invalid game process.".to_string());
    }
    let job = protected_job()?;
    if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
        return Err(format!(
            "Couldn't bind the game to launcher protection (error {}).",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

pub fn terminate_all(exit_code: u32) -> Result<(), String> {
    let job = protected_job()?;
    if unsafe { TerminateJobObject(job.0, exit_code) } == 0 {
        return Err(format!(
            "Couldn't terminate protected launcher processes (error {}).",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

/// Resume the sole initial thread of a process created with CREATE_SUSPENDED. The process cannot
/// create a child before this call, so assigning its process handle to the launcher Job Object
/// first closes the short child-process escape window present with std::process::Command::spawn.
/// Used for the P2P player host.
#[cfg_attr(not(mystic_p2p), allow(dead_code))]
pub fn resume_initial_thread(process_id: u32) -> Result<(), String> {
    if process_id == 0 {
        return Err("Couldn't resume an invalid protected process.".to_string());
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err(format!(
                "Couldn't enumerate the protected process threads (error {}).",
                GetLastError()
            ));
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = Thread32First(snapshot, &mut entry) != 0;
        while found {
            if entry.th32OwnerProcessID == process_id {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() {
                    let error = GetLastError();
                    CloseHandle(snapshot);
                    return Err(format!(
                        "Couldn't open the protected process thread (error {error})."
                    ));
                }
                let resumed = ResumeThread(thread);
                let error = if resumed == u32::MAX {
                    Some(GetLastError())
                } else {
                    None
                };
                CloseHandle(thread);
                CloseHandle(snapshot);
                return match error {
                    Some(error) => Err(format!(
                        "Couldn't resume the protected process (error {error})."
                    )),
                    None => Ok(()),
                };
            }
            found = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Err("Couldn't find the protected process initial thread.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_null_process_handle() {
        assert!(assign_process_handle(std::ptr::null_mut()).is_err());
    }
}
