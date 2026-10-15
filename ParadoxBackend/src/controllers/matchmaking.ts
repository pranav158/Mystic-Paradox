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

import { RecordDedicatedHuntEnds, RecordDedicatedHuntStarts } from "../activity/activityMonitor";
import { logger } from "../logger";
import { GetRequestId, REQUEST_ID_HEADER } from "../observability/requestContext";
import crypto from "node:crypto";
import { CandidateLeaveOutcome, GetP2PExtension } from "../extensions/p2p";
import { GAUNTLET_DISABLED_REASON, RefusesGauntletRequest } from "../matchmakingHuntPolicy";
import { GetPartyForPlayer } from "./party";
import { DedicatedServersConfigured } from "../config/dedicatedServers";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
// [2026-10-15] Unset or blank (the VPS has no DeployServer): nothing is requested from one, and a hub or hunt that needs one is
// cancelled with NO_DEDICATED_SERVERS. Read from the same value as the address, so the check and the request cannot disagree.
const DEPLOYSERVER_CONFIGURED = DedicatedServersConfigured({ DEPLOYSERVER_URL });
const NO_DEDICATED_SERVERS_REASON = "NO_DEDICATED_SERVERS";
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";

/** A DeployServer launch. `reason` is set when no launch was requested because no DeployServer is configured. */
interface DeployServerLaunch {
    succeeded: boolean;
    readyNow: boolean;
    host: string;
    port: number;
    reason?: string;
}

let HubStatusUnavailableLogged = false;

type MatchmakingQueueData = {
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean
};

