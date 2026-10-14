// [2026-10-13 realms S1] Server list commands. Every command returns the whole refreshed list (or an error the
// user can read), so the UI never merges partial state. The model and its rules are in `servers/model.rs`.
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use crate::auth::consent;
use crate::commands::auth::{api_base_url, forget_server};
use crate::install::paths;
use crate::servers::realm_directory::{self, RealmLookupView};
use crate::servers::{
    self, is_official_backend_address, normalize_backend_url, play_block_reason, FolderSource,
    NewServer, ServerEntry, ServerKind, ServerTarget, OFFICIAL_ID,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    pub entry: ServerEntry,
    /// The server Play, the updater and the install check work on.
    pub selected: bool,
    /// Everything but the built-in official server.
    pub removable: bool,
    /// The game executable exists on disk.
    pub located: bool,
    /// Our signed runtime feed serves this server (false: the realm's own files are used).
    pub uses_official_feed: bool,
    /// Why Play is off for this server whatever its folder holds (a local server's warning is not accepted yet).
    pub play_blocked_reason: Option<&'static str>,
    /// Why its saved folder cannot be used (for example it is the official install).
    pub folder_problem: Option<String>,
    /// Where the folder comes from: its own, the official install (a realm with no folder of its own), or none.
    pub folder_source: FolderSource,
    /// The game executable the server runs from (its own saved path, or the official install's), when it has one.
    pub folder: Option<String>,
    /// [2026-10-13 realms S5] The LOCAL SERVER WARNING is accepted for this launcher run, or remembered. Always true
    /// for a server that has no such warning. Nothing is sent to a local server before this.
    pub acknowledged: bool,
    /// "Don't show again" is saved for this server.
    pub warning_remembered: bool,
}

fn view_of(
    target: ServerTarget,
    selected_id: &str,
    acknowledged: bool,
    remembered: bool,
) -> ServerView {
    let located = target.exe_path.as_ref().is_some_and(|exe| exe.is_file());
    let kind = target.server.kind;
    let folder = match target.folder_source {
        FolderSource::Own => target.server.game_exe_path.clone(),
        FolderSource::Official => target
            .exe_path
            .as_ref()
            .map(|exe| exe.to_string_lossy().into_owned()),
        FolderSource::None => None,
    };
    ServerView {
        selected: target.server.id == selected_id,
        removable: kind != ServerKind::Official,
        located,
        uses_official_feed: target.uses_official_feed(),
        play_blocked_reason: play_block_reason(kind, acknowledged),
        folder_problem: target.folder_problem,
        folder_source: target.folder_source,
        folder,
        acknowledged: acknowledged || !kind.network_rules().warning_required,
        warning_remembered: remembered && kind.network_rules().warning_required,
        entry: target.server,
    }
}

fn views(app: &AppHandle) -> Vec<ServerView> {
    let (selected, targets) = servers::all_targets(app);
    targets
        .into_iter()
        .map(|target| {
            let (accepted, remembered) = if target.server.kind.network_rules().warning_required {
                (
                    consent::is_accepted(app, &target.server.id),
                    consent::is_remembered(app, &target.server.id),
                )
            } else {
                (true, false)
            };
            view_of(target, &selected, accepted, remembered)
        })
        .collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The server list task stopped unexpectedly.".to_string())?
}

/// Held while a change to the selected server or its folder is written (`None`: the change does not touch the
/// selected server). Bind it to a name, not `_`, so it lives to the end of the write.
pub(crate) type ChangeFence = Option<tokio::sync::OwnedMutexGuard<()>>;

/// The selected server and the folder it runs from must not change under a running game or a Play that is being
/// prepared: Guard, the updater and the exit monitor all follow the selection. Taking the launch lock keeps Play
/// out for as long as the fence is held, and its resolution of the server cannot interleave with the write.
fn fence_selection() -> Result<ChangeFence, String> {
    let guard = super::launch::try_hold_launch_lock()
        .ok_or_else(|| "A launch is being prepared. Please wait a moment.".to_string())?;
    // After the lock: a Play that just finished its spawn has registered its process by now.
    if crate::launch::protected_process_running() {
        return Err("Close Dauntless before changing servers or install folders.".to_string());
    }
    Ok(Some(guard))
}

/// A fence for a change to `id`'s folder or existence: needed only while that server is the one in use.
pub(crate) fn fence_server_change(app: &AppHandle, id: &str) -> Result<ChangeFence, String> {
    let list = servers::store::load(app);
    let selected = list.effective_selected_id();
    // A Paradox realm with no folder of its own runs from the official install, so changing that install changes the
    // folder of the selected realm too.
    let selected_runs_official = list
        .find(selected)
        .is_some_and(|entry| entry.uses_official_install());
    if selected == id || (id == OFFICIAL_ID && selected_runs_official) {
        fence_selection()
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn list_servers(app: AppHandle) -> Result<Vec<ServerView>, String> {
    blocking(move || Ok(views(&app))).await
}

#[tauri::command]
pub async fn add_server(app: AppHandle, server: NewServer) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        if server.kind == Some(ServerKind::Local) {
            // The official backend is the built-in server, not a "local" one.
            if let Ok(candidate) =
                normalize_backend_url(server.backend_url.as_deref().unwrap_or(""))
            {
                if is_official_backend_address(&candidate, api_base_url()) {
                    return Err(
                        "That is the official Mystic Paradox address. Use the built-in official server instead."
                            .to_string(),
                    );
                }
            }
        }
        servers::store::update(&app, |list, _| {
            let id = servers::new_server_id(list);
            list.add(server, id).map(|_| ())
        })?;
        Ok(views(&app))
    })
    .await
}

