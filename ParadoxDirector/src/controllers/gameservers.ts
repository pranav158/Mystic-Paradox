//0503
/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { kill } from "node:process";
import { logger } from "../logger";
import { gameDataDir } from "../gameData/loader";
// [2026-10-14 M1] The hunt lookup and its tables live in shared/hunt-manifest (the Metagame resolves manifests with the same code).
import { CreateHuntResolver, LoadHuntTables, ParseTrialsRotationMinutes, TransformExpectedPlayerArgs } from "../../../shared/hunt-manifest";
import { PortPool } from "./portPool";
import { CreateSerialGate, HubSupervisor, HubLogLevel, HubSwitchOn } from "./hubSupervisor";

// [2026-10-14 M1] Hunt tables from ParadoxDirector/game-data (exported from the client by CatalogExporter). Trials/Arena
// rows sit in their own matchmaker tables and are reached only through tag routing (shared/hunt-manifest).
const HuntTables = LoadHuntTables(gameDataDir());

const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent";
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    startTime: Date,
    // A process exists before UE has a listening GameNetDriver. Never advertise it
    // to the client until the injected server has emitted the matching ready marker.
    state: "starting" | "ready" | "failed",
    launchId: string,
    readyTime?: Date
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export let Gameservers: Gameserver[] = [];
// [2026-10-10 1.14.7] Hunt ports are leased per launch id (portPool.ts): a late or duplicate release cannot
// free a port that a newer hunt holds.
const Ports = new PortPool();

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!;
// [move8 — 2026-07-10] Phoenix VeryVerbose diagnostic
//
// Symptom: gameserver logs "OnSetHttpRequestComplete Response failed, Null Response, Timeout?"
// followed by "Doesn't Have Data, Failing Any Queued Requests" and eventually crashes with
// exit code 3 after "Failed to update player account progress flag: UnknownError".
//
// Ghidra decompilation of OnSetHttpRequestComplete (0x140dc9230) shows the "Null Response"
// path fires when the FHttpResponsePtr itself is NULL — the HTTP client never materialized
// a response at all. That means the failing request either (a) went to a host not in the
// interceptor's IsBackendHost() list and passthru'd to a dead upstream, or (b) reached the
// backend but the interceptor closed the socket before delivering the response.
//
// Metagame log shows ZERO [REQ]/[RES] entries in the 21ms window before the failure fires,
// so the request didn't reach metagame. We need Phoenix to tell us WHICH URL it's retrying
// with "Null Response". The decompilation shows these VeryVerbose logs exist:
//   - "OnSetHttpRequestComplete for Attempt #: %d, Keys: %s"
//   - "OnSetHttpRequestComplete Response Content: %s"
//   - "OnSetHttpRequestComplete Failed To Parse, Missing Data Field, Response: %s"
// and are gated on `5 < DAT_146a07410` (VeryVerbose level for LogPhoenixCharacter).
//
// LogCmds arg format is UE4-standard: category+space+verbosity, comma-separated.
// LogOnline is also bumped because "Failed to update player account progress flag" is
// under LogOnline and we want its full context too.
//
// [2026-07-21] LogOnline dropped from VeryVerbose to Verbose. Root-caused a permanent per-tick
// server degradation on long-lived Ramsgate sessions: LogOnline VeryVerbose makes native netcode
// verbosely format connection/channel object NAMES on every tick (FName::ToString-family calls),
// and once a connection/channel is in a stale/half-torn state (see the incomplete disconnect
// teardown already flagged elsewhere - NotifyClientDisconnectedHook never fires for a normal
// quit), that formatting call dereferences a NULL/corrupted FName and faults (0xC0000005,
// confirmed via Ghidra at the exact native crash site). SafeManualTickDispatch/SafeManualTickFlush
// swallow the exception so the process survives, but the SAME fault then recurs on literally
// every subsequent tick for the rest of that server's life - TickDispatch/TickFlush never
// actually complete again, so outgoing replication stops flushing (stale/broken HUD state, travel
// requests like the Ramsgate airship never arriving). Confirmed via a real repro log: 10,575
// consecutive "[NetTickTrace] ... swallowed TickFlush exception" lines, onset at a single tick and
// continuous through end of capture. Ramsgate hits this and hunts don't because Ramsgate is
// long-running and accumulates far more connection churn (repeated joins/leaves) than any single
// hunt's lifetime. Verbose (not VeryVerbose) still keeps LogOnline's warnings/errors (the original
// reason it was bumped - "Failed to update player account progress flag") without the per-tick
// object-name formatting tier that's the actual crash trigger.
const STANDARD_GAMESERVER_ARGS = [
    "-EpicPortal",
    "-server",
    "-nullrhi",
    "-warp",
    // [1.14.7 2026-10-03] A dedicated hub must not initialise or play audio. Window suppression
    // alone left the process initialising the audio stack, so launching a hub played the game's
    // launch audio on the host machine. -nosound is UE's own switch (FApp::SetUseSound(false)) and
    // is checked by the audio device and by the Wwise/AkAudio plugin before it starts.
    "-nosound",
    "-RepDriverEnable",
    // [1.14.7 2026-10-03] LogLoad Off: this WindowsClient build run headless floods that category with
    // "WorldContext requested with invalid context object" (the client build's UI/world-lookup noise,
    // see Progress/34 section AA) until the runtime log reaches 500+ MB, which makes the log useless for
    // diagnosis and expensive to read. LogOnline/LogPhoenixCharacter verbosity is unchanged.
    "-LogCmds=\"LogPhoenixCharacter VeryVerbose, LogOnline Verbose, LogLoad Off\""
];
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);
const GAMESERVER_READY_TIMEOUT_MS = Number(process.env.GAMESERVER_READY_TIMEOUT_MS ?? "30000");

