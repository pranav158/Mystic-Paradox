//! [2026-10-14] A realm's hub on the host's PC and the sessions around it (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md
//! §4, §6.1): which kind of session a bootstrap asks for, what the host bundle must do differently for it, the peer
//! list of a running hub (members come and go while it runs, so the host's launcher keeps the transport module's roster
//! equal to the backend's list) and the live facts the realm panel shows. Pure rules first (tested), then the thread.

use super::*;
use crate::commands::auth::send_authorized;
use std::collections::{BTreeMap, HashSet};

/// A hub holds up to this many remote peers (the module's limit for `session_role=HUB`); a hunt up to 4.
pub(super) const MAX_HUB_PEERS: usize = 64;
pub(super) const MAX_HUNT_PEERS: usize = 4;
/// How often a running hub re-reads its peer list when nothing told it to hurry (`REALM_PEER_EXPECTED`).
pub(super) const PEER_SYNC_INTERVAL: Duration = Duration::from_secs(5);
/// A failing peer sync logs its first failure and then once in this many.
const SYNC_FAILURE_LOG_EVERY: u32 = 12;
/// What the transport module is told when the backend no longer lists a member.
const PEER_REMOVE_REASON: &str = "not_expected";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum HubKind {
    Ramsgate,
    Training,
}

impl HubKind {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "RAMSGATE" => Some(Self::Ramsgate),
            "TRAINING" => Some(Self::Training),
            _ => None,
        }
    }

    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Ramsgate => "RAMSGATE",
            Self::Training => "TRAINING",
        }
    }
}

/// What a registered supervisor is: a host or a join, of a hunt or of a realm's hub.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionKind {
    HuntHost,
    HuntJoin,
    HubHost,
    HubJoin,
}

impl SessionKind {
    pub(crate) fn is_host(self) -> bool {
        matches!(self, Self::HuntHost | Self::HubHost)
    }

    pub(crate) fn is_hub(self) -> bool {
        matches!(self, Self::HubHost | Self::HubJoin)
    }

    pub(crate) fn join_of(hub: bool) -> Self {
        if hub {
            Self::HubJoin
        } else {
            Self::HuntJoin
        }
    }
}

/// `CommonBootstrap::session_kind` of a realm hub.
pub(super) const HUB_SESSION_KIND: &str = "REALM_HUB";
/// Its default, a hunt.
pub(super) const HUNT_SESSION_KIND: &str = "HUNT";

/// What the host bundle does for one bootstrap, decided once from the backend's answer.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct HostPlan {
    pub kind: SessionKind,
    pub hub_kind: Option<HubKind>,
    /// The host PC's own client plays this session through a local bridge (a host ticket, a local route and the
    /// route-ready call). False for a realm hunt the host does not take part in.
    pub local_client: bool,
    /// The transport publishes hunt evidence for this session (needs an actor account: the local client's).
    pub hunt_evidence: bool,
    pub maximum_peers: usize,
    /// The runtime's player cap (`MYSTICPARADOX_MAX_PLAYERS`), hubs only.
    pub max_players: Option<u32>,
}

impl HostPlan {
    /// A hub, or a session without the host's client, needs the module's version 3 (session role, no host ticket).
    pub(super) fn needs_handle_module(&self) -> bool {
        self.kind == SessionKind::HubHost || !self.local_client
    }
}

