use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::commands::updates::TARGET_CHANGELIST;
use crate::install::{paths, verify};

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
}

fn not_located() -> InstallStatus {
    InstallStatus {
        located: false,
        exe_path: None,
        exe_sha256: None,
        runtime_repair_required: false,
        error: None,
        target_changelist: TARGET_CHANGELIST,
    }
}

fn build_status(exe_path: &std::path::Path) -> InstallStatus {
    let exe_path_string = exe_path.display().to_string();

    let game_dir = match paths::game_dir(exe_path) {
        Ok(d) => d,
        Err(e) => {
            return InstallStatus {
                located: true,
                exe_path: Some(exe_path_string),
                exe_sha256: None,
                runtime_repair_required: false,
                error: Some(e),
                target_changelist: TARGET_CHANGELIST,
            }
        }
    };

    if let Err(e) = verify::verify_runtime_dlls_present(&game_dir) {
        return InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            runtime_repair_required: true,
            error: Some(e),
            target_changelist: TARGET_CHANGELIST,
        };
    }

    // Display only: Play re-hashes every protected file in full before requesting a ticket.
    match verify::hash_file_sha256_cached(exe_path) {
        Ok(hash) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: Some(hash),
            runtime_repair_required: false,
            error: None,
            target_changelist: TARGET_CHANGELIST,
        },
        Err(e) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            runtime_repair_required: false,
            error: Some(e),
            target_changelist: TARGET_CHANGELIST,
        },
    }
}

fn read_install_status(app: AppHandle) -> InstallStatus {
    match paths::load_saved_exe_path(&app) {
        Some(exe_path) if exe_path.is_file() => build_status(&exe_path),
        _ => not_located(),
    }
}

#[tauri::command]
pub async fn get_install_status(app: AppHandle) -> Result<InstallStatus, String> {
    // Hashing the game executable can take seconds on a slow disk. Keep it off Tauri's UI thread.
    tauri::async_runtime::spawn_blocking(move || read_install_status(app))
        .await
        .map_err(|_| "The installation check stopped unexpectedly.".to_string())
}

#[tauri::command]
pub async fn pick_install_path(app: AppHandle) -> Result<InstallStatus, String> {
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
        return get_install_status(app).await;
    };

    let selected_folder = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = paths::find_game_executable(&selected_folder)?;

    paths::save_exe_path(&app, &canonical)?;

    tauri::async_runtime::spawn_blocking(move || build_status(&canonical))
        .await
        .map_err(|_| "The installation check stopped unexpectedly.".to_string())
}