// [2026-10-10 1.14.7] The persistent hubs are owned by one HubSupervisor each (hubSupervisor.ts): one start
// in flight per hub, retries with capped backoff after a failed start or a crash loop, and both hubs'
// cold starts serialized through one gate (never Ramsgate and the dojo at once). The supervisor's
// `current` is undefined while a hub is down or restarting, so the getters answer "not ready" instead of
// handing out a dead address (the 2026-10-04 fencing rule).
//   HUB_PROMPT_RESTART=1 (default)  a hub exit restarts the hub at once (exit event, or a getter that finds
//                                   the process gone or the hub missing), subject to the crash-loop backoff.
//   HUB_PROMPT_RESTART=0            hub exits are noticed only by the 60 s watchdog, as before; the getters
//                                   still refuse a dead hub but never start one. A failed start is still
//                                   retried on its backoff timer and by the watchdog.
//                                   0, false, no and off (any case) all switch it off.
// A hub start other than the boot start first waits (capped at 60 s) for the hunt ServerLaunchQueue tail as
// it stands at that moment, so a prompt restart is spaced behind hunt cold starts already queued by the same
// SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP stagger hunts get from each other (the FAsyncLoadingThread rule
// in Startup). The hub is not added to the stagger: hunts queued after it do not wait for it.
const HUB_PROMPT_RESTART = !/^(0|false|no|off)$/i.test((process.env.HUB_PROMPT_RESTART ?? "1").trim());
const HUB_HUNT_QUEUE_WAIT_CAP_MS = 60_000;
const StartHubSerialized = CreateSerialGate();
const HubLog = (Level: HubLogLevel, Message: string, Error?: unknown) =>
    Error === undefined ? logger[Level](Message) : logger[Level]({ error: Error }, Message);
const RamsgateHub = new HubSupervisor<Gameserver>({
    label: "ramsgate",
    start: (Reason) => StartHubSerialized(async () => {
        if (Reason !== "boot") await WaitForHuntLaunchQueue("ramsgate");
        return StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    }),
    isAlive: (Server) => IsProcessAlive(Server.processId),
    log: HubLog
});
const TrainingHub = new HubSupervisor<Gameserver>({
    label: "training_dojo",
    start: (Reason) => StartHubSerialized(async () => {
        if (Reason !== "boot") await WaitForHuntLaunchQueue("training_dojo");
        return StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    }),
    isAlive: (Server) => IsProcessAlive(Server.processId),
    log: HubLog
});

// [2026-10-11 P2P on 1.14.7, plan 39_ §13.1 B7] The owner's target hosts the Training Grounds on players' PCs (Metagame
// P2P_TRAINING_ENABLED), so the dedicated Training hub becomes optional. It stays the fallback either way:
//   TRAINING_HUB=on (default)  booted with Ramsgate and supervised as before - nothing changes.
//   TRAINING_HUB=off           not started at boot and not restarted by the watchdog until the first Training request
//                              (a player the Metagame routes to the dedicated hub because no player host is eligible).
//                              That request waits for the start (up to GAMESERVER_READY_TIMEOUT_MS) instead of
//                              failing, and from then on the hub is supervised like Ramsgate.
//                              0, false, no and off (any case) all mean off.
const TRAINING_HUB_AT_BOOT = HubSwitchOn(process.env.TRAINING_HUB, true);

// [2026-10-14 Paradox realms] A realm's Ramsgate runs on its host's PC, so the dedicated Ramsgate hub can be switched off:
//   RAMSGATE_HUB=on (default)  booted and supervised as before - nothing changes.
//   RAMSGATE_HUB=off           never started (not at boot, not by the watchdog, not by a request). Realm players never
//                              use it; a player routed to the dedicated Ramsgate gets "not ready". The Director still
//                              answers hunt manifests (realm hunts ask it for their map and Behemoth).
//                              0, false, no and off (any case) all mean off.
const RAMSGATE_HUB_ENABLED = HubSwitchOn(process.env.RAMSGATE_HUB, true);
let TrainingHubWanted = TRAINING_HUB_AT_BOOT;

// Trials uses 181 real numbered arena rows. Keep the live default at one week, but permit short,
// deterministic UTC buckets for end-to-end rotation testing (for example, 30 minutes). The injected
// server DLL reads the same inherited environment variable and uses the same Unix-epoch bucket formula,
// so Ramsgate's advertised row and DeployServer's spawned matchmaker row cannot drift apart.
// [2026-07-17 resource guardrails] Each hunt is a full UE4 dedicated-server process (~1 GB even at
// -nullrhi), so on an 8 GB box only a couple can coexist alongside the persistent Ramsgate + Dojo.
// Previously nothing capped spawns, so matchmaking/travel spam exhausted RAM until the whole box died.
//   MAX_CONCURRENT_HUNT_SERVERS   hard cap on live non-persistent (hunt) servers (default 3)
// NOTE: empty/abandoned hunts are reclaimed by the gameserver DLL self-terminating when it has had no
// client connections for a grace period (accurate: never kills a hunt while anyone is still fighting).
// We deliberately do NOT reap by wall-clock lifetime — big maps + long hunts must not be cut short.
const MAX_CONCURRENT_HUNT_SERVERS = Number(process.env.MAX_CONCURRENT_HUNT_SERVERS ?? "3");

// [2026-07-19] Public Hunt Server Reuse (Part B). When enabled, a SHARED (public Hunting Grounds) request
// for a player hunt id that already has a live, ready, non-full server JOINS that server instead of
// spawning a new one — so P2 lands on P1's instance (the DLL backfills the late joiner's PlayerHuntId).
// Default OFF: enable with ENABLE_PUBLIC_HUNT_REUSE=1 for the controlled A/B test; flip to 0 to instantly
// revert to spawn-per-player if late-joiner attribution is ever wrong. PUBLIC_HUNT_MAX_PLAYERS is the reuse
// occupancy cap and MUST match the DLL's HUB_MAX_PLAYERS (the ?MaxPlayers the server actually accepts;
// default 4). See Plans/PUBLIC_HUNT_SERVER_REUSE_PLAN.md.
const ENABLE_PUBLIC_HUNT_REUSE = (process.env.ENABLE_PUBLIC_HUNT_REUSE ?? "0") === "1";
const PUBLIC_HUNT_MAX_PLAYERS = Number(process.env.PUBLIC_HUNT_MAX_PLAYERS ?? "4");

// Thrown when the hunt-server cap is reached; the matchmaker route catches it and falls back to
// Ramsgate rather than piling on another process (or leaking an unhandled rejection).
export class NoHuntCapacityError extends Error {
    constructor(current: number, cap: number) {
        super(`Hunt server capacity reached (${current}/${cap})`);
        this.name = "NoHuntCapacityError";
    }
}

export class GameserverStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GameserverStartupError";
    }
}

function CountHuntServers(): number {
    return Gameservers.filter((Server) => !Server.isRamsgate && !Server.isTrainingDojo).length;
}

// Where each dedicated-server process's console output is captured, one file
// per port, so it can be grepped directly. Defaults to <repo>/debug/gameservers.
const GAMESERVER_LOG_DIR = path.resolve(
    process.env.GAMESERVER_LOG_DIR ?? path.join(process.cwd(), "../debug/gameservers")
);
fs.mkdirSync(GAMESERVER_LOG_DIR, { recursive: true });