/// Checks a host bootstrap's bindings and decides what the bundle does. Old backends (no hub fields) get exactly
/// today's hunt plan.
pub(super) fn plan_host(bootstrap: &HostBootstrap) -> Result<HostPlan, String> {
    let invalid = || "The host bootstrap bindings are invalid.".to_string();
    let common = &bootstrap.common;
    if common.session_id.is_empty() || common.generation == 0 || bootstrap.server_udp_port == 0 {
        return Err(invalid());
    }
    match common.session_kind.as_str() {
        HUB_SESSION_KIND => {
            let hub_kind = common
                .hub_kind
                .as_deref()
                .and_then(HubKind::parse)
                .ok_or_else(invalid)?;
            // A hub produces no hunt evidence and never completes; its host plays it through its own client, which is
            // what takes the hub to RUNNING on the backend.
            if !(1..=MAX_HUB_PEERS).contains(&bootstrap.maximum_peers)
                || common.guard_completion_mode != "NO_COMPLETION"
                || !common.host_local_client
                || common
                    .max_players
                    .is_some_and(|players| !(1..=MAX_HUB_PEERS as u32).contains(&players))
            {
                return Err(invalid());
            }
            Ok(HostPlan {
                kind: SessionKind::HubHost,
                hub_kind: Some(hub_kind),
                local_client: true,
                hunt_evidence: false,
                maximum_peers: bootstrap.maximum_peers,
                max_players: Some(common.max_players.unwrap_or(bootstrap.maximum_peers as u32)),
            })
        }
        HUNT_SESSION_KIND => {
            // NO_COMPLETION: Training hosted P2P (11 Oct) - a no-reward session; the runtime's Hunt Guard never
            // requests completion for it and the backend refuses Guard completion and host grants in that mode.
            if !(1..=MAX_HUNT_PEERS).contains(&bootstrap.maximum_peers)
                || !matches!(
                    common.guard_completion_mode.as_str(),
                    "FIRST_DEFEAT" | "END_OF_HUNT" | "NO_COMPLETION"
                )
            {
                return Err(invalid());
            }
            // A realm hunt whose host does not take part: no host ticket, no local bridge, no route-ready, and no
            // evidence (the transport would publish it with no actor account).
            let local_client = common.host_participates && common.host_local_client;
            Ok(HostPlan {
                kind: SessionKind::HuntHost,
                hub_kind: None,
                local_client,
                hunt_evidence: common.evidence_collection && local_client,
                maximum_peers: bootstrap.maximum_peers,
                max_players: None,
            })
        }
        _ => Err(invalid()),
    }
}

// ---- peer events ---------------------------------------------------------------------------------------------------

/// A line of `ReadPeerEventH`: `PEER_ADMITTED account=<id> route=relay|direct` and its kin.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PeerEvent {
    Connected {
        account: String,
        route: Option<String>,
    },
    Admitted {
        account: String,
        route: Option<String>,
    },
    Lost {
        account: String,
        reason: Option<String>,
    },
    Removed {
        account: String,
        reason: Option<String>,
        admitted: bool,
    },
    AddRejected {
        account: String,
        reason: Option<String>,
    },
}

pub(crate) fn parse_peer_event(line: &str) -> Option<PeerEvent> {
    let mut tokens = line.split_whitespace();
    let kind = tokens.next()?;
    let fields: HashMap<&str, &str> = tokens.filter_map(|token| token.split_once('=')).collect();
    let account = fields.get("account")?.to_string();
    let text = |key: &str| fields.get(key).map(|value| value.to_string());
    Some(match kind {
        "PEER_CONNECTED" => PeerEvent::Connected {
            account,
            route: text("route"),
        },
        "PEER_ADMITTED" => PeerEvent::Admitted {
            account,
            route: text("route"),
        },
        "PEER_LOST" => PeerEvent::Lost {
            account,
            reason: text("reason"),
        },
        "PEER_REMOVED" => PeerEvent::Removed {
            account,
            reason: text("reason"),
            admitted: fields.get("admitted") == Some(&"1"),
        },
        "PEER_ADD_REJECTED" => PeerEvent::AddRejected {
            account,
            reason: text("reason"),
        },
        _ => return None,
    })
}

/// A member of a session this launcher hosts, as the transport reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PeerLive {
    pub route: Option<String>,
    pub since: String,
}

/// The AFK limit the realm host chose for its hub (`MYSTICPARADOX_HUB_AFK_SECONDS`), None for the runtime's default.
/// Set by the realm host before its hub starts (`realm.rs`); a Training hub started on demand reads it too.
static HUB_AFK_SECONDS: Mutex<Option<u32>> = Mutex::new(None);

pub(crate) fn set_hub_afk_seconds(seconds: Option<u32>) {
    if let Ok(mut value) = HUB_AFK_SECONDS.lock() {
        *value = seconds;
    }
}

pub(crate) fn hub_afk_seconds() -> Option<u32> {
    HUB_AFK_SECONDS.lock().ok().and_then(|value| *value)
}

