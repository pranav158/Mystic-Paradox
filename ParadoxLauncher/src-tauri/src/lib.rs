mod auth;
mod commands;
mod install;
mod launch;
mod servers;
// rustfmt resolves `mod` files whatever their cfg, and the public tree has no P2P folder: format it with
// `rustfmt --edition 2021 --check src/p2p/mod.rs` instead.
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
            commands::auth::native_check_username,
            // [2026-10-15] The email code after sign-up or an unverified sign-in, password resets, and the official play switch.
            commands::auth::native_verify_email,
            commands::auth::native_resend_email_code,
            commands::auth::native_forgot_password,
            commands::auth::native_reset_password,
            commands::auth::native_official_play,
            // [2026-10-15] Link and unlink Discord on the Account page (the signed-in official account). Unlinking
            // takes two steps: the emailed code, then the confirmation.
            commands::auth::native_start_discord_link,
            commands::auth::native_start_discord_unlink,
            commands::auth::native_confirm_discord_unlink,
            // [2026-10-15] Launcher notices (banner and tags) from the official backend; anonymous, never an error on a 404.
            commands::notices::native_launcher_notices,
            // [2026-10-14] Terms of Use and Privacy Policy consent, and account deletion (official accounts only).
            commands::account::native_consent_status,
            commands::account::native_accept_consent,
            commands::account::native_deletion_status,
            commands::account::native_request_deletion,
            commands::account::native_cancel_deletion,
            commands::install::get_install_status,
            commands::install::pick_install_path,
            // [2026-10-15] About -> "Check against GitHub" (contacts GitHub only when asked).
            commands::provenance::check_public_builds,
            // [2026-10-15] The launcher's own update waits while a game runs or this PC hosts.
            commands::updates::launcher_update_hold_reason,
            commands::launch::is_game_running,
            commands::launch::secure_launch,
            commands::updates::check_runtime_update,
            // [2026-10-15] About -> Runtime: the installed DLL against the signed manifest (read-only).
            commands::updates::verify_installed_runtime,
            commands::updates::install_runtime_update,
            commands::logs::native_get_log_paths,
            commands::logs::native_open_log_folder,
            commands::logs::native_upload_last_session,
            commands::logs::native_recent_sessions,
            // [2026-10-13 realms S1] Multi-server list.
            commands::servers::list_servers,
            commands::servers::add_server,
            commands::servers::remove_server,
            commands::servers::select_server,
            commands::servers::acknowledge_local_server,
            commands::servers::set_server_game_exe,
            commands::servers::use_official_install,
            // [2026-10-14 realms] The host key of a Paradox realm: the directory lookup and the stored key.
            commands::servers::realm_lookup,
            commands::servers::set_realm_host_key,
            $($extra),*
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match app.get_webview_window(launch::MAIN_WINDOW) {
                Some(window) => {
                    let _ = window.set_focus();
                }
                // Windowless while a game runs (the window was lost): starting the launcher again brings it back.
                None => launch::restore_main_window(app),
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
    // [2026-10-14 realms] The realm host's commands join the P2P build's list (p2p/realm.rs).
    #[cfg(mystic_p2p)]
    let builder = builder.invoke_handler(launcher_commands!(
        p2p::native_get_p2p_host_settings,
        p2p::realm_host_status,
        p2p::realm_host_start,
        p2p::realm_host_stop,
        p2p::realm_host_kick,
        p2p::realm_host_ban,
        p2p::realm_host_unban,
        p2p::realm_host_set_limits,
    ));
    #[cfg(not(mystic_p2p))]
    let builder = builder.invoke_handler(launcher_commands!());
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } if label == launch::MAIN_WINDOW => launch::note_close_requested(),
        // A window that went away by itself (no explicit exit code) must not end a running game: the launcher
        // stays and rebuilds its window. The title-bar close is an explicit exit and still shuts everything down.
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if launch::on_exit_requested(app_handle, code) {
                api.prevent_exit();
            } else {
                launch::shutdown_all();
            }
        }
        tauri::RunEvent::Exit => launch::shutdown_all(),
        _ => {}
    });
}
