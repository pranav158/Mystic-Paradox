//! [2026-10-13] Host and join sessions over the ICE co-op transport (ParadoxTransport.dll, transport ABI 2;
//! SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md §6.1 step 4).
//!
//! Differences from the Steam path:
//! - Before starting, each side fetches `POST /launcher/v1/p2p/hunts/:id/transport-config`: STUN/TURN servers, the
//!   pair keys and the peer ids. The relay credential and the keys go into a one-use `transport.secret` file next to
//!   the ticket; the rest into `bridge.conf`.
//! - The module produces ICE signals (`DESCRIPTION`, `CANDIDATE`, `GATHERING_DONE`) that `pump` posts to
//!   `/signal`; the other side's arrive as `ICE_SIGNAL` control messages (control.rs -> `deliver_ice_signal`).
//! - A joiner speaks first and waits for the host's answer, which comes through the control loop. The join therefore
//!   finishes on its own thread instead of blocking that loop (the Steam join waits inside it).

use super::*;
use crate::commands::auth::send_authorized;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IceServerEntry {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IcePeerEntry {
    pub account_id: String,
    pub peer_id: String,
    pub transport_key: String,
}

/// The relay part of a transport-config answer: whether a relay credential was issued and until when it works.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelayGrant {
    #[serde(default)]
    pub allowed: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// The backend's transport-config answer (ParadoxBackend src/p2p/controllers/p2pIce.ts).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransportConfig {
    pub generation: u32,
    pub local_account_id: String,
    pub local_peer_id: String,
    pub host_account_id: String,
    pub host_peer_id: String,
    pub ice_servers: Vec<IceServerEntry>,
    pub peers: Vec<IcePeerEntry>,
    /// Absent from older backends.
    #[serde(default)]
    pub relay: Option<RelayGrant>,
}

impl TransportConfig {
    /// When the relay credential in this answer stops working, if a relay was issued.
    pub(super) fn relay_expires_at(&self) -> Option<String> {
        self.relay
            .as_ref()
            .filter(|relay| relay.allowed)
            .and_then(|relay| relay.expires_at.clone())
    }
}

/// Who the files are for: a hunt's host lists every joiner, a joiner exactly the host, and a hub's host none (its
/// members are added and removed while it runs, `session/hub.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FilesFor {
    Joiner,
    /// A hunt the host plays: it lists up to three joiners.
    HuntHost,
    /// A realm hunt the host does not play: it lists up to four players and has no local client.
    AwayHuntHost,
    /// A realm hub: the relay credential only; the members come through the peer sync.
    HubHost,
}

/// What the module reads: config additions (non-secret) and the secrets file.
pub(super) struct IceFiles {
    pub config: String,
    pub secrets: String,
}

/// A hunt's frozen transport must match the installed module (ABI 2 = ICE); otherwise the session is refused and
/// the hunt falls back like any failed start.
pub(super) fn require_matching_module(ice: bool) -> Result<(), String> {
    match transport::abi_version() {
        Some(version) if (version >= 2) != ice => Err(if ice {
            "This hunt uses the ICE co-op transport, but the installed transport module is the Steam one. Repair the runtime."
        } else {
            "This hunt uses the Steam co-op transport, but the installed transport module is the ICE one. Repair the runtime."
        }
        .to_string()),
        _ => Ok(()),
    }
}

pub(super) fn fetch_transport_config(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
) -> Result<TransportConfig, String> {
    let url = format!(
        "{}/launcher/v1/p2p/hunts/{session_id}/transport-config",
        api_base_url()
    );
    let body = serde_json::json!({ "generation": generation });
    let response = send_authorized(app, |token| {
        http_client()?
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|_| "Couldn't request the co-op transport configuration.".to_string())
    })?;
    if !response.status().is_success() {
        return Err(safe_api_error(
            response,
            "The co-op transport configuration was refused.",
        ));
    }
    let config: TransportConfig = response.json().map_err(|_| {
        "The backend returned an invalid co-op transport configuration.".to_string()
    })?;
    if config.generation != generation {
        return Err(
            "The co-op transport configuration belongs to another hunt generation.".to_string(),
        );
    }
    Ok(config)
}

