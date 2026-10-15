// Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
// Licensed under the GNU Affero General Public License v3.0.
// SPDX-License-Identifier: AGPL-3.0-only
// Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.

//! [2026-10-15] "Check against GitHub" (About page): compares this launcher, the installed runtime loader and the co-op
//! transport with the public repository's release builds, by SHA-256. It runs only when the player asks (it contacts
//! GitHub) and changes nothing.
//!
//! - launcher.exe: release `launcher-v<this version>`, file `INSTALLED-SHA256SUMS` (the launcher.exe its installer installs;
//!   published since 0.1.65).
//! - winmm.dll and ParadoxTransport.dll: the newest `runtime-extras-v*` releases' `SHA256SUMS`, searched for these hashes
//!   (a runtime version may reuse an earlier release's files).
//! - MysticParadox.dll: no public build exists (it needs the game's SDK headers); its hash is shown, and the launcher already
//!   checks its signature before installing it.
//!
//! The check is only as honest as the launcher running it: a modified launcher could fake it. The page therefore also shows
//! how to check the files without the launcher (`gh attestation verify`).

use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use crate::install::{paths, verify};

const DEFAULT_RELEASE_REPO: &str = "pranav158/Mystic-Paradox";
const MAX_SUMS_BYTES: usize = 64 * 1024;
const MAX_RELEASES_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXTRAS_RELEASES: usize = 10;
const EXTRAS_TAG_PREFIX: &str = "runtime-extras-v";

/// The public repository whose releases are compared (`owner/name`; a self-hosted build may set MYSTICPARADOX_RELEASE_REPO).
fn release_repo() -> &'static str {
    let candidate = option_env!("MYSTICPARADOX_RELEASE_REPO").unwrap_or(DEFAULT_RELEASE_REPO);
    if is_repo_name(candidate) {
        candidate
    } else {
        DEFAULT_RELEASE_REPO
    }
}

