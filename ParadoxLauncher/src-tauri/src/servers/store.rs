// [2026-10-13 realms S1] Persistence of the server list and resolution of "the server the launcher works on now".
//
// `servers.json` lives in the app config dir next to `install.json` and is written like `p2p-host-settings.json`
// (temporary file, then rename). It holds only the non-official servers and the selected id; the official server is
// built in and keeps its install path in `install.json`, exactly as before the list existed.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use super::model::{
    may_share_install, official_entry, FolderSource, ServerEntry, ServerKind, ServerList,
    OFFICIAL_ID,
};
use crate::install::paths;

const SERVERS_FILE: &str = "servers.json";
const SERVERS_FILE_VERSION: u32 = 1;

/// Serialises every read-modify-write of the file (commands run on several threads).
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredServers {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    selected_id: Option<String>,
    #[serde(default)]
    servers: Vec<ServerEntry>,
}

pub struct Loaded {
    pub list: ServerList,
    /// The file exists but is not valid JSON. It is moved aside (`servers.json.bad`) before the next write instead
    /// of being silently replaced.
    pub damaged: bool,
}

/// Reads the list from `dir`. A missing file is an empty list; unreadable (not merely absent) is an error, so a
/// transient failure never lets a later write replace a good file.
pub fn read_list(dir: &Path) -> Result<Loaded, String> {
    let path = dir.join(SERVERS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                list: ServerList::default(),
                damaged: false,
            });
        }
        Err(_) => return Err("Couldn't read the launcher's server list.".to_string()),
    };
    match serde_json::from_str::<StoredServers>(&text) {
        Ok(stored) => Ok(Loaded {
            list: ServerList::sanitized(stored.selected_id, stored.servers),
            damaged: false,
        }),
        Err(_) => Ok(Loaded {
            list: ServerList::default(),
            damaged: true,
        }),
    }
}

/// Writes the list: temporary file, then rename over the old one.
pub fn write_list(dir: &Path, list: &ServerList) -> Result<(), String> {
    let path = dir.join(SERVERS_FILE);
    let temporary = path.with_extension("json.tmp");
    let stored = StoredServers {
        version: SERVERS_FILE_VERSION,
        selected_id: Some(list.selected_id.clone()),
        servers: list.servers.clone(),
    };
    let contents = serde_json::to_vec_pretty(&stored)
        .map_err(|_| "Couldn't encode the launcher's server list.".to_string())?;
    std::fs::write(&temporary, contents)
        .map_err(|_| "Couldn't save the launcher's server list.".to_string())?;
    std::fs::rename(&temporary, &path)
        .map_err(|_| "Couldn't commit the launcher's server list.".to_string())
}

/// Read, change, write, all under the store lock. Returns what `change` returns.
pub fn update_in<R>(
    dir: &Path,
    official_exe: Option<PathBuf>,
    change: impl FnOnce(&mut ServerList, Option<&Path>) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let loaded = read_list(dir)?;
    let before = loaded.list.clone();
    let mut list = loaded.list;
    let result = change(&mut list, official_exe.as_deref())?;
    // A change that left the list as it was (the official server's folder is saved in `install.json`, not here) writes
    // nothing: a launcher that never uses the list never gets a `servers.json`, and a damaged file is set aside only
    // when there is something to write in its place.
    if list == before {
        return Ok(result);
    }
    if loaded.damaged {
        // Keep the damaged file for inspection; a failure to move it must not lose it, so stop here.
        let path = dir.join(SERVERS_FILE);
        let backup = path.with_extension("json.bad");
        std::fs::rename(&path, &backup).map_err(|_| {
            "The launcher's server list is damaged and couldn't be set aside.".to_string()
        })?;
    }
    write_list(dir, &list)?;
    Ok(result)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    paths::config_dir(app)
}

