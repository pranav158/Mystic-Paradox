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

import { logger } from "../logger";
import { GetRequestId, REQUEST_ID_HEADER } from "../observability/requestContext";
import crypto from "node:crypto";
import { GetP2PExtension } from "../extensions/p2p";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";

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
    ReadyAt: number
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
const HubGameSessionIds: Map<string, string> = new Map<string, string>();

function GetHubGameSessionId(Host: string, Port: number): string {
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

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
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
        CancelHuntMatchmaking(HuntId, MatchmakingQueue!.Players, "DEDICATED_HUNT_DISABLED");
        MatchmakingQueueMap.delete(HuntId);
        return;
    }
    const ReleaseAt = CreateGoNowReleaseAt(false);
    logger.info(`Hunt '${HuntId}' is online; synchronized Go Now release in ${ReleaseAt - Date.now()}ms for ${MatchmakingQueue!.Players.length} queued player(s)`);

    for(const Player of MatchmakingQueue!.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        if(PlayerMatchmakingResultToUpdate != undefined){
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

        if((new Date()).getTime() - MatchmakingQueue!.LastPlayerAddedTime.getTime() > 20000){ // existing 20s queue behavior
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
        return true;
    }

    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, PartyMembers);

    if(!GameOnDeployServer.succeeded){
        return false;
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

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string, PartyId?: string, PartyMembers?: string[], PartyRevision?: number){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const EffectiveHuntId = GetFallbackHuntId(GameMode, GameArgs, HuntId);
        // An optional module may route the hunt itself (for example to a player host).
        const ExtensionRoute = await GetP2PExtension().matchmaking.routeHunt({
            gameMode: GameMode,
            huntId: EffectiveHuntId,
            playerId: PlayerId,
            partyId: PartyId,
            partyMembers: PartyMembers,
            partyRevision: PartyRevision,
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
                return false;
            }

            const IsHub = IsHubDestination(GameMode, EffectiveHuntId);
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
