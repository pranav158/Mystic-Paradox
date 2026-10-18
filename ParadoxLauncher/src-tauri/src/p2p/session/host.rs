//! [2026-10-14] The host bundle: a player-host server and the transport session it serves, from the host bootstrap to the
//! supervisor thread that keeps both alive (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md §5, §6.1). One bundle serves
//! a hunt the host plays, a realm hunt the host does not play, and a realm's hub. A hub adds the peer sync loop (its
//! members come and go while it runs); a hunt without the host's client has no local bridge and no route-ready call.

use super::ice::FilesFor;
use super::*;

/// A host bundle's failure after the transport or the server started: everything it started is stopped, the fence is
/// sent, and the session directory goes.
fn abort_host(
    link: Option<Link>,
    server: &mut HostProcess,
    control_pipe_name: &str,
    session_id: &str,
    generation: u32,
    session_dir: &Path,
) {
    if let Some(link) = link {
        link.stop();
    }
    let _ = send_fence(control_pipe_name, session_id, generation);
    let _ = server.kill();
    cleanup_directory(session_dir);
}

pub fn start_host_bundle(
    app: &AppHandle,
    access_token: &mut String,
    session_id: &str,
) -> Result<P2PStartResult, String> {
    let mut reservation = reserve_supervisor(session_id)?;
    let bootstrap: HostBootstrap = fetch_bootstrap(access_token, session_id, "host")?;
    if bootstrap.common.session_id != session_id {
        return Err("The host bootstrap bindings are invalid.".to_string());
    }
    let plan = hub::plan_host(&bootstrap)?;
    let hub_session = plan.kind == SessionKind::HubHost;
    let ice = bootstrap.common.coop_transport == "ICE";
    if hub_session && !ice {
        return Err("A realm hub needs the ICE co-op transport.".to_string());
    }
    let local_client = plan.local_client;
    let realm = hub_session || bootstrap.common.realm_id.is_some();
    set_generation(session_id, bootstrap.common.generation);
    set_kind(session_id, plan.kind, plan.hub_kind, realm);
    ice::require_matching_module(ice)?;
    // A hub, and a hunt without the host's own client, need the handle API (module interface version 3): an older
    // module would run them as plain hunts.
    if plan.needs_handle_module() && transport::abi_version() != Some(3) {
        return Err(
            "This session needs the co-op transport module with sessions by handle. Repair the runtime.".to_string(),
        );
    }
    if local_client && bootstrap.host_ticket.is_empty() {
        return Err("The host bootstrap has no host ticket.".to_string());
    }
    let runtime = verified_runtime(app, &bootstrap.common.artifacts)?;
    let generation = bootstrap.common.generation;
    let session_dir = session_directory(app, session_id, generation)?;
    let mut session_cleanup = SessionCleanup::new(session_dir.clone());
    let (log_path, bridge_log) = session_log(app, session_id, generation, "host")?;
    append_log(
        &bridge_log,
        "launcher",
        &format!(
            "HOST_MANIFEST playerHuntId={} nativeHuntId={} map={} behemoth={}",
            bootstrap.common.hunt_definition_id,
            bootstrap.matchmaker_hunt_id,
            bootstrap.map_path,
            bootstrap.behemoth_path
        ),
    );
    append_log(
        &bridge_log,
        "launcher",
        &format!(
            "HOST_KIND kind={} hubKind={} hubRoom={} localClient={} maxPeers={} realm={}",
            if hub_session { "HUB" } else { "HUNT" },
            plan.hub_kind.map_or("none", HubKind::wire),
            bootstrap.common.hub_room_id.as_deref().unwrap_or("none"),
            local_client,
            plan.maximum_peers,
            realm
        ),
    );
    let suffix = random_hex(16)?;
    let ready_pipe_name = format!(r"\\.\pipe\MysticInternalServer.ready.{suffix}");
    let control_pipe_name = format!(r"\\.\pipe\MysticInternalServer.control.{suffix}");
    let guard_pipe_token = format!("MysticHuntGuard.events.{suffix}");
    let guard_pipe_name = format!(r"\\.\pipe\{guard_pipe_token}");
    let launch_id = format!("host-{suffix}");
    let ready_pipe = create_ready_pipe(&ready_pipe_name).inspect_err(|_error| {
        log_host_failure(&bridge_log, "ready_pipe_create", "pipe_create_failed");
    })?;
    let capability_path = session_dir.join("capability.secret");
    let host_ticket_path = session_dir.join("ticket.secret");
    let config_path = session_dir.join("bridge.conf");
    let secrets_path = session_dir.join("transport.secret");
    write_once(&capability_path, bootstrap.capability.as_bytes()).inspect_err(|_error| {
        log_host_failure(&bridge_log, "host_config", "capability_file_write_failed");
    })?;
    if local_client {
        write_once(&host_ticket_path, bootstrap.host_ticket.as_bytes()).inspect_err(|_error| {
            log_host_failure(&bridge_log, "host_config", "ticket_file_write_failed");
        })?;
    }
    let mut config = common_config(&bootstrap.common).inspect_err(|_error| {
        log_host_failure(&bridge_log, "host_config", "common_config_invalid");
    })?;
    config.push_str(&format!(
        "backend_url={}\nserver_udp_port={}\nmaximum_peers={}\nforce_relay={}\nguard_pipe_name={}\nhunt_evidence={}\nexpected_server_pid=SERVER_PID_PLACEHOLDER\n",
        safe_config_value(&bootstrap.backend_url, 512)?,
        bootstrap.server_udp_port,
        plan.maximum_peers,
        bootstrap.common.force_relay,
        guard_pipe_token,
        plan.hunt_evidence
    ));
    if hub_session {
        config.push_str("session_role=HUB\nhost_local_client=1\n");
    } else if !local_client {
        config.push_str("host_local_client=0\n");
    }
    // ICE: relay credential and pair keys in their own one-use file, servers and identities in the config. A hub's
    // file holds the relay credential only; its members arrive through the peer sync.
    let mut host_account_id: Option<String> = None;
    let mut relay_expires_at = None;
    if ice {
        let transport_config = ice::fetch_transport_config(app, session_id, generation)
            .inspect_err(|_error| {
                log_host_failure(&bridge_log, "transport_config", "transport_config_failed");
            })?;
        let files_for = if hub_session {
            FilesFor::HubHost
        } else if local_client {
            FilesFor::HuntHost
        } else {
            FilesFor::AwayHuntHost
        };
        let files = ice::ice_files(&transport_config, files_for, &bootstrap.common.host_peer_id)
            .inspect_err(|_error| {
                log_host_failure(&bridge_log, "transport_config", "transport_config_invalid");
            })?;
        write_once(&secrets_path, files.secrets.as_bytes()).inspect_err(|_error| {
            log_host_failure(&bridge_log, "host_config", "transport_secrets_write_failed");
        })?;
        config.push_str(&files.config);
        host_account_id = Some(transport_config.local_account_id.clone());
        relay_expires_at = transport_config.relay_expires_at();
        // [2026-10-17] Known to the relay credential refresh (session.rs refresh_due_relay_credentials).
        super::set_relay_expiry(session_id, relay_expires_at.clone());
    }

    let game_dir = runtime
        .game_exe
        .parent()
        .ok_or_else(|| "Invalid game path.".to_string())?;
    for value in [
        &bootstrap.matchmaker_hunt_id,
        &bootstrap.map_path,
        &bootstrap.behemoth_path,
        &bootstrap.expected_players,
    ] {
        safe_config_value(value, 4096)?;
    }
    let server_args = host_server_arguments(
        bootstrap.server_udp_port,
        &bootstrap.map_path,
        &bootstrap.behemoth_path,
        &bootstrap.matchmaker_hunt_id,
        &bootstrap.expected_players,
    );
    let runtime_profile = match fetch_policy(access_token)
        .inspect_err(|_error| {
            log_host_failure(&bridge_log, "runtime_policy", "policy_fetch_failed");
        })?
        .diagnostics_profile
        .as_str()
    {
        "DEVELOPMENT" => "development",
        _ => "production",
    };
    let generation_text = generation.to_string();
    let launcher_pid = std::process::id().to_string();
    let max_players_text = plan
        .max_players
        .map(|value| value.to_string())
        .unwrap_or_default();
    let afk_text = hub::hub_afk_seconds().map(|value| value.to_string());
    let hosted_role = if hub_session { "HUB" } else { "HUNT" };
    let mut host_variables = vec![
        ("MYSTICPARADOX_AUTH_MODE", "HUNT_CAPABILITY"),
        ("MYSTICPARADOX_BIND_ADDRESS", "127.0.0.1"),
        (
            "MYSTICPARADOX_HOST_RUNTIME_CAPABILITY",
            bootstrap.capability.as_str(),
        ),
        ("MYSTICPARADOX_HOSTED_ROLE", hosted_role),
        ("MYSTICPARADOX_SESSION_ID", session_id),
        ("MYSTICPARADOX_SESSION_GENERATION", generation_text.as_str()),
        ("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", launch_id.as_str()),
        ("MYSTICPARADOX_READY_PIPE", ready_pipe_name.as_str()),
        ("MYSTICPARADOX_CONTROL_PIPE", control_pipe_name.as_str()),
        ("MYSTICPARADOX_GUARD_PIPE", guard_pipe_name.as_str()),
        (
            "MYSTICPARADOX_HUNT_GUARD_EVENTS",
            if plan.hunt_evidence { "1" } else { "0" },
        ),
        (
            "MYSTICPARADOX_HUNT_GUARD_COMPLETION_MODE",
            bootstrap.common.guard_completion_mode.as_str(),
        ),
        ("MYSTICPARADOX_RUNTIME_PROFILE", runtime_profile),
        ("MYSTICPARADOX_LAUNCHER_PID", launcher_pid.as_str()),
    ];
    if hub_session {
        host_variables.push(("MYSTICPARADOX_MAX_PLAYERS", max_players_text.as_str()));
        if let Some(afk) = afk_text.as_deref() {
            host_variables.push(("MYSTICPARADOX_HUB_AFK_SECONDS", afk));
        }
    }
    if let Some(week) = trials_week(&bootstrap.matchmaker_hunt_id) {
        host_variables.push(("MYSTICPARADOX_TRIALS_WEEK", week));
        append_log(
            &bridge_log,
            "launcher",
            &format!("HOST_TRIALS_WEEK week={week}"),
        );
    }
    // Never inherit the old combat-mutation switches into a normal player-host process.
    let mut environment = host_environment(
        &host_variables,
        &[
            "MYSTICPARADOX_ALLOW_DAMAGE_DEBUG",
            "MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER",
        ],
    );
    // [2026-10-17] Where this server's runtime log ends before it starts, and who hosts it: a tester's log upload sends
    // this run of the port's log, never earlier runs or another account's (launch/log_upload.rs).
    crate::launch::logs::record_hosted_server_log_start(
        game_dir,
        bootstrap.server_udp_port,
        host_account_id.as_deref(),
    );
    // These positional arguments are the frozen DeployServer launch manifest. The launcher must not reinterpret
    // hunt IDs or content; it only transports the dedicated resolver's result into the local host process.
    // The player client is reparented under Explorer before it joins the protection job. This host is spawned by
    // the launcher and may inherit an outer job: it breaks away from that job before the still-suspended host is
    // assigned to launcher protection.
    let spawned = HostProcess::spawn_suspended_hidden(
        &runtime.game_exe,
        &server_args,
        game_dir,
        &mut environment,
    );
    // The block carries the host capability; the child has its own copy now.
    environment.zeroize();
    let mut server = match spawned {
        Ok(child) => child,
        Err(error) => {
            log_host_failure(
                &bridge_log,
                "internal_server_spawn",
                &format!("spawn_failed; win32_error={error}"),
            );
            cleanup_directory(&session_dir);
            return Err("Couldn't start the player-host Dauntless server.".to_string());
        }
    };
    if let Err(error) = crate::launch::supervisor::assign_process_handle(server.raw_handle()) {
        log_host_failure(
            &bridge_log,
            "internal_server_supervisor",
            &format!("assign_process_failed; {error}"),
        );
        let _ = server.kill();
        cleanup_directory(&session_dir);
        return Err(error);
    }
    let server_pid = server.id();
    if let Err(error) = crate::launch::supervisor::resume_initial_thread(server_pid) {
        log_host_failure(
            &bridge_log,
            "internal_server_supervisor",
            "resume_process_failed",
        );
        let _ = server.kill();
        cleanup_directory(&session_dir);
        return Err(error);
    }
    set_monitored_pid(session_id, server_pid);
    let config_body = config.replace("SERVER_PID_PLACEHOLDER", &server_pid.to_string());
    if let Err(error) = write_once(&config_path, config_body.as_bytes()) {
        log_host_failure(&bridge_log, "host_config", "config_write_failed");
        let _ = server.kill();
        cleanup_directory(&session_dir);
        return Err(error);
    }
    let expected_ready = format!(
        "MYS1 READY session={session_id} generation={generation} launch={launch_id} port={} bind=127.0.0.1\n",
        bootstrap.server_udp_port
    );
    let (ready_sender, ready_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = ready_sender.send(read_ready_pipe(ready_pipe, server_pid, expected_ready));
    });
    match ready_receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let child_status = child_exit_reason(&mut server);
            log_host_failure(
                &bridge_log,
                "internal_server_ready_pipe",
                &format!("{error}; {child_status}"),
            );
            let _ = server.kill();
            cleanup_directory(&session_dir);
            return Err(error);
        }
        Err(_) => {
            let child_status = child_exit_reason(&mut server);
            log_host_failure(
                &bridge_log,
                "internal_server_ready_pipe",
                &format!("ready_pipe_timeout; {child_status}"),
            );
            let _ = server.kill();
            unblock_pipe(&ready_pipe_name);
            cleanup_directory(&session_dir);
            return Err("InternalServer readiness timed out.".to_string());
        }
    }

    if !transport::status().loaded {
        log_host_failure(&bridge_log, "transport", "transport_not_loaded");
        abort_host(
            None,
            &mut server,
            &control_pipe_name,
            session_id,
            generation,
            &session_dir,
        );
        return Err(
            "The co-op connection is not running. Restart Dauntless from the Mystic launcher."
                .to_string(),
        );
    }
    let started = if ice {
        let host_ticket = local_client.then_some(host_ticket_path.as_path());
        transport::host_open(
            &runtime.admission_key,
            &config_path,
            &capability_path,
            host_ticket,
            &secrets_path,
        )
        .map(|handle| {
            set_handle(session_id, handle);
            Link::Ice(handle)
        })
    } else {
        transport::start_host(
            &runtime.admission_key,
            &config_path,
            &capability_path,
            &host_ticket_path,
        )
        .map(|_| Link::Steam)
    };
    let link = match started {
        Ok(link) => link,
        Err(error) => {
            log_host_failure(
                &bridge_log,
                "transport_host_start",
                "transport_start_failed",
            );
            abort_host(
                None,
                &mut server,
                &control_pipe_name,
                session_id,
                generation,
                &session_dir,
            );
            return Err(error);
        }
    };
    let ready_result = link.wait_ready(READY_TIMEOUT);
    drain_transport_diagnostics(&bridge_log, link);
    let ready_state = if ice { "HOST_READY" } else { "LOBBY_READY" };
    let ready_line = match ready_result {
        Ok(line) if line.starts_with(&format!("{ready_state} ")) => line,
        Ok(_) => {
            log_host_failure(
                &bridge_log,
                "transport_host_ready",
                "unexpected_readiness_state",
            );
            abort_host(
                Some(link),
                &mut server,
                &control_pipe_name,
                session_id,
                generation,
                &session_dir,
            );
            return Err(
                "The co-op transport module returned an unexpected host readiness state."
                    .to_string(),
            );
        }
        Err(error) => {
            log_host_failure(&bridge_log, "transport_host_ready", &error);
            abort_host(
                Some(link),
                &mut server,
                &control_pipe_name,
                session_id,
                generation,
                &session_dir,
            );
            return Err(error);
        }
    };
    append_log(&bridge_log, "transport", &ready_line);
    let parsed = if ice {
        ice::parse_ice_ready(
            &ready_line,
            ready_state,
            bootstrap.common.force_relay,
            local_client,
        )
    } else {
        parse_local_route(&ready_line, ready_state, bootstrap.common.force_relay)
    };
    let local_port = match parsed {
        Ok(port) => port,
        Err(error) => {
            abort_host(
                Some(link),
                &mut server,
                &control_pipe_name,
                session_id,
                generation,
                &session_dir,
            );
            return Err(error);
        }
    };
    let _ = std::fs::remove_file(&capability_path);
    let _ = std::fs::remove_file(&host_ticket_path);
    let _ = std::fs::remove_file(&secrets_path);
    if local_client {
        let route_ready = RouteReadyRequest {
            generation,
            bridge_instance_id: &bootstrap.common.bridge_instance_id,
            local_host: "127.0.0.1",
            local_port,
        };
        if let Err(error) = publish_route_ready(app, access_token, session_id, &route_ready) {
            abort_host(
                Some(link),
                &mut server,
                &control_pipe_name,
                session_id,
                generation,
                &session_dir,
            );
            return Err(error);
        }
        append_log(
            &bridge_log,
            "launcher",
            &format!(
                "ROUTE_READY role=host localHost=127.0.0.1 localPort={local_port} routePolicy={}",
                if bootstrap.common.force_relay {
                    "RELAY_ONLY"
                } else {
                    "AUTOMATIC"
                }
            ),
        );
    } else {
        // The backend admits the first joiner of a hunt the host does not play itself (no host-admitted step).
        append_log(
            &bridge_log,
            "launcher",
            "HOST_NO_LOCAL_CLIENT route-ready skipped (the host does not play this session)",
        );
    }
    let live: SharedLive = Arc::new(Mutex::new(SessionLive {
        hunt_id: bootstrap.common.hunt_definition_id.clone(),
        started_at: Some(crate::launch::logs::iso8601_now()),
        peers: Default::default(),
        relay_expires_at,
        local_since: None,
    }));
    set_live(session_id, Arc::clone(&live));
    // A hub's roster follows its members: the first sync runs now, later ones every few seconds or on request.
    let peer_sync = match link {
        Link::Ice(handle) if hub_session => {
            let (sender, join) = hub::spawn_peer_sync(
                app,
                session_id,
                generation,
                handle,
                host_account_id.clone(),
                &bridge_log,
            );
            let _ = sender.send(SyncCommand::Now);
            set_peer_sync(session_id, sender.clone());
            Some((sender, join))
        }
        _ => None,
    };
    let receiver = reservation.receiver();
    let session_owned = session_id.to_string();
    let supervisor_log = Arc::clone(&bridge_log);
    let app_handle = app.clone();
    std::thread::spawn(move || {
        loop {
            // ICE: the joiners' descriptions arrive through the control loop; the answers go out from here.
            if let Link::Ice(handle) = link {
                ice::pump(
                    &app_handle,
                    &session_owned,
                    generation,
                    handle,
                    &supervisor_log,
                    Some(&live),
                );
            }
            drain_host_diagnostics(&supervisor_log, link, &live);
            if receiver.try_recv().is_ok()
                || !link.session_running()
                || server.try_wait().ok().flatten().is_some()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Fence first, then the roster sync (its module calls end before the session stops), then the transport, then
        // the server.
        let _ = send_fence(&control_pipe_name, &session_owned, generation);
        if let Some((sender, join)) = peer_sync {
            let _ = sender.send(SyncCommand::Stop);
            let _ = join.join();
        }
        link.stop();
        let graceful_deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < graceful_deadline && server.try_wait().ok().flatten().is_none() {
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = server.kill();
        drain_transport_diagnostics(&supervisor_log, link);
        if let Link::Ice(handle) = link {
            append_log(
                &supervisor_log,
                "transport",
                &format!("ICE_SESSION_END result={}", handle.last_result()),
            );
        }
        unregister(&session_owned);
        cleanup_directory(&session_dir);
    });
    reservation.commit();
    session_cleanup.commit();
    Ok(P2PStartResult {
        session_id: session_id.to_string(),
        generation,
        role: "host",
        local_host: "127.0.0.1",
        local_port,
        log_path: log_path.to_string_lossy().into_owned(),
    })
}
