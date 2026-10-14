// [2026-10-13 realms S1] The launcher's server list: pure data model and validation, no I/O. `store.rs` persists it.
//
// Three kinds of server share one launcher:
//   * official      - built in, always present, cannot be removed, uses the built-in API and the saved install
//                     folder (`install.json`, unchanged since before the list existed);
//   * paradox_realm - identified by its directory name, uses OUR backend and OUR signed feed, and runs the same game
//                     build as the official server. It plays from the OFFICIAL install unless it was given a folder of
//                     its own (`game_exe_path`), so it needs no folder of its own by default;
//   * local         - the player's own backend at `scheme://host[:port]`, its own install folder, never our feed.
//
// A local server has its own install folder, and no two of its folders may overlap: the official install above all.
// A realm may share the official install (`may_share_install`); a realm's own folder may not overlap a local one.
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path};

pub const OFFICIAL_ID: &str = "official";
pub const OFFICIAL_NAME: &str = "Mystic Paradox";
/// More than this is a mistake or a hand-edited file, not a player's server list.
pub const MAX_SERVERS: usize = 32;
const MAX_NAME_CHARS: usize = 40;
const MAX_URL_CHARS: usize = 300;
const MAX_ID_CHARS: usize = 40;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ServerKind {
    Official,
    ParadoxRealm,
    Local,
}

impl ServerKind {
    /// Whether this server's runtime files come from our signed feed (and the launcher may write them into its
    /// folder). A local server's files are the realm's own: the launcher never writes ours there.
    pub fn uses_official_feed(self) -> bool {
        self.network_rules().runtime_feed
    }

    pub fn label(self) -> &'static str {
        match self {
            ServerKind::Official => "official",
            ServerKind::ParadoxRealm => "paradox_realm",
            ServerKind::Local => "local",
        }
    }
}

/// Where a server's game folder comes from. The Servers page shows it and the install check follows it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FolderSource {
    /// The server's own folder: the official install's `install.json` path, or a folder saved for the server.
    Own,
    /// A Paradox realm with no folder of its own: it runs from the official install.
    Official,
    /// Nothing saved for the server (a local server before its folder is chosen).
    None,
}

/// Whether two servers may run from the same game folder. A Paradox realm runs the same game build and our signed
/// runtime as the official server, so it may share the official install. Every other pair must not overlap.
pub fn may_share_install(a: ServerKind, b: ServerKind) -> bool {
    matches!(
        (a, b),
        (ServerKind::Official, ServerKind::ParadoxRealm)
            | (ServerKind::ParadoxRealm, ServerKind::Official)
    )
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub id: String,
    pub kind: ServerKind,
    pub name: String,
    /// `local` only: `scheme://host[:port]`, already normalised.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_url: Option<String>,
    /// `paradox_realm` only: the realm's directory name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realm_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_exe_path: Option<String>,
    /// `paradox_realm` only: the host's public key the player agreed to. Not a secret (the directory returns it to
    /// anyone). Play sends it, and the realm refuses the entry when its name now belongs to another key
    /// (REALM_OWNER_CHANGED). Absent until the player has confirmed the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_public_key: Option<String>,
}

impl ServerEntry {
    /// A Paradox realm with no folder of its own runs from the official install.
    pub fn uses_official_install(&self) -> bool {
        self.kind == ServerKind::ParadoxRealm && self.game_exe_path.is_none()
    }
}

/// What the UI sends to add a server. `name` may be left empty for a realm (its realm name is used).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewServer {
    pub kind: Option<ServerKind>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub backend_url: Option<String>,
    #[serde(default)]
    pub realm_name: Option<String>,
}

/// The built-in official entry. Its install path is not part of the list: it stays in `install.json`.
pub fn official_entry(game_exe_path: Option<String>) -> ServerEntry {
    ServerEntry {
        id: OFFICIAL_ID.to_string(),
        kind: ServerKind::Official,
        name: OFFICIAL_NAME.to_string(),
        backend_url: None,
        realm_name: None,
        game_exe_path,
        host_public_key: None,
    }
}

/// The non-official servers and which server is selected. The official server is implicit.
#[derive(Clone, Debug, PartialEq)]
pub struct ServerList {
    pub selected_id: String,
    pub servers: Vec<ServerEntry>,
}

impl Default for ServerList {
    fn default() -> Self {
        Self {
            selected_id: OFFICIAL_ID.to_string(),
            servers: Vec::new(),
        }
    }
}

// ---- validation -----------------------------------------------------------------------------------------------

/// A display name: 1-40 characters, no control characters, trimmed.
pub fn validate_display_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Enter a name for the server.".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "Server names are at most {MAX_NAME_CHARS} characters."
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("The server name contains characters that are not allowed.".to_string());
    }
    Ok(name.to_string())
}

/// A realm's directory name, exactly `^[a-z0-9-]{3,24}$` (surrounding spaces are trimmed first).
pub fn validate_realm_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let length_ok = (3..=24).contains(&name.len());
    let chars_ok = name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !length_ok || !chars_ok {
        return Err(
            "A realm name uses 3 to 24 lowercase letters, digits or hyphens, for example ember-hold.".to_string(),
        );
    }
    Ok(name.to_string())
}

