// [2026-10-13 realms S5] Which backend, and which saved session, one launcher call belongs to.
//
// The launcher signs in to the SELECTED server's backend:
//   * official and Paradox realms -> the official backend and the original saved session (a realm is played with the
//     official account);
//   * a local server              -> that server's own backend (`backendUrl`) and a session stored under that server's
//     id, so the two never mix: an official token is never sent to a local server, a local token never to the
//     official one.
// Everything that needs a base URL or a token store asks an `AuthScope`; no call site picks either by itself.
use crate::commands::auth::api_base_url;
use crate::servers::model::{is_valid_id, ServerList, OFFICIAL_ID};
use crate::servers::{is_official_backend_address, normalize_backend_url, ServerEntry, ServerKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthScope {
    /// The official backend, with the session saved since before the server list existed.
    Official,
    /// A local server: its own backend, and a session saved under its id.
    Local { id: String, base_url: String },
}

/// Where a scope keeps its refresh token: a Credential Manager entry (the user part of the name) and the DPAPI
/// file used when the Credential Manager is unavailable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreNames {
    pub credential_user: String,
    pub fallback_file: String,
}

/// The official names are the ones used since the first launcher, so existing sign-ins survive.
const OFFICIAL_CREDENTIAL_USER: &str = "refresh-token";
const OFFICIAL_FALLBACK_FILE: &str = "session.dpapi";

pub const SERVER_CHANGED: &str = "The selected server changed. Please try again.";

impl AuthScope {
    /// The scope of a server entry. Official and Paradox realms share the official scope. A local entry must carry a
    /// well-formed id and a canonical backend address that is not the official one: the list is validated on load, and
    /// this is the second check right where tokens are routed.
    pub fn from_entry(entry: &ServerEntry) -> Result<Self, String> {
        match entry.kind {
            ServerKind::Official | ServerKind::ParadoxRealm => Ok(AuthScope::Official),
            ServerKind::Local => {
                if !is_valid_id(&entry.id) {
                    return Err("That server has an invalid id.".to_string());
                }
                let url = entry.backend_url.as_deref().unwrap_or("");
                if normalize_backend_url(url).as_deref() != Ok(url) {
                    return Err("That server's address is not valid.".to_string());
                }
                if is_official_backend_address(url, api_base_url()) {
                    return Err(
                        "That is the official Mystic Paradox address. Use the built-in official server instead."
                            .to_string(),
                    );
                }
                Ok(AuthScope::Local {
                    id: entry.id.clone(),
                    base_url: url.to_string(),
                })
            }
        }
    }

    pub fn is_official(&self) -> bool {
        matches!(self, AuthScope::Official)
    }

    /// The scope's identity for per-scope caches and fences: `official`, or the local server's id (never `official`).
    pub fn key(&self) -> &str {
        match self {
            AuthScope::Official => OFFICIAL_ID,
            AuthScope::Local { id, .. } => id,
        }
    }

    /// The backend every call of this scope goes to, as `scheme://host[:port]`.
    pub fn base_url(&self) -> &str {
        match self {
            AuthScope::Official => api_base_url(),
            AuthScope::Local { base_url, .. } => base_url,
        }
    }

    pub fn store_names(&self) -> StoreNames {
        match self {
            AuthScope::Official => StoreNames {
                credential_user: OFFICIAL_CREDENTIAL_USER.to_string(),
                fallback_file: OFFICIAL_FALLBACK_FILE.to_string(),
            },
            AuthScope::Local { id, .. } => StoreNames {
                credential_user: format!("{OFFICIAL_CREDENTIAL_USER}:{id}"),
                fallback_file: format!("session-{id}.dpapi"),
            },
        }
    }

    /// "the Mystic Paradox account server" or "this server", for messages that must not call a local server ours.
    pub fn pick<'a>(&self, official: &'a str, local: &'a str) -> &'a str {
        if self.is_official() {
            official
        } else {
            local
        }
    }
}

