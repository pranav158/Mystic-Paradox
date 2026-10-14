use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CONFIG_FILE_NAME: &str = "install.json";
pub const GAME_EXE_NAME: &str = "Dauntless-Win64-Shipping.exe";

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct InstallConfig {
    game_exe_path: Option<String>,
}

/// The launcher's config folder (created on demand): `install.json`, `servers.json`, the P2P settings.
pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(CONFIG_FILE_NAME))
}

/// The OFFICIAL server's saved game executable (`install.json`). This is the only place the official install path
/// is stored, exactly as before the server list existed.
pub fn load_official_exe_path(app: &AppHandle) -> Option<PathBuf> {
    let path = config_path(app).ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    let config: InstallConfig = serde_json::from_str(&contents).ok()?;
    config.game_exe_path.map(PathBuf::from)
}

/// The game executable of the server the launcher is working on (Play, the runtime updater, Guard, the install
/// check). [2026-10-13 realms S1] With the official server selected this is `install.json`'s path, byte for byte
/// the old behaviour. [2026-10-14] A Paradox realm with no folder of its own gets the official install's path (the same
/// build and our feed); a realm with its own folder, and a local server, get that folder. A local folder that is (or
/// overlaps) the official install is never returned.
pub fn load_saved_exe_path(app: &AppHandle) -> Option<PathBuf> {
    crate::servers::active_target(app).exe_path
}

/// Saves the OFFICIAL server's game executable. Other servers' paths go through `servers::set_game_exe`.
pub fn save_exe_path(app: &AppHandle, exe_path: &Path) -> Result<(), String> {
    let path = config_path(app)?;
    let config = InstallConfig {
        game_exe_path: Some(exe_path.to_string_lossy().to_string()),
    };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Canonicalizes the path (via `dunce`, which avoids the `\\?\`-prefixed form
/// `std::fs::canonicalize` returns on Windows — cleaner to display and to hand
/// to `Command`/other tools) and confirms it's actually named
/// Dauntless-Win64-Shipping.exe, case-insensitively — rejects anything else, so
/// a user can't point the launcher at an arbitrary executable.
pub fn canonicalize_game_exe(candidate: &Path) -> Result<PathBuf, String> {
    let canonical =
        dunce::canonicalize(candidate).map_err(|_| "That file doesn't exist.".to_string())?;

    let file_name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file name.".to_string())?;

    if !file_name.eq_ignore_ascii_case(GAME_EXE_NAME) {
        return Err(format!("Select {GAME_EXE_NAME}, not a different file."));
    }

    Ok(canonical)
}

/// Resolves the game executable from a folder selected by the player.  The
/// normal installation is the Archon folder itself, but accepting its parent
/// as well makes the picker natural to use without a broad recursive search.
/// Only the expected executable name in known Dauntless install locations is accepted.
pub fn find_game_executable(install_folder: &Path) -> Result<PathBuf, String> {
    let folder = dunce::canonicalize(install_folder)
        .map_err(|_| "That folder doesn't exist.".to_string())?;

    if !folder.is_dir() {
        return Err("Select the Dauntless installation folder, not a file.".to_string());
    }

    let candidates = [
        folder.join(GAME_EXE_NAME),
        folder.join("Binaries").join("Win64").join(GAME_EXE_NAME),
        folder
            .join("Archon")
            .join("Binaries")
            .join("Win64")
            .join(GAME_EXE_NAME),
    ];

    for candidate in candidates {
        if candidate.is_file() {
            return canonicalize_game_exe(&candidate);
        }
    }

    Err(format!(
        "Couldn't find {GAME_EXE_NAME}. Select the Dauntless or Archon installation folder."
    ))
}

/// A path the player typed, pasted or picked: the game executable itself, or an install folder to search.
pub fn resolve_game_exe_input(input: &Path) -> Result<PathBuf, String> {
    if input.is_file() {
        canonicalize_game_exe(input)
    } else {
        find_game_executable(input)
    }
}

pub fn game_dir(exe_path: &Path) -> Result<PathBuf, String> {
    exe_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Invalid installation path.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_executable_from_dauntless_parent_folder() {
        let root = std::env::temp_dir().join(format!(
            "mysticparadox-install-path-test-{}",
            std::process::id()
        ));
        let exe_dir = root.join("Archon").join("Binaries").join("Win64");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::write(exe_dir.join(GAME_EXE_NAME), b"test").unwrap();

        let resolved = find_game_executable(&root).unwrap();
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some(GAME_EXE_NAME)
        );
        // The resolver canonicalizes, so compare canonical forms (CI temp paths can be 8.3 short names).
        let expected_dir = dunce::canonicalize(&exe_dir).unwrap();
        assert_eq!(resolved.parent(), Some(expected_dir.as_path()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn typed_paths_may_be_the_executable_or_a_folder_but_never_another_file() {
        let root = std::env::temp_dir().join(format!(
            "mysticparadox-install-input-test-{}",
            std::process::id()
        ));
        let exe_dir = root.join("Archon").join("Binaries").join("Win64");
        fs::create_dir_all(&exe_dir).unwrap();
        fs::write(exe_dir.join(GAME_EXE_NAME), b"test").unwrap();
        fs::write(exe_dir.join("notepad.exe"), b"test").unwrap();

        let by_file = resolve_game_exe_input(&exe_dir.join(GAME_EXE_NAME)).unwrap();
        let by_folder = resolve_game_exe_input(&root).unwrap();
        assert_eq!(by_file, by_folder);
        assert!(resolve_game_exe_input(&exe_dir.join("notepad.exe")).is_err());
        assert!(resolve_game_exe_input(&root.join("missing")).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