/// The current list (official-only when the file is missing, damaged or unreadable).
pub fn load(app: &AppHandle) -> ServerList {
    config_dir(app)
        .ok()
        .and_then(|dir| read_list(&dir).ok())
        .map(|loaded| loaded.list)
        .unwrap_or_default()
}

pub fn update<R>(
    app: &AppHandle,
    change: impl FnOnce(&mut ServerList, Option<&Path>) -> Result<R, String>,
) -> Result<R, String> {
    let dir = config_dir(app)?;
    update_in(&dir, paths::load_official_exe_path(app), change)
}

/// Stores a server's game executable (already validated and canonical). The official server's goes to
/// `install.json` as always; every other server's goes to the list. Either way the folder must not overlap another
/// server's.
pub fn set_game_exe(app: &AppHandle, id: &str, exe: &Path) -> Result<(), String> {
    update(app, |list, official_exe| {
        if id == OFFICIAL_ID {
            list.check_folder_available(id, exe, official_exe)?;
            paths::save_exe_path(app, exe)
        } else {
            list.set_game_exe(id, exe, official_exe)
        }
    })
}

/// A fresh id that no entry uses: `s-` plus 12 hex digits. Not secret and not cryptographic; sha2 is already a
/// dependency, so no `uuid`/`rand` crate is pulled in for this (same approach as the launch session ids).
pub fn new_server_id(list: &ServerList) -> String {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    loop {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let digest = Sha256::digest(format!("{nanos}-{}-{count}", std::process::id()).as_bytes());
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        let id = format!("s-{hex}");
        if list.find(&id).is_none() {
            return id;
        }
    }
}

// ---- the server the launcher works on ------------------------------------------------------------------------

/// A server resolved to what Play, the updater, Guard and the install check need: its entry, and its game
/// executable when it has a usable one.
#[derive(Clone, Debug)]
pub struct ServerTarget {
    pub server: ServerEntry,
    /// The game executable, or `None` when none is set or `folder_problem` refuses it.
    pub exe_path: Option<PathBuf>,
    /// Why a saved folder cannot be used (for example it is the official install).
    pub folder_problem: Option<String>,
    /// Where the folder comes from: the server's own, the official install (a realm with no folder of its own), or none.
    pub folder_source: FolderSource,
}

impl ServerTarget {
    pub fn kind(&self) -> ServerKind {
        self.server.kind
    }

    /// Whether our signed runtime feed serves this server (and may write into its folder).
    pub fn uses_official_feed(&self) -> bool {
        self.server.kind.uses_official_feed()
    }

    /// The address the game must use instead of the built-in one: only a local server has one.
    pub fn backend_url(&self) -> Option<&str> {
        match self.server.kind {
            ServerKind::Local => self.server.backend_url.as_deref(),
            _ => None,
        }
    }

    /// The folder our feed writes into: this server's game folder.
    pub fn install_dir(&self) -> Result<PathBuf, String> {
        if let Some(problem) = &self.folder_problem {
            return Err(problem.clone());
        }
        let exe = self
            .exe_path
            .clone()
            .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
        if !exe.is_file() {
            return Err("Your Dauntless installation is missing.".to_string());
        }
        paths::game_dir(&exe)
    }
}

