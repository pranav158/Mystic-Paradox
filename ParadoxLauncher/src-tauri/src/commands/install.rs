use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::install::{paths, verify};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub located: bool,
    pub exe_path: Option<String>,
    pub exe_sha256: Option<String>,
    /// Set whenever something about a located installation is wrong (missing
    /// DLLs, unreadable exe, etc.) — `located` can be true with an error set,
    /// meaning "we found something at the saved path, but it's not usable."
    pub error: Option<String>,
}

fn not_located() -> InstallStatus {
    InstallStatus {
        located: false,
        exe_path: None,
        exe_sha256: None,
        error: None,
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
                error: Some(e),
            }
        }
    };

    if let Err(e) = verify::verify_runtime_dlls_present(&game_dir) {
        return InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            error: Some(e),
        };
    }

    match verify::hash_file_sha256(exe_path) {
        Ok(hash) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: Some(hash),
            error: None,
        },
        Err(e) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn get_install_status(app: AppHandle) -> InstallStatus {
    match paths::load_saved_exe_path(&app) {
        Some(exe_path) if exe_path.is_file() => build_status(&exe_path),
        _ => not_located(),
    }
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
        return Ok(get_install_status(app));
    };

    let selected_folder = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = paths::find_game_executable(&selected_folder)?;

    paths::save_exe_path(&app, &canonical)?;

    Ok(build_status(&canonical))
}