/// A realm host's public key, trimmed: 16 to 512 characters of letters, digits and `+ / _ = -`. The same shape the
/// directory accepts (ParadoxBackend src/realms/realmInput.ts `HostKeyPattern`).
pub fn validate_host_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    let length_ok = (16..=512).contains(&key.len());
    let chars_ok = key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'=' | b'-'));
    if !length_ok || !chars_ok {
        return Err(
            "The realm directory sent a host key this launcher does not accept.".to_string(),
        );
    }
    Ok(key.to_string())
}

/// The short form of a host key shown to the player: the first and last 8 characters around an ellipsis. A key of 16
/// characters or fewer is shown whole. Keys are ASCII (see `validate_host_key`), so characters are bytes.
pub fn key_fingerprint(key: &str) -> String {
    if key.len() <= 16 {
        return key.to_string();
    }
    format!("{}…{}", &key[..8], &key[key.len() - 8..])
}

pub(crate) fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id != OFFICIAL_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

const URL_SHAPE_ERROR: &str =
    "Use only the scheme, host and optional port, like https://realm.example.com or https://realm.example.com:8443 (no path, query, fragment or user name).";

/// A local server's backend address. Accepts `scheme://host[:port]` (one trailing slash is dropped) and returns it
/// in canonical form. `https` is required, `http` only for `localhost`, `127.0.0.1` and `[::1]`. No path, query,
/// fragment or user info; the host is a plain DNS name or an IP address; the port is 1-65535.
pub fn normalize_backend_url(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Enter the server address, for example https://realm.example.com.".to_string());
    }
    if text.chars().count() > MAX_URL_CHARS
        || text.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("The server address contains characters that are not allowed.".to_string());
    }
    // Check the shape on the raw text first: the URL parser is deliberately forgiving (it turns backslashes into
    // slashes, drops tabs and lets `host:port` pass as a scheme), and a server address must not rely on that.
    let Some((scheme_raw, rest)) = text.split_once("://") else {
        return Err(
            "The server address must start with https:// (http:// is allowed only for localhost)."
                .to_string(),
        );
    };
    let scheme = scheme_raw.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(
            "Only https:// addresses are allowed (http:// only for localhost).".to_string(),
        );
    }
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() {
        return Err("The server address has no host.".to_string());
    }
    if authority.contains(['/', '?', '#', '@', '\\']) {
        return Err(URL_SHAPE_ERROR.to_string());
    }
    let url = url::Url::parse(&format!("{scheme}://{authority}"))
        .map_err(|_| "That server address is not valid.".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(URL_SHAPE_ERROR.to_string());
    }
    if url.port() == Some(0) {
        return Err("The server port must be between 1 and 65535.".to_string());
    }
    let host = url
        .host()
        .ok_or_else(|| "The server address has no host.".to_string())?;
    let loopback = match &host {
        url::Host::Domain(domain) => *domain == "localhost",
        url::Host::Ipv4(ip) => *ip == Ipv4Addr::LOCALHOST,
        url::Host::Ipv6(ip) => *ip == Ipv6Addr::LOCALHOST,
    };
    if scheme == "http" && !loopback {
        return Err(
            "Only https:// addresses are allowed. http:// works only for localhost, 127.0.0.1 and [::1]."
                .to_string(),
        );
    }
    match &host {
        url::Host::Domain(domain) if !is_plain_dns_name(domain) => {
            return Err("That host name is not valid.".to_string());
        }
        url::Host::Ipv4(ip) if is_unusable_ip(&IpAddr::V4(*ip)) => {
            return Err("That IP address cannot be a server.".to_string());
        }
        url::Host::Ipv6(ip) if is_unusable_ip(&IpAddr::V6(*ip)) => {
            return Err("That IP address cannot be a server.".to_string());
        }
        _ => {}
    }
    let host_text = url
        .host_str()
        .ok_or_else(|| "The server address has no host.".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("{scheme}://{host_text}:{port}"),
        None => format!("{scheme}://{host_text}"),
    })
}

/// Letters, digits and hyphens in dot-separated labels (the URL parser has already lower-cased it and turned
/// international names into punycode). No empty label, so no leading, double or trailing dot.
fn is_plain_dns_name(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn is_unusable_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast(),
        IpAddr::V6(v6) => v6.is_unspecified() || v6.is_multicast(),
    }
}

/// True when `candidate` (already normalised) is the official backend itself. Adding it as a "local" server would
/// only mislabel the official server, so it is refused. A loopback official address (debug builds point at
/// `127.0.0.1:3000`) is never refused: a developer's own local realm may well live there.
pub fn is_official_backend_address(candidate: &str, official_base: &str) -> bool {
    let Ok(official) = normalize_backend_url(official_base) else {
        return false;
    };
    // Only a loopback address may be plain http (see above), so `http://` marks a developer's loopback API.
    let developer_loopback = official.starts_with("http://");
    !developer_loopback && official == candidate
}

// ---- install folders ------------------------------------------------------------------------------------------