/// What the realm panel may show about a session this launcher hosts, kept current by the host supervisor.
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionLive {
    /// The hunt or hub's id as the client knows it (`ShatteredIsles_ReturnToRamsgate`).
    pub hunt_id: String,
    pub started_at: Option<String>,
    /// Admitted peers by account (the host's own client is not a peer).
    pub peers: BTreeMap<String, PeerLive>,
    /// When the relay credential this session started with stops working (RFC 3339), if the backend said.
    pub relay_expires_at: Option<String>,
    /// [2026-10-15] When the transport last admitted this PC's own game to the session (`is_local_admission`), RFC 3339.
    /// None when it never did. The realm panel lists the host there (realm.rs `host_place`).
    pub local_since: Option<String>,
}

pub(crate) type SharedLive = Arc<Mutex<SessionLive>>;

pub(crate) fn apply_peer_event(live: &mut SessionLive, event: &PeerEvent, now_iso: &str) {
    match event {
        PeerEvent::Admitted { account, route } => {
            live.peers.insert(
                account.clone(),
                PeerLive {
                    route: route.clone(),
                    since: now_iso.to_string(),
                },
            );
        }
        PeerEvent::Lost { account, .. } | PeerEvent::Removed { account, .. } => {
            live.peers.remove(account);
        }
        PeerEvent::Connected { .. } | PeerEvent::AddRejected { .. } => {}
    }
}

/// [2026-10-15] `ADMISSION_ACCEPTED role=host peer=<n> source=local`: the transport admitted this PC's own game through the
/// local bridge. The line carries no account id (the host's is the signed-in one), so only the fact is read.
pub(crate) fn is_local_admission(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    if tokens.next() != Some("ADMISSION_ACCEPTED") {
        return false;
    }
    let fields: Vec<&str> = tokens.collect();
    fields.contains(&"role=host") && fields.contains(&"source=local")
}

/// [2026-10-14] Applies one line the module queued for a host session to its live state. `pump` calls it for every line it
/// drains, and the realm status reads the result, so the two cannot drift apart. A line that is not a peer event changes
/// nothing.
pub(crate) fn apply_peer_line(live: &SharedLive, line: &str, now_iso: &str) {
    if is_local_admission(line) {
        if let Ok(mut live) = live.lock() {
            live.local_since = Some(now_iso.to_string());
        }
        return;
    }
    let Some(event) = parse_peer_event(line) else {
        return;
    };
    if let Ok(mut live) = live.lock() {
        apply_peer_event(&mut live, &event, now_iso);
    }
}

// ---- the peer list -------------------------------------------------------------------------------------------------

/// One row of `POST /launcher/v1/p2p/hunts/:sessionId/peers`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PeerListEntry {
    pub account_id: String,
    pub peer_id: String,
    pub transport_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PeerList {
    pub generation: u32,
    #[serde(default)]
    pub peers: Vec<PeerListEntry>,
}

/// A member the host's transport roster should hold, validated like a transport-config peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WantedPeer {
    pub account_id: String,
    pub peer_id: u64,
    pub transport_key: String,
}