export type MatchmakingResult = {
    Ready: boolean,
    Canceled?: boolean,
    StatusReason?: string,
    HuntId: string,
    CandidateId: string,
    GameSessionId: string,
    Host: string,
    Port: number,
    // Epoch ms. Ready remains internal server readiness; this controls the shared
    // client-visible Go Now release after the instance is genuinely online.
    ReadyAt: number,
    // [2026-10-14 realms S2] A realm's Ramsgate or Training hub on a member's PC (the P2P module's candidate). SourceSessionId is
    // the hub session the candidate's status is read from (GameSessionId is the hub's stable chat room id, not a session id).
    Source?: "REALM_HUB",
    SourceSessionId?: string
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PlayerID
let PartyInstanceMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PartyID — the party's shared hunt instance
let PartyInstanceCreatedAtMap: Map<string, number> = new Map<string, number>(); // Key is PartyID — epoch ms the shared instance above was created (fan-out window)

// Key is `${host}:${port}` of a shared HUB destination (Ramsgate/dojo). GameSessionId becomes
// serverInfo.gameSessionId in /candidate/status, which the client turns into its XMPP MUC room
// (City-<gameSessionId>). It must therefore stay stable for the lifetime of the persistent hub.
//
// CandidateId is deliberately NOT reused: it identifies one matchmaking/travel attempt. Reusing
// the hub's game-session id as its candidate id made a client that had already visited Ramsgate
// treat a later ReturnToRamsgate result as the already-consumed candidate and never open a new
// socket. Keep transport/session identity and matchmaking-request identity separate.
// [2026-10-14] Activity monitor: the launch id of each dedicated instance, by `${host}:${port}`. A party follower who joins a shared
// instance later gets the same hunt row as the launch (HandlePartyMatchmaking).
const HuntRefOfInstance: Map<string, string> = new Map<string, string>();
const HubGameSessionIds: Map<string, string> = new Map<string, string>();

// [2026-10-11] Exported for the P2P module's recovery to Ramsgate, which used a random id and so put returning players
// in a different XMPP city room than everyone already in the hub (plan 39_ §13.1 B6).
export function GetHubGameSessionId(Host: string, Port: number): string {
    const Key = `${Host}:${Port}`;
    let Id = HubGameSessionIds.get(Key);
    if (Id == undefined) {
        Id = crypto.randomUUID();
        HubGameSessionIds.set(Key, Id);
    }
    return Id;
}

// How long a party's shared hunt instance stays reusable for LATE-arriving members following the leader
// into the SAME hunt. Members fan out within seconds of the leader, so this only needs to cover the join
// spread; past it (or for a DIFFERENT hunt) a new hunt request launches a FRESH instance instead of
// reusing a previous/closed one. Prevents the "hunt island -> other hunt island starts and cancels" bug.
const PARTY_INSTANCE_REUSE_MS = 120000;

// Cosmetic/player-synchronization delay after a hunt server is truly online. This is
// deliberately separate from the existing CR19 queue wait (20 seconds).
function ReadDelayMs(Name: string, Fallback: number): number {
    const Value = Number(process.env[Name]);
    return Number.isFinite(Value) && Value > 0 ? Math.floor(Value) : Fallback;
}

const HUNT_GO_NOW_MIN_DELAY_MS = ReadDelayMs("HUNT_GO_NOW_MIN_DELAY_MS", 10000);
const HUNT_GO_NOW_MAX_DELAY_MS = ReadDelayMs("HUNT_GO_NOW_MAX_DELAY_MS", 20000);

// [2026-07-21] Hub destinations (Ramsgate/Dojo) are ALREADY-RUNNING persistent servers - unlike a
// hunt, there is no dedicated-server spin-up time this countdown needs to mask. When the countdown
// was extended to hubs (see CreateGoNowReleaseAt below), it reused the hunt's 10-20s window wholesale,
// which meant a solo login/return-to-Ramsgate now eats a mandatory random 10-20s wait for no reason
// that applies to it - only the load-shedding purpose (spreading a genuine login burst) applies to
// hubs, not spin-up masking. Own, much smaller base window; load padding still layers on top for
// real bursts.
const HUB_GO_NOW_MIN_DELAY_MS = ReadDelayMs("HUB_GO_NOW_MIN_DELAY_MS", 0);
const HUB_GO_NOW_MAX_DELAY_MS = ReadDelayMs("HUB_GO_NOW_MAX_DELAY_MS", 1000);

// Load-aware widening: how much extra max-delay to add per additional CONCURRENT joiner (a request
// whose own release window hasn't fired yet), and the cap on that extra padding. A burst of players
// all landing on the same persistent Ramsgate/Dojo connection (or the same hunt) at the exact same
// instant is worse than spreading their actual "Go Now" connects over a slightly wider window.
const GO_NOW_LOAD_PADDING_PER_JOINER_MS = ReadDelayMs("GO_NOW_LOAD_PADDING_PER_JOINER_MS", 1000);
const GO_NOW_LOAD_PADDING_MAX_MS = ReadDelayMs("GO_NOW_LOAD_PADDING_MAX_MS", 20000);

// Concurrent joiners = results whose release window is still in the future right now. Cheap proxy
// for "how much load is this synchronized-release round already carrying" — no cross-process
// visibility into DeployServer's own CPU/RAM is needed for this, it only has to widen the window
// when multiple players are genuinely converging on the same moment.
function CountInFlightReleases(): number {
    const Now = Date.now();
    let Count = 0;
    for (const Result of MatchmakingResultMap.values()) {
        if (Result.ReadyAt > Now) Count++;
    }
    return Count;
}

// Shared by hunts AND hub destinations (Ramsgate/Dojo) — both get a synchronized, load-aware
// countdown before Ready flips true, instead of hubs resolving instantly while only hunts waited.
// Hunts use their own (10-20s) window, which masks real dedicated-server spin-up time. Hubs use the
// much smaller HUB_GO_NOW_* window (see above) since they're already-running persistent servers with
// nothing to spin up — their countdown exists purely for load-shedding. Load padding applies to both.
function CreateGoNowReleaseAt(IsHub: boolean): number {
    const LoadPadding = Math.min(CountInFlightReleases() * GO_NOW_LOAD_PADDING_PER_JOINER_MS, GO_NOW_LOAD_PADDING_MAX_MS);
    const BaseMin = IsHub ? HUB_GO_NOW_MIN_DELAY_MS : HUNT_GO_NOW_MIN_DELAY_MS;
    const BaseMax = IsHub ? HUB_GO_NOW_MAX_DELAY_MS : HUNT_GO_NOW_MAX_DELAY_MS;
    const Min = Math.min(BaseMin, BaseMax);
    const Max = Math.max(Min, BaseMax) + LoadPadding;
    return Date.now() + crypto.randomInt(Min, Max + 1);
}

function IsClientReady(Result: MatchmakingResult): boolean {
    return Result.Ready && (Result.ReadyAt === 0 || Date.now() >= Result.ReadyAt);
}

function ClientVisibleResult(Result: MatchmakingResult): MatchmakingResult {
    return { ...Result, Ready: IsClientReady(Result) };
}

export function GetCandidateStatusPeriodMillis(Result: MatchmakingResult): number {
    // Poll once per second only during the post-ready release window, then return to
    // the original 10s cadence. Existing queue behavior and timers are unchanged.
    return Result.ReadyAt > Date.now() ? 1000 : 10000;
}

function GetFallbackHuntId(GameMode: string, GameArgs: string, HuntId: string | undefined){
    if(HuntId != undefined && HuntId.trim().length > 0){
        return HuntId;
    }

    if(GameMode === "CITY"){
        return "ShatteredIsles_ReturnToRamsgate";
    }

    if(GameArgs != undefined && GameArgs.includes("/Game/Maps/islands/1705/dia_moss_triforce")){
        return "ShatteredIsles_IslandA";
    }

    return HuntId ?? "";
}

function HuntIdRequiresMatchmaking(HuntId: string){
    return HuntId.includes("CR19");
}

// Hub destinations are shared social spaces that never party-matchmake: the party is already together
// there (Ramsgate is one replicated instance). Everything else — hunt islands, escalation, etc. — is a
// hunt destination that a party must be fanned out into ONE shared instance.
function IsHubDestination(GameMode: string, HuntId: string | undefined){
    if(GameMode === "CITY"){
        return true;
    }
    return IsHubHuntId(HuntId);
}

// [2026-10-14 cancel] A hub by its hunt id alone: a candidate carries no game mode, so the leave route uses this on it.
function IsHubHuntId(HuntId: string | undefined): boolean {
    if(HuntId == undefined){
        return false;
    }
    return HuntId.includes("ReturnToRamsgate") || HuntId.includes("TrainingDojo");
}

function CancelHuntMatchmaking(HuntId: string, PlayerIds: readonly string[], Reason: string): boolean {
    for (const PlayerId of new Set(PlayerIds)) {
        const CandidateId = crypto.randomUUID();
        MatchmakingResultMap.set(PlayerId, {
            Ready: false,
            Canceled: true,
            StatusReason: Reason,
            HuntId,
            CandidateId,
            GameSessionId: CandidateId,
            Host: "",
            Port: 0,
            ReadyAt: 0
        });
    }
    return true;
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined): Promise<DeployServerLaunch> {
    // [2026-10-15] No DeployServer: no request is made, for a hub or a hunt alike; the caller cancels with the reason.
    if (!DEPLOYSERVER_CONFIGURED) {
        logger.warn(`[HuntRoute] no dedicated server (DEPLOYSERVER_URL is unset): refused ${IsHubDestination(GameMode, HuntId) ? "hub" : "hunt"} huntId=${HuntId}`);
        return { succeeded: false, readyNow: false, host: "", port: 0, reason: NO_DEDICATED_SERVERS_REASON };
    }
    if (!IsHubDestination(GameMode, HuntId) && GetP2PExtension().matchmaking.dedicatedHuntsDisabled()) {
        logger.error(`[HuntRoute] blocked dedicated hunt launch (dedicated hunts are disabled) huntId=${HuntId}`);
        return { succeeded: false, readyNow: false, host: "", port: 0 };
    }
    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;

    const RequestId = GetRequestId();
    const Headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (RequestId != undefined) Headers[REQUEST_ID_HEADER] = RequestId;

    const MatchmakingResult = await fetch(URL, {
        method: "POST",
        headers: Headers,
        body: JSON.stringify({
            GameMode: GameMode,
            GameArgs: GameArgs,
            HuntId: HuntId,
            ExpectedPlayers: ExpectedPlayers!
        })
    });

    if(MatchmakingResult.status === 200){
        const MatchmakingData = await MatchmakingResult.json();

        logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${MatchmakingData.port}`);
        // [2026-10-14] Activity monitor: a hunt (not a hub) gives each player a participation row. Not awaited: the launch never waits for it.
        if (!IsHubDestination(GameMode, HuntId)) {
            const HuntRef = crypto.randomUUID();
            HuntRefOfInstance.set(`${MatchmakingData.host}:${MatchmakingData.port}`, HuntRef);
            void RecordDedicatedHuntStarts(ExpectedPlayers ?? [], HuntId, HuntRef);
        }

        return {
            succeeded: true,
            readyNow: true,
            host: MatchmakingData.host,
            port: MatchmakingData.port
        }
    }
    else{
        logger.error(`DeployServer returned status ${MatchmakingResult.status}`);

        return {
            succeeded: false,
            readyNow: false,
            host: "",
            port: 0
        };
    }
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue!.Resolved){
        return;
    }

    MatchmakingQueue!.Resolved = true;
    
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue!.Players);
    if (!GameOnDeployServer.succeeded) {
        CancelHuntMatchmaking(HuntId, MatchmakingQueue!.Players, GameOnDeployServer.reason ?? "DEDICATED_HUNT_DISABLED");
        MatchmakingQueueMap.delete(HuntId);
        return;
    }
    const ReleaseAt = CreateGoNowReleaseAt(false);
    logger.info(`Hunt '${HuntId}' is online; synchronized Go Now release in ${ReleaseAt - Date.now()}ms for ${MatchmakingQueue!.Players.length} queued player(s)`);

    for(const Player of MatchmakingQueue!.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        // [2026-10-14 cancel] A player who cancelled while this queue was launching is not told to travel.
        if(PlayerMatchmakingResultToUpdate != undefined && !PlayerMatchmakingResultToUpdate.Canceled){
            PlayerMatchmakingResultToUpdate.Host = GameOnDeployServer.host;
            PlayerMatchmakingResultToUpdate.Port = GameOnDeployServer.port;
            PlayerMatchmakingResultToUpdate.Ready = true;
            PlayerMatchmakingResultToUpdate.ReadyAt = ReleaseAt;
        }
    }

    MatchmakingQueueMap.delete(HuntId);
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    let PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        // A candidate owned by an optional module may outlive this process (for example a
        // player-hosted hunt after a restart).
        PlayerMatchmakingResult = await GetP2PExtension().matchmaking.restoreCandidate(PlayerId);
        if(PlayerMatchmakingResult == undefined) return undefined;
        MatchmakingResultMap.set(PlayerId, PlayerMatchmakingResult);
    }

    const ExtensionStatus = await GetP2PExtension().matchmaking.candidateStatus(PlayerId, PlayerMatchmakingResult);
    if(ExtensionStatus != undefined){
        return ExtensionStatus;
    }

    if(!PlayerMatchmakingResult.Ready){
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

        // [2026-10-14 realms S2] A candidate that was cancelled with no queue behind it (its session is gone) has nothing to pop;
        // before this guard the status poll threw here and the cancel never reached the client.
        if(MatchmakingQueue != undefined && (new Date()).getTime() - MatchmakingQueue.LastPlayerAddedTime.getTime() > 20000){ // existing 20s queue behavior
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }

    return ClientVisibleResult(MatchmakingResultMap.get(PlayerId)!);
}

// TODO: This can fail if the previous party is waiting for the deployserver, and a new party is joining in.
// Right now we handle this by failing all new players until the old party is cleared out
// This can be MUCH better in the future
async function QueuePlayer(HuntId: string, PlayerId: string){
    if(MatchmakingQueueMap.get(HuntId) != undefined && !MatchmakingQueueMap.get(HuntId)?.Resolved){
        const CurrentMMEntry = MatchmakingQueueMap.get(HuntId);

        CurrentMMEntry!.Players.push(PlayerId);
        CurrentMMEntry!.LastPlayerAddedTime = new Date();

        if(CurrentMMEntry!.Players.length >= 4){
            await PopQueue(HuntId);
        }
    }
    else if(MatchmakingQueueMap.get(HuntId) != undefined){
        return false;
    }
    else{
        MatchmakingQueueMap.set(HuntId, {
            Players: [PlayerId],
            LastPlayerAddedTime: new Date(),
            Resolved: false
        });
    }

    const CandidateId = crypto.randomUUID();
    MatchmakingResultMap.set(PlayerId, {
        Ready: false,
        CandidateId,
        GameSessionId: CandidateId,
        HuntId: HuntId,
        Host: "",
        Port: 0,
        ReadyAt: 0
    });

    return true;
}

// When a whole party joins the same hunt, they must land in ONE game instance. The first
// member to arrive creates it (with the full party as ExpectedPlayers); everyone else — who
// follows once GetParty shows the party's active hunt — reuses that same host:port.
async function HandlePartyMatchmaking(HuntId: string, PlayerId: string, PartyId: string, PartyMembers: string[]){
    const Existing = PartyInstanceMap.get(PartyId);
    const ExistingCreatedAt = PartyInstanceCreatedAtMap.get(PartyId) ?? 0;

    // Reuse the party's shared instance ONLY when it is for the SAME hunt AND was created recently (the
    // fan-out window while members follow the leader in). A request for a DIFFERENT hunt — or a stale entry
    // past the window (the previous hunt already ended) — must launch a FRESH instance. Otherwise the party
    // is routed back into the previous/closed hunt server and the new hunt "starts and cancels" (the
    // reported hunt-island -> other-hunt-island bug).
    if(Existing != undefined && Existing.HuntId === HuntId && (Date.now() - ExistingCreatedAt) < PARTY_INSTANCE_REUSE_MS){
        // The destination/game session is party-wide, but a candidate is one client's travel attempt.
        // A late follower or retry must not inherit an already-consumed candidate from the leader.
        MatchmakingResultMap.set(PlayerId, { ...Existing, CandidateId: crypto.randomUUID() });
        // [2026-10-14] A late follower of the shared instance is a participant too (its row carries the launch's id).
        void RecordDedicatedHuntStarts([PlayerId], HuntId, HuntRefOfInstance.get(`${Existing.Host}:${Existing.Port}`) ?? `${Existing.Host}:${Existing.Port}`);
        return true;
    }

    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, PartyMembers);

    if(!GameOnDeployServer.succeeded){
        // [2026-10-15] Without a DeployServer the party's members are cancelled with the reason, not left waiting.
        return GameOnDeployServer.reason != undefined ? CancelHuntMatchmaking(HuntId, PartyMembers, GameOnDeployServer.reason) : false;
    }

    const CandidateId = crypto.randomUUID();
    const SharedResult: MatchmakingResult = {
        Ready: true,
        CandidateId,
        GameSessionId: CandidateId,
        HuntId: HuntId,
        Host: GameOnDeployServer.host,
        Port: GameOnDeployServer.port,
        ReadyAt: CreateGoNowReleaseAt(false)
    };

    logger.info(`Party ${PartyId} hunt '${HuntId}' is online; synchronized Go Now release in ${SharedResult.ReadyAt - Date.now()}ms for ${PartyMembers.length} member(s)`);
    PartyInstanceMap.set(PartyId, SharedResult);
    PartyInstanceCreatedAtMap.set(PartyId, Date.now());

    for(const Member of PartyMembers){
        MatchmakingResultMap.set(Member, { ...SharedResult, CandidateId: crypto.randomUUID() });
    }

    return true;
}

// Party route reads these to reflect the party's shared matchmaking state in GetParty.
export async function GetPartyInstance(PartyId: string): Promise<MatchmakingResult | undefined> {
    const Result = PartyInstanceMap.get(PartyId);
    if (Result != undefined) return ClientVisibleResult(Result);
    return GetP2PExtension().matchmaking.partyInstance(PartyId);
}

// [1.14.7 REVALIDATION 2026-10-04] Live persistent-hub status from the DeployServer. A cached matchmaking
// candidate carries an address that was true when it was created; this asks whether it is still true now.
// Returns undefined when the DeployServer cannot be reached, which callers treat as "not verified".
export interface LiveHubStatus {
    ramsgate?: { ready: boolean; host: string; port: number; processId: number };
    trainingDojo?: { ready: boolean; host: string; port: number; processId: number };
}

export async function FetchLiveHubStatus(): Promise<LiveHubStatus | undefined> {
    // [2026-10-15] No DeployServer: the hubs are reported unavailable and nothing is requested. The candidate status polls this
    // every second or so, so the reason is logged once for the process.
    if (!DEPLOYSERVER_CONFIGURED) {
        if (!HubStatusUnavailableLogged) {
            HubStatusUnavailableLogged = true;
            logger.warn("[HuntRoute] hub-status not requested: no DeployServer (DEPLOYSERVER_URL is unset); the hubs are reported unavailable");
        }
        return undefined;
    }
    try {
        const Response = await fetch("http://" + DEPLOYSERVER_URL + "/api/hub-status");
        if (!Response.ok) {
            logger.warn(`hub-status returned ${Response.status}; treating cached hub candidates as unverified`);
            return undefined;
        }
        return await Response.json() as LiveHubStatus;
    } catch (e) {
        logger.warn(`hub-status unreachable (${e}); treating cached hub candidates as unverified`);
        return undefined;
    }
}

export async function GetPlayerCandidate(PlayerId: string): Promise<MatchmakingResult | undefined> {
    const Result = MatchmakingResultMap.get(PlayerId);
    if (Result != undefined) return ClientVisibleResult(Result);
    return CheckAndUpdateQueueStatus(PlayerId);
}

/** [2026-10-14 cancel] The party of a leave: the requester's party, or undefined for a solo search. */
export type LeavePartyLookup = (playerId: string) => Promise<{ partyId: string; members: string[] } | undefined>;

/** [2026-10-14 cancel] What a leave did: its outcome, the search's state before it, and the candidate it acted on. */
export interface LeaveAnswer {
    outcome: CandidateLeaveOutcome | "no-candidate";
    state: string;
    candidateId?: string;
}

/** [2026-10-14 cancel] The state of a dedicated search as a leave found it (for the leave log). */
function DedicatedLeaveState(Result: MatchmakingResult, queued: boolean): string {
    if (Result.Canceled) return "canceled";
    if (IsClientReady(Result)) return "ready";
    if (Result.Ready) return "go-now";
    return queued ? "queued" : "matching";
}

/**
 * [2026-10-14 cancel] The accounts a dedicated party hunt ends with when its member cancels: the requester and each party member whose
 * candidate is the same shared instance. A party that is not formed into one hunt ends with the requester alone.
 */
async function FormingHuntAccounts(PlayerId: string, Current: MatchmakingResult, partyOf: LeavePartyLookup): Promise<{ accountIds: string[]; partyId?: string }> {
    const Party = await partyOf(PlayerId);
    if (Party == undefined || Party.members.length < 2) return { accountIds: [PlayerId] };
    const Instance = PartyInstanceMap.get(Party.partyId);
    if (Instance == undefined || Instance.GameSessionId !== Current.GameSessionId) return { accountIds: [PlayerId] };
    const Members = Party.members.filter((Member) => {
        if (Member === PlayerId) return false;
        const MemberResult = MatchmakingResultMap.get(Member);
        return MemberResult != undefined && !MemberResult.Canceled && MemberResult.GameSessionId === Current.GameSessionId;
    });
    return { accountIds: [PlayerId, ...Members], partyId: Party.partyId };
}

/**
 * [2026-10-14 cancel] The client's Cancel of its search (DELETE /candidate/leave). The client sends it only from the party leader, and
 * the party's forming hunt is cancelled for every member: a dedicated party hunt's shared instance (the canceller reads PLAYER_CANCELED,
 * the others PARTY_MEMBER_CANCELED), a queued solo search (out of its queue), or a player-hosted or realm hunt (the module's hook, which
 * aborts it before RUNNING with no dedicated fallback). A search already told to travel is left alone (too-late); a hub candidate is never
 * cancelled. A second leave answers already-canceled or already-ended. A later join starts a fresh search.
 */
export async function CancelMatchmakingForLeave(PlayerId: string, partyOf: LeavePartyLookup = GetPartyForPlayer): Promise<LeaveAnswer> {
    let Current = MatchmakingResultMap.get(PlayerId);
    if (Current == undefined) {
        // A candidate the module owns may outlive this process; CheckAndUpdateQueueStatus restores it the same way.
        const Restored = await GetP2PExtension().matchmaking.restoreCandidate(PlayerId);
        if (Restored == undefined) return { outcome: "no-candidate", state: "none" };
        MatchmakingResultMap.set(PlayerId, Restored);
        Current = Restored;
    }
    const CandidateId = Current.CandidateId;
    const Owned = await GetP2PExtension().matchmaking.cancelCandidate(PlayerId, Current);
    if (Owned.handled) return { outcome: Owned.outcome, state: Owned.state, candidateId: CandidateId };

    if (IsHubHuntId(Current.HuntId)) return { outcome: "hub-not-cancelled", state: "hub", candidateId: CandidateId };
    if (Current.Canceled) return { outcome: "already-canceled", state: "canceled", candidateId: CandidateId };

    const Queue = MatchmakingQueueMap.get(Current.HuntId);
    const State = DedicatedLeaveState(Current, Queue?.Players.includes(PlayerId) === true);
    const Forming = await FormingHuntAccounts(PlayerId, Current, partyOf);
    const AnyTold = Forming.accountIds.some((AccountId) => {
        const MemberResult = MatchmakingResultMap.get(AccountId);
        return MemberResult != undefined && IsClientReady(MemberResult);
    });
    if (AnyTold) return { outcome: "too-late", state: State, candidateId: CandidateId };

    for (const AccountId of Forming.accountIds) {
        const MemberResult = MatchmakingResultMap.get(AccountId);
        if (MemberResult == undefined) continue;
        MatchmakingResultMap.set(AccountId, {
            ...MemberResult,
            Ready: false,
            Canceled: true,
            StatusReason: AccountId === PlayerId ? "PLAYER_CANCELED" : "PARTY_MEMBER_CANCELED",
            Host: "",
            Port: 0,
            ReadyAt: 0
        });
    }
    // A queue that is still collecting drops these players; a resolved one is already launching (PopQueue skips cancelled players).
    if (Queue != undefined && !Queue.Resolved) {
        Queue.Players = Queue.Players.filter((Member) => !Forming.accountIds.includes(Member));
        if (Queue.Players.length === 0) MatchmakingQueueMap.delete(Current.HuntId);
    }
    if (Forming.partyId != undefined) {
        PartyInstanceMap.delete(Forming.partyId);
        PartyInstanceCreatedAtMap.delete(Forming.partyId);
    }
    logger.info(`Search for ${Current.HuntId} cancelled by its player: ${Forming.accountIds.length} account(s), state=${State}`);
    return { outcome: "canceled", state: State, candidateId: CandidateId };
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string, PartyId?: string, PartyMembers?: string[], PartyRevision?: number, BuildId?: string){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const EffectiveHuntId = GetFallbackHuntId(GameMode, GameArgs, HuntId);
        // [2026-10-14] Gauntlet is refused on every route (realm, player-hosted and dedicated) until MYSTICPARADOX_GAUNTLET=on. The
        // cancel reaches the requester's and the party's candidate status like any other refusal.
        if (RefusesGauntletRequest(EffectiveHuntId)) {
            logger.warn({ event: "gauntlet_refused", huntId: EffectiveHuntId, reason: GAUNTLET_DISABLED_REASON },
                `[HuntRoute] Gauntlet hunt ${EffectiveHuntId} refused reason=${GAUNTLET_DISABLED_REASON} (MYSTICPARADOX_GAUNTLET is not on)`);
            return CancelHuntMatchmaking(EffectiveHuntId, PartyMembers ?? [PlayerId], GAUNTLET_DISABLED_REASON);
        }
        // An optional module may route the hunt itself (for example to a player host).
        const ExtensionRoute = await GetP2PExtension().matchmaking.routeHunt({
            gameMode: GameMode,
            huntId: EffectiveHuntId,
            playerId: PlayerId,
            partyId: PartyId,
            partyMembers: PartyMembers,
            partyRevision: PartyRevision,
            buildId: BuildId,
            isHub: IsHubDestination(GameMode, EffectiveHuntId),
            setCandidate: (AccountId, Result) => { MatchmakingResultMap.set(AccountId, Result); },
            cancel: CancelHuntMatchmaking
        });
        if (ExtensionRoute.handled) {
            return ExtensionRoute.result;
        }

        // [2026-07-17 party-follow fix] A party (more than just the leader) travelling to a NON-HUB hunt must
        // all land in ONE instance. Route it through HandlePartyMatchmaking BEFORE the immediate-return path
        // below. That path only registered the leader, deleted the shared PartyInstanceMap, and never gave
        // members a matchmaking result — stranding them in Ramsgate (the reported bug, because
        // HuntIdRequiresMatchmaking only recognized legacy "CR19" so ShatteredIsles_IslandA fell through here).
        // HandlePartyMatchmaking launches one gameserver with the full party, stores the shared host/port in
        // PartyInstanceMap, and populates MatchmakingResultMap for every member, so each member's
        // /candidate/status and the party's GetPartyInstance return the same server and every member follows.
        if(!IsHubDestination(GameMode, EffectiveHuntId) && EffectiveHuntId.trim().length > 0
           && PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
            return await HandlePartyMatchmaking(EffectiveHuntId, PlayerId, PartyId, PartyMembers);
        }

        if(EffectiveHuntId == undefined || EffectiveHuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(EffectiveHuntId)){
            // Immediate shared instance (Ramsgate / city hub / dojo) — everyone goes to the same
            // pre-spawned server.
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, EffectiveHuntId, PartyMembers ?? [PlayerId]);

            if(!GameOnDeployServer.succeeded){
                // [2026-10-15] Without a DeployServer the requester (and its party) is cancelled with the reason, not left waiting.
                return GameOnDeployServer.reason != undefined
                    ? CancelHuntMatchmaking(EffectiveHuntId, PartyMembers ?? [PlayerId], GameOnDeployServer.reason)
                    : false;
            }

            const IsHub = IsHubDestination(GameMode, EffectiveHuntId);
            // [2026-10-14] Travelling to a hub ends the dedicated hunts of the party (activity monitor: completed or abandoned, once each).
            if (IsHub) void RecordDedicatedHuntEnds(PartyMembers ?? [PlayerId], "RETURNED");
            const CandidateId = crypto.randomUUID();
            const SharedResult: MatchmakingResult = {
                Ready: true,
                CandidateId,
                GameSessionId: IsHub
                    ? GetHubGameSessionId(GameOnDeployServer.host, GameOnDeployServer.port)
                    : CandidateId,
                HuntId: EffectiveHuntId,
                Host: GameOnDeployServer.host,
                Port: GameOnDeployServer.port,
                // Hub destinations (Ramsgate/Dojo) now get the SAME synchronized, load-aware Go Now
                // countdown as hunts instead of resolving instantly — consistent UX, and it doubles as
                // load shedding: a burst of returning players is spread across the release window
                // instead of every client hitting the persistent server's connect at once.
                ReadyAt: CreateGoNowReleaseAt(IsHub)
            };

            logger.info(`${IsHub ? "Hub" : "Hunt"} '${EffectiveHuntId}' is online; synchronized Go Now release in ${SharedResult.ReadyAt - Date.now()}ms candidateId=${SharedResult.CandidateId} gameSessionId=${SharedResult.GameSessionId}`);

            // [2026-07-17 hub party-follow fix] When a PARTY returns to a shared hub (Ramsgate/dojo), fan the
            // destination out to EVERY member exactly like a party hunt, so all members follow the leader.
            // Previously this path set ONLY the leader's result and DELETED PartyInstanceMap, so the other
            // members polling POST /party (which reads GetPartyInstance) saw no instance and were stranded at
            // the hunt island while only the leader got the airship (the reported bug). Storing the hub in
            // PartyInstanceMap is safe: a later DIFFERENT hunt won't reuse it (HandlePartyMatchmaking requires a
            // matching HuntId), and returning to the same hub again just refreshes it.
            if(PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
                PartyInstanceMap.set(PartyId, SharedResult);
                PartyInstanceCreatedAtMap.set(PartyId, Date.now());
                for(const Member of PartyMembers){
                    // Each client needs a fresh candidate to notice and consume this travel. Host,
                    // port, ReadyAt and GameSessionId remain shared so everyone lands together.
                    MatchmakingResultMap.set(Member, { ...SharedResult, CandidateId: crypto.randomUUID() });
                }
            }
            else{
                if(PartyId != undefined){
                    PartyInstanceMap.delete(PartyId);
                    PartyInstanceCreatedAtMap.delete(PartyId);
                }
                MatchmakingResultMap.set(PlayerId, { ...SharedResult });
            }

            return true;
        }
        else if(PartyId != undefined && PartyMembers != undefined && PartyMembers.length > 1){
            // Party hunt — route the whole party into one instance.
            return await HandlePartyMatchmaking(EffectiveHuntId, PlayerId, PartyId, PartyMembers);
        }
        else{
            return await QueuePlayer(EffectiveHuntId, PlayerId);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}