pub(super) fn safe_account(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) fn safe_peer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

pub(super) fn safe_key(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn safe_url(value: &str) -> bool {
    value.len() <= 256
        && (value.starts_with("stun:") || value.starts_with("turn:") || value.starts_with("turns:"))
        && value
            .bytes()
            .all(|byte| byte > 0x20 && byte < 0x7f && byte != b',')
}

fn safe_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.bytes().all(|byte| byte > 0x20 && byte < 0x7f)
}

/// The module's input from a transport-config answer. `host_peer_id` is the bootstrap's; both must agree. A hunt's
/// host lists every joiner, a joiner exactly the host, a hub's host nobody (relay credential only).
pub(super) fn ice_files(
    config: &TransportConfig,
    files_for: FilesFor,
    host_peer_id: &str,
) -> Result<IceFiles, String> {
    let host = files_for != FilesFor::Joiner;
    let hub = files_for == FilesFor::HubHost;
    let invalid = || "The backend returned an unsafe co-op transport configuration.".to_string();
    if !safe_account(&config.local_account_id)
        || !safe_peer_id(&config.local_peer_id)
        || !safe_account(&config.host_account_id)
        || !safe_peer_id(&config.host_peer_id)
        || config.host_peer_id != host_peer_id
    {
        return Err(invalid());
    }
    let mut stun = Vec::new();
    let mut turn = Vec::new();
    let mut credential: Option<(&str, &str)> = None;
    for server in &config.ice_servers {
        if !server.urls.iter().all(|url| safe_url(url)) {
            return Err(invalid());
        }
        match (&server.username, &server.credential) {
            (Some(user), Some(secret)) => {
                if !safe_credential(user) || !safe_credential(secret) {
                    return Err(invalid());
                }
                if credential.is_none() {
                    credential = Some((user, secret));
                    turn.extend(
                        server
                            .urls
                            .iter()
                            .filter(|url| url.starts_with("turn"))
                            .cloned(),
                    );
                }
            }
            _ => stun.extend(
                server
                    .urls
                    .iter()
                    .filter(|url| url.starts_with("stun:"))
                    .cloned(),
            ),
        }
    }
    // A hub's members are not read here: the peer sync adds them (validated per row) while the hub runs.
    let peers_valid = hub
        || config.peers.iter().all(|peer| {
            safe_account(&peer.account_id)
                && safe_peer_id(&peer.peer_id)
                && safe_key(&peer.transport_key)
        });
    let pairs_valid = if hub {
        true
    } else if host {
        let joiners = if files_for == FilesFor::AwayHuntHost {
            4
        } else {
            3
        };
        config.peers.len() <= joiners
            && config
                .peers
                .iter()
                .all(|peer| peer.account_id != config.local_account_id)
    } else {
        config.peers.len() == 1
            && config.peers[0].account_id == config.host_account_id
            && config.peers[0].peer_id == config.host_peer_id
    };
    if !peers_valid || !pairs_valid {
        return Err(invalid());
    }
    let mut text = String::new();
    if !stun.is_empty() {
        text.push_str(&format!("ice_stun_urls={}\n", stun.join(",")));
    }
    if !turn.is_empty() {
        text.push_str(&format!("ice_turn_urls={}\n", turn.join(",")));
    }
    text.push_str(&format!("local_account_id={}\n", config.local_account_id));
    if !host {
        text.push_str(&format!(
            "local_peer_id={}\nhost_account_id={}\n",
            config.local_peer_id, config.host_account_id
        ));
    }
    let mut secrets = String::new();
    if let Some((user, secret)) = credential.filter(|_| !turn.is_empty()) {
        secrets.push_str(&format!("turn_username={user}\nturn_credential={secret}\n"));
    }
    for peer in config.peers.iter().filter(|_| !hub) {
        secrets.push_str(&format!(
            "peer={},{},{}\n",
            peer.account_id, peer.peer_id, peer.transport_key
        ));
    }
    Ok(IceFiles {
        config: text,
        secrets,
    })
}