function WaitForServerReady(Child: ReturnType<typeof spawn>, LaunchId: string, Port: number, Label: string): Promise<void> {
    if (!Child.stdout) {
        return Promise.reject(new GameserverStartupError(`${Label} port ${Port} has no stdout pipe for readiness`));
    }

    /*
     * [2026-07-19 GAME-THREAD FREEZE FIX] Readiness is detected with a plain 'data' listener, NOT
     * readline.createInterface, and the listener is removed WITHOUT ever pausing the stream.
     *
     * WHAT WENT WRONG: createInterface() attaches to Child.stdout — the same stream already feeding
     * pipe(LogStream) — and Lines.close() PAUSES that input. Once paused, nothing drains the child's
     * stdout, the OS pipe buffer fills, and the gameserver's next write to stdout blocks forever in
     * the kernel. The CRT holds its per-stream stdio lock across that blocked write, so the game
     * thread deadlocks on its very next log call and the whole server freezes mid-hunt.
     *
     * Captured stack of a frozen game thread (port 8788, pid 3560, 2-player hunt):
     *     frame[0]  ntdll.dll+0x162A34          <- blocked in the wait
     *     frame[1]  KERNELBASE.dll+0xB194D
     *     frame[2..7] ucrtbase.dll              <- stdio, holding the stream lock
     *     frame[8]  Dauntless+0x2419A78         <- UE's log/Logf (calls __stdio_common_vswprintf)
     * RIP and RSP were byte-identical 161 seconds apart: a hard wait, no progress.
     *
     * The tell was visible long before the stack was: gameserver stdout goes silent immediately
     * after MYSTICPARADOX_GAMESERVER_READY — i.e. exactly when Lines.close() paused the stream.
     *
     * Matches every reported symptom: not tied to a map or behemoth, worse with more players (more
     * log volume fills the pipe sooner), instantaneous with no prior degradation, and cured by a
     * restart (fresh pipes).
     *
     * RULE: pipe(LogStream) must remain the sole, always-flowing consumer of Child.stdout. Never
     * pause() it, and never attach anything that pauses it on cleanup.
     */
    return new Promise((resolve, reject) => {
        let settled = false;
        let Buffered = "";

        const OnData = (Chunk: Buffer | string) => {
            Buffered += Chunk.toString();

            let NewlineIndex: number;
            while ((NewlineIndex = Buffered.indexOf("\n")) !== -1) {
                const Line = Buffered.slice(0, NewlineIndex);
                Buffered = Buffered.slice(NewlineIndex + 1);
                HandleLine(Line);
            }

            // A gameserver that never emits a newline must not grow this unboundedly.
            if (Buffered.length > 65536) Buffered = Buffered.slice(-4096);
        };

        const Finish = (Error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(Timeout);
            // Detach only. Do NOT pause/destroy — pipe(LogStream) has to keep draining stdout for
            // the entire life of the process, or the child blocks on a full pipe (see above).
            Child.stdout?.off("data", OnData);
            Child.off("exit", OnExit);
            Child.off("error", OnError);
            Error ? reject(Error) : resolve();
        };
        const OnExit = (Code: number | null, Signal: NodeJS.Signals | null) => Finish(new GameserverStartupError(`${Label} port ${Port} exited before ready (code=${Code ?? "null"}, signal=${Signal ?? "null"})`));
        const OnError = (Error: Error) => Finish(new GameserverStartupError(`${Label} port ${Port} failed before ready: ${Error.message}`));
        const Timeout = globalThis.setTimeout(() => Finish(new GameserverStartupError(`${Label} port ${Port} did not report ready within ${GAMESERVER_READY_TIMEOUT_MS}ms`)), GAMESERVER_READY_TIMEOUT_MS);

        function HandleLine(Line: string){
            const Match = /^MYSTICPARADOX_GAMESERVER_READY launchId=([0-9a-f-]+) port=(\d+)$/.exec(Line.trim());
            if (!Match) return;
            if (Match[1] !== LaunchId || Number(Match[2]) !== Port) {
                logger.warn(`Ignoring mismatched gameserver readiness marker on port ${Port}: ${Line}`);
                return;
            }
            Finish();
        }

        Child.stdout!.on("data", OnData);
        Child.once("exit", OnExit);
        Child.once("error", OnError);
    });
}

// [1.14.7 FENCING 2026-10-04] The hub reference is cleared BEFORE its restart, so the getters throw their
// existing "not ready" (callers wait on that) instead of returning the dead hub's address.
// [2026-10-05] A failed restart must never escape to the watchdog's setInterval (an unhandled rejection
// once killed the whole DeployServer and with it the healthy Ramsgate).
// [2026-10-10 1.14.7] The hub supervisors own the restart: CleanupServer no longer awaits it (the watchdog
// pass stays short, which ends the stale-snapshot port race), HubSupervisor.ensure() never rejects, and a
// failed restart is retried with backoff instead of being "left down until the next request" (nothing ever
// retried it). Idempotent: the exit event, the getters and the watchdog may all report the same server.
export async function CleanupServer(ServerToShutdown: Gameserver, Reason: string = "watchdog"){
    const Listed = Gameservers.includes(ServerToShutdown);
    if (Listed) Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(ServerToShutdown.isRamsgate || ServerToShutdown.isTrainingDojo){
        const Hub = ServerToShutdown.isRamsgate ? RamsgateHub : TrainingHub;
        if (ServerToShutdown === Hub.current) {
            logger.warn(ServerToShutdown.isRamsgate
                ? `RAMSGATE HAS FALLEN (${Reason})! Restarting!`
                : `Training Dojo down (${Reason})! Restarting!`);
            Hub.onExit(ServerToShutdown, Reason);
        } else if (Listed) {
            // Never current: the hub exited during its own readiness wait. Its start attempt reports the
            // failure and schedules the retry; nothing restarts here.
            logger.info(`[HubSupervisor] ${ServerToShutdown.isRamsgate ? "ramsgate" : "training_dojo"} pid=${ServerToShutdown.processId} exited during startup (${Reason}); its start attempt handles the retry`);
        }
        return;
    }

    // Owner-checked: a no-op when the exit event already returned the port (or a newer hunt holds it).
    Ports.release(ServerToShutdown.port, ServerToShutdown.launchId);
}

