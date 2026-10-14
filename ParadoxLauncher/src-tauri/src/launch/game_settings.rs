//! [2026-10-15] Borderless launch: the game's display mode is read from its settings file when it starts.
//!
//! In exclusive fullscreen the owner's game freezes its animations. On the owner's PC the game runs at Low
//! integrity (the checkout has a Low mandatory label), so it cannot save its own settings and reverts to exclusive
//! fullscreen on every start. Before each client starts, the launcher sets the three fullscreen keys to borderless.
//! The write is best-effort: a failure is logged by the caller and the game starts anyway.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The section that holds the game's display keys in `GameUserSettings.ini`.
const SECTION: &str = "[/Script/Archon.ArchonGameUserSettings]";
/// The three keys that choose the display mode; they are written in this order when missing.
const BORDERLESS_KEYS: [&str; 3] = [
    "FullscreenMode",
    "LastConfirmedFullscreenMode",
    "PreferredFullscreenMode",
];
/// `EWindowMode` value for WindowedFullscreen (borderless). 0 is exclusive fullscreen.
const BORDERLESS_VALUE: &str = "1";
const SETTINGS_FILE: &str = "GameUserSettings.ini";

/// Path of the game's settings file: `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\GameUserSettings.ini`.
pub fn settings_path() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .join("Archon")
            .join("Saved")
            .join("Config")
            .join("WindowsClient")
            .join(SETTINGS_FILE),
    )
}

/// Returns `text` with the three display keys set to borderless. A key that already exists is updated where it is
/// (in the game's section only), missing keys are added after the section's last line, and a missing section is
/// appended to the end. Every other line keeps its text, its order and its line ending. The file's own line ending
/// is kept (CRLF when the text has no line break), and an empty file becomes just the section and its keys.
pub fn borderless_settings(text: &str) -> String {
    let newline = if text.contains("\r\n") || !text.contains('\n') {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();

    let mut in_section = false;
    let mut section_found = false;
    let mut present = [false; BORDERLESS_KEYS.len()];
    // The section's last line that has text (its header counts). Missing keys go right after it.
    let mut last_content: Option<usize> = None;
    for (index, line) in lines.iter_mut().enumerate() {
        let body = line_body(line);
        let trimmed = body.trim();
        if trimmed == SECTION {
            in_section = true;
            section_found = true;
            last_content = Some(index);
            continue;
        }
        if is_section_header(trimmed) {
            in_section = false;
            continue;
        }
        if !in_section {
            continue;
        }
        if !trimmed.is_empty() {
            last_content = Some(index);
        }
        if let Some(slot) = borderless_key_slot(trimmed) {
            present[slot] = true;
            // Keep the line's own ending (none on a last line without one).
            let replacement = format!(
                "{}={BORDERLESS_VALUE}{}",
                BORDERLESS_KEYS[slot],
                &line[body.len()..]
            );
            *line = replacement;
        }
    }

    let missing: Vec<&str> = BORDERLESS_KEYS
        .iter()
        .zip(present)
        .filter(|(_, found)| !found)
        .map(|(key, _)| *key)
        .collect();
    if !section_found {
        if let Some(last) = lines.last_mut() {
            if !last.ends_with('\n') {
                last.push_str(newline);
            }
            if !line_body(last).trim().is_empty() {
                lines.push(newline.to_string());
            }
        }
        lines.push(format!("{SECTION}{newline}"));
        lines.extend(missing.iter().map(|key| key_line(key, newline)));
    } else if !missing.is_empty() {
        let at = last_content.unwrap_or(0);
        if !lines[at].ends_with('\n') {
            lines[at].push_str(newline);
        }
        for (offset, key) in missing.iter().enumerate() {
            lines.insert(at + 1 + offset, key_line(key, newline));
        }
    }
    lines.concat()
}

/// Writes borderless mode into the settings file, creating the file and its folders when they are missing.
/// Returns whether the file changed; an already borderless file is left untouched. The write goes to a temp file in
/// the same folder first and then replaces the file with a rename, so a failed write never leaves a half file.
pub fn set_borderless_fullscreen(path: &Path) -> Result<bool, String> {
    let existing = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("couldn't read {}: {error}", path.display())),
    };
    let updated = borderless_settings(existing.as_deref().unwrap_or(""));
    if existing.as_deref() == Some(updated.as_str()) {
        return Ok(false);
    }
    write_atomically(path, &updated)?;
    Ok(true)
}

fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    fs::create_dir_all(dir)
        .map_err(|error| format!("couldn't create {}: {error}", dir.display()))?;
    let temp = path.with_file_name(format!("{SETTINGS_FILE}.mysticparadox-tmp"));
    let result = (|| -> io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("couldn't write {}: {error}", path.display()));
    }
    Ok(())
}

/// A line without its line break.
fn line_body(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn is_section_header(trimmed: &str) -> bool {
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

/// Index into `BORDERLESS_KEYS` when a trimmed line is one of the three `Key=value` entries.
fn borderless_key_slot(trimmed: &str) -> Option<usize> {
    let (key, _) = trimmed.split_once('=')?;
    BORDERLESS_KEYS
        .iter()
        .position(|candidate| *candidate == key.trim())
}

fn key_line(key: &str, newline: &str) -> String {
    format!("{key}={BORDERLESS_VALUE}{newline}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "[/Script/Archon.ArchonGameUserSettings]";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-game-settings-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_the_three_keys_where_they_are_and_keeps_every_other_line() {
        let text = "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n\r\n[/Script/Archon.ArchonGameUserSettings]\r\n\
            ResolutionSizeX=1920\r\n; kept comment\r\nFullscreenMode=0\r\nLastConfirmedFullscreenMode=1\r\n\
            PreferredFullscreenMode=1\r\nVersion=5\r\n";
        let expected = "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n\r\n[/Script/Archon.ArchonGameUserSettings]\r\n\
            ResolutionSizeX=1920\r\n; kept comment\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\n\
            PreferredFullscreenMode=1\r\nVersion=5\r\n";
        assert_eq!(borderless_settings(text), expected);
    }

    #[test]
    fn a_key_outside_the_game_section_is_left_alone() {
        let text = "[/Script/Engine.GameUserSettings]\r\nFullscreenMode=0\r\n\r\n[/Script/Archon.ArchonGameUserSettings]\r\nVersion=5\r\n";
        let expected = "[/Script/Engine.GameUserSettings]\r\nFullscreenMode=0\r\n\r\n[/Script/Archon.ArchonGameUserSettings]\r\nVersion=5\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n";
        assert_eq!(borderless_settings(text), expected);
    }

    #[test]
    fn adds_missing_keys_inside_the_game_section_only() {
        let text = format!("{HEADER}\r\nVersion=5\r\n\r\n[/Script/Engine.GameUserSettings]\r\nbUseDesiredScreenHeight=False\r\n");
        let expected = format!(
            "{HEADER}\r\nVersion=5\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n\r\n[/Script/Engine.GameUserSettings]\r\nbUseDesiredScreenHeight=False\r\n"
        );
        assert_eq!(borderless_settings(&text), expected);
    }

    #[test]
    fn adds_only_the_keys_that_are_missing() {
        let text = format!("{HEADER}\r\nFullscreenMode=0\r\nPreferredFullscreenMode=0\r\n");
        let expected = format!("{HEADER}\r\nFullscreenMode=1\r\nPreferredFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\n");
        assert_eq!(borderless_settings(&text), expected);
    }

    #[test]
    fn appends_the_section_to_a_file_without_it() {
        let text = "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n";
        let expected = format!(
            "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n\r\n{HEADER}\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n"
        );
        assert_eq!(borderless_settings(text), expected);
    }

    #[test]
    fn a_last_line_without_a_line_break_gets_one_before_the_new_lines() {
        let text = "[ScalabilityGroups]\r\nsg.ShadowQuality=3";
        let expected = format!(
            "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n\r\n{HEADER}\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n"
        );
        assert_eq!(borderless_settings(text), expected);
        // The game section as the last line, with no line break after its last key.
        let header_only = format!("{HEADER}\r\nFullscreenMode=0");
        assert_eq!(
            borderless_settings(&header_only),
            format!("{HEADER}\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n")
        );
    }

    #[test]
    fn an_empty_text_becomes_the_section_with_its_keys() {
        let expected = format!(
            "{HEADER}\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n"
        );
        assert_eq!(borderless_settings(""), expected);
    }

    #[test]
    fn an_lf_file_keeps_lf_endings() {
        let text = "[ScalabilityGroups]\nsg.ShadowQuality=3\n\n[/Script/Archon.ArchonGameUserSettings]\nFullscreenMode=0\nVersion=5\n";
        let expected = "[ScalabilityGroups]\nsg.ShadowQuality=3\n\n[/Script/Archon.ArchonGameUserSettings]\nFullscreenMode=1\nVersion=5\nLastConfirmedFullscreenMode=1\nPreferredFullscreenMode=1\n";
        assert_eq!(borderless_settings(text), expected);
        assert!(!borderless_settings(text).contains('\r'));
        let appended = "[ScalabilityGroups]\nsg.ShadowQuality=3\n";
        assert_eq!(
            borderless_settings(appended),
            format!("[ScalabilityGroups]\nsg.ShadowQuality=3\n\n{HEADER}\nFullscreenMode=1\nLastConfirmedFullscreenMode=1\nPreferredFullscreenMode=1\n")
        );
    }

    #[test]
    fn an_already_borderless_file_is_unchanged() {
        let text = format!("{HEADER}\r\nFullscreenMode=1\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\nVersion=5\r\n");
        assert_eq!(borderless_settings(&text), text);
        assert_eq!(
            borderless_settings(&borderless_settings("x=1")),
            borderless_settings("x=1")
        );
    }

    #[test]
    fn writing_a_missing_file_creates_its_folders_and_a_second_write_changes_nothing() {
        let dir = temp_dir("create");
        let path = dir
            .join("Archon")
            .join("Saved")
            .join("GameUserSettings.ini");
        assert_eq!(set_borderless_fullscreen(&path), Ok(true));
        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(written, borderless_settings(""));
        assert!(!dir
            .join("Archon")
            .join("Saved")
            .join("GameUserSettings.ini.mysticparadox-tmp")
            .exists());
        assert_eq!(set_borderless_fullscreen(&path), Ok(false));
        assert_eq!(fs::read_to_string(&path).unwrap(), written);
    }

    #[test]
    fn writing_an_existing_file_keeps_its_other_bytes() {
        let dir = temp_dir("existing");
        let path = dir.join(SETTINGS_FILE);
        let original = format!("{HEADER}\r\nFullscreenMode=0\r\nVersion=5\r\nbIsLanMatch=True\r\n");
        fs::write(&path, &original).unwrap();
        assert_eq!(set_borderless_fullscreen(&path), Ok(true));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{HEADER}\r\nFullscreenMode=1\r\nVersion=5\r\nbIsLanMatch=True\r\nLastConfirmedFullscreenMode=1\r\nPreferredFullscreenMode=1\r\n")
        );
    }

    #[test]
    fn a_folder_in_the_way_is_an_error_not_a_panic() {
        let dir = temp_dir("blocked");
        let blocker = dir.join("Archon");
        fs::write(&blocker, b"not a folder").unwrap();
        let error =
            set_borderless_fullscreen(&blocker.join("Saved").join(SETTINGS_FILE)).unwrap_err();
        assert!(error.starts_with("couldn't"), "{error}");
    }
}