/// The components of a game installation root, lower-cased: the folder holding `Archon\Binaries\Win64\<exe>`
/// (or `Binaries\Win64\<exe>`, or the exe's own folder when the layout is flat).
fn install_root_components(exe: &Path) -> Vec<String> {
    let mut parts: Vec<String> = exe
        .parent()
        .map(|dir| {
            dir.components()
                .filter_map(|component| match component {
                    Component::Normal(part) => Some(part.to_string_lossy().to_lowercase()),
                    Component::Prefix(prefix) => {
                        Some(prefix.as_os_str().to_string_lossy().to_lowercase())
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let strip = if parts.ends_with(&["archon".into(), "binaries".into(), "win64".into()]) {
        3
    } else if parts.ends_with(&["binaries".into(), "win64".into()]) {
        2
    } else {
        0
    };
    parts.truncate(parts.len() - strip);
    parts
}

/// True when the two installations are the same folder or one is inside the other (case-insensitive, as Windows
/// paths are). An empty path overlaps everything: fail closed.
pub fn installs_overlap(exe_a: &Path, exe_b: &Path) -> bool {
    let a = install_root_components(exe_a);
    let b = install_root_components(exe_b);
    if a.is_empty() || b.is_empty() {
        return true;
    }
    let shared = a.len().min(b.len());
    a[..shared] == b[..shared]
}

// ---- the list -------------------------------------------------------------------------------------------------

impl ServerList {
    pub fn find(&self, id: &str) -> Option<&ServerEntry> {
        self.servers.iter().find(|entry| entry.id == id)
    }

    /// The selected server's id, falling back to the official server when the selection no longer exists.
    pub fn effective_selected_id(&self) -> &str {
        if self.selected_id == OFFICIAL_ID || self.find(&self.selected_id).is_some() {
            &self.selected_id
        } else {
            OFFICIAL_ID
        }
    }

    /// Adds a validated server. `new_id` is a fresh, unused id (the caller generates it).
    pub fn add(&mut self, request: NewServer, new_id: String) -> Result<ServerEntry, String> {
        if self.servers.len() >= MAX_SERVERS {
            return Err(format!(
                "The server list is full ({MAX_SERVERS} servers). Remove one first."
            ));
        }
        let kind = request
            .kind
            .ok_or_else(|| "Choose what kind of server to add.".to_string())?;
        let entry = match kind {
            ServerKind::Official => {
                return Err("The official server is built in; there is nothing to add.".to_string());
            }
            ServerKind::ParadoxRealm => {
                let realm_name = validate_realm_name(request.realm_name.as_deref().unwrap_or(""))?;
                if request
                    .backend_url
                    .as_deref()
                    .is_some_and(|url| !url.trim().is_empty())
                {
                    return Err(
                        "A Paradox realm uses the Mystic Paradox backend; it has no server address."
                            .to_string(),
                    );
                }
                let name = match request.name.as_deref().map(str::trim) {
                    Some(text) if !text.is_empty() => validate_display_name(text)?,
                    _ => realm_name.clone(),
                };
                if self
                    .servers
                    .iter()
                    .any(|other| other.realm_name.as_deref() == Some(realm_name.as_str()))
                {
                    return Err(format!("The realm {realm_name} is already in your list."));
                }
                ServerEntry {
                    id: new_id,
                    kind,
                    name,
                    backend_url: None,
                    realm_name: Some(realm_name),
                    game_exe_path: None,
                    host_public_key: None,
                }
            }
            ServerKind::Local => {
                let backend_url =
                    normalize_backend_url(request.backend_url.as_deref().unwrap_or(""))?;
                if request
                    .realm_name
                    .as_deref()
                    .is_some_and(|name| !name.trim().is_empty())
                {
                    return Err(
                        "A local server is reached by its address, not a realm name.".to_string(),
                    );
                }
                let name = validate_display_name(request.name.as_deref().unwrap_or(""))?;
                if self
                    .servers
                    .iter()
                    .any(|other| other.backend_url.as_deref() == Some(backend_url.as_str()))
                {
                    return Err("That server address is already in your list.".to_string());
                }
                ServerEntry {
                    id: new_id,
                    kind,
                    name,
                    backend_url: Some(backend_url),
                    realm_name: None,
                    game_exe_path: None,
                    host_public_key: None,
                }
            }
        };
        let taken = entry.name.to_lowercase();
        if taken == OFFICIAL_NAME.to_lowercase()
            || self
                .servers
                .iter()
                .any(|other| other.name.to_lowercase() == taken)
        {
            return Err(format!(
                "A server called \"{}\" is already in your list. Choose another name.",
                entry.name
            ));
        }
        self.servers.push(entry.clone());
        Ok(entry)
    }

    /// Removes a non-official server (its files on disk are never touched). If it was selected, the official
    /// server is selected again.
    pub fn remove(&mut self, id: &str) -> Result<ServerEntry, String> {
        if id == OFFICIAL_ID {
            return Err("The official server is built in and cannot be removed.".to_string());
        }
        let position = self
            .servers
            .iter()
            .position(|entry| entry.id == id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        let removed = self.servers.remove(position);
        if self.selected_id == removed.id {
            self.selected_id = OFFICIAL_ID.to_string();
        }
        Ok(removed)
    }

    pub fn select(&mut self, id: &str) -> Result<(), String> {
        if id != OFFICIAL_ID && self.find(id).is_none() {
            return Err("That server is not in your list.".to_string());
        }
        self.selected_id = id.to_string();
        Ok(())
    }

    fn kind_of(&self, id: &str) -> Option<ServerKind> {
        if id == OFFICIAL_ID {
            Some(ServerKind::Official)
        } else {
            self.find(id).map(|entry| entry.kind)
        }
    }

    /// Refuses `exe` when its installation overlaps the official one or another server's, unless the two may share
    /// a folder (`may_share_install`: a realm and the official install). `for_id` is the server being set (its own
    /// current path is not a conflict).
    pub fn check_folder_available(
        &self,
        for_id: &str,
        exe: &Path,
        official_exe: Option<&Path>,
    ) -> Result<(), String> {
        let for_kind = self
            .kind_of(for_id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        if for_kind != ServerKind::Official && !may_share_install(for_kind, ServerKind::Official) {
            if let Some(official) = official_exe {
                if installs_overlap(exe, official) {
                    return Err(
                        "That is the official server's Dauntless folder (or a folder inside or around it). Give a local server its own separate copy of the game, so the official install is never touched."
                            .to_string(),
                    );
                }
            }
        }
        for other in &self.servers {
            if other.id == for_id || may_share_install(for_kind, other.kind) {
                continue;
            }
            if let Some(path) = other.game_exe_path.as_deref() {
                if installs_overlap(exe, Path::new(path)) {
                    return Err(format!(
                        "That folder already belongs to \"{}\" (or overlaps it). Only a Paradox realm may share the official install; every other server needs its own separate Dauntless folder.",
                        other.name
                    ));
                }
            }
        }
        Ok(())
    }

    /// Stores a non-official server's game executable (already validated and canonical). The official server's
    /// path lives in `install.json` and is saved by the caller.
    pub fn set_game_exe(
        &mut self,
        id: &str,
        exe: &Path,
        official_exe: Option<&Path>,
    ) -> Result<(), String> {
        if id == OFFICIAL_ID {
            return Err("The official server's folder is saved separately.".to_string());
        }
        self.check_folder_available(id, exe, official_exe)?;
        let entry = self
            .servers
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        entry.game_exe_path = Some(exe.to_string_lossy().into_owned());
        Ok(())
    }

    /// Drops a Paradox realm's own folder, so it runs from the official install again. Nothing on disk is touched.
    pub fn clear_game_exe(&mut self, id: &str) -> Result<(), String> {
        let entry = self
            .servers
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        if entry.kind != ServerKind::ParadoxRealm {
            return Err(
                "Only a Paradox realm can use the official install. A local server keeps its own folder.".to_string(),
            );
        }
        entry.game_exe_path = None;
        Ok(())
    }

    /// Stores the host key the player agreed to for a Paradox realm (validated here). Only a realm has one.
    pub fn set_host_key(&mut self, id: &str, key: &str) -> Result<(), String> {
        let key = validate_host_key(key)?;
        let entry = self
            .servers
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "That server is not in your list.".to_string())?;
        if entry.kind != ServerKind::ParadoxRealm {
            return Err("Only a Paradox realm has a host to confirm.".to_string());
        }
        entry.host_public_key = Some(key);
        Ok(())
    }

    /// Keeps only entries that are well formed, whatever hand-edited or damaged file they came from. The list is
    /// trusted for launching, so nothing unvalidated survives a load.
    pub fn sanitized(selected_id: Option<String>, entries: Vec<ServerEntry>) -> ServerList {
        let mut servers: Vec<ServerEntry> = Vec::new();
        for mut entry in entries {
            if servers.len() >= MAX_SERVERS
                || !is_valid_id(&entry.id)
                || servers.iter().any(|kept| kept.id == entry.id)
            {
                continue;
            }
            let Ok(name) = validate_display_name(&entry.name) else {
                continue;
            };
            entry.name = name;
            match entry.kind {
                ServerKind::Official => continue,
                ServerKind::ParadoxRealm => {
                    let Ok(realm) = validate_realm_name(entry.realm_name.as_deref().unwrap_or(""))
                    else {
                        continue;
                    };
                    entry.realm_name = Some(realm);
                    entry.backend_url = None;
                    // A key that no longer has the directory's shape is dropped, so the player is asked again.
                    entry.host_public_key = entry
                        .host_public_key
                        .as_deref()
                        .and_then(|key| validate_host_key(key).ok());
                }
                ServerKind::Local => {
                    let Ok(url) = normalize_backend_url(entry.backend_url.as_deref().unwrap_or(""))
                    else {
                        continue;
                    };
                    entry.backend_url = Some(url);
                    entry.realm_name = None;
                    entry.host_public_key = None;
                }
            }
            if entry
                .game_exe_path
                .as_deref()
                .is_some_and(|path| path.trim().is_empty())
            {
                entry.game_exe_path = None;
            }
            servers.push(entry);
        }
        let selected = selected_id
            .filter(|id| id == OFFICIAL_ID || servers.iter().any(|entry| &entry.id == id))
            .unwrap_or_else(|| OFFICIAL_ID.to_string());
        ServerList {
            selected_id: selected,
            servers,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn exe(root: &str) -> PathBuf {
        PathBuf::from(format!(
            "{root}\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe"
        ))
    }

    fn local(name: &str, url: &str) -> NewServer {
        NewServer {
            kind: Some(ServerKind::Local),
            name: Some(name.to_string()),
            backend_url: Some(url.to_string()),
            realm_name: None,
        }
    }

    fn realm(name: &str, realm_name: &str) -> NewServer {
        NewServer {
            kind: Some(ServerKind::ParadoxRealm),
            name: Some(name.to_string()),
            backend_url: None,
            realm_name: Some(realm_name.to_string()),
        }
    }

    #[test]
    fn realm_names_follow_the_directory_rule() {
        for good in [
            "abc",
            "ember-hold",
            "a1-b2-c3",
            "123",
            "a-b",
            "x".repeat(24).as_str(),
        ] {
            assert_eq!(validate_realm_name(good).as_deref(), Ok(good), "{good}");
        }
        assert_eq!(
            validate_realm_name("  ember-hold \n").unwrap(),
            "ember-hold"
        );
        for bad in [
            "",
            "ab",
            "Ember-Hold",
            "ember_hold",
            "ember hold",
            "ember.hold",
            "emberhöld",
            "x".repeat(25).as_str(),
        ] {
            assert!(validate_realm_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn backend_urls_are_normalised_and_checked_strictly() {
        let ok = [
            ("https://realm.example.com", "https://realm.example.com"),
            ("HTTPS://Realm.Example.COM/", "https://realm.example.com"),
            (
                "  https://realm.example.com:8443 ",
                "https://realm.example.com:8443",
            ),
            ("https://realm.example.com:443", "https://realm.example.com"),
            ("https://203.0.113.7:9000", "https://203.0.113.7:9000"),
            ("https://[2001:db8::1]:9000", "https://[2001:db8::1]:9000"),
            ("https://localhost", "https://localhost"),
            ("http://localhost:3000", "http://localhost:3000"),
            ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("http://[::1]:3000", "http://[::1]:3000"),
            ("http://LOCALHOST", "http://localhost"),
        ];
        for (input, expected) in ok {
            assert_eq!(
                normalize_backend_url(input).as_deref(),
                Ok(expected),
                "{input}"
            );
        }
        let bad = [
            "",
            "   ",
            "realm.example.com",
            "ftp://realm.example.com",
            "javascript://realm.example.com",
            "ws://realm.example.com",
            "http://realm.example.com",
            "http://192.168.1.5:3000",
            "http://127.0.0.2:3000",
            "http://[::2]",
            "https://",
            "https:///path",
            "https://realm.example.com/api",
            "https://realm.example.com//",
            "https://realm.example.com/?x=1",
            "https://realm.example.com?x=1",
            "https://realm.example.com#frag",
            "https://user@realm.example.com",
            "https://user:pass@realm.example.com",
            "https://realm.example.com\\@evil.example",
            "https://realm.example.com:0",
            "https://realm.example.com:65536",
            "https://realm.example.com:abc",
            "https://realm .example.com",
            "https://realm..example.com",
            "https://-realm.example.com",
            "https://realm_one.example.com",
            "https://0.0.0.0",
            "https://[::]",
            "https://255.255.255.255",
        ];
        for input in bad {
            assert!(
                normalize_backend_url(input).is_err(),
                "should refuse {input:?}"
            );
        }
        assert!(
            normalize_backend_url(&format!("https://{}.example.com", "a".repeat(300))).is_err()
        );
    }

    #[test]
    fn odd_loopback_spellings_are_judged_by_what_they_resolve_to() {
        // The URL parser turns these into 127.0.0.1; the stored address is the canonical one.
        assert_eq!(
            normalize_backend_url("http://127.1:3000").as_deref(),
            Ok("http://127.0.0.1:3000")
        );
        // A different loopback address is not on the http allow-list.
        assert!(normalize_backend_url("http://127.0.0.2").is_err());
        // Nor is a name that merely contains the word.
        assert!(normalize_backend_url("http://localhost.example.com").is_err());
    }

    #[test]
    fn the_official_backend_cannot_be_added_as_a_local_server() {
        let official = "https://paradox.mysticfox.dev";
        assert!(is_official_backend_address(
            "https://paradox.mysticfox.dev",
            official
        ));
        assert!(!is_official_backend_address(
            "https://realm.example.com",
            official
        ));
        // A debug build's loopback API stays usable as a developer's local realm.
        assert!(!is_official_backend_address(
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3000"
        ));
    }

    #[test]
    fn add_validates_each_kind_and_rejects_duplicates() {
        let mut list = ServerList::default();
        let entry = list
            .add(local("My PC", "https://realm.example.com/"), "a1".into())
            .unwrap();
        assert_eq!(
            entry.backend_url.as_deref(),
            Some("https://realm.example.com")
        );
        assert_eq!(entry.realm_name, None);
        assert_eq!(entry.game_exe_path, None);

        let entry = list.add(realm("", "ember-hold"), "a2".into()).unwrap();
        assert_eq!(entry.name, "ember-hold");
        assert_eq!(entry.backend_url, None);

        // Duplicate address, realm and name (case-insensitive).
        assert!(list
            .add(local("Other", "https://realm.example.com"), "a3".into())
            .is_err());
        assert!(list.add(realm("Other", "ember-hold"), "a3".into()).is_err());
        assert!(list
            .add(local("MY PC", "https://other.example.com"), "a3".into())
            .is_err());
        assert!(list
            .add(
                local("mystic paradox", "https://other.example.com"),
                "a3".into()
            )
            .is_err());
        // Wrong fields for the kind.
        assert!(list.add(local("No URL", ""), "a3".into()).is_err());
        assert!(list
            .add(local("", "https://other.example.com"), "a3".into())
            .is_err());
        assert!(list.add(realm("Bad", "Ember Hold"), "a3".into()).is_err());
        let mut mixed = realm("Mixed", "mixed-realm");
        mixed.backend_url = Some("https://x.example.com".into());
        assert!(list.add(mixed, "a3".into()).is_err());
        let mut mixed = local("Mixed", "https://x.example.com");
        mixed.realm_name = Some("mixed-realm".into());
        assert!(list.add(mixed, "a3".into()).is_err());
        // The official server cannot be added, and a kind is required.
        let official = NewServer {
            kind: Some(ServerKind::Official),
            ..NewServer::default()
        };
        assert!(list.add(official, "a3".into()).is_err());
        assert!(list.add(NewServer::default(), "a3".into()).is_err());
        assert_eq!(list.servers.len(), 2);
        // Overlong or control-character names.
        assert!(list
            .add(local(&"n".repeat(41), "https://x.example.com"), "a3".into())
            .is_err());
        assert!(list
            .add(local("tab\tname", "https://x.example.com"), "a3".into())
            .is_err());
    }

    #[test]
    fn the_list_has_a_size_limit() {
        let mut list = ServerList::default();
        for index in 0..MAX_SERVERS {
            list.add(
                local(
                    &format!("srv {index}"),
                    &format!("https://s{index}.example.com"),
                ),
                format!("id{index}"),
            )
            .unwrap();
        }
        assert!(list
            .add(local("one more", "https://more.example.com"), "idx".into())
            .is_err());
    }

    #[test]
    fn remove_and_select_never_touch_the_official_server() {
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();

        assert!(list.remove(OFFICIAL_ID).is_err());
        assert!(list.remove("missing").is_err());
        assert!(list.select("missing").is_err());
        assert_eq!(list.selected_id, OFFICIAL_ID);

        list.select("a1").unwrap();
        assert_eq!(list.effective_selected_id(), "a1");
        list.select(OFFICIAL_ID).unwrap();
        list.select("a2").unwrap();
        // Removing the selected server returns to the official one.
        assert_eq!(list.remove("a2").unwrap().name, "Realm");
        assert_eq!(list.selected_id, OFFICIAL_ID);
        assert_eq!(list.servers.len(), 1);
        // Removing another server keeps the selection.
        list.select("a1").unwrap();
        list.add(realm("Other", "other-realm"), "a3".into())
            .unwrap();
        list.remove("a3").unwrap();
        assert_eq!(list.selected_id, "a1");
    }

    #[test]
    fn a_selection_that_no_longer_exists_falls_back_to_official() {
        let list = ServerList {
            selected_id: "gone".into(),
            servers: Vec::new(),
        };
        assert_eq!(list.effective_selected_id(), OFFICIAL_ID);
    }

    #[test]
    fn install_roots_ignore_case_and_the_exe_subfolders() {
        let official = exe("D:\\Games\\Dauntless");
        assert!(installs_overlap(&official, &exe("d:\\games\\DAUNTLESS")));
        assert!(installs_overlap(&official, &official));
        assert!(!installs_overlap(
            &official,
            &exe("D:\\Games\\Dauntless-Realm")
        ));
        assert!(!installs_overlap(&official, &exe("E:\\Games\\Dauntless")));
        // Nested either way.
        assert!(installs_overlap(
            &official,
            &exe("D:\\Games\\Dauntless\\Realm")
        ));
        assert!(installs_overlap(
            &exe("D:\\Games\\Dauntless\\Realm"),
            &official
        ));
        // Flat and Binaries\Win64 layouts.
        let flat = PathBuf::from("D:\\Games\\Dauntless\\Dauntless-Win64-Shipping.exe");
        assert!(installs_overlap(&official, &flat));
        let binaries =
            PathBuf::from("D:\\Games\\Dauntless\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe");
        assert!(installs_overlap(&official, &binaries));
        // An empty or relative path overlaps everything (fail closed).
        assert!(installs_overlap(
            &official,
            Path::new("Dauntless-Win64-Shipping.exe")
        ));
    }

    #[test]
    fn a_server_cannot_use_the_official_folder_or_another_servers() {
        let official = exe("D:\\Games\\Dauntless");
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();

        // The official folder, in any spelling, is refused for a non-official server.
        assert!(list.set_game_exe("a1", &official, Some(&official)).is_err());
        assert!(list
            .set_game_exe("a1", &exe("d:\\GAMES\\dauntless"), Some(&official))
            .is_err());
        assert!(list
            .set_game_exe("a1", &exe("D:\\Games\\Dauntless\\Local"), Some(&official))
            .is_err());
        assert_eq!(list.find("a1").unwrap().game_exe_path, None);

        // A separate folder works, and another server cannot take the same one.
        let own = exe("D:\\Games\\Realm One");
        list.set_game_exe("a1", &own, Some(&official)).unwrap();
        assert_eq!(
            list.find("a1").unwrap().game_exe_path.as_deref(),
            Some(own.to_string_lossy().as_ref())
        );
        assert!(list.set_game_exe("a2", &own, Some(&official)).is_err());
        // Re-saving a server's own folder is fine.
        list.set_game_exe("a1", &own, Some(&official)).unwrap();
        // The official server may not take a realm's folder either.
        assert!(list
            .check_folder_available(OFFICIAL_ID, &own, None)
            .is_err());
        assert!(list
            .check_folder_available(OFFICIAL_ID, &exe("D:\\Games\\Dauntless"), None)
            .is_ok());
        // The official path is not stored in the list.
        assert!(list.set_game_exe(OFFICIAL_ID, &official, None).is_err());
        assert!(list.set_game_exe("missing", &own, Some(&official)).is_err());
    }

    #[test]
    fn a_realm_shares_the_official_install_and_nothing_else_does() {
        let official = exe("D:\\Games\\Dauntless");
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();

        assert!(may_share_install(
            ServerKind::ParadoxRealm,
            ServerKind::Official
        ));
        assert!(may_share_install(
            ServerKind::Official,
            ServerKind::ParadoxRealm
        ));
        assert!(!may_share_install(ServerKind::Local, ServerKind::Official));
        assert!(!may_share_install(
            ServerKind::ParadoxRealm,
            ServerKind::Local
        ));
        assert!(!may_share_install(
            ServerKind::ParadoxRealm,
            ServerKind::ParadoxRealm
        ));

        // A new realm has no folder of its own: it runs from the official install, so nothing is refused for it.
        assert!(list.find("a2").unwrap().uses_official_install());
        assert!(!list.find("a1").unwrap().uses_official_install());
        assert!(list
            .check_folder_available("a2", &official, Some(&official))
            .is_ok());
        // A realm may still opt into the official folder or one inside it, and the official folder may be set.
        list.set_game_exe("a2", &official, Some(&official)).unwrap();
        assert!(!list.find("a2").unwrap().uses_official_install());
        list.clear_game_exe("a2").unwrap();
        list.set_game_exe("a2", &exe("D:\\Games\\Dauntless\\Realm"), Some(&official))
            .unwrap();
        assert!(list
            .check_folder_available(OFFICIAL_ID, &official, None)
            .is_ok());
        // A local server may not take the official folder, or one inside it, in any spelling.
        assert!(list.set_game_exe("a1", &official, Some(&official)).is_err());
        assert!(list
            .set_game_exe("a1", &exe("D:\\Games\\Dauntless\\Local"), Some(&official))
            .is_err());
        assert_eq!(list.find("a1").unwrap().game_exe_path, None);
    }

    #[test]
    fn a_realm_folder_may_not_overlap_a_local_servers_and_the_reverse() {
        let official = exe("D:\\Games\\Dauntless");
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();

        let own = exe("D:\\Games\\Own One");
        list.set_game_exe("a1", &own, Some(&official)).unwrap();
        assert!(list.set_game_exe("a2", &own, Some(&official)).is_err());
        assert!(list
            .set_game_exe("a2", &exe("d:\\games\\own one\\Realm"), Some(&official))
            .is_err());
        assert!(list.find("a2").unwrap().uses_official_install());

        list.set_game_exe("a2", &exe("D:\\Games\\Realm Own"), Some(&official))
            .unwrap();
        assert!(list
            .set_game_exe("a1", &exe("D:\\Games\\Realm Own\\Local"), Some(&official))
            .is_err());
    }

    #[test]
    fn a_realm_gives_up_its_own_folder_and_a_local_server_keeps_its_own() {
        let official = exe("D:\\Games\\Dauntless");
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();
        let realm_folder = exe("D:\\Games\\Realm One");
        let local_folder = exe("D:\\Games\\Local One");
        list.set_game_exe("a2", &realm_folder, Some(&official))
            .unwrap();
        list.set_game_exe("a1", &local_folder, Some(&official))
            .unwrap();

        list.clear_game_exe("a2").unwrap();
        assert_eq!(list.find("a2").unwrap().game_exe_path, None);
        assert!(list.find("a2").unwrap().uses_official_install());

        assert!(list.clear_game_exe("a1").is_err());
        assert_eq!(
            list.find("a1").unwrap().game_exe_path.as_deref(),
            Some(local_folder.to_string_lossy().as_ref())
        );
        assert!(list.clear_game_exe("missing").is_err());
        assert!(list.clear_game_exe(OFFICIAL_ID).is_err());
    }

    #[test]
    fn folder_sources_serialise_as_the_wire_names() {
        assert_eq!(
            serde_json::to_string(&FolderSource::Own).unwrap(),
            "\"own\""
        );
        assert_eq!(
            serde_json::to_string(&FolderSource::Official).unwrap(),
            "\"official\""
        );
        assert_eq!(
            serde_json::to_string(&FolderSource::None).unwrap(),
            "\"none\""
        );
    }

    #[test]
    fn loading_drops_anything_that_is_not_well_formed() {
        let entry =
            |id: &str, kind, name: &str, url: Option<&str>, realm: Option<&str>| ServerEntry {
                id: id.into(),
                kind,
                name: name.into(),
                backend_url: url.map(str::to_string),
                realm_name: realm.map(str::to_string),
                game_exe_path: Some(
                    "D:\\Games\\X\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe".into(),
                ),
                host_public_key: None,
            };
        let list = ServerList::sanitized(
            Some("l1".into()),
            vec![
                entry(
                    "l1",
                    ServerKind::Local,
                    " Local ",
                    Some("https://Realm.example.com/"),
                    Some("junk"),
                ),
                entry(
                    "l1",
                    ServerKind::Local,
                    "Duplicate id",
                    Some("https://b.example.com"),
                    None,
                ),
                entry(
                    "official",
                    ServerKind::Local,
                    "Fake official",
                    Some("https://c.example.com"),
                    None,
                ),
                entry("o2", ServerKind::Official, "Second official", None, None),
                entry(
                    "bad id!",
                    ServerKind::Local,
                    "Bad id",
                    Some("https://d.example.com"),
                    None,
                ),
                entry(
                    "l3",
                    ServerKind::Local,
                    "Plain http",
                    Some("http://e.example.com"),
                    None,
                ),
                entry(
                    "l4",
                    ServerKind::Local,
                    "Path",
                    Some("https://f.example.com/api"),
                    None,
                ),
                entry(
                    "l5",
                    ServerKind::Local,
                    "",
                    Some("https://g.example.com"),
                    None,
                ),
                entry(
                    "r1",
                    ServerKind::ParadoxRealm,
                    "Realm",
                    Some("https://x.example.com"),
                    Some("ember-hold"),
                ),
                entry(
                    "r2",
                    ServerKind::ParadoxRealm,
                    "Bad realm",
                    None,
                    Some("Ember Hold"),
                ),
            ],
        );
        let ids: Vec<&str> = list.servers.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["l1", "r1"]);
        let local = list.find("l1").unwrap();
        assert_eq!(local.name, "Local");
        assert_eq!(
            local.backend_url.as_deref(),
            Some("https://realm.example.com")
        );
        assert_eq!(local.realm_name, None);
        let realm = list.find("r1").unwrap();
        assert_eq!(realm.backend_url, None);
        assert_eq!(list.selected_id, "l1");

        // A selection that does not survive falls back to official.
        let list = ServerList::sanitized(Some("l9".into()), Vec::new());
        assert_eq!(list.selected_id, OFFICIAL_ID);
        let list = ServerList::sanitized(None, Vec::new());
        assert_eq!(list.selected_id, OFFICIAL_ID);
    }

    #[test]
    fn host_keys_follow_the_directory_shape() {
        for good in [
            "KEY-0123456789abcdef",
            "  abcdEF0123456789+/_=-  ",
            "k".repeat(512).as_str(),
        ] {
            assert!(validate_host_key(good).is_ok(), "{good}");
        }
        assert_eq!(
            validate_host_key("  abcdEF0123456789+/_=-  ").unwrap(),
            "abcdEF0123456789+/_=-"
        );
        for bad in [
            "",
            "short-key",
            "k".repeat(15).as_str(),
            "k".repeat(513).as_str(),
            "has space in the middle",
            "bad!characters-here-1234",
            "unicode-\u{e9}-key-1234567",
        ] {
            assert!(validate_host_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn fingerprints_show_the_ends_of_long_keys_only() {
        assert_eq!(key_fingerprint("0123456789abcdef"), "0123456789abcdef");
        assert_eq!(
            key_fingerprint("KEY-0123456789abcdefghijklmnop"),
            "KEY-0123…ijklmnop"
        );
    }

    #[test]
    fn only_a_realm_takes_a_host_key_and_a_bad_one_is_dropped_on_load() {
        let mut list = ServerList::default();
        list.add(local("My PC", "https://realm.example.com"), "a1".into())
            .unwrap();
        list.add(realm("Realm", "ember-hold"), "a2".into()).unwrap();
        assert_eq!(list.find("a2").unwrap().host_public_key, None);

        assert!(list.set_host_key("a1", "KEY-0123456789abcdef").is_err());
        assert!(list
            .set_host_key(OFFICIAL_ID, "KEY-0123456789abcdef")
            .is_err());
        assert!(list
            .set_host_key("missing", "KEY-0123456789abcdef")
            .is_err());
        assert!(list.set_host_key("a2", "too short").is_err());
        assert_eq!(list.find("a2").unwrap().host_public_key, None);
        list.set_host_key("a2", " KEY-0123456789abcdef ").unwrap();
        assert_eq!(
            list.find("a2").unwrap().host_public_key.as_deref(),
            Some("KEY-0123456789abcdef")
        );

        // On load: a valid key survives on a realm, a malformed one is dropped (the entry stays), and a local
        // server never keeps one.
        let kept = ServerList::sanitized(
            None,
            vec![
                ServerEntry {
                    id: "r1".into(),
                    kind: ServerKind::ParadoxRealm,
                    name: "Realm".into(),
                    backend_url: None,
                    realm_name: Some("ember-hold".into()),
                    game_exe_path: None,
                    host_public_key: Some("KEY-0123456789abcdef".into()),
                },
                ServerEntry {
                    id: "r2".into(),
                    kind: ServerKind::ParadoxRealm,
                    name: "Other".into(),
                    backend_url: None,
                    realm_name: Some("other-hold".into()),
                    game_exe_path: None,
                    host_public_key: Some("nope".into()),
                },
                ServerEntry {
                    id: "l1".into(),
                    kind: ServerKind::Local,
                    name: "Local".into(),
                    backend_url: Some("https://local.example.com".into()),
                    realm_name: None,
                    game_exe_path: None,
                    host_public_key: Some("KEY-0123456789abcdef".into()),
                },
            ],
        );
        assert_eq!(
            kept.find("r1").unwrap().host_public_key.as_deref(),
            Some("KEY-0123456789abcdef")
        );
        assert_eq!(kept.find("r2").unwrap().host_public_key, None);
        assert_eq!(kept.find("l1").unwrap().host_public_key, None);
        assert_eq!(kept.servers.len(), 3);
    }

    #[test]
    fn kinds_serialise_as_the_wire_names() {
        assert_eq!(
            serde_json::to_string(&ServerKind::ParadoxRealm).unwrap(),
            "\"paradox_realm\""
        );
        assert_eq!(
            serde_json::to_string(&ServerKind::Local).unwrap(),
            "\"local\""
        );
        assert_eq!(
            serde_json::to_string(&ServerKind::Official).unwrap(),
            "\"official\""
        );
        assert!(ServerKind::Official.uses_official_feed());
        assert!(ServerKind::ParadoxRealm.uses_official_feed());
        assert!(!ServerKind::Local.uses_official_feed());
        let request: NewServer = serde_json::from_str(
            r#"{"kind":"local","name":"A","backendUrl":"https://a.example.com"}"#,
        )
        .unwrap();
        assert_eq!(request.kind, Some(ServerKind::Local));
        assert_eq!(
            request.backend_url.as_deref(),
            Some("https://a.example.com")
        );
    }
}