// [2026-10-10 1.14.7] Watchdog fallback for a hunt whose exit event never arrived after it left Gameservers
// (a timed-out start whose kill was issued, or a lost child handle): its lease is returned once the
// recorded pid is gone. A lease whose pid is still alive stays held - that process may still own the socket.
export function ReclaimOrphanedPortLeases(): void {
    const Reclaimed = Ports.reclaim(
        (Owner) => Gameservers.some((Server) => Server.launchId === Owner),
        (Pid) => IsProcessAlive(Pid)
    );
    for (const Lease of Reclaimed) {
        logger.warn(`[PortPool] reclaimed port ${Lease.port} from launch ${Lease.owner} (pid=${Lease.pid ?? "none"} gone, no exit event)`);
    }
}

// [2026-10-10 1.14.7] Watchdog safety net for the hubs: retries a hub whose start failed (it is in neither
// Gameservers nor its supervisor) and restarts a dead hub that sent no exit event.
export function TickPersistentHubs(): void {
    if (RAMSGATE_HUB_ENABLED) RamsgateHub.tick();
    // An on-demand Training hub (TRAINING_HUB=off) is left alone until someone asked for it.
    if (TrainingHubWanted) TrainingHub.tick();
}

let ServerLaunchQueue: Promise<void> = Promise.resolve();

// [2026-10-10 1.14.7] Hub restarts wait for the hunt stagger tail captured now (only hunts already queued),
// capped so a burst of matchmaking requests cannot keep a down hub down. Never rejects.
async function WaitForHuntLaunchQueue(Label: string): Promise<void> {
    const Tail = ServerLaunchQueue.catch(() => {});
    const StartedAt = performance.now();
    let CapTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const TimedOut = await Promise.race([
        Tail.then(() => false),
        new Promise<boolean>((resolve) => { CapTimer = globalThis.setTimeout(() => resolve(true), HUB_HUNT_QUEUE_WAIT_CAP_MS); })
    ]);
    globalThis.clearTimeout(CapTimer);
    const WaitedMs = Math.round(performance.now() - StartedAt);
    if (TimedOut) logger.warn(`[HubSupervisor] ${Label} hunt launch queue still busy after ${WaitedMs} ms - cold-starting anyway`);
    else if (WaitedMs >= 100) logger.info(`[HubSupervisor] ${Label} waited ${WaitedMs} ms for the hunt launch queue before cold start`);
}

async function StartServer(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){
    // The stagger queue exists to stop a BURST of hunt-server spawns (real matchmaking requests)
    // from slamming the box with several simultaneous UE4 process starts. Ramsgate and Training are
    // the two persistent hubs: exactly one of each, spawned once at boot (or restarted individually
    // by CleanupServer on a crash) — there is nothing to stagger them against, and queuing them
    // behind it only delayed boot for no reason (and would delay a crashed hub's restart behind
    // whatever hunt spawns happened to be mid-stagger at the time). Only real hunt spawns enqueue.
    if(!IsRamsgate && !IsTrainingDojo){
        const LaunchProc = ServerLaunchQueue;
        ServerLaunchQueue = ServerLaunchQueue.catch(() => {}).then(async () => await setTimeout(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));
        await LaunchProc;
    }

    let Port: number | undefined;
    const Id = crypto.randomUUID();

    if(IsRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(IsTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        // Authoritative cap check here (after the launch queue serialized us) so concurrent spam can't
        // race past it: only spawn a new hunt if we're under the concurrent cap. Over-cap throws
        // NoHuntCapacityError, which the matchmaker falls back to Ramsgate on (no extra process, no OOM).
        if(CountHuntServers() >= MAX_CONCURRENT_HUNT_SERVERS){
            throw new NoHuntCapacityError(CountHuntServers(), MAX_CONCURRENT_HUNT_SERVERS);
        }
        Port = Ports.take(Id);
    }

    if(Port == undefined){
        throw new Error("No free ports left!");
    }
    // TS does not narrow a `let` inside the exit closure below.
    const LeasedPort: number = Port;
    const IsHunt = !IsRamsgate && !IsTrainingDojo;

    // Per-gameserver console capture (organized under the debug dir) so the
    // dedicated-server output can be grepped directly. Piping also drains
    // stdout/stderr so a chatty server can't stall on a full, unread OS pipe.
    const Label = IsRamsgate
        ? "ramsgate"
        : IsTrainingDojo
            ? "training_dojo"
            : (Behemoth != undefined ? Behemoth.split("/").pop()!.split(".")[0] : "hunt");
    const LogPath = path.join(GAMESERVER_LOG_DIR, `port${Port}_${Label}.log`);
    const LogStream = fs.createWriteStream(LogPath, { flags: "a" });
    LogStream.write(
        `=== Gameserver launch ${new Date().toLocaleString()} (local time) ===\n` +
        `port=${Port} map=${Map} behemoth=${Behemoth ?? "NO_BEHEMOTH"} ` +
        `mmHunt=${MatchmakerHuntId ?? "NO_MM_HUNTID"} ` +
        `players=${ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS"}\n\n`
    );

    // Pin an arena child to the exact week chosen above. Persistent hubs intentionally receive no
    // override and keep following the rotating schedule; an in-progress Trial retains the row it was
    // launched for even if the global UTC bucket changes while its process is starting/running.
    const ArenaWeekMatch = MatchmakerHuntId?.match(/^Arena_MatchmakerHunt_(?:Easy|Hard|Elite)_(\d{3})$/);
    const ChildEnvironment = {
        ...process.env,
        MYSTICPARADOX_GAMESERVER_LAUNCH_ID: Id,
        ...(ArenaWeekMatch ? { MYSTICPARADOX_TRIALS_WEEK: ArenaWeekMatch[1] } : {})
    };

    let Child: ReturnType<typeof spawn>;
    try {
        Child = spawn(GAMESERVER_BINARY_PATH, [
            METAGAME_API_KEY,
            Port.toString(),
            Map,
            Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
            MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
            ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
            MY_IP + ":" + Port.toString(),
            ...STANDARD_GAMESERVER_ARGS
        ], {
            // [1.14.7] The game executable is a GUI application, so it creates a render window even
            // with -nullrhi. windowsHide sets STARTF_USESHOWWINDOW=SW_HIDE, which is what keeps the
            // dedicated hubs headless on this box. stdout/stderr remain piped to the per-port log
            // either way. Set GAMESERVER_WINDOWS_HIDE=0 to show the window for interactive debugging.
            windowsHide: (process.env.GAMESERVER_WINDOWS_HIDE ?? "1") !== "0",
            stdio: ["ignore", "pipe", "pipe"],
            // The DLL prints this child-only correlation value only after Listen succeeds.
            env: ChildEnvironment
        });
    } catch (SpawnError) {
        // [2026-10-10 1.14.7] A synchronous spawn failure has no child and no exit event: return the lease.
        if (IsHunt) Ports.release(LeasedPort, Id);
        LogStream.end();
        throw SpawnError;
    }
    if (IsHunt) Ports.attachPid(LeasedPort, Id, Child.pid);

    Child.stdout?.pipe(LogStream);
    Child.stderr?.pipe(LogStream);
    LogStream.write(`pid=${Child.pid ?? "unknown"}\n\n`);

    logger.info(`${Label} spawned on port ${Port} (pid=${Child.pid ?? "unknown"}) -> ${LogPath}`);

    Child.on("exit", (code, signal) => {
        const ExitMessage = `Gameserver process exited port=${Port} label=${Label} pid=${Child.pid} code=${code ?? "null"} signal=${signal ?? "null"}`;
        logger.warn(ExitMessage);
        LogStream.write(`\n=== ${ExitMessage} ===\n`);

        // [2026-07-17] Reclaim immediately instead of waiting up to 60s for the watchdog — this lag was
        // part of the port/RAM leak under churn. For a HUNT, drop it from the live list and return its
        // port to the pool right now: the process is confirmed gone, and the release is owner-checked.
        // [2026-10-10 1.14.7] A hub exit now reaches its supervisor at once (CleanupServer -> onExit, with
        // crash-loop backoff) instead of waiting up to 60 s for the watchdog. A hub that exits during its
        // own readiness wait is not current yet: CleanupServer only logs it and the start's rejection drives
        // the retry. HUB_PROMPT_RESTART=0 leaves hubs listed for the watchdog, as before.
        if(IsHunt){
            Gameservers = Gameservers.filter((Server) => Server.launchId !== Id);
            Ports.release(LeasedPort, Id);
        }
        else if(HUB_PROMPT_RESTART){
            const Hub = Gameservers.find((Server) => Server.launchId === Id);
            if (Hub) void CleanupServer(Hub, `exit code=${code ?? "null"} signal=${signal ?? "null"}`);
        }
    });

    Child.on("error", (err) => {
        const ErrorMessage = `Gameserver process error port=${Port} label=${Label} pid=${Child.pid}: ${err.message}`;
        logger.error(ErrorMessage);
        LogStream.write(`\n=== ${ErrorMessage} ===\n`);
    });

    Child.unref();

    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: ExpectedPlayers,
        isRamsgate: IsRamsgate,
        isTrainingDojo: IsTrainingDojo,
        processId: Child.pid!,
        startTime: new Date(),
        state: "starting",
        launchId: Id
    };

    Gameservers.push(NewGameserver);

    try {
        await WaitForServerReady(Child, Id, Port, Label);
        NewGameserver.state = "ready";
        NewGameserver.readyTime = new Date();
        logger.info(`${Label} ready on ${MY_IP}:${Port} after ${NewGameserver.readyTime.getTime() - NewGameserver.startTime.getTime()}ms`);
    }
    catch (Err: any) {
        NewGameserver.state = "failed";
        Gameservers = Gameservers.filter((Server) => Server !== NewGameserver);
        // [2026-10-10 1.14.7] Return a hunt's port only when its process is really gone. A timed-out child
        // that is still alive is killed and its exit event releases the port (owner-checked); if that event
        // never arrives, the watchdog reclaims the lease once the pid is gone (ReclaimOrphanedPortLeases).
        const Gone = Child.pid === undefined || Child.exitCode !== null || Child.signalCode !== null;
        if (!Gone) Child.kill();
        else if (IsHunt) Ports.release(LeasedPort, Id);
        throw Err instanceof GameserverStartupError ? Err : new GameserverStartupError(`${Label} port ${Port} readiness failed: ${Err?.message ?? Err}`);
    }

    return NewGameserver;
}

