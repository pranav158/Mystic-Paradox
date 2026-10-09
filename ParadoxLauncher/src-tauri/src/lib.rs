mod auth;
mod commands;
mod install;
mod launch;
// rustfmt resolves `mod` files whatever their cfg, and the public tree has neither folder: format them with
// `rustfmt --edition 2021 --check src/p2p/mod.rs src/anticheat/mod.rs` instead.
#[cfg(mystic_anticheat)]
#[rustfmt::skip]
mod anticheat;
#[cfg(mystic_p2p)]
#[rustfmt::skip]
mod p2p;

use tauri::Manager;
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;

/// Every build's commands, plus any extra paths given (a P2P build adds its own).
macro_rules! launcher_commands {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            commands::auth::native_restore_session,
            commands::auth::native_get_server_status,
            commands::auth::native_login,
            commands::auth::native_register,
            commands::auth::native_discord_complete,
            commands::auth::native_start_discord_login,
            commands::auth::native_set_username,
            commands::auth::native_logout,
            commands::auth::native_forget_session,
            commands::auth::native_get_policy,
            commands::auth::native_refresh_account,
            commands::install::get_install_status,
            commands::install::pick_install_path,
            commands::launch::is_game_running,
            commands::launch::secure_launch,
            commands::updates::check_runtime_update,
            commands::updates::install_runtime_update,
            commands::logs::native_get_log_paths,
            commands::logs::native_open_log_folder,
            commands::logs::native_upload_last_session,
            commands::logs::native_recent_sessions,
            $($extra),*
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
        // Restore size, position and maximised state, but never decorations: the window is
        // frameless by design, and 0.1.44 and earlier saved `decorated: true`, which would bring the
        // native title bar back on top of the custom one.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                app.deep_link().register_all()?;
            }

            auth::deep_link::listen(app.handle().clone());
            auth::deep_link::check_startup_url(app.handle());
            // Silent first-pass signed runtime repair. It never blocks launcher startup; Play
            // performs the strict second repair/verification boundary.
            commands::updates::start_runtime_prefetch(app.handle().clone());
            // Guard heartbeats for the processes this launcher protects (observe-only).
            launch::guard_loop::start(app.handle().clone());
            // P2P builds only: host presence, the control channel and host/join sessions.
            #[cfg(mystic_p2p)]
            p2p::start(app.handle().clone());

            Ok(())
        });
    // A P2P build adds its own commands (p2p/mod.rs).
    #[cfg(mystic_p2p)]
    let builder = builder.invoke_handler(launcher_commands!(p2p::native_get_p2p_host_settings));
    #[cfg(not(mystic_p2p))]
    let builder = builder.invoke_handler(launcher_commands!());
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            launch::shutdown_all();
        }
    });
}
