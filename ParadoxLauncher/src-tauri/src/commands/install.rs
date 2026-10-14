use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::auth::consent;
use crate::commands::updates::TARGET_CHANGELIST;
use crate::install::{paths, verify};
use crate::servers::{self, play_block_reason, ServerKind, ServerTarget, OFFICIAL_ID};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub located: bool,
    pub exe_path: Option<String>,
    pub exe_sha256: Option<String>,
    /// True only when the saved game path is valid but one or more project runtime artifacts
    /// need download/repair. Home can still offer Play because Play performs the authoritative
    /// repair+verification pass before spawning.
    pub runtime_repair_required: bool,
    /// Set whenever something about a located installation is wrong. Runtime-only errors are
    /// repairable; path/executable errors remain fatal until the user fixes the install.
    pub error: Option<String>,
    /// The Dauntless changelist this launcher and its signed runtime target. The UI compares it
    /// with the backend's supported changelist instead of printing a hard-coded build name.
    pub target_changelist: u32,
    // [2026-10-13 realms S1] Which server this status describes (the selected one unless a command named another).
    pub server_id: String,
    pub server_kind: ServerKind,
    pub server_name: String,
    /// Set when Play is off for this server whatever the installation holds (a local server whose warning has not
    /// been accepted yet).
    pub play_blocked_reason: Option<String>,
    /// False when the realm's own files are used and the launcher neither checks nor updates them.
    pub runtime_managed: bool,
}

fn status_for(
    target: &ServerTarget,
    warning_accepted: bool,
    located: bool,
    exe_path: Option<String>,
    exe_sha256: Option<String>,
    runtime_repair_required: bool,
    error: Option<String>,
) -> InstallStatus {
    InstallStatus {
        located,
        exe_path,
        exe_sha256,
        runtime_repair_required,
        error,
        target_changelist: TARGET_CHANGELIST,
        server_id: target.server.id.clone(),
        server_kind: target.server.kind,
        server_name: target.server.name.clone(),
        play_blocked_reason: play_block_reason(target.server.kind, warning_accepted)
            .map(str::to_string),
        runtime_managed: target.uses_official_feed(),
    }
}

fn not_located(target: &ServerTarget, warning_accepted: bool) -> InstallStatus {
    status_for(target, warning_accepted, false, None, None, false, None)
}

fn build_status(
    target: &ServerTarget,
    warning_accepted: bool,
    exe_path: &std::path::Path,
) -> InstallStatus {
    let exe_path_string = exe_path.display().to_string();
    let located = |sha: Option<String>, repair: bool, error: Option<String>| {
        status_for(
            target,
            warning_accepted,
            true,
            Some(exe_path_string.clone()),
            sha,
            repair,
            error,
        )
    };

    let game_dir = match paths::game_dir(exe_path) {
        Ok(d) => d,
        Err(e) => return located(None, false, Some(e)),
    };

    // Our runtime files are checked only where our feed provides them. A local server's files are the realm's own.
    if target.uses_official_feed() {
        if let Err(e) = verify::verify_runtime_dlls_present(&game_dir) {
            return located(None, true, Some(e));
        }
    }

    // Display only: Play re-hashes every protected file in full before requesting a ticket.
    match verify::hash_file_sha256_cached(exe_path) {
        Ok(hash) => located(Some(hash), false, None),
        Err(e) => located(None, false, Some(e)),
    }
}

/// A saved folder the launcher refuses (it is, or overlaps, the official install): shown as an installation
/// error, so the player is asked to pick the server's own folder again.
fn refused_folder_status(
    target: &ServerTarget,
    warning_accepted: bool,
    problem: &str,
) -> InstallStatus {
    status_for(
        target,
        warning_accepted,
        true,
        target.server.game_exe_path.clone(),
        None,
        false,
        Some(problem.to_string()),
    )
}

fn status_of(target: &ServerTarget, warning_accepted: bool) -> InstallStatus {
    if let Some(problem) = &target.folder_problem {
        return refused_folder_status(target, warning_accepted, problem);
    }
    match &target.exe_path {
        Some(exe_path) if exe_path.is_file() => build_status(target, warning_accepted, exe_path),
        _ => not_located(target, warning_accepted),
    }
}

fn read_install_status(app: AppHandle, server_id: Option<String>) -> Result<InstallStatus, String> {
    let target = servers::target_for(&app, server_id.as_deref())?;
    let warning_accepted = consent::is_accepted(&app, &target.server.id);
    Ok(status_of(&target, warning_accepted))
}

/// The installation status of `server_id`, or of the selected server when none is named.
#[tauri::command]
pub async fn get_install_status(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<InstallStatus, String> {
    // Hashing the game executable can take seconds on a slow disk. Keep it off Tauri's UI thread.
    tauri::async_runtime::spawn_blocking(move || read_install_status(app, server_id))
        .await
        .map_err(|_| "The installation check stopped unexpectedly.".to_string())?
}

/// Lets the player pick `server_id`'s install folder (the selected server's when none is named). For the official
/// server this saves `install.json` exactly as before. A Paradox realm with no folder of its own runs from the official
/// install, so the picker locates that install for it; `own_folder` (the realm's "separate folder") saves the picked
/// folder for the realm instead. A local server keeps its own folder, which may not overlap another server's.
#[tauri::command]
pub async fn pick_install_path(
    app: AppHandle,
    server_id: Option<String>,
    own_folder: Option<bool>,
) -> Result<InstallStatus, String> {
    let target = servers::target_for(&app, server_id.as_deref())?;
    let id = target.server.id.clone();
    // The server whose folder is saved: the official install for a realm with no folder of its own.
    let save_id = if target.server.uses_official_install() && own_folder != Some(true) {
        OFFICIAL_ID.to_string()
    } else {
        id.clone()
    };
    // Refuse early (before the player browses for a folder) while this server is in use. The fence is taken again
    // around the write below, because the dialog can stay open for as long as the player likes.
    super::servers::fence_server_change(&app, &save_id)?;

    // File dialogs block the calling thread until the user responds — run it
    // on a blocking-friendly task so it doesn't stall the async runtime.
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Select your Dauntless installation folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else {
        // User cancelled the dialog — not an error, just report whatever was
        // already saved (or "not located" if nothing was).
        return get_install_status(app, Some(id)).await;
    };

    let selected_folder = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = paths::find_game_executable(&selected_folder)?;

    let save_app = app.clone();
    let task_id = save_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _fence = super::servers::fence_server_change(&save_app, &task_id)?;
        servers::set_game_exe(&save_app, &task_id, &canonical)
    })
    .await
    .map_err(|_| "The installation check stopped unexpectedly.".to_string())??;

    get_install_status(app, Some(id)).await
}