// [1.14.7 FENCING 2026-10-04] A cached "ready" state is NOT proof that the hub is still serving. Measured
// failure: Ramsgate left its map for AFK at 12:52:58 (LeavingMap, then "LoadMap: failed to Listen"), the
// cached object stayed ready, and a client already in matchmaking was handed that address -
// "RemoteAddr: 127.0.0.1:8790" - and timed out after 20s, while the replacement only reported
// "Networking::Listen returned OK" 17 seconds later.
//
// So revalidate before answering: the process must still be alive (the same kill(pid, 0) probe the watchdog
// uses), and the hub must have confirmed the port. Map/listener loss is reported by the hub itself - its DLL
// exits when it can no longer serve - and CleanupServer now clears the cached reference BEFORE the restart
// await, which is what closes the window.
function IsProcessAlive(ProcessId: number | undefined): boolean {
    if (ProcessId == undefined) return false;
    try {
        kill(ProcessId, 0);
        return true;
    } catch {
        return false;
    }
}

// [1.14.7 FENCING 2026-10-04] Live status of the persistent hubs, so a caller can revalidate a cached
// candidate before handing its address to a client. "state === ready" alone is not enough: it survives the
// process, and during a restart the old reference was previously still returned (see CleanupServer).
export function GetPersistentHubStatus(){
    const Describe = (Server: Gameserver | undefined) => {
        if (Server == undefined) return null;
        if (Server.state !== "ready") return null;
        if (!IsProcessAlive(Server.processId)) return null;
        return {
            ready: true,
            host: MY_IP,
            port: Server.port,
            processId: Server.processId
        };
    };

    return {
        ramsgate: Describe(RamsgateHub.current),
        trainingDojo: Describe(TrainingHub.current)
    };
}

// [2026-10-10 1.14.7] Both getters check ready AND alive (the Training getter used to hand out a dead dojo's
// address for up to 60 s). A dead hub is reported to its supervisor, which restarts it; a missing hub asks
// the supervisor for a start (it honours the backoff and joins a start already in flight). Either way the
// caller gets the synchronous "not ready" it already waits on. With HUB_PROMPT_RESTART=0 the getters only
// refuse; the watchdog restarts.
function HubConnectionDetails(Hub: HubSupervisor<Gameserver>, Name: string){
    const Server = Hub.current;
    if (Server && Server.state === "ready" && IsProcessAlive(Server.processId)) {
        return {
            host: MY_IP,
            port: Server.port
        };
    }
    if (HUB_PROMPT_RESTART) {
        if (Server && !IsProcessAlive(Server.processId)) void CleanupServer(Server, "getter: process gone");
        else if (!Server) void Hub.ensure("request");
    }
    throw new GameserverStartupError(`${Name} is not ready`);
}

export function GetRamsgateConnectionDetails(){
    if (!RAMSGATE_HUB_ENABLED) throw new GameserverStartupError("the dedicated Ramsgate hub is switched off (RAMSGATE_HUB=off)");
    return HubConnectionDetails(RamsgateHub, "Ramsgate");
}