/// The valid rows of a peer list as wanted peers, and how many rows were refused (a row with an unsafe account id,
/// peer id or key never reaches the module; the host account itself is never a peer).
pub(super) fn wanted_peers(
    entries: &[PeerListEntry],
    host_account_id: Option<&str>,
) -> (Vec<WantedPeer>, usize) {
    let mut wanted = Vec::new();
    let mut refused = 0;
    for entry in entries.iter().take(MAX_HUB_PEERS) {
        let peer_id = entry
            .peer_id
            .parse::<u64>()
            .ok()
            .filter(|_| ice::safe_peer_id(&entry.peer_id));
        match peer_id {
            Some(peer_id)
                if ice::safe_account(&entry.account_id)
                    && ice::safe_key(&entry.transport_key)
                    && Some(entry.account_id.as_str()) != host_account_id =>
            {
                if !wanted
                    .iter()
                    .any(|other: &WantedPeer| other.account_id == entry.account_id)
                {
                    wanted.push(WantedPeer {
                        account_id: entry.account_id.clone(),
                        peer_id,
                        transport_key: entry.transport_key.clone(),
                    });
                }
            }
            _ => refused += 1,
        }
    }
    (wanted, refused)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PeerDiff {
    /// Wanted and not linked yet.
    pub add: Vec<WantedPeer>,
    /// Linked and no longer wanted (sorted, so the log and the calls are stable).
    pub remove: Vec<String>,
}

/// The roster changes that make the module's peers (`linked`, by account) equal the wanted list.
pub(crate) fn peer_diff(linked: &HashSet<String>, wanted: &[WantedPeer]) -> PeerDiff {
    let add = wanted
        .iter()
        .filter(|peer| !linked.contains(&peer.account_id))
        .cloned()
        .collect();
    let mut remove: Vec<String> = linked
        .iter()
        .filter(|account| !wanted.iter().any(|peer| &peer.account_id == *account))
        .cloned()
        .collect();
    remove.sort();
    PeerDiff { add, remove }
}

/// The roster of a host session (the transport module's `AddPeerH` / `RemovePeerH`), as a trait for the tests.
pub(crate) trait PeerRoster {
    fn add(&self, peer: &WantedPeer) -> bool;
    fn remove(&self, account_id: &str);
}

impl PeerRoster for SessionHandle {
    fn add(&self, peer: &WantedPeer) -> bool {
        self.add_peer(&peer.account_id, peer.peer_id, &peer.transport_key)
    }

    fn remove(&self, account_id: &str) {
        self.remove_peer(account_id, PEER_REMOVE_REASON);
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SyncOutcome {
    pub added: usize,
    pub removed: usize,
    /// Accounts the module refused (a full roster, a duplicate): they stay unlinked and are tried again next sync.
    pub refused: Vec<String>,
}

/// Applies a diff to the roster and to `linked`. A refused add leaves the account unlinked, so the next sync tries
/// it again; a removal always unlinks (the module answers false only for an account it no longer holds).
pub(crate) fn apply_peer_diff(
    roster: &impl PeerRoster,
    linked: &mut HashSet<String>,
    diff: PeerDiff,
) -> SyncOutcome {
    let mut outcome = SyncOutcome::default();
    for peer in &diff.add {
        if roster.add(peer) {
            linked.insert(peer.account_id.clone());
            outcome.added += 1;
        } else {
            outcome.refused.push(peer.account_id.clone());
        }
    }
    for account in &diff.remove {
        roster.remove(account);
        linked.remove(account);
        outcome.removed += 1;
    }
    outcome
}

// ---- the sync thread ------------------------------------------------------------------------------------------------

pub(crate) enum SyncCommand {
    /// Sync now (a member is expected, or was removed).
    Now,
    Stop,
}

pub(super) fn fetch_peer_list(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
) -> Result<PeerList, String> {
    let url = format!(
        "{}/launcher/v1/p2p/hunts/{session_id}/peers",
        api_base_url()
    );
    let body = serde_json::json!({ "generation": generation });
    let response = send_authorized(app, |token| {
        http_client()?
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|_| "Couldn't read the hub's peer list.".to_string())
    })?;
    if !response.status().is_success() {
        return Err(safe_api_error(response, "The hub's peer list was refused."));
    }
    let list: PeerList = response
        .json()
        .map_err(|_| "The backend returned an invalid peer list.".to_string())?;
    if list.generation != generation {
        return Err("The peer list belongs to another hub generation.".to_string());
    }
    Ok(list)
}

/// Runs the host's peer sync for a hub: every `PEER_SYNC_INTERVAL` and whenever a `SyncCommand::Now` arrives it reads
/// the backend's list, diffs it against the module's roster and applies the difference. The supervisor stops it (and
/// joins it) before it stops the transport session: every module call happens while the session is registered.
pub(super) fn spawn_peer_sync(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
    handle: SessionHandle,
    host_account_id: Option<String>,
    log: &SharedLog,
) -> (mpsc::Sender<SyncCommand>, std::thread::JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel();
    let app = app.clone();
    let session_id = session_id.to_string();
    let log = Arc::clone(log);
    let join = std::thread::spawn(move || {
        let mut linked: HashSet<String> = HashSet::new();
        let mut failures = 0u32;
        loop {
            match receiver.recv_timeout(PEER_SYNC_INTERVAL) {
                Ok(SyncCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Ok(SyncCommand::Now) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Triggers that queued up while the last sync ran are one sync.
            while let Ok(command) = receiver.try_recv() {
                if matches!(command, SyncCommand::Stop) {
                    return;
                }
            }
            match fetch_peer_list(&app, &session_id, generation) {
                Ok(list) => {
                    failures = 0;
                    let (wanted, refused_rows) =
                        wanted_peers(&list.peers, host_account_id.as_deref());
                    if refused_rows > 0 {
                        append_log(
                            &log,
                            "launcher",
                            &format!("PEER_SYNC refused={refused_rows} reason=unsafe_peer_row"),
                        );
                    }
                    let diff = peer_diff(&linked, &wanted);
                    let outcome = apply_peer_diff(&handle, &mut linked, diff);
                    if outcome.added > 0 || outcome.removed > 0 {
                        append_log(
                            &log,
                            "launcher",
                            &format!(
                                "PEER_SYNC added={} removed={}",
                                outcome.added, outcome.removed
                            ),
                        );
                    }
                    if !outcome.refused.is_empty() {
                        append_log(
                            &log,
                            "launcher",
                            &format!(
                                "PEER_SYNC add_refused={} (roster full or duplicate; retried next sync)",
                                outcome.refused.len()
                            ),
                        );
                    }
                }
                Err(error) => {
                    if failures.is_multiple_of(SYNC_FAILURE_LOG_EVERY) {
                        append_log(
                            &log,
                            "launcher",
                            &format!("PEER_SYNC_FAILED reason={}", error.replace(' ', "_")),
                        );
                    }
                    failures = failures.saturating_add(1);
                }
            }
        }
    });
    (sender, join)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn bootstrap(extra: serde_json::Value) -> HostBootstrap {
        let hash = |digit: &str| digit.repeat(64);
        let mut value = serde_json::json!({
            "keyId": "key", "sessionId": "session", "partyId": "party", "partyRevision": 1,
            "huntDefinitionId": "hunt", "guardCompletionMode": "FIRST_DEFEAT", "generation": 2,
            "build": 647472, "bridgeProtocol": 1, "virtualPort": 7,
            "hostPeerId": "1001", "bridgeInstanceId": "instance", "metadataNonce": "nonce",
            "forceRelay": false, "coopTransport": "ICE",
            "artifacts": {
                "gameExe": hash("a"), "internalServer": hash("b"), "winmmProxy": hash("c"),
                "transportModule": hash("d"), "transportRuntime": hash("e"),
                "admissionPublicKey": hash("f")
            },
            "capability": "cap", "hostTicket": "ticket", "backendUrl": "https://paradox.example.com",
            "serverUdpPort": 8791, "maximumPeers": 2, "matchmakerHuntId": "Adventure_IslandA",
            "mapPath": "/Game/Maps/a", "behemothPath": "/Game/Monsters/b", "expectedPlayers": "x:y"
        });
        for (key, extra_value) in extra.as_object().unwrap() {
            value[key] = extra_value.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn an_older_backends_bootstrap_is_a_plain_hunt() {
        let plan = plan_host(&bootstrap(serde_json::json!({}))).unwrap();
        assert_eq!(
            plan,
            HostPlan {
                kind: SessionKind::HuntHost,
                hub_kind: None,
                local_client: true,
                hunt_evidence: true,
                maximum_peers: 2,
                max_players: None,
            }
        );
        assert!(!plan.needs_handle_module());
        // The anti-cheat switch of the server is respected as before.
        let plan = plan_host(&bootstrap(serde_json::json!({"evidenceCollection": false}))).unwrap();
        assert!(!plan.hunt_evidence);
    }

    #[test]
    fn a_hub_bootstrap_plans_a_hub_with_its_players() {
        let hub = bootstrap(serde_json::json!({
            "sessionKind": "REALM_HUB", "hubKind": "RAMSGATE", "hubRoomId": "room",
            "maxPlayers": 12, "hostParticipates": true, "hostLocalClient": true,
            "guardCompletionMode": "NO_COMPLETION", "maximumPeers": 12,
            "matchmakerHuntId": "NO_MM_HUNTID", "behemothPath": "NO_BEHEMOTH",
            "expectedPlayers": "NO_EXPECTED_PLAYERS"
        }));
        let plan = plan_host(&hub).unwrap();
        assert_eq!(plan.kind, SessionKind::HubHost);
        assert_eq!(plan.hub_kind, Some(HubKind::Ramsgate));
        assert_eq!(plan.maximum_peers, 12);
        assert_eq!(plan.max_players, Some(12));
        assert!(plan.local_client && !plan.hunt_evidence && plan.needs_handle_module());
        assert_eq!(hub.common.hub_room_id.as_deref(), Some("room"));

        // maxPlayers falls back to the peer cap; Training is a hub too.
        let training = bootstrap(serde_json::json!({
            "sessionKind": "REALM_HUB", "hubKind": "TRAINING", "guardCompletionMode": "NO_COMPLETION",
            "maximumPeers": 64
        }));
        let plan = plan_host(&training).unwrap();
        assert_eq!(plan.hub_kind, Some(HubKind::Training));
        assert_eq!((plan.maximum_peers, plan.max_players), (64, Some(64)));
    }

    #[test]
    fn a_hub_bootstrap_that_breaks_the_hub_rules_is_refused() {
        let hub = |extra: serde_json::Value| {
            let mut base = serde_json::json!({
                "sessionKind": "REALM_HUB", "hubKind": "RAMSGATE",
                "guardCompletionMode": "NO_COMPLETION", "maximumPeers": 8
            });
            for (key, value) in extra.as_object().unwrap() {
                base[key] = value.clone();
            }
            plan_host(&bootstrap(base))
        };
        assert!(hub(serde_json::json!({})).is_ok());
        assert!(hub(serde_json::json!({"hubKind": "CASTLE"})).is_err());
        assert!(hub(serde_json::json!({"hubKind": null})).is_err());
        assert!(hub(serde_json::json!({"maximumPeers": 65})).is_err());
        assert!(hub(serde_json::json!({"maximumPeers": 0})).is_err());
        assert!(hub(serde_json::json!({"maxPlayers": 0})).is_err());
        assert!(hub(serde_json::json!({"maxPlayers": 65})).is_err());
        // A hub never completes, and its route is the host's own client's.
        assert!(hub(serde_json::json!({"guardCompletionMode": "FIRST_DEFEAT"})).is_err());
        assert!(hub(serde_json::json!({"hostLocalClient": false})).is_err());
        assert!(hub(serde_json::json!({"generation": 0})).is_err());
        assert!(hub(serde_json::json!({"serverUdpPort": 0})).is_err());
        // An unknown session kind is never run as a hunt.
        assert!(plan_host(&bootstrap(serde_json::json!({"sessionKind": "SOMETHING"}))).is_err());
    }

    #[test]
    fn a_hunt_the_host_does_not_play_has_no_local_client_and_no_evidence() {
        let away = bootstrap(serde_json::json!({
            "hostParticipates": false, "hostLocalClient": false, "hostTicket": ""
        }));
        let plan = plan_host(&away).unwrap();
        assert_eq!(plan.kind, SessionKind::HuntHost);
        assert!(!plan.local_client && !plan.hunt_evidence && plan.needs_handle_module());
        // Not participating is enough, whatever hostLocalClient says; and a missing ticket parses.
        let away = bootstrap(serde_json::json!({"hostParticipates": false}));
        assert!(!plan_host(&away).unwrap().local_client);
        // Hunts keep their 1..=4 peers and completion modes.
        assert!(plan_host(&bootstrap(serde_json::json!({"maximumPeers": 5}))).is_err());
        assert!(plan_host(&bootstrap(
            serde_json::json!({"guardCompletionMode": "NONE"})
        ))
        .is_err());
    }

    #[test]
    fn peer_events_are_read_by_kind_and_account() {
        assert_eq!(
            parse_peer_event("PEER_ADMITTED account=u-1 route=relay"),
            Some(PeerEvent::Admitted {
                account: "u-1".to_string(),
                route: Some("relay".to_string())
            })
        );
        assert_eq!(
            parse_peer_event("PEER_CONNECTED account=u-1 route=direct"),
            Some(PeerEvent::Connected {
                account: "u-1".to_string(),
                route: Some("direct".to_string())
            })
        );
        assert_eq!(
            parse_peer_event("PEER_LOST account=u-1 reason=link_lost"),
            Some(PeerEvent::Lost {
                account: "u-1".to_string(),
                reason: Some("link_lost".to_string())
            })
        );
        assert_eq!(
            parse_peer_event("PEER_REMOVED account=u-1 reason=not_expected admitted=1"),
            Some(PeerEvent::Removed {
                account: "u-1".to_string(),
                reason: Some("not_expected".to_string()),
                admitted: true
            })
        );
        assert_eq!(
            parse_peer_event("PEER_ADD_REJECTED account=u-2 reason=roster_full"),
            Some(PeerEvent::AddRejected {
                account: "u-2".to_string(),
                reason: Some("roster_full".to_string())
            })
        );
        // A joiner's line has no account; an unknown kind is not an event.
        assert_eq!(parse_peer_event("PEER_ADMITTED route=relay"), None);
        assert_eq!(parse_peer_event("SOMETHING account=u-1"), None);
        assert_eq!(parse_peer_event(""), None);
    }

    /// [2026-10-15] The host's own game is recognised by its admission line and by nothing else: a remote peer's admission
    /// is a peer, and a joiner's or another role's line changes nothing. The time is the last local admission.
    #[test]
    fn the_host_own_game_is_marked_by_its_local_admission() {
        assert!(is_local_admission(
            "ADMISSION_ACCEPTED role=host peer=2 source=local"
        ));
        assert!(!is_local_admission(
            "ADMISSION_ACCEPTED role=host peer=3 source=relay"
        ));
        assert!(!is_local_admission(
            "ADMISSION_ACCEPTED role=join peer=2 source=local"
        ));
        assert!(!is_local_admission("PEER_ADMITTED account=u-1 route=relay"));
        assert_eq!(
            parse_peer_event("ADMISSION_ACCEPTED role=host peer=2 source=local"),
            None
        );

        let live: SharedLive = Arc::new(Mutex::new(SessionLive::default()));
        apply_peer_line(&live, "PEER_ADMITTED account=u-1 route=relay", "t1");
        assert_eq!(live.lock().unwrap().local_since, None);
        let local = "ADMISSION_ACCEPTED role=host peer=2 source=local";
        apply_peer_line(&live, local, "t2");
        apply_peer_line(&live, local, "t3");
        let live = live.lock().unwrap();
        assert_eq!(
            live.local_since.as_deref(),
            Some("t3"),
            "the latest admission counts"
        );
        assert_eq!(live.peers.len(), 1, "the host's own game is not a peer");
    }

    #[test]
    fn live_peers_follow_admission_loss_and_removal() {
        let mut live = SessionLive::default();
        let admitted = |account: &str, route: &str| PeerEvent::Admitted {
            account: account.to_string(),
            route: Some(route.to_string()),
        };
        apply_peer_event(&mut live, &admitted("a", "relay"), "t1");
        apply_peer_event(&mut live, &admitted("b", "direct"), "t2");
        apply_peer_event(
            &mut live,
            &PeerEvent::Connected {
                account: "c".to_string(),
                route: None,
            },
            "t3",
        );
        assert_eq!(live.peers.len(), 2);
        assert_eq!(live.peers["a"].route.as_deref(), Some("relay"));
        apply_peer_event(
            &mut live,
            &PeerEvent::Lost {
                account: "a".to_string(),
                reason: None,
            },
            "t4",
        );
        apply_peer_event(
            &mut live,
            &PeerEvent::Removed {
                account: "b".to_string(),
                reason: None,
                admitted: true,
            },
            "t5",
        );
        assert!(live.peers.is_empty());
    }

    fn wanted(account: &str, peer: u64) -> WantedPeer {
        WantedPeer {
            account_id: account.to_string(),
            peer_id: peer,
            transport_key: "A".repeat(43),
        }
    }

    #[test]
    fn the_diff_adds_the_new_and_removes_the_missing_by_account() {
        let linked: HashSet<String> = ["a", "b", "z"]
            .iter()
            .map(|text| text.to_string())
            .collect();
        let diff = peer_diff(&linked, &[wanted("b", 2), wanted("c", 3), wanted("d", 4)]);
        assert_eq!(diff.add, [wanted("c", 3), wanted("d", 4)]);
        assert_eq!(diff.remove, ["a", "z"]);
        // Nothing to do when the roster already matches (a member who re-enters stays listed and stays linked).
        let same = peer_diff(&linked, &[wanted("a", 1), wanted("b", 2), wanted("z", 26)]);
        assert_eq!(same, PeerDiff::default());
        // From nothing, everything is added; to nothing, everything goes.
        assert_eq!(peer_diff(&HashSet::new(), &[wanted("a", 1)]).add.len(), 1);
        assert_eq!(peer_diff(&linked, &[]).remove, ["a", "b", "z"]);
    }

    #[derive(Default)]
    struct FakeRoster {
        refuse: Vec<String>,
        calls: RefCell<Vec<String>>,
    }

    impl PeerRoster for FakeRoster {
        fn add(&self, peer: &WantedPeer) -> bool {
            self.calls
                .borrow_mut()
                .push(format!("add {}", peer.account_id));
            !self.refuse.contains(&peer.account_id)
        }

        fn remove(&self, account_id: &str) {
            self.calls.borrow_mut().push(format!("remove {account_id}"));
        }
    }

    #[test]
    fn a_refused_add_stays_unlinked_and_is_tried_again() {
        let roster = FakeRoster {
            refuse: vec!["full".to_string()],
            ..Default::default()
        };
        let mut linked: HashSet<String> = ["gone"].iter().map(|text| text.to_string()).collect();
        let wanted_now = [wanted("ok", 1), wanted("full", 2)];
        let diff = peer_diff(&linked, &wanted_now);
        let outcome = apply_peer_diff(&roster, &mut linked, diff);
        assert_eq!(
            outcome,
            SyncOutcome {
                added: 1,
                removed: 1,
                refused: vec!["full".to_string()]
            }
        );
        assert!(linked.contains("ok") && !linked.contains("full") && !linked.contains("gone"));
        assert_eq!(
            *roster.calls.borrow(),
            ["add ok", "add full", "remove gone"]
        );
        // The next sync offers the refused account again and nothing else.
        let again = peer_diff(&linked, &wanted_now);
        assert_eq!(again.add, [wanted("full", 2)]);
        assert!(again.remove.is_empty());
    }

    #[test]
    fn peer_rows_are_validated_before_they_reach_the_module() {
        let key = "A".repeat(43);
        let row = |account: &str, peer: &str, key: &str| PeerListEntry {
            account_id: account.to_string(),
            peer_id: peer.to_string(),
            transport_key: key.to_string(),
        };
        let entries = [
            row("member-1", "1234567890123456789", &key),
            row("member-2", "0", &key),
            row("member-3", "12", "short"),
            row("bad account", "12", &key),
            row("host-1", "99", &key),
            row("member-1", "1234567890123456789", &key),
            row("member-4", "18446744073709551616", &key),
            row("member-5", "77", &key),
        ];
        let (wanted, refused) = wanted_peers(&entries, Some("host-1"));
        assert_eq!(
            wanted
                .iter()
                .map(|peer| peer.account_id.as_str())
                .collect::<Vec<_>>(),
            ["member-1", "member-5"]
        );
        assert_eq!(wanted[0].peer_id, 1_234_567_890_123_456_789);
        // member-2 (peer id 0), member-3 (key), the bad account, the host itself and the overflowing id; the repeated
        // member-1 row is silently one peer.
        assert_eq!(refused, 5);
    }

    #[test]
    fn the_backends_peer_list_parses() {
        let list: PeerList = serde_json::from_str(
            r#"{"generation":3,"peers":[{"accountId":"u-1","peerId":"42","transportKey":"k","state":"PENDING"}]}"#,
        )
        .unwrap();
        assert_eq!(list.generation, 3);
        assert_eq!(list.peers[0].peer_id, "42");
        let empty: PeerList = serde_json::from_str(r#"{"generation":3}"#).unwrap();
        assert!(empty.peers.is_empty());
    }

    #[test]
    fn hub_kinds_round_trip_their_wire_names() {
        for kind in [HubKind::Ramsgate, HubKind::Training] {
            assert_eq!(HubKind::parse(kind.wire()), Some(kind));
        }
        assert_eq!(HubKind::parse("ramsgate"), None);
        assert!(SessionKind::HubHost.is_host() && SessionKind::HubHost.is_hub());
        assert!(!SessionKind::HubJoin.is_host() && SessionKind::HubJoin.is_hub());
        assert!(SessionKind::HuntHost.is_host() && !SessionKind::HuntHost.is_hub());
        assert_eq!(SessionKind::join_of(true), SessionKind::HubJoin);
        assert_eq!(SessionKind::join_of(false), SessionKind::HuntJoin);
    }
}