fn is_repo_name(value: &str) -> bool {
    let mut parts = value.split('/');
    let valid = |part: Option<&str>| {
        part.is_some_and(|text| {
            !text.is_empty()
                && text != "."
                && text != ".."
                && text.len() <= 100
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        })
    };
    valid(parts.next()) && valid(parts.next()) && parts.next().is_none()
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    /// The installed file is the release's file.
    Match,
    /// The release lists another hash for this file.
    Differs,
    /// No public release lists this file.
    NotPublished,
    /// The file is not installed (or the game folder is unknown).
    Missing,
    /// No public build exists by design (the main runtime).
    OperatorBuild,
    /// GitHub could not be reached or answered something unreadable.
    Unavailable,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicBuildCheck {
    pub name: String,
    pub label: String,
    /// The installed file's full path (shown for `gh attestation verify`), when known.
    pub path: Option<String>,
    pub installed_sha256: Option<String>,
    pub published_sha256: Option<String>,
    /// The release tag the published hash comes from.
    pub release: Option<String>,
    pub status: CheckStatus,
    pub note: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublicBuildReport {
    pub repository: String,
    pub launcher_version: String,
    pub files: Vec<PublicBuildCheck>,
}

/// `<sha256>  <name>` lines (sha256sum's text or binary marker) to name -> lower-case hash. Other lines are ignored.
pub(crate) fn parse_sums(text: &str) -> HashMap<String, String> {
    let mut sums = HashMap::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((hash, rest)) = line.split_once(' ') else {
            continue;
        };
        let name = rest.trim_start_matches([' ', '*']);
        if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && !name.is_empty() {
            sums.insert(name.to_string(), hash.to_ascii_lowercase());
        }
    }
    sums
}

/// A runtime extras tag `runtime-extras-v<x.y.z>`, with its version for ordering.
pub(crate) fn extras_tag_version(tag: &str) -> Option<(u64, u64, u64)> {
    let version = tag.strip_prefix(EXTRAS_TAG_PREFIX)?;
    let mut parts = version.split('.');
    let mut next = || -> Option<u64> {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let parsed = (next()?, next()?, next()?);
    parts.next().is_none().then_some(parsed)
}

/// The runtime extras tags of a GitHub releases listing, newest version first, at most MAX_EXTRAS_RELEASES.
pub(crate) fn extras_tags(releases: &serde_json::Value) -> Vec<String> {
    let mut tags: Vec<(u64, u64, u64, String)> = releases
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|release| !release["draft"].as_bool().unwrap_or(false))
                .filter_map(|release| release["tag_name"].as_str())
                .filter_map(|tag| {
                    extras_tag_version(tag).map(|(a, b, c)| (a, b, c, tag.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    tags.sort_by_key(|tag| std::cmp::Reverse((tag.0, tag.1, tag.2)));
    tags.into_iter()
        .take(MAX_EXTRAS_RELEASES)
        .map(|(_, _, _, tag)| tag)
        .collect()
}

pub(crate) fn compare(installed: &str, published: &str) -> CheckStatus {
    if installed.eq_ignore_ascii_case(published) {
        CheckStatus::Match
    } else {
        CheckStatus::Differs
    }
}

enum Fetch {
    Found(Vec<u8>),
    NotFound,
    Failed,
}

fn client() -> Option<Client> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("MysticParadoxLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

async fn fetch(client: &Client, url: &str, limit: usize) -> Fetch {
    let Ok(response) = client.get(url).send().await else {
        return Fetch::Failed;
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Fetch::NotFound;
    }
    if !response.status().is_success() {
        return Fetch::Failed;
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Fetch::Failed;
    }
    match response.bytes().await {
        Ok(bytes) if bytes.len() <= limit => Fetch::Found(bytes.to_vec()),
        _ => Fetch::Failed,
    }
}

async fn hash_of(path: PathBuf) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_file() {
            verify::hash_file_sha256(&path).ok()
        } else {
            None
        }
    })
    .await
    .ok()
    .flatten()
}

fn display(path: &Path) -> Option<String> {
    Some(path.to_string_lossy().into_owned())
}

async fn check_launcher(client: Option<&Client>, repo: &str) -> PublicBuildCheck {
    let version = env!("CARGO_PKG_VERSION");
    let tag = format!("launcher-v{version}");
    let exe = std::env::current_exe().ok();
    let installed = match exe.clone() {
        Some(path) => hash_of(path).await,
        None => None,
    };
    let mut check = PublicBuildCheck {
        name: "launcher.exe".into(),
        label: "Launcher".into(),
        path: exe.as_deref().and_then(display),
        installed_sha256: installed.clone(),
        published_sha256: None,
        release: Some(tag.clone()),
        status: CheckStatus::Unavailable,
        note: String::new(),
    };
    let Some(installed) = installed else {
        check.status = CheckStatus::Missing;
        check.note = "This launcher could not read its own file.".into();
        return check;
    };
    let Some(client) = client else {
        check.note = "Couldn't reach GitHub.".into();
        return check;
    };
    let url = format!("https://github.com/{repo}/releases/download/{tag}/INSTALLED-SHA256SUMS");
    match fetch(client, &url, MAX_SUMS_BYTES).await {
        Fetch::Found(bytes) => {
            match parse_sums(&String::from_utf8_lossy(&bytes)).get("launcher.exe") {
                Some(published) => {
                    check.status = compare(&installed, published);
                    check.published_sha256 = Some(published.clone());
                    check.note = if check.status == CheckStatus::Match {
                        format!("Identical to the launcher.exe of the public release {tag}.")
                    } else {
                        format!("Not the launcher.exe of the public release {tag}: this launcher was built elsewhere or changed.")
                    };
                }
                None => check.note = "The release's checksum file has no launcher.exe line.".into(),
            }
        }
        Fetch::NotFound => {
            check.status = CheckStatus::NotPublished;
            check.note = format!(
                "No public release {tag} lists an installed launcher.exe (releases before 0.1.65 do not), so this launcher cannot be matched."
            );
        }
        Fetch::Failed => check.note = "Couldn't reach GitHub.".into(),
    }
    check
}

async fn check_runtime_files(
    client: Option<&Client>,
    repo: &str,
    game_dir: Option<PathBuf>,
) -> Vec<PublicBuildCheck> {
    let files = [
        ("winmm.dll", "Runtime loader"),
        ("ParadoxTransport.dll", "Co-op transport"),
    ];
    let mut checks = Vec::new();
    for (name, label) in files {
        let path = game_dir.as_ref().map(|dir| dir.join(name));
        let installed = match path.clone() {
            Some(path) => hash_of(path).await,
            None => None,
        };
        checks.push(PublicBuildCheck {
            name: name.into(),
            label: label.into(),
            path: path.as_deref().and_then(display),
            installed_sha256: installed,
            published_sha256: None,
            release: None,
            status: CheckStatus::Unavailable,
            note: String::new(),
        });
    }
    for check in checks
        .iter_mut()
        .filter(|check| check.installed_sha256.is_none())
    {
        check.status = CheckStatus::Missing;
        check.note = if game_dir.is_none() {
            "Locate the game first.".into()
        } else {
            "Not installed.".into()
        };
    }
    if checks
        .iter()
        .all(|check| check.status == CheckStatus::Missing)
    {
        return checks;
    }
    let Some(client) = client else {
        for check in checks
            .iter_mut()
            .filter(|check| check.status == CheckStatus::Unavailable)
        {
            check.note = "Couldn't reach GitHub.".into();
        }
        return checks;
    };

    let listing = format!("https://api.github.com/repos/{repo}/releases?per_page=50");
    let tags = match fetch(client, &listing, MAX_RELEASES_BYTES).await {
        Fetch::Found(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .map(|releases| extras_tags(&releases))
            .ok(),
        _ => None,
    };
    let Some(tags) = tags else {
        for check in checks
            .iter_mut()
            .filter(|check| check.status == CheckStatus::Unavailable)
        {
            check.note = "Couldn't read the public releases from GitHub.".into();
        }
        return checks;
    };
    let mut searched = 0usize;
    for tag in &tags {
        if checks
            .iter()
            .all(|check| check.status != CheckStatus::Unavailable)
        {
            break;
        }
        let url = format!("https://github.com/{repo}/releases/download/{tag}/SHA256SUMS");
        let Fetch::Found(bytes) = fetch(client, &url, MAX_SUMS_BYTES).await else {
            continue;
        };
        searched += 1;
        let sums = parse_sums(&String::from_utf8_lossy(&bytes));
        for check in checks
            .iter_mut()
            .filter(|check| check.status == CheckStatus::Unavailable)
        {
            let (Some(installed), Some(published)) =
                (check.installed_sha256.as_deref(), sums.get(&check.name))
            else {
                continue;
            };
            if compare(installed, published) == CheckStatus::Match {
                check.status = CheckStatus::Match;
                check.published_sha256 = Some(published.clone());
                check.release = Some(tag.clone());
                check.note = format!("Identical to {} of the public release {tag}.", check.name);
            }
        }
    }
    for check in checks
        .iter_mut()
        .filter(|check| check.status == CheckStatus::Unavailable)
    {
        if searched == 0 {
            check.note = "Couldn't read the public runtime releases from GitHub.".into();
        } else {
            check.status = CheckStatus::NotPublished;
            check.note = format!(
                "No public runtime release ({searched} searched) has this file: it was built by the server operator before the public builds (runtime 0.2.136 and earlier), or it was changed."
            );
        }
    }
    checks
}

async fn check_runtime(game_dir: Option<PathBuf>) -> PublicBuildCheck {
    let path = game_dir.map(|dir| dir.join("MysticParadox.dll"));
    let installed = match path.clone() {
        Some(path) => hash_of(path).await,
        None => None,
    };
    PublicBuildCheck {
        name: "MysticParadox.dll".into(),
        label: "Runtime".into(),
        path: path.as_deref().and_then(display),
        status: if installed.is_some() {
            CheckStatus::OperatorBuild
        } else {
            CheckStatus::Missing
        },
        installed_sha256: installed,
        published_sha256: None,
        release: None,
        note: "Built by the official server's operator: it needs the game's SDK headers, which are not public. Its source is public, and the launcher checks the runtime's signature before installing it.".into(),
    }
}

/// The About page's "Check against GitHub".
#[tauri::command]
pub async fn check_public_builds(app: AppHandle) -> Result<PublicBuildReport, String> {
    let repo = release_repo();
    let client = client();
    let game_dir = paths::load_saved_exe_path(&app).and_then(|exe| paths::game_dir(&exe).ok());
    let mut files = vec![check_launcher(client.as_ref(), repo).await];
    files.extend(check_runtime_files(client.as_ref(), repo, game_dir.clone()).await);
    files.push(check_runtime(game_dir).await);
    Ok(PublicBuildReport {
        repository: repo.to_string(),
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_lines_are_read_in_text_and_binary_form_and_anything_else_is_skipped() {
        let hash = "AB".repeat(32);
        let sums = parse_sums(&format!(
            "{hash}  launcher.exe\r\n{} *winmm.dll\nnot a line\n{}  short\n",
            "cd".repeat(32),
            "ef".repeat(31)
        ));
        assert_eq!(
            sums.get("launcher.exe").map(String::as_str),
            Some("ab".repeat(32).as_str())
        );
        assert_eq!(
            sums.get("winmm.dll").map(String::as_str),
            Some("cd".repeat(32).as_str())
        );
        assert_eq!(sums.len(), 2);
    }

    #[test]
    fn runtime_extras_tags_are_found_newest_first_and_other_tags_ignored() {
        let releases = serde_json::json!([
            { "tag_name": "launcher-v0.1.65" },
            { "tag_name": "runtime-extras-v0.2.137" },
            { "tag_name": "runtime-extras-v0.2.140" },
            { "tag_name": "runtime-extras-v0.2.99" },
            { "tag_name": "runtime-extras-v0.2.141", "draft": true },
            { "tag_name": "runtime-extras-v0.2" },
            { "tag_name": "runtime-extras-v0.2.1x" },
        ]);
        assert_eq!(
            extras_tags(&releases),
            vec![
                "runtime-extras-v0.2.140",
                "runtime-extras-v0.2.137",
                "runtime-extras-v0.2.99"
            ]
        );
        assert!(extras_tags(&serde_json::json!({ "message": "rate limited" })).is_empty());
    }

    #[test]
    fn hashes_compare_without_regard_to_case() {
        assert_eq!(
            compare(&"AB".repeat(32), &"ab".repeat(32)),
            CheckStatus::Match
        );
        assert_eq!(
            compare(&"ab".repeat(32), &"ac".repeat(32)),
            CheckStatus::Differs
        );
    }

    #[test]
    fn only_owner_slash_name_is_a_repository() {
        assert!(is_repo_name("pranav158/Mystic-Paradox"));
        assert!(!is_repo_name("pranav158"));
        assert!(!is_repo_name("a/b/c"));
        assert!(!is_repo_name("a/../b"));
        assert!(!is_repo_name("a/b?x"));
        assert_eq!(release_repo(), DEFAULT_RELEASE_REPO);
    }

    #[test]
    fn statuses_reach_the_page_in_camel_case() {
        assert_eq!(
            serde_json::to_value(CheckStatus::NotPublished).unwrap(),
            serde_json::json!("notPublished")
        );
        assert_eq!(
            serde_json::to_value(CheckStatus::OperatorBuild).unwrap(),
            serde_json::json!("operatorBuild")
        );
    }
}