/// The module's readiness line: `HOST_READY ...` for a host, `ROUTE_READY ...` for a joiner, always on loopback and
/// with the requested route policy; a relay-only joiner must report `route=relay`. `local_client` says whether the
/// session has a local bridge for a client on this PC: its port must then be real, and a host without one (a realm hunt
/// the host does not play) reports `localPort=0`, which is returned as 0.
pub(super) fn parse_ice_ready(
    line: &str,
    expected_state: &str,
    force_relay: bool,
    local_client: bool,
) -> Result<u16, String> {
    let mut tokens = line.split_whitespace();
    if tokens.next() != Some(expected_state) {
        return Err(
            "The co-op transport module returned an unexpected readiness state.".to_string(),
        );
    }
    let mut fields = HashMap::new();
    for token in tokens {
        let Some((key, value)) = token.split_once('=') else {
            return Err("The co-op transport module returned a malformed local route.".to_string());
        };
        if key.is_empty() || value.is_empty() || fields.insert(key, value).is_some() {
            return Err("The co-op transport module returned a malformed local route.".to_string());
        }
    }
    if fields.get("localHost") != Some(&"127.0.0.1") || fields.get("transport") != Some(&"ice") {
        return Err(
            "The co-op transport module did not return a verified loopback route.".to_string(),
        );
    }
    let expected_policy = if force_relay {
        "RELAY_ONLY"
    } else {
        "AUTOMATIC"
    };
    if fields.get("routePolicy") != Some(&expected_policy)
        || (force_relay && expected_state == "ROUTE_READY" && fields.get("route") != Some(&"relay"))
    {
        return Err(
            "The co-op transport module returned a route outside the requested transport policy."
                .to_string(),
        );
    }
    fields
        .get("localPort")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| (*port != 0) == local_client)
        .ok_or_else(|| "The co-op transport module returned an invalid local route.".to_string())
}

/// Posts the module's pending signals and logs its peer events (and, for a host session, keeps `live` current).
/// Signal contents (addresses, ICE credentials) are never logged; only their kind.
pub(super) fn pump(
    app: &AppHandle,
    session_id: &str,
    generation: u32,
    handle: SessionHandle,
    log: &SharedLog,
    live: Option<&SharedLive>,
) {
    for signal in handle.take_signals() {
        let url = format!(
            "{}/launcher/v1/p2p/hunts/{session_id}/signal",
            api_base_url()
        );
        let body = serde_json::json!({
            "generation": generation,
            "toAccountId": signal.to_account_id,
            "kind": signal.kind,
            "data": signal.data
        });
        let result = send_authorized(app, |token| {
            http_client()?
                .post(&url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .map_err(|_| "Couldn't deliver a co-op signal.".to_string())
        });
        match result {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => append_log(
                log,
                "launcher",
                &format!(
                    "ICE_SIGNAL_REFUSED kind={} status={}",
                    signal.kind,
                    response.status().as_u16()
                ),
            ),
            Err(_) => append_log(
                log,
                "launcher",
                &format!("ICE_SIGNAL_FAILED kind={}", signal.kind),
            ),
        }
    }
    for event in handle.drain_peer_events() {
        append_log(log, "transport", &event);
        if let Some(live) = live {
            hub::apply_peer_line(live, &event, &crate::launch::logs::iso8601_now());
        }
    }
}

fn publish_route_ready_authorized(
    app: &AppHandle,
    session_id: &str,
    request: &RouteReadyRequest<'_>,
) -> Result<(), String> {
    let url = format!(
        "{}/launcher/v1/p2p/hunts/{session_id}/route-ready",
        api_base_url()
    );
    let response = send_authorized(app, |token| {
        http_client()?
            .post(&url)
            .bearer_auth(token)
            .json(request)
            .send()
            .map_err(|_| "Couldn't publish the local bridge route.".to_string())
    })?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(safe_api_error(
            response,
            "The local bridge route was rejected.",
        ))
    }
}