/// Resolves `id` (the selected server when `None`) against `list`. `canonical` maps a stored path to its canonical
/// form: production re-resolves links on every call (a junction made later into the official folder is caught),
/// tests pass the identity.
pub fn resolve_target(
    list: &ServerList,
    official_exe: Option<PathBuf>,
    id: Option<&str>,
    canonical: impl Fn(&Path) -> PathBuf,
) -> Result<ServerTarget, String> {
    let id = id.unwrap_or_else(|| list.effective_selected_id());
    if id == OFFICIAL_ID {
        return Ok(ServerTarget {
            server: official_entry(
                official_exe
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
            ),
            exe_path: official_exe,
            folder_problem: None,
            folder_source: FolderSource::Own,
        });
    }
    let entry = list
        .find(id)
        .ok_or_else(|| "That server is not in your list.".to_string())?
        .clone();
    // A Paradox realm with no folder of its own runs from the official install: the same game build and our feed.
    if entry.uses_official_install() {
        return Ok(ServerTarget {
            server: entry,
            exe_path: official_exe,
            folder_problem: None,
            folder_source: FolderSource::Official,
        });
    }
    let stored = entry.game_exe_path.as_deref().map(PathBuf::from);
    let folder_source = if stored.is_some() {
        FolderSource::Own
    } else {
        FolderSource::None
    };
    let shares_official = may_share_install(entry.kind, ServerKind::Official);
    let (exe_path, folder_problem) = match stored {
        None => (None, None),
        Some(path) => {
            let named_right = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(paths::GAME_EXE_NAME));
            let exe = canonical(&path);
            if !named_right {
                (
                    None,
                    Some(format!(
                        "The saved game file for this server is not {}. Choose its folder again.",
                        paths::GAME_EXE_NAME
                    )),
                )
            } else if !shares_official
                && official_exe.as_deref().is_some_and(|official| {
                    super::model::installs_overlap(&exe, &canonical(official))
                })
            {
                (
                    None,
                    Some(
                        "This server's folder is the official Dauntless folder. Choose its own separate folder."
                            .to_string(),
                    ),
                )
            } else {
                (Some(exe), None)
            }
        }
    };
    Ok(ServerTarget {
        server: entry,
        exe_path,
        folder_problem,
        folder_source,
    })
}

