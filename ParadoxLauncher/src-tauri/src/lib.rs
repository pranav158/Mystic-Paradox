mod auth;
mod commands;
mod install;
mod launch;

use tauri::Manager;
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            // Windows/Linux: a second protocol invocation while we're already
            // running spawns a new process whose argv carries the URL instead
            // of firing `on_open_url` again — forward it through by hand.
            for arg in argv.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    auth::deep_link::handle_url(app, &url);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                app.deep_link().register_all()?;
            }

            auth::deep_link::listen(app.handle().clone());
            auth::deep_link::check_startup_url(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth::native_restore_session,
            commands::auth::native_login,
            commands::auth::native_register,
            commands::auth::native_discord_complete,
            commands::auth::native_start_discord_login,
            commands::auth::native_set_username,
            commands::auth::native_logout,
            commands::auth::native_forget_session,
            commands::auth::native_get_policy,
            commands::install::get_install_status,
            commands::install::pick_install_path,
            commands::launch::is_game_running,
            commands::launch::secure_launch,
            commands::updates::check_runtime_update,
            commands::updates::install_runtime_update,
            commands::logs::native_get_log_paths,
            commands::logs::native_open_log_folder,
            commands::logs::native_upload_last_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