export function GetTrainingDojoConnectionDetails(){
    return HubConnectionDetails(TrainingHub, "Training Dojo");
}

// [2026-10-11] The matchmaker's Training getter. With the hub booted (TRAINING_HUB=on) this is exactly the getter above.
// An on-demand hub (TRAINING_HUB=off) that is not up yet is started here - whatever HUB_PROMPT_RESTART says, since
// nothing else would start it - and the request waits for that start (HubSupervisor.ensure is single-flight and never
// rejects); a failed start still answers the usual "not ready".
export async function GetTrainingDojoConnectionDetailsForRequest(){
    if (TRAINING_HUB_AT_BOOT) return GetTrainingDojoConnectionDetails();
    if (!TrainingHubWanted) logger.info("[TrainingHub] on-demand Training hub requested for the first time (TRAINING_HUB=off) - starting it");
    TrainingHubWanted = true;
    const Server = TrainingHub.current;
    if (!Server || Server.state !== "ready" || !IsProcessAlive(Server.processId)) {
        await TrainingHub.ensure("request");
    }
    return HubConnectionDetails(TrainingHub, "Training Dojo");
}

// [2026-07-19] Public Hunt Server Reuse (Part B). If a live, ready, non-full public-hunt server already
// hosts the SAME player hunt id, return its connection details (and add the joiner uids to its roster) so
// the late joiner lands there instead of spawning a new process. Keyed on the PLAYER hunt id (not the
// matchmaker row — GetMatchmakerHuntIdFromPlayerHuntId picks randomly and would split a party). Returns
// undefined when reuse is disabled or no suitable server exists, so the caller spawns fresh.
// Occupancy (MVP): roster grows on join and is NOT decremented on leave — the empty-watchdog reaps an
// emptied server and drops it from Gameservers, clearing its roster. A joiner could briefly be added to a
// server in its ~50s empty-but-not-yet-reaped window (bounded, acceptable).
export function TryReuseSharedHuntServer(PlayerHuntId: string, JoinerUids: string[] | undefined): { host: string; port: number } | undefined {
    if(!ENABLE_PUBLIC_HUNT_REUSE) return undefined;
    if(PlayerHuntId == undefined || PlayerHuntId.trim().length === 0) return undefined;

    const Candidate = Gameservers.find((Server) =>
        Server.state === "ready"
        && !Server.isRamsgate
        && !Server.isTrainingDojo
        && Server.expectedPlayers != undefined
        && Server.expectedPlayers.length > 0
        && Server.expectedPlayers[0].playerHuntId === PlayerHuntId
        && Server.expectedPlayers.length < PUBLIC_HUNT_MAX_PLAYERS
    );

    if(Candidate == undefined) return undefined;

    if(JoinerUids != undefined){
        for(const Uid of JoinerUids){
            if(!Candidate.expectedPlayers!.some((Player) => Player.playerUid === Uid)){
                Candidate.expectedPlayers!.push({ playerUid: Uid, playerHuntId: PlayerHuntId });
            }
        }
    }

    logger.info(`[PublicHuntReuse] joining existing server port=${Candidate.port} pid=${Candidate.processId} huntId=${PlayerHuntId} roster=${Candidate.expectedPlayers!.length}/${PUBLIC_HUNT_MAX_PLAYERS}`);

    return {
        host: MY_IP,
        port: Candidate.port
    };
}

function GetArgValue(GameArgs: string, Key: string){
    const Query = GameArgs.split("?").slice(1);

    for(const Arg of Query){
        const [ArgKey, ...ValueParts] = Arg.split("=");

        if(ArgKey === Key){
            return ValueParts.join("=");
        }
    }

    return undefined;
}

function GetExpectedPlayers(PlayerIds: string[] | undefined, PlayerHuntId: string | undefined){
    if(PlayerIds == undefined || PlayerIds.length === 0 || PlayerHuntId == undefined || PlayerHuntId.trim().length === 0){
        return undefined;
    }

    return PlayerIds.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: PlayerHuntId
        };
    });
}

export async function StartupGameserverWithArgs(GameArgs: string, HuntId: string | undefined, ExpectedPlayers: string[] | undefined){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GetArgValue(GameArgs, "MonsterClass");
    const MatchmakerHuntIdFromArgs = GetArgValue(GameArgs, "HuntID");
    const MatchmakerHuntId = MatchmakerHuntIdFromArgs != undefined && MatchmakerHuntIdFromArgs.trim().length > 0
        ? MatchmakerHuntIdFromArgs
        : (HuntId != undefined && HuntId.trim().length > 0 ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : undefined);

    const GameServerToReturn = await StartServer(Map, Behemoth, MatchmakerHuntId, GetExpectedPlayers(ExpectedPlayers, HuntId), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}

/*
 * [2026-10-14 M1] The matchmaker tables, the FGameplayTagQuery evaluator and the tag routing of Trials/Arena now live in
 * shared/hunt-manifest, which the Metagame resolves with too. This file keeps the Director's resolver over the tables it
 * loads, and the coverage diagnostics below. Trials do not name their matchmaker rows directly (MatchmakerHuntsByTag),
 * and their arena tables are separate DataTables, so they are registered as additional sources rather than merged.
 */
/** The resolver over the shared tables. A player row that is absent is recorded for the coverage diagnostics below. */
export const HuntResolver = CreateHuntResolver({
    tables: HuntTables,
    log: logger,
    trialsRotationMinutes: ParseTrialsRotationMinutes(process.env.TRIALS_ROTATION_MINUTES, logger),
    onMissingHunt: RecordMissingHuntRequest
});

/** Looks a matchmaker row up across every registered table. Main table wins on a name collision. */
export function FindMatchmakerRow(MatchmakerHuntId: string): any | undefined {
    return HuntResolver.FindMatchmakerRow(MatchmakerHuntId);
}

/** Resolves MatchmakerHuntsByTag into concrete matchmaker row names (shared/hunt-manifest). */
function ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId: string, Row: any): string[] {
    return HuntResolver.ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);
}

/*
 * Runtime registry of hunt ids the client asked for that our vendored tables cannot serve.
 *
 * WHY: ValidateHuntTableData is an INWARD consistency check — it walks rows that exist and
 * verifies their references resolve. It is structurally incapable of noticing a row that was
 * never exported. That is how the server booted with `problems=0` while every request for
 * ShatteredIsles_IslandT failed: the vendored tables stop at IslandR, and 1.12 ships islands
 * past it. The client is the only party that knows the real hunt id set, so we learn coverage
 * gaps from what it actually requests and surface them loudly instead of emitting an
 * indistinguishable error per retry.
 */
