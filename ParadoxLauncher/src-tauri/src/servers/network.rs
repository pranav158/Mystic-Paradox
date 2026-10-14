// [2026-10-13 realms S5] What each kind of server may touch. One table answers "does this call belong to the Mystic
// Paradox network?" for the whole launcher, so a call is routed or skipped by what the server IS, never by an ad hoc
// check at the call site. The auth scope (`auth/scope.rs`) and the Play flow (`commands/launch.rs`) both read it.
use super::model::ServerKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkRules {
    /// Sign-in, refresh, policy, status, game tickets and every authenticated launcher call go to OUR backend with the
    /// official session. `false`: the server's own backend, with a session of its own.
    pub official_backend: bool,
    /// Our signed runtime feed may write into this server's folder.
    pub runtime_feed: bool,
    /// Guard sessions and heartbeats (module lists, hashes) are sent to our backend for this server's game.
    pub guard: bool,
    /// The co-op transport and the P2P control loop may be switched on.
    pub coop: bool,
    /// The server's policy may choose the diagnostics profile and switch diagnostic flags on in the game folder.
    /// A foreign server never gets to: it is not an authority over this PC's runtime.
    pub server_diagnostics: bool,
    /// Session logs may be uploaded to our backend.
    pub log_upload: bool,
    /// Discord sign-in (it belongs to the official account system).
    pub discord: bool,
    /// The LOCAL SERVER WARNING must be accepted before anything is sent to the server.
    pub warning_required: bool,
}

const OUR_NETWORK: NetworkRules = NetworkRules {
    official_backend: true,
    runtime_feed: true,
    guard: true,
    coop: true,
    server_diagnostics: true,
    log_upload: true,
    discord: true,
    warning_required: false,
};

const OWN_NETWORK: NetworkRules = NetworkRules {
    official_backend: false,
    runtime_feed: false,
    guard: false,
    coop: false,
    server_diagnostics: false,
    log_upload: false,
    discord: false,
    warning_required: true,
};

impl ServerKind {
    /// The official server and Paradox realms use our backend and our feed (a realm plays from the official install
    /// unless it has a folder of its own).
    /// A local server is the player's own: nothing of ours is sent to it and nothing of it is sent to us.
    pub const fn network_rules(self) -> NetworkRules {
        match self {
            ServerKind::Official | ServerKind::ParadoxRealm => OUR_NETWORK,
            ServerKind::Local => OWN_NETWORK,
        }
    }
}

/// Why Play is off for a server whatever its folder holds: a local server's warning has not been accepted yet.
pub const WARNING_NOT_ACCEPTED: &str =
    "Read and accept the local server warning before playing here.";

pub fn play_block_reason(kind: ServerKind, warning_accepted: bool) -> Option<&'static str> {
    (kind.network_rules().warning_required && !warning_accepted).then_some(WARNING_NOT_ACCEPTED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_and_realm_use_our_network_in_full() {
        for kind in [ServerKind::Official, ServerKind::ParadoxRealm] {
            let rules = kind.network_rules();
            assert!(rules.official_backend, "{kind:?}");
            assert!(rules.runtime_feed && rules.guard && rules.coop, "{kind:?}");
            assert!(
                rules.server_diagnostics && rules.log_upload && rules.discord,
                "{kind:?}"
            );
            assert!(!rules.warning_required, "{kind:?}");
        }
    }

    #[test]
    fn a_local_server_gets_nothing_of_ours_and_needs_the_warning_first() {
        let rules = ServerKind::Local.network_rules();
        assert!(!rules.official_backend);
        assert!(
            !rules.runtime_feed,
            "our feed never writes into a local folder"
        );
        assert!(
            !rules.guard,
            "no Guard session or heartbeat reaches our backend"
        );
        assert!(!rules.coop, "no co-op transport or P2P presence");
        assert!(
            !rules.server_diagnostics,
            "a foreign server does not set this PC's diagnostics"
        );
        assert!(!rules.log_upload, "local sessions are never uploaded to us");
        assert!(
            !rules.discord,
            "Discord belongs to the official account system"
        );
        assert!(rules.warning_required);
    }

    #[test]
    fn the_feed_rule_matches_the_older_feed_question() {
        for kind in [
            ServerKind::Official,
            ServerKind::ParadoxRealm,
            ServerKind::Local,
        ] {
            assert_eq!(kind.uses_official_feed(), kind.network_rules().runtime_feed);
        }
    }

    #[test]
    fn play_is_blocked_only_for_an_unaccepted_local_warning() {
        assert_eq!(
            play_block_reason(ServerKind::Local, false),
            Some(WARNING_NOT_ACCEPTED)
        );
        assert_eq!(play_block_reason(ServerKind::Local, true), None);
        assert_eq!(play_block_reason(ServerKind::Official, false), None);
        assert_eq!(play_block_reason(ServerKind::ParadoxRealm, false), None);
    }
}
