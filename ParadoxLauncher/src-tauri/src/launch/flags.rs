use std::collections::HashSet;
use std::path::Path;

// Mirrors ParadoxBackend/src/security/testerFeatures.ts (TESTER_MANAGED_FEATURES) by hand —
// keep the two in sync. This is the only place the launcher maps a server-sent logical
// feature id to an exe-relative .flag filename; the server never sends a filename or path
// directly (see that file's header comment: local .flag files are not a security control,
// just a diagnostics convenience the runtime DLL checks via MpExeRelativeFlagPresent).
//
// Deliberately just one entry — see testerFeatures.ts's header comment: an earlier version
// of this table included NATIVE_NET_TICK.flag by copying names out of a source grep without
// checking what they do, and that flag is a documented "makes the server unjoinable" dead
// end (Progress/02_NETWORK_REPLICATION.md). Trim, don't add to, until each addition has been
// checked against that history.
const MANAGED_FEATURES: &[(&str, &str)] = &[("diagnostics.verbose", "VERBOSE_DIAG.flag")];

const OWNERSHIP_MARKER_FILE: &str = ".mysticparadox-managed-flags.json";

/// Filenames (from MANAGED_FEATURES) this launcher itself has created and is therefore
/// allowed to remove. Loading/saving is best-effort: a missing or corrupt marker is treated
/// as "the launcher owns nothing here", which is the safe direction to fail in — it only
/// means reconcile() won't delete something on this run, never that it deletes something it
/// shouldn't.
fn load_owned(game_dir: &Path) -> HashSet<String> {
    std::fs::read_to_string(game_dir.join(OWNERSHIP_MARKER_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .map(|names| names.into_iter().collect())
        .unwrap_or_default()
}

fn save_owned(game_dir: &Path, owned: &HashSet<String>) {
    let mut names: Vec<&String> = owned.iter().collect();
    names.sort();
    if let Ok(json) = serde_json::to_string(&names) {
        let _ = std::fs::write(game_dir.join(OWNERSHIP_MARKER_FILE), json);
    }
}

/// Enforces exact state for every filename this table knows about: created if its id is in
/// `managed_feature_ids`, removed otherwise — but a flag is only ever DELETED if this
/// launcher created it (tracked in `.mysticparadox-managed-flags.json`, next to the flags
/// themselves). A flag that already existed before the launcher touched it (created by hand
/// for local testing, or left over from before this feature existed) is left alone in both
/// directions: creating it isn't needed (it's already present) and this launcher never claims
/// ownership of a file it didn't create, so a later revoke won't delete it either. Flags
/// outside this table are never touched at all. Idempotent — safe to call on every policy
/// refresh (login, session restore, and immediately before Play, since the runtime caches
/// several of these for the process lifetime).
pub fn reconcile(game_dir: &Path, managed_feature_ids: &[String]) -> Result<(), String> {
    let active: HashSet<&str> = managed_feature_ids.iter().map(String::as_str).collect();
    let mut owned = load_owned(game_dir);
    let mut changed = false;

    for (id, filename) in MANAGED_FEATURES {
        let path = game_dir.join(filename);
        if active.contains(id) {
            if !path.exists() {
                std::fs::write(&path, b"")
                    .map_err(|e| format!("Couldn't enable {filename}: {e}"))?;
                owned.insert(filename.to_string());
                changed = true;
            }
        } else if owned.remove(*filename) {
            changed = true;
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("Couldn't disable {filename}: {e}"))?;
            }
        }
    }

    if changed {
        save_owned(game_dir, &owned);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mystpax-flags-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_active_flags_and_removes_ones_it_created() {
        let dir = temp_dir("basic");

        reconcile(&dir, &["diagnostics.verbose".to_string()]).unwrap();
        assert!(dir.join("VERBOSE_DIAG.flag").exists());

        reconcile(&dir, &[]).unwrap();
        assert!(!dir.join("VERBOSE_DIAG.flag").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_deletes_a_flag_it_did_not_create() {
        let dir = temp_dir("hand-created");

        // A tester creates the same flag file by hand, BEFORE ever being granted the
        // matching feature — the launcher must never claim or delete this.
        fs::write(dir.join("VERBOSE_DIAG.flag"), b"").unwrap();

        // Policy grants the feature — file already exists, launcher does nothing, and must
        // NOT record ownership of it.
        reconcile(&dir, &["diagnostics.verbose".to_string()]).unwrap();
        assert!(dir.join("VERBOSE_DIAG.flag").exists());

        // Policy revokes the feature — since the launcher never created this file, it must
        // survive.
        reconcile(&dir, &[]).unwrap();
        assert!(
            dir.join("VERBOSE_DIAG.flag").exists(),
            "hand-created flag was deleted"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_unmanaged_flags_untouched() {
        let dir = temp_dir("unmanaged");
        fs::write(dir.join("CUSTOM_UNMANAGED.flag"), b"").unwrap();

        reconcile(&dir, &["diagnostics.verbose".to_string()]).unwrap();
        reconcile(&dir, &[]).unwrap();
        assert!(dir.join("CUSTOM_UNMANAGED.flag").exists());

        fs::remove_dir_all(&dir).unwrap();
    }
}