type MissingHuntRequest = { count: number; firstSeen: Date; lastSeen: Date };
const MissingHuntRequests = new Map<string, MissingHuntRequest>();

function RecordMissingHuntRequest(PlayerHuntId: string){
    const Now = new Date();
    const Existing = MissingHuntRequests.get(PlayerHuntId);

    if(Existing == undefined){
        MissingHuntRequests.set(PlayerHuntId, { count: 1, firstSeen: Now, lastSeen: Now });
        // First sighting only — the client retries hard, and one actionable line beats fifty.
        logger.error(`[HuntTableGap] Client requested HuntId '${PlayerHuntId}' which is absent from player_hunts_table. This hunt CANNOT start. The vendored tables predate this content — re-export with CatalogExporter EXPORT_HUNTS=1 and import the new rows.`);
        return;
    }

    Existing.count++;
    Existing.lastSeen = Now;
}

export function GetMissingHuntRequests(){
    return [...MissingHuntRequests.entries()]
        .map(([HuntId, Info]) => ({ huntId: HuntId, ...Info }))
        .sort((A, B) => B.count - A.count);
}

/** Emits a one-line summary of coverage gaps, or nothing when there are none. */
export function LogMissingHuntRequests(){
    if(MissingHuntRequests.size === 0) return;

    const Summary = GetMissingHuntRequests()
        .map((Entry) => `${Entry.huntId} x${Entry.count}`)
        .join(", ");

    logger.warn(`[HuntTableGap] ${MissingHuntRequests.size} hunt id(s) requested but missing from player_hunts_table: ${Summary}`);
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string): string{
    return HuntResolver.MatchmakerHuntIdFor(PlayerHuntId);
}


export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const Manifest = ResolveHuntLaunchManifest(HuntId, ExpectedPlayers);
    const MatchmakerHuntId = Manifest.matchmakerHuntId;
    const BehemothPath = Manifest.behemothPath === "NO_BEHEMOTH" ? undefined : Manifest.behemothPath;
    const MapPath = Manifest.mapPath;

    const GameServerToReturn = await StartServer(MapPath, BehemothPath, MatchmakerHuntId, ExpectedPlayers.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: HuntId
        };
    }), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

/** Resolve and freeze the exact server arguments without allocating a port or starting a process (shared/hunt-manifest). */
export function ResolveHuntLaunchManifest(HuntId: string, ExpectedPlayers: string[]) {
    return HuntResolver.ResolveManifest(HuntId, ExpectedPlayers);
}

/*
 * Prints where each lettered hunt family stops, e.g. "ShatteredIsles_Island: A-R (18)".
 *
 * This is the cheap human-readable half of gap detection. It cannot know that IslandS exists in
 * the client — only the client knows that — but a family that ends at R is an immediate visual
 * cue to check whether newer content was ever exported. Purely diagnostic; suffixes are not
 * assumed to be contiguous or complete.
 */
function LogHuntFamilyCoverage(PlayerHuntIds: string[]){
    const Families = new Map<string, string[]>();

    for(const HuntId of PlayerHuntIds){
        const Match = /^(.*?)([A-Z])$/.exec(HuntId);
        if(Match == undefined) continue;

        const [, Prefix, Suffix] = Match;
        const Existing = Families.get(Prefix);
        if(Existing == undefined) Families.set(Prefix, [Suffix]);
        else Existing.push(Suffix);
    }

    for(const [Prefix, Suffixes] of [...Families.entries()].sort()){
        // Two-member "families" are usually coincidence, not a lettered series.
        if(Suffixes.length < 3) continue;

        const Sorted = [...Suffixes].sort();
        const First = Sorted[0];
        const Last = Sorted[Sorted.length - 1];
        const Expected = Last.charCodeAt(0) - First.charCodeAt(0) + 1;
        const Gap = Expected > Sorted.length ? " (NON-CONTIGUOUS)" : "";

        logger.info(`[HuntTableCoverage] ${Prefix}: ${First}-${Last} (${Sorted.length})${Gap}`);
    }
}

export type HuntLaunchCoverageAudit = {
    totalPlayerHunts: number;
    resolvablePlayerHunts: number;
    unresolvedPlayerHunts: string[];
    referencedMatchmakerRows: number;
    uniqueMapAssets: string[];
    gameModeOverrides: string[];
    maxPlayerValues: number[];
};

/**
 * Enumerate the complete frozen-launch surface every hunt launch resolves through.
 * This deliberately audits table references rather than trusting hunt-name heuristics: direct
 * rows and tag-routed Trials go through the same resolver used at launch, while stale player rows
 * with no concrete destination remain visible as unsupported coverage instead of being guessed.
 */
export function AuditHuntLaunchCoverage(): HuntLaunchCoverageAudit {
    const PlayerRows = HuntTables.playerRows as Record<string, any>;
    const Unresolved: string[] = [];
    const ReferencedRows = new Set<string>();
    const Maps = new Set<string>();
    const GameModes = new Set<string>();
    const MaxPlayers = new Set<number>();

    for (const [PlayerHuntId, Row] of Object.entries(PlayerRows)) {
        const Direct = Array.isArray(Row?.MatchmakerHuntIDs)
            ? Row.MatchmakerHuntIDs
                .map((Entry: any) => Entry?.RowName)
                .filter((RowName: unknown): RowName is string =>
                    typeof RowName === "string" && RowName.length > 0 && RowName !== "None" && FindMatchmakerRow(RowName) != undefined)
            : [];
        const Candidates = Direct.length > 0 ? Direct : ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);
        if (Candidates.length === 0) {
            Unresolved.push(PlayerHuntId);
            continue;
        }

        for (const MatchmakerHuntId of Candidates) {
            const MatchmakerRow = FindMatchmakerRow(MatchmakerHuntId);
            if (MatchmakerRow == undefined) continue;
            ReferencedRows.add(MatchmakerHuntId);
            const Mode = typeof MatchmakerRow.GameModeOverride === "string" && MatchmakerRow.GameModeOverride.length > 0
                ? MatchmakerRow.GameModeOverride
                : "(map/default)";
            GameModes.add(Mode);
            if (Number.isSafeInteger(MatchmakerRow.MaxPlayers)) MaxPlayers.add(MatchmakerRow.MaxPlayers);
            for (const MapEntry of MatchmakerRow.MapList ?? []) {
                const Asset = MapEntry?.MapAssetName;
                if (typeof Asset === "string" && Asset.startsWith("/Game/") && Asset.includes(".")) Maps.add(Asset);
            }
        }
    }

    Unresolved.sort();
    return {
        totalPlayerHunts: Object.keys(PlayerRows).length,
        resolvablePlayerHunts: Object.keys(PlayerRows).length - Unresolved.length,
        unresolvedPlayerHunts: Unresolved,
        referencedMatchmakerRows: ReferencedRows.size,
        uniqueMapAssets: [...Maps].sort(),
        gameModeOverrides: [...GameModes].sort(),
        maxPlayerValues: [...MaxPlayers].sort((A, B) => A - B)
    };
}