#[tauri::command]
pub async fn remove_server(app: AppHandle, server_id: String) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        if server_id == OFFICIAL_ID {
            return Err("The official server is built in and cannot be removed.".to_string());
        }
        let _fence = fence_server_change(&app, &server_id)?;
        // The server's files on disk are never touched: only the list entry goes, with the session this launcher
        // saved for it and the choices made in its warning.
        let removed = servers::store::update(&app, |list, _| list.remove(&server_id))?;
        forget_server(&app, &removed);
        // [2026-10-14 realms] The host limits saved for this server go with it (the realm host is a P2P build feature).
        #[cfg(mystic_p2p)]
        crate::p2p::forget_realm_host_limits(&app, &removed.id);
        Ok(views(&app))
    })
    .await
}

/// The player's "I agree" in the LOCAL SERVER WARNING of a local server. `remember` is the "Don't show again" box:
/// ticked, it is saved for this server; clear, it only lasts for this launcher run. Nothing is sent to a local server
/// before this.
#[tauri::command]
pub async fn acknowledge_local_server(
    app: AppHandle,
    server_id: String,
    remember: bool,
) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        let list = servers::store::load(&app);
        let entry = list
            .find(&server_id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        if !entry.kind.network_rules().warning_required {
            return Err("Only a local server has this warning.".to_string());
        }
        consent::accept(&app, &server_id, remember)?;
        Ok(views(&app))
    })
    .await
}

#[tauri::command]
pub async fn select_server(app: AppHandle, server_id: String) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        let _fence = fence_selection()?;
        servers::store::update(&app, |list, _| list.select(&server_id))?;
        Ok(views(&app))
    })
    .await
}

/// Sets a server's install folder. `path` is the game executable or the folder that holds it (the same forms the
/// folder picker accepts); it must be `Dauntless-Win64-Shipping.exe`. A local server's folder must not overlap another
/// server's, least of all the official one; a Paradox realm may take the official install or a folder of its own.
#[tauri::command]
pub async fn set_server_game_exe(
    app: AppHandle,
    server_id: String,
    path: String,
) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        let _fence = fence_server_change(&app, &server_id)?;
        let exe = paths::resolve_game_exe_input(Path::new(path.trim()))?;
        servers::set_game_exe(&app, &server_id, &exe)?;
        Ok(views(&app))
    })
    .await
}

/// [2026-10-14 realms] Drops a Paradox realm's own folder, so it runs from the official install again. Nothing on disk is
/// touched; a local server keeps its own folder. Resolves with the refreshed list.
#[tauri::command]
pub async fn use_official_install(
    app: AppHandle,
    server_id: String,
) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        let _fence = fence_server_change(&app, &server_id)?;
        servers::store::update(&app, |list, _| list.clear_game_exe(&server_id))?;
        Ok(views(&app))
    })
    .await
}

/// [2026-10-14 realms] What the realm directory says about a Paradox realm's host: its key, its display name and whether the
/// name now belongs to a different key than the one stored (`ownershipChanged`, answered only when a key is stored). Needs the
/// official sign-in; without it the call refuses with the usual message and the realm keeps no key until its first Play.
#[tauri::command]
pub async fn realm_lookup(app: AppHandle, server_id: String) -> Result<RealmLookupView, String> {
    blocking(move || {
        let list = servers::store::load(&app);
        let entry = list
            .find(&server_id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        if entry.kind != ServerKind::ParadoxRealm {
            return Err("Only a Paradox realm has a host to confirm.".to_string());
        }
        let realm = entry
            .realm_name
            .as_deref()
            .ok_or_else(|| "That realm has no name to look up.".to_string())?;
        realm_directory::lookup(&app, realm, entry.host_public_key.as_deref())
    })
    .await
}

/// [2026-10-14 realms] Stores the host key the player agreed to for a Paradox realm (the key the lookup showed; validated).
/// Resolves with the refreshed list.
#[tauri::command]
pub async fn set_realm_host_key(
    app: AppHandle,
    server_id: String,
    host_public_key: String,
) -> Result<Vec<ServerView>, String> {
    blocking(move || {
        servers::store::update(&app, |list, _| {
            list.set_host_key(&server_id, &host_public_key)
        })?;
        Ok(views(&app))
    })
    .await
}