fn canonicalize_best_effort(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The server the launcher works on now, with its game executable. Falls back to the official server when the list
/// cannot be read. Cheap enough for periodic callers.
pub fn active_target(app: &AppHandle) -> ServerTarget {
    target_for(app, None).unwrap_or_else(|_| {
        // `None` always resolves; this is only the type-level fallback.
        ServerTarget {
            server: official_entry(None),
            exe_path: paths::load_official_exe_path(app),
            folder_problem: None,
            folder_source: FolderSource::Own,
        }
    })
}

/// A specific server (`None` = the selected one), or an error for an unknown id.
pub fn target_for(app: &AppHandle, id: Option<&str>) -> Result<ServerTarget, String> {
    resolve_target(
        &load(app),
        paths::load_official_exe_path(app),
        id,
        canonicalize_best_effort,
    )
}

/// Every server in display order (the official one first), each resolved like `target_for`, and the selected id.
pub fn all_targets(app: &AppHandle) -> (String, Vec<ServerTarget>) {
    let list = load(app);
    let official_exe = paths::load_official_exe_path(app);
    let selected = list.effective_selected_id().to_string();
    let ids = std::iter::once(OFFICIAL_ID.to_string())
        .chain(list.servers.iter().map(|entry| entry.id.clone()));
    let targets = ids
        .filter_map(|id| {
            resolve_target(
                &list,
                official_exe.clone(),
                Some(&id),
                canonicalize_best_effort,
            )
            .ok()
        })
        .collect();
    (selected, targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::model::NewServer;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-servers-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn exe(root: &str) -> PathBuf {
        PathBuf::from(format!(
            "{root}\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe"
        ))
    }

    fn identity(path: &Path) -> PathBuf {
        path.to_path_buf()
    }

    fn sample_list() -> ServerList {
        let mut list = ServerList::default();
        list.add(
            NewServer {
                kind: Some(ServerKind::Local),
                name: Some("My PC".into()),
                backend_url: Some("https://realm.example.com:8443".into()),
                realm_name: None,
            },
            "s-aaaaaaaaaaaa".into(),
        )
        .unwrap();
        list.add(
            NewServer {
                kind: Some(ServerKind::ParadoxRealm),
                name: Some("Embers".into()),
                backend_url: None,
                realm_name: Some("ember-hold".into()),
            },
            "s-bbbbbbbbbbbb".into(),
        )
        .unwrap();
        list
    }

    #[test]
    fn the_list_round_trips_through_the_file() {
        let dir = scratch("roundtrip");
        // No file: official only.
        let loaded = read_list(&dir).unwrap();
        assert!(!loaded.damaged);
        assert_eq!(loaded.list, ServerList::default());

        let mut list = sample_list();
        list.set_game_exe("s-aaaaaaaaaaaa", &exe("D:\\Games\\Local One"), None)
            .unwrap();
        list.select("s-bbbbbbbbbbbb").unwrap();
        write_list(&dir, &list).unwrap();
        assert!(
            !dir.join("servers.json.tmp").exists(),
            "temp file is renamed away"
        );

        let loaded = read_list(&dir).unwrap();
        assert!(!loaded.damaged);
        assert_eq!(loaded.list, list);
        let text = fs::read_to_string(dir.join("servers.json")).unwrap();
        assert!(
            text.contains("\"selectedId\": \"s-bbbbbbbbbbbb\""),
            "{text}"
        );
        assert!(text.contains("\"kind\": \"paradox_realm\""), "{text}");
        assert!(
            text.contains("\"backendUrl\": \"https://realm.example.com:8443\""),
            "{text}"
        );
        assert!(text.contains("\"realmName\": \"ember-hold\""), "{text}");
        // The official server is never written.
        assert!(!text.contains("official"), "{text}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_file_is_set_aside_not_overwritten() {
        let dir = scratch("damaged");
        fs::write(dir.join("servers.json"), b"{ not json").unwrap();
        let loaded = read_list(&dir).unwrap();
        assert!(loaded.damaged);
        assert_eq!(loaded.list, ServerList::default());

        let added = update_in(&dir, None, |list, _| {
            list.add(
                NewServer {
                    kind: Some(ServerKind::ParadoxRealm),
                    name: None,
                    backend_url: None,
                    realm_name: Some("fresh-realm".into()),
                },
                "s-cccccccccccc".into(),
            )
        })
        .unwrap();
        assert_eq!(added.name, "fresh-realm");
        assert_eq!(
            fs::read_to_string(dir.join("servers.json.bad")).unwrap(),
            "{ not json"
        );
        assert_eq!(read_list(&dir).unwrap().list.servers.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_change_that_changes_nothing_writes_nothing() {
        let dir = scratch("unchanged");
        // The official server's folder goes through the same entry point but lives in install.json.
        update_in(&dir, None, |_, _| Ok(())).unwrap();
        assert!(!dir.join("servers.json").exists());
        update_in(&dir, None, |list, _| list.select(OFFICIAL_ID)).unwrap();
        assert!(!dir.join("servers.json").exists());
        // A damaged file that nothing changed is left exactly where it is.
        fs::write(dir.join("servers.json"), b"{ not json").unwrap();
        update_in(&dir, None, |_, _| Ok(())).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("servers.json")).unwrap(),
            "{ not json"
        );
        assert!(!dir.join("servers.json.bad").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_change_writes_nothing() {
        let dir = scratch("failed");
        let list = sample_list();
        write_list(&dir, &list).unwrap();
        let before = fs::read_to_string(dir.join("servers.json")).unwrap();
        let result: Result<(), String> =
            update_in(&dir, None, |list, _| list.remove("official").map(|_| ()));
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(dir.join("servers.json")).unwrap(),
            before
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hand_edited_files_cannot_smuggle_in_an_unchecked_entry() {
        let dir = scratch("handedit");
        fs::write(
            dir.join("servers.json"),
            r#"{
              "version": 1,
              "selectedId": "s-evil",
              "servers": [
                {"id": "s-evil", "kind": "local", "name": "Evil", "backendUrl": "http://evil.example.com"},
                {"id": "s-ok", "kind": "local", "name": "Fine", "backendUrl": "https://fine.example.com"}
              ]
            }"#,
        )
        .unwrap();
        let loaded = read_list(&dir).unwrap();
        assert_eq!(loaded.list.servers.len(), 1);
        assert_eq!(loaded.list.servers[0].id, "s-ok");
        // The selected server did not survive, so the official one is selected.
        assert_eq!(loaded.list.selected_id, OFFICIAL_ID);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn new_ids_are_unused_and_well_formed() {
        let mut list = ServerList::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..30 {
            let id = new_server_id(&list);
            assert!(id.starts_with("s-") && id.len() == 14, "{id}");
            assert!(seen.insert(id.clone()), "duplicate {id}");
            list.add(
                NewServer {
                    kind: Some(ServerKind::ParadoxRealm),
                    name: Some(format!("realm {id}")),
                    backend_url: None,
                    realm_name: Some(format!("r-{}", &id[2..])),
                },
                id,
            )
            .unwrap();
        }
    }

    #[test]
    fn the_official_server_resolves_to_its_saved_path_unchanged() {
        let official = exe("D:\\Games\\Dauntless");
        let list = sample_list();
        let target = resolve_target(&list, Some(official.clone()), None, identity).unwrap();
        assert_eq!(target.kind(), ServerKind::Official);
        assert_eq!(target.exe_path, Some(official.clone()));
        assert!(target.folder_problem.is_none());
        assert!(target.uses_official_feed());
        assert!(target.backend_url().is_none());
        // Not located: still the official server, with no path (callers say "Locate your installation").
        let target = resolve_target(&list, None, Some(OFFICIAL_ID), identity).unwrap();
        assert_eq!(target.exe_path, None);
        assert!(target.install_dir().is_err());
    }

    #[test]
    fn each_kind_resolves_its_own_folder_environment_and_feed() {
        let official = exe("D:\\Games\\Dauntless");
        let mut list = sample_list();
        let local_exe = exe("D:\\Games\\Local One");
        let realm_exe = exe("D:\\Games\\Realm One");
        list.set_game_exe("s-aaaaaaaaaaaa", &local_exe, Some(&official))
            .unwrap();
        list.set_game_exe("s-bbbbbbbbbbbb", &realm_exe, Some(&official))
            .unwrap();

        let local = resolve_target(
            &list,
            Some(official.clone()),
            Some("s-aaaaaaaaaaaa"),
            identity,
        )
        .unwrap();
        assert_eq!(local.kind(), ServerKind::Local);
        assert_eq!(local.exe_path, Some(local_exe));
        assert!(
            !local.uses_official_feed(),
            "our feed never writes into a local folder"
        );
        assert_eq!(local.backend_url(), Some("https://realm.example.com:8443"));

        let realm = resolve_target(
            &list,
            Some(official.clone()),
            Some("s-bbbbbbbbbbbb"),
            identity,
        )
        .unwrap();
        assert_eq!(realm.kind(), ServerKind::ParadoxRealm);
        assert_eq!(realm.exe_path, Some(realm_exe));
        assert_eq!(realm.folder_source, FolderSource::Own);
        assert!(realm.uses_official_feed());
        assert!(
            realm.backend_url().is_none(),
            "a realm uses the built-in backend"
        );

        // The selected server is what `None` resolves to.
        list.select("s-bbbbbbbbbbbb").unwrap();
        let active = resolve_target(&list, Some(official), None, identity).unwrap();
        assert_eq!(active.server.id, "s-bbbbbbbbbbbb");
        assert!(resolve_target(&list, None, Some("nope"), identity).is_err());
    }

    #[test]
    fn a_local_folder_that_became_the_official_one_is_refused_at_use() {
        // The folder was fine when saved; the official install later moved onto it (or a link now points there).
        let mut list = sample_list();
        let local_exe = exe("D:\\Games\\Local One");
        list.set_game_exe("s-aaaaaaaaaaaa", &local_exe, None)
            .unwrap();
        let target = resolve_target(
            &list,
            Some(local_exe.clone()),
            Some("s-aaaaaaaaaaaa"),
            identity,
        )
        .unwrap();
        assert_eq!(target.exe_path, None);
        assert!(target
            .folder_problem
            .as_deref()
            .unwrap()
            .contains("official"));
        assert!(target.install_dir().is_err());

        // A link resolved by the canonicalizer is caught the same way.
        let official = exe("D:\\Games\\Dauntless");
        let junction = |path: &Path| {
            if path == local_exe {
                official.clone()
            } else {
                path.to_path_buf()
            }
        };
        let target = resolve_target(
            &list,
            Some(official.clone()),
            Some("s-aaaaaaaaaaaa"),
            junction,
        )
        .unwrap();
        assert_eq!(target.exe_path, None);
        assert!(target.folder_problem.is_some());
    }

    #[test]
    fn a_realm_may_keep_a_folder_that_is_the_official_install() {
        // A realm shares the official install (the same build and our feed), so the official folder is no problem for it.
        let official = exe("D:\\Games\\Dauntless");
        let mut list = sample_list();
        list.set_game_exe("s-bbbbbbbbbbbb", &official, None)
            .unwrap();
        let target = resolve_target(
            &list,
            Some(official.clone()),
            Some("s-bbbbbbbbbbbb"),
            identity,
        )
        .unwrap();
        assert_eq!(target.exe_path, Some(official));
        assert_eq!(target.folder_source, FolderSource::Own);
        assert!(target.folder_problem.is_none());
    }

    #[test]
    fn a_saved_file_that_is_not_the_game_executable_is_refused_at_use() {
        let mut list = sample_list();
        // Only a hand-edited file can get here: the set path is always the validated executable.
        list.servers[0].game_exe_path = Some("D:\\Tools\\other.exe".into());
        let target = resolve_target(&list, None, Some("s-aaaaaaaaaaaa"), identity).unwrap();
        assert_eq!(target.exe_path, None);
        assert!(target.folder_problem.is_some());
    }

    #[test]
    fn a_realm_without_a_folder_runs_from_the_official_install() {
        let official = exe("D:\\Games\\Dauntless");
        let list = sample_list();
        let target = resolve_target(
            &list,
            Some(official.clone()),
            Some("s-bbbbbbbbbbbb"),
            identity,
        )
        .unwrap();
        assert_eq!(target.kind(), ServerKind::ParadoxRealm);
        assert_eq!(target.exe_path, Some(official.clone()));
        assert_eq!(target.folder_source, FolderSource::Official);
        assert!(target.folder_problem.is_none());
        assert!(target.uses_official_feed());
        // Selected, the realm is what the launcher works on, from the official install's folder.
        let mut selected = sample_list();
        selected.select("s-bbbbbbbbbbbb").unwrap();
        let active = resolve_target(&selected, Some(official.clone()), None, identity).unwrap();
        assert_eq!(active.exe_path, Some(official));
        // The official install not located yet: the realm is not located either.
        let target = resolve_target(&list, None, Some("s-bbbbbbbbbbbb"), identity).unwrap();
        assert_eq!(target.exe_path, None);
        assert_eq!(target.folder_source, FolderSource::Official);
        assert_eq!(
            target.install_dir().unwrap_err(),
            "Locate your Dauntless installation first."
        );
    }

    #[test]
    fn a_local_server_without_a_folder_is_not_located_and_never_uses_the_official_one() {
        let list = sample_list();
        let target = resolve_target(
            &list,
            Some(exe("D:\\Games\\Dauntless")),
            Some("s-aaaaaaaaaaaa"),
            identity,
        )
        .unwrap();
        assert_eq!(target.exe_path, None);
        assert_eq!(target.folder_source, FolderSource::None);
        assert!(target.folder_problem.is_none());
        assert_eq!(
            target.install_dir().unwrap_err(),
            "Locate your Dauntless installation first."
        );
    }
}