/** Non-mutating audit for generated 1.12 hunt data; never invent legacy aliases. */
export function ValidateHuntTableData() {
    const PlayerRows = (HuntTables.playerRows as Record<string, any>);
    const MatchmakerRows = (HuntTables.matchmakerRows as Record<string, any>);
    const Problems: string[] = [];
    let DirectPlayerRows = 0;
    let TagRoutedReferences = 0;
    let TagRoutedPlayerRows = 0;

    const HasValidMapPath = (MatchmakerRow: any) =>
        Array.isArray(MatchmakerRow?.MapList) && MatchmakerRow.MapList.some((Map: any) =>
            typeof Map?.MapAssetName === "string" && Map.MapAssetName.startsWith("/Game/") && Map.MapAssetName.includes("."));

    for (const [PlayerHuntId, Row] of Object.entries(PlayerRows)) {
        const HasDirect = Array.isArray(Row?.MatchmakerHuntIDs) && Row.MatchmakerHuntIDs.length > 0;

        if (!HasDirect) {
            // No direct references is not automatically a fault — Trials route by tag. Actually
            // resolve it, so a broken tag query is reported here at boot instead of surfacing as a
            // failed hunt later.
            const Resolved = ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);
            if (Resolved.length === 0) continue;

            TagRoutedPlayerRows++;
            const Unusable = Resolved.filter((RowName) => !HasValidMapPath(FindMatchmakerRow(RowName)));
            if (Unusable.length > 0) {
                Problems.push(`${PlayerHuntId} -> ${Unusable.length}/${Resolved.length} tag-routed rows have no valid map`);
            }
            continue;
        }

        DirectPlayerRows++;
        for (const Entry of Row.MatchmakerHuntIDs) {
            const MatchmakerHuntId = Entry?.RowName;
            // "None" is the 1.12 table's tag-routed sentinel, not a dangling direct reference.
            if (MatchmakerHuntId === "None") { TagRoutedReferences++; continue; }
            // Registry lookup, not main-table-only: a direct reference may target an arena table.
            const MatchmakerRow = typeof MatchmakerHuntId === "string" ? FindMatchmakerRow(MatchmakerHuntId) : undefined;
            if (!MatchmakerRow) { Problems.push(`${PlayerHuntId} -> missing MatchmakerHunt '${String(MatchmakerHuntId)}'`); continue; }
            if (!HasValidMapPath(MatchmakerRow)) Problems.push(`${PlayerHuntId} -> ${MatchmakerHuntId} has no valid map`);
        }
    }
    const Coverage = AuditHuntLaunchCoverage();
    const Summary = { playerRows: Object.keys(PlayerRows).length, directPlayerRows: DirectPlayerRows, tagRoutedReferences: TagRoutedReferences, matchmakerRows: Object.keys(MatchmakerRows).length, problems: Problems, coverage: Coverage };
    logger.info(`[HuntTableAudit] playerRows=${Summary.playerRows} directRows=${Summary.directPlayerRows} tagRoutedRows=${TagRoutedPlayerRows} tagRoutedRefs=${Summary.tagRoutedReferences} matchmakerRows=${Summary.matchmakerRows} (+${HuntTables.matchmakerSources.length - 1} aux tables) problems=${Problems.length}`);
    logger.info(`[HuntLaunchCoverage] resolvable=${Coverage.resolvablePlayerHunts}/${Coverage.totalPlayerHunts} referencedMatchmakerRows=${Coverage.referencedMatchmakerRows} uniqueMaps=${Coverage.uniqueMapAssets.length} gameModes=${Coverage.gameModeOverrides.length} unresolved=${Coverage.unresolvedPlayerHunts.length}`);
    if (Coverage.unresolvedPlayerHunts.length > 0) logger.warn(`[HuntLaunchCoverage] unsupported player hunt rows: ${Coverage.unresolvedPlayerHunts.join(", ")}`);
    LogHuntFamilyCoverage(Object.keys(PlayerRows));
    for (const Problem of Problems.slice(0, 20)) logger.warn(`[HuntTableAudit] ${Problem}`);
    if (Problems.length > 20) logger.warn(`[HuntTableAudit] ${Problems.length - 20} additional problems omitted`);
    return Summary;
}

export async function Startup(){
    ValidateHuntTableData();
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        Ports.add(i);
    }

    // Do not cold-start both UE processes concurrently. Each process mounts the full pak set and
    // drives UE's async loader heavily; a real concurrent-start repro crashed Ramsgate's
    // FAsyncLoadingThread before it could create/listen on its NetDriver. Keep the starts serialized,
    // Ramsgate first, but still attempt Dojo and report both failures instead of losing a healthy
    // sibling when one hub fails.
    // [2026-10-10 1.14.7] Through the hub supervisors and their shared start gate: still sequential,
    // Ramsgate first, but a failed boot start is now retried with backoff instead of staying down.
    const Failures: string[] = [];
    if (RAMSGATE_HUB_ENABLED) {
        if (!(await RamsgateHub.ensure("boot"))) Failures.push("ramsgate");
    } else {
        logger.info("[RamsgateHub] RAMSGATE_HUB=off - no dedicated Ramsgate hub (realms run their own on the host's PC)");
    }
    if (TRAINING_HUB_AT_BOOT) {
        if (!(await TrainingHub.ensure("boot"))) Failures.push("training_dojo");
    } else {
        logger.info("[TrainingHub] TRAINING_HUB=off - the dedicated Training hub starts on its first request (fallback for hosted Training)");
    }

    // [2026-10-05] Report, do not throw. The bootstrap does catch this rejection, but a failed hub start
    // is not fatal to the service: the healthy sibling must keep serving. Throwing here also marked the
    // whole DeployServer unready even when Ramsgate itself was listening.
    if (Failures.length > 0) {
        logger.warn(`Persistent hub startup reported failures (${Failures.join("; ")}) - continuing with whichever hubs are up; retrying with backoff until up`);
    }
}