/// An ICE join: prepares the files and starts the module here, then waits for admission on its own thread while
/// `pump` carries the signals. The supervisor registration (`reservation`) stays in place until that thread ends.
pub(super) fn start_join(
    app: &AppHandle,
    mut reservation: SupervisorReservation,
    bootstrap: JoinBootstrap,
    session_id: &str,
) -> Result<P2PStartResult, String> {
    require_matching_module(true)?;
    let generation = bootstrap.common.generation;
    let force_relay = bootstrap.common.force_relay;
    let runtime = verified_runtime(app, &bootstrap.common.artifacts)?;
    let transport_config = fetch_transport_config(app, session_id, generation)?;
    let files = ice_files(
        &transport_config,
        FilesFor::Joiner,
        &bootstrap.common.host_peer_id,
    )?;
    let session_dir = session_directory(app, session_id, generation)?;
    let mut session_cleanup = SessionCleanup::new(session_dir.clone());
    let (log_path, log) = session_log(app, session_id, generation, "join")?;
    let ticket_path = session_dir.join("ticket.secret");
    let secrets_path = session_dir.join("transport.secret");
    let config_path = session_dir.join("bridge.conf");
    write_once(&ticket_path, bootstrap.ticket.as_bytes())?;
    write_once(&secrets_path, files.secrets.as_bytes())?;
    let mut config = common_config(&bootstrap.common)?;
    config.push_str(&format!(
        "local_udp_port=0\nforce_relay={force_relay}\n{}",
        files.config
    ));
    write_once(&config_path, config.as_bytes())?;
    if !transport::status().loaded {
        return Err(
            "The co-op connection is not running. Restart Dauntless from the Mystic launcher."
                .to_string(),
        );
    }
    let handle = transport::join_open(
        &runtime.admission_key,
        &config_path,
        &ticket_path,
        &secrets_path,
    )?;
    set_handle(session_id, handle);
    set_join_kind(session_id, &bootstrap.common);
    append_log(
        &log,
        "launcher",
        &format!(
            "ICE_JOIN_STARTED routePolicy={}",
            if force_relay {
                "RELAY_ONLY"
            } else {
                "AUTOMATIC"
            }
        ),
    );

    let receiver = reservation.receiver();
    reservation.commit();
    session_cleanup.commit();
    let app_handle = app.clone();
    let session_owned = session_id.to_string();
    let bridge_instance_id = bootstrap.common.bridge_instance_id.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let ready = loop {
            pump(&app_handle, &session_owned, generation, handle, &log, None);
            drain_transport_diagnostics(&log, Link::Ice(handle));
            if receiver.try_recv().is_ok() {
                break Err("stopped before the co-op connection was ready".to_string());
            }
            match handle.wait_ready(Duration::from_millis(100)) {
                transport::ReadyState::Ready(line) => break Ok(line),
                transport::ReadyState::Failed(error) => break Err(error),
                transport::ReadyState::Pending if started.elapsed() >= READY_TIMEOUT => {
                    break Err("The co-op connection timed out before it was ready.".to_string())
                }
                transport::ReadyState::Pending => {}
            }
        };
        let _ = std::fs::remove_file(&ticket_path);
        let _ = std::fs::remove_file(&secrets_path);
        let routed = ready.and_then(|line| {
            append_log(&log, "transport", &line);
            let local_port = parse_ice_ready(&line, "ROUTE_READY", force_relay, true)?;
            publish_route_ready_authorized(
                &app_handle,
                &session_owned,
                &RouteReadyRequest {
                    generation,
                    bridge_instance_id: &bridge_instance_id,
                    local_host: "127.0.0.1",
                    local_port,
                },
            )?;
            Ok(local_port)
        });
        match routed {
            Ok(local_port) => {
                append_log(
                    &log,
                    "launcher",
                    &format!("ROUTE_READY role=join transport=ice localHost=127.0.0.1 localPort={local_port}"),
                );
                // [2026-10-16] A hunt join asked to end when its game leaves (the member is entering a realm hub) keeps running
                // until the game has sent nothing for GAME_LEFT_IDLE, so the game can still travel over it.
                let mut traffic = GameTrafficWatch::new(Instant::now());
                let mut leave_asked: Option<Instant> = None;
                loop {
                    pump(&app_handle, &session_owned, generation, handle, &log, None);
                    drain_join_diagnostics(&log, Link::Ice(handle), &mut traffic);
                    match receiver.try_recv() {
                        Ok(SupervisorCommand::StopWhenGameLeaves) => {
                            if leave_asked.is_none() {
                                let now = Instant::now();
                                traffic.restart(now);
                                leave_asked = Some(now);
                            }
                        }
                        Ok(SupervisorCommand::Stop) => break,
                        Err(_) => {}
                    }
                    if let Some(asked_at) = leave_asked {
                        if let Some(outcome) =
                            hunt_join_leave_outcome(asked_at, &traffic, Instant::now())
                        {
                            append_log(
                                &log,
                                "launcher",
                                &format!(
                                    "hunt join ended outcome={outcome} after={}s",
                                    asked_at.elapsed().as_secs()
                                ),
                            );
                            break;
                        }
                    }
                    if !handle.session_running() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Err(error) => append_log(
                &log,
                "launcher",
                &format!(
                    "p2p join failed stage=ice_ready reason={}",
                    error.replace(' ', "_")
                ),
            ),
        }
        handle.stop();
        drain_transport_diagnostics(&log, Link::Ice(handle));
        unregister(&session_owned);
        cleanup_directory(&session_dir);
    });
    Ok(P2PStartResult {
        session_id: session_id.to_string(),
        generation,
        role: "join",
        local_host: "127.0.0.1",
        local_port: 0,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn config(peers: Vec<IcePeerEntry>) -> TransportConfig {
        TransportConfig {
            generation: 3,
            local_account_id: "join-1".to_string(),
            local_peer_id: "222".to_string(),
            host_account_id: "host-1".to_string(),
            host_peer_id: "111".to_string(),
            ice_servers: vec![
                IceServerEntry {
                    urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
                    username: None,
                    credential: None,
                },
                IceServerEntry {
                    urls: vec![
                        "turn:turn.cloudflare.com:3478?transport=udp".to_string(),
                        "turns:turn.cloudflare.com:5349?transport=tcp".to_string(),
                    ],
                    username: Some("user".to_string()),
                    credential: Some("secret".to_string()),
                },
            ],
            peers,
            relay: None,
        }
    }

    fn peer(account: &str, id: &str) -> IcePeerEntry {
        IcePeerEntry {
            account_id: account.to_string(),
            peer_id: id.to_string(),
            transport_key: KEY.to_string(),
        }
    }

    #[test]
    fn join_files_name_the_host_and_keep_secrets_apart() {
        let files = ice_files(
            &config(vec![peer("host-1", "111")]),
            FilesFor::Joiner,
            "111",
        )
        .unwrap();
        assert!(files
            .config
            .contains("ice_stun_urls=stun:stun.cloudflare.com:3478\n"));
        assert!(files.config.contains(
            "ice_turn_urls=turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp\n"
        ));
        assert!(files
            .config
            .contains("local_peer_id=222\nhost_account_id=host-1\n"));
        assert!(!files.config.contains("secret"));
        assert_eq!(
            files.secrets,
            format!("turn_username=user\nturn_credential=secret\npeer=host-1,111,{KEY}\n")
        );
    }

    #[test]
    fn transport_configs_that_do_not_fit_the_pair_are_refused() {
        // A joiner must list exactly the host, with the bootstrap's host peer id.
        assert!(ice_files(&config(vec![peer("other", "111")]), FilesFor::Joiner, "111",).is_err());
        assert!(ice_files(
            &config(vec![peer("host-1", "111")]),
            FilesFor::Joiner,
            "999",
        )
        .is_err());
        assert!(ice_files(&config(vec![]), FilesFor::Joiner, "111").is_err());
        // Line injection and unsafe values.
        let mut injected = config(vec![peer("host-1", "111")]);
        injected.ice_servers[1].credential = Some("a\nturn_username=x".to_string());
        assert!(ice_files(&injected, FilesFor::Joiner, "111").is_err());
        let mut bad_key = config(vec![peer("host-1", "111")]);
        bad_key.peers[0].transport_key = "short".to_string();
        assert!(ice_files(&bad_key, FilesFor::Joiner, "111").is_err());
        // A host never lists itself.
        let mut host = config(vec![peer("join-1", "222")]);
        host.local_account_id = "host-1".to_string();
        assert!(ice_files(&host, FilesFor::HuntHost, "111").is_ok());
        host.peers.push(peer("host-1", "111"));
        assert!(ice_files(&host, FilesFor::HuntHost, "111").is_err());
    }

    #[test]
    fn a_host_without_relay_or_joiners_gets_an_empty_secrets_file() {
        let mut solo = config(vec![]);
        solo.local_account_id = "host-1".to_string();
        solo.ice_servers.truncate(1);
        let files = ice_files(&solo, FilesFor::HuntHost, "111").unwrap();
        assert!(files.secrets.is_empty());
        assert!(!files.config.contains("ice_turn_urls"));
    }

    #[test]
    fn ready_lines_must_be_loopback_ice_with_the_requested_policy() {
        assert_eq!(
            parse_ice_ready(
                "HOST_READY session=s generation=3 transport=ice localHost=127.0.0.1 localPort=4100 routePolicy=AUTOMATIC relayReady=1 peers=1",
                "HOST_READY",
                false,
                true
            )
            .unwrap(),
            4100
        );
        assert_eq!(
            parse_ice_ready(
                "ROUTE_READY localHost=127.0.0.1 localPort=4200 session=s generation=3 transport=ice routePolicy=RELAY_ONLY route=relay",
                "ROUTE_READY",
                true,
                true
            )
            .unwrap(),
            4200
        );
        // Relay-only joiner on a direct route, wrong policy, Steam line, non-loopback.
        assert!(parse_ice_ready(
            "ROUTE_READY localHost=127.0.0.1 localPort=4200 transport=ice routePolicy=RELAY_ONLY route=direct",
            "ROUTE_READY",
            true,
            true
        )
        .is_err());
        assert!(parse_ice_ready(
            "HOST_READY localHost=127.0.0.1 localPort=4100 transport=ice routePolicy=RELAY_ONLY",
            "HOST_READY",
            false,
            true
        )
        .is_err());
        assert!(parse_ice_ready(
            "LOBBY_READY lobbyId=1 localHost=127.0.0.1 localPort=4100 routePolicy=AUTOMATIC ice=automatic relayReady=1",
            "HOST_READY",
            false,
            true
        )
        .is_err());
        assert!(parse_ice_ready(
            "HOST_READY localHost=0.0.0.0 localPort=4100 transport=ice routePolicy=AUTOMATIC",
            "HOST_READY",
            false,
            true
        )
        .is_err());
    }

    #[test]
    fn a_host_without_a_local_client_reports_port_zero() {
        let away = "HOST_READY session=s generation=3 transport=ice localHost=127.0.0.1 localPort=0 routePolicy=AUTOMATIC relayReady=1 peers=0";
        assert_eq!(parse_ice_ready(away, "HOST_READY", false, false), Ok(0));
        // A real port with no local client, or no port with one, is a broken route.
        assert!(parse_ice_ready(
            &away.replace("localPort=0", "localPort=4100"),
            "HOST_READY",
            false,
            false
        )
        .is_err());
        assert!(parse_ice_ready(away, "HOST_READY", false, true).is_err());
    }

    #[test]
    fn a_realm_hub_host_gets_the_relay_credential_and_no_members_up_front() {
        let mut hub = config(vec![peer("join-1", "222"), peer("join-2", "333")]);
        hub.local_account_id = "host-1".to_string();
        let files = ice_files(&hub, FilesFor::HubHost, "111").unwrap();
        assert!(!files.secrets.contains("peer="), "{}", files.secrets);
        assert!(files.config.contains("local_account_id=host-1\n"));
        assert!(!files.config.contains("local_peer_id="));
    }

    #[test]
    fn a_realm_hunt_the_host_does_not_play_lists_up_to_four_players() {
        let mut away = config(vec![
            peer("a", "1"),
            peer("b", "2"),
            peer("c", "3"),
            peer("d", "4"),
        ]);
        away.local_account_id = "host-1".to_string();
        assert!(ice_files(&away, FilesFor::AwayHuntHost, "111").is_ok());
        // A host that plays the hunt still lists at most three joiners (four players with itself).
        assert!(ice_files(&away, FilesFor::HuntHost, "111").is_err());
        away.peers.push(peer("e", "5"));
        assert!(ice_files(&away, FilesFor::AwayHuntHost, "111").is_err());
    }
}