/// The scope of the selected server. `requested` is the server the UI says it is showing: when it is not the selected
/// one the call is refused, so a sign-in form typed for one server can never be sent to another.
pub fn scope_for(list: &ServerList, requested: Option<&str>) -> Result<AuthScope, String> {
    let selected = list.effective_selected_id();
    if requested.is_some_and(|id| id != selected) {
        return Err(SERVER_CHANGED.to_string());
    }
    if selected == OFFICIAL_ID {
        return Ok(AuthScope::Official);
    }
    let entry = list
        .find(selected)
        .ok_or_else(|| "That server is not in your list.".to_string())?;
    AuthScope::from_entry(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::model::NewServer;

    fn list() -> ServerList {
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
                kind: Some(ServerKind::Local),
                name: Some("Friends".into()),
                backend_url: Some("http://127.0.0.1:4000".into()),
                realm_name: None,
            },
            "s-cccccccccccc".into(),
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
    fn official_and_realm_use_the_official_backend_and_the_original_session() {
        let mut list = list();
        assert_eq!(scope_for(&list, None).unwrap(), AuthScope::Official);
        list.select("s-bbbbbbbbbbbb").unwrap();
        let realm = scope_for(&list, None).unwrap();
        assert_eq!(
            realm,
            AuthScope::Official,
            "a realm is played with the official account"
        );
        assert_eq!(realm.base_url(), api_base_url());
        assert_eq!(realm.key(), "official");
        // The names of the sign-in stored since the first launcher are unchanged.
        assert_eq!(
            realm.store_names(),
            StoreNames {
                credential_user: "refresh-token".into(),
                fallback_file: "session.dpapi".into()
            }
        );
    }

    #[test]
    fn a_local_server_uses_its_own_backend_and_its_own_session() {
        let mut list = list();
        list.select("s-aaaaaaaaaaaa").unwrap();
        let local = scope_for(&list, None).unwrap();
        assert_eq!(local.base_url(), "https://realm.example.com:8443");
        assert_ne!(local.base_url(), api_base_url());
        assert_eq!(local.key(), "s-aaaaaaaaaaaa");
        assert!(!local.is_official());
        let names = local.store_names();
        assert_eq!(names.credential_user, "refresh-token:s-aaaaaaaaaaaa");
        assert_eq!(names.fallback_file, "session-s-aaaaaaaaaaaa.dpapi");
        assert_ne!(names, AuthScope::Official.store_names());
    }

    #[test]
    fn two_local_servers_never_share_a_session_or_a_backend() {
        let mut list = list();
        list.select("s-aaaaaaaaaaaa").unwrap();
        let first = scope_for(&list, None).unwrap();
        list.select("s-cccccccccccc").unwrap();
        let second = scope_for(&list, None).unwrap();
        assert_ne!(first.key(), second.key());
        assert_ne!(first.base_url(), second.base_url());
        assert_ne!(first.store_names(), second.store_names());
        assert_eq!(second.base_url(), "http://127.0.0.1:4000");
    }

    #[test]
    fn the_official_scope_key_can_never_be_a_local_servers() {
        // `official` is not a valid id for a stored server, so no local scope can ever take the official key or names.
        let entry = ServerEntry {
            id: "official".into(),
            kind: ServerKind::Local,
            name: "Imposter".into(),
            backend_url: Some("https://realm.example.com".into()),
            realm_name: None,
            game_exe_path: None,
            host_public_key: None,
        };
        assert!(AuthScope::from_entry(&entry).is_err());
        for bad in ["", "S-UPPER", "s-a b", "s-../x", "s-a\\b"] {
            let entry = ServerEntry {
                id: bad.into(),
                ..entry.clone()
            };
            assert!(AuthScope::from_entry(&entry).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_local_entry_with_a_hand_edited_address_is_refused() {
        let entry = |url: &str| ServerEntry {
            id: "s-aaaaaaaaaaaa".into(),
            kind: ServerKind::Local,
            name: "x".into(),
            backend_url: Some(url.into()),
            realm_name: None,
            game_exe_path: None,
            host_public_key: None,
        };
        assert!(AuthScope::from_entry(&entry("https://realm.example.com")).is_ok());
        for bad in [
            "",
            "realm.example.com",
            "http://realm.example.com",
            "https://realm.example.com/path",
            "https://user@realm.example.com",
            "https://REALM.example.com",
        ] {
            assert!(AuthScope::from_entry(&entry(bad)).is_err(), "{bad:?}");
        }
        let mut no_url = entry("");
        no_url.backend_url = None;
        assert!(AuthScope::from_entry(&no_url).is_err());
    }

    #[test]
    fn the_official_address_cannot_become_a_local_scope() {
        // A release build points at the address it was built with (the official one: https://paradox.mysticfox.dev);
        // a debug build's loopback API is a developer's own.
        let official = api_base_url();
        let entry = ServerEntry {
            id: "s-aaaaaaaaaaaa".into(),
            kind: ServerKind::Local,
            name: "x".into(),
            backend_url: Some(official.to_string()),
            realm_name: None,
            game_exe_path: None,
            host_public_key: None,
        };
        let refused = AuthScope::from_entry(&entry).is_err();
        assert_eq!(refused, !official.starts_with("http://"));
        // The check itself, with the production address.
        assert!(is_official_backend_address(
            "https://paradox.mysticfox.dev",
            "https://paradox.mysticfox.dev"
        ));
    }

    #[test]
    fn a_form_typed_for_another_server_is_refused() {
        let mut list = list();
        list.select("s-aaaaaaaaaaaa").unwrap();
        assert!(scope_for(&list, Some("s-aaaaaaaaaaaa")).is_ok());
        assert_eq!(
            scope_for(&list, Some("official")).unwrap_err(),
            SERVER_CHANGED
        );
        assert_eq!(
            scope_for(&list, Some("s-cccccccccccc")).unwrap_err(),
            SERVER_CHANGED
        );
        list.select(OFFICIAL_ID).unwrap();
        assert_eq!(
            scope_for(&list, Some("s-aaaaaaaaaaaa")).unwrap_err(),
            SERVER_CHANGED
        );
        assert!(scope_for(&list, Some("official")).is_ok());
    }

    #[test]
    fn a_selection_that_no_longer_exists_falls_back_to_the_official_scope() {
        let mut list = list();
        list.selected_id = "s-gone".into();
        assert_eq!(scope_for(&list, None).unwrap(), AuthScope::Official);
        assert_eq!(
            scope_for(&list, Some("official")).unwrap(),
            AuthScope::Official
        );
    }
}
