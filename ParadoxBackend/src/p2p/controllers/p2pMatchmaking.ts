import crypto from "node:crypto";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { CandidateLeaveResult, HuntRouteContext, HuntRouteOutcome } from "../../extensions/p2p";
import { GetOrCreateParty } from "../../controllers/party";
import { logger } from "../../logger";
import { GAUNTLET_DISABLED_REASON, RefusesGauntletRequest } from "../../matchmakingHuntPolicy";
import { DecideHuntRoute, IsP2PTrainingRequest, P2PPolicySummary, ReadP2PPolicy } from "../config/p2pPolicy";
import { DedicatedServersConfigured } from "../../config/dedicatedServers";
import { GetP2PRepositories, P2PHuntSessionRecord, WithP2PTransaction } from "../persistence";
import { GetAntiCheatExtension } from "../antiCheat";
import { FenceP2PEmergencyStop, GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { IsRealmHostingEnabled } from "../realm/realmHubPolicy";
import { IsHubLive, IsPresenceLive, IsRealmHub } from "../realm/realmHubRules";
import { GetRealmsPort, RealmPresenceView } from "../realm/realmsPort";
import {
    BeginDrainPartySession,
    BeginHostSelection,
    CancelFormingHunt,
    ClassifyExistingPartySession,
    CloseRecoveredSessionForParty,
    IsCancellableForming,
    NoteHubReturn,
    SupersedePartySession
} from "./p2pHostLifecycle";
import { RemoveLeaverFromFormingHunt } from "./partyLeave";
import { HubCandidate, REALM_HUB_START_TIMEOUT_MS, RouteRealmRequest } from "./p2pRealmRouting";
import { ReadHuntManifestSource, ResolveLocalHuntLaunchManifest } from "../huntManifest/localHuntManifest";

// Player-hosted hunt routing for the shared matchmaker (controllers/matchmaking.ts). A player-hosted
// candidate stores the durable HuntSession UUID as GameSessionId; a dedicated candidate has no
// matching HuntSession record and follows the shared in-memory path unchanged.

const DEPLOYSERVER_MANIFEST_PATH = "/api/matchmaker/resolve-hunt-launch-manifest";

function StableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(StableJson).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${StableJson(child)}`).join(",")}}`;
}

function CanonicalStoredJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        // Existing malformed rows should fail closed without taking matchmaking down. Bind their
        // exact bytes into the snapshot so they cannot collide with valid JSON.
        return { invalidStoredJsonSha256: crypto.createHash("sha256").update(value).digest("hex") };
    }
}

function ReadP2PInteger(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export async function RestoreP2PCandidate(PlayerId: string): Promise<MatchmakingResult | undefined> {
    const Persisted = await GetP2PRepositories().p2pHunts.findActiveHuntForAccount(PlayerId);
    const Participant = Persisted?.roster.find((entry) => entry.accountId === PlayerId);
    if (Persisted == undefined || Participant == undefined) return RestoreRealmHubCandidate(PlayerId);
    return {
        Ready: false,
        HuntId: Persisted.huntDefinitionId,
        CandidateId: Participant.candidateId,
        GameSessionId: Persisted.sessionId,
        Host: "",
        Port: 0,
        ReadyAt: 0
    };
}

/** [2026-10-14 realms S2] A realm hub candidate after a restart: the account's live entry (or its host seat) in a live hub. */
async function RestoreRealmHubCandidate(PlayerId: string): Promise<MatchmakingResult | undefined> {
    if (!IsRealmHostingEnabled()) return undefined;
    const repos = GetP2PRepositories();
    const row = await repos.realmHub.findForAccount(PlayerId);
    if (row == undefined) return undefined;
    const hub = await repos.p2pHunts.findHunt(row.sessionId);
    if (hub == undefined || !IsRealmHub(hub) || !IsHubLive(hub.state) || hub.generation !== row.generation) return undefined;
    return HubCandidate(hub, row.candidateId, false);
}

/**
 * [2026-10-14 realms S2, design section 3.5] The status of a realm hub candidate, read from its hub session (SourceSessionId) and
 * the member's presence row. Ready when the hub runs and the member is admitted with its route published; the host's candidate
 * is ready on the hub's own loopback port. A hub that ended, an entry that was lost or expired, and a Training hub that did not
 * start within 90 s are cancelled with the reason.
 */
async function RealmHubCandidateStatus(PlayerId: string, Result: MatchmakingResult): Promise<MatchmakingResult> {
    const repos = GetP2PRepositories();
    const canceled = (reason: string): MatchmakingResult => ({ ...Result, Ready: false, Canceled: true, StatusReason: reason, Host: "", Port: 0, ReadyAt: 0 });
    const hub = Result.SourceSessionId == undefined ? undefined : await repos.p2pHunts.findHunt(Result.SourceSessionId);
    if (hub == undefined || !IsRealmHub(hub)) return canceled("REALM_HUB_ENDED");
    if (hub.state === "ABORTED" || hub.state === "COMPLETED") {
        return canceled(hub.failureReason ?? hub.completionReason ?? "REALM_HUB_ENDED");
    }
    const running = hub.state === "RUNNING";
    if (PlayerId === hub.hostAccountId) {
        // The host has no join: its own loopback port into its hub answers once the hub runs.
        const ready = running && hub.hostLocalBridgePort != undefined;
        return { ...Result, Ready: ready, Host: ready ? "127.0.0.1" : "", Port: ready ? hub.hostLocalBridgePort! : 0, ReadyAt: 0 };
    }
    if (!running && hub.hubKind === "TRAINING" && Date.now() - Date.parse(hub.createdAt) > REALM_HUB_START_TIMEOUT_MS) {
        return canceled("REALM_HUB_START_TIMEOUT");
    }
    const presence = await repos.realmHub.findPresence(hub.sessionId, PlayerId);
    if (presence == undefined) return canceled("REALM_ENTRY_ENDED");
    if (presence.state === "PENDING" || presence.state === "TICKETED") {
        if (!IsPresenceLive(presence, new Date().toISOString())) return canceled("REALM_ENTRY_EXPIRED");
    } else if (presence.state !== "ADMITTED") {
        return canceled(`REALM_ENTRY_${presence.state}`);
    }
    const ready = running && presence.state === "ADMITTED" && presence.localBridgePort != undefined;
    return { ...Result, Ready: ready, Host: ready ? "127.0.0.1" : "", Port: ready ? presence.localBridgePort! : 0, ReadyAt: 0 };
}

/**
 * [2026-10-14 cancel] The status reason a participant reads when its hunt ended. A hunt its player cancelled reads PLAYER_CANCELED
 * for that player and PARTY_MEMBER_CANCELED for the other roster members.
 */
function EndedReasonFor(hunt: P2PHuntSessionRecord, accountId: string): string {
    if (hunt.failureReason === "PLAYER_CANCELED" && hunt.cancelledByAccountId != undefined && hunt.cancelledByAccountId !== accountId) {
        return "PARTY_MEMBER_CANCELED";
    }
    return hunt.failureReason ?? hunt.completionReason ?? "HOST_ROUTE_FAILED";
}

// Do not release Dauntless until this account's native launcher has completed Steam
// admission and published its loopback endpoint.
export async function P2PCandidateStatus(PlayerId: string, PlayerMatchmakingResult: MatchmakingResult): Promise<MatchmakingResult | undefined> {
    if (PlayerMatchmakingResult.Source === "REALM_HUB") return RealmHubCandidateStatus(PlayerId, PlayerMatchmakingResult);
    const P2PHunt = await GetP2PRepositories().p2pHunts.findHunt(PlayerMatchmakingResult.GameSessionId);
    if (P2PHunt == undefined) return undefined;
    // [2026-10-11 B1] A clean end (COMPLETED) also ends the wait of a participant who never travelled; before, such a
    // session only ever ended as ABORTED.
    if (P2PHunt.state === "ABORTED" || P2PHunt.state === "COMPLETED") {
        return {
            ...PlayerMatchmakingResult,
            Ready: false,
            Canceled: true,
            StatusReason: EndedReasonFor(P2PHunt, PlayerId),
            Host: "",
            Port: 0,
            ReadyAt: 0
        };
    }
    if (P2PHunt.state === "RECOVERING" && P2PHunt.fallbackHost != undefined && P2PHunt.fallbackPort != undefined) {
        const RecoveryCandidateId = P2PHunt.recoveryCandidateIds?.[PlayerId];
        if (RecoveryCandidateId == undefined) {
            // This participant never completed the P2P route and is still in its current
            // world (normally Ramsgate). End the pending hunt UI without issuing a redundant
            // ReturnToRamsgate connection.
            return {
                ...PlayerMatchmakingResult,
                Ready: false,
                Canceled: true,
                StatusReason: "HOST_ROUTE_FAILED",
                Host: "",
                Port: 0,
                ReadyAt: 0
            };
        }
        return {
            ...PlayerMatchmakingResult,
            CandidateId: RecoveryCandidateId,
            GameSessionId: P2PHunt.fallbackGameSessionId ?? P2PHunt.sessionId,
            HuntId: P2PHunt.fallbackHuntDefinitionId ?? "ShatteredIsles_ReturnToRamsgate",
            Ready: true,
            Host: P2PHunt.fallbackHost,
            Port: P2PHunt.fallbackPort,
            ReadyAt: 0
        };
    }
    const Participant = P2PHunt.roster.find((entry) => entry.accountId === PlayerId);
    const SessionAcceptsTravel = ["HOST_READY", "ADMITTING", "RUNNING"].includes(P2PHunt.state);
    const RouteReady = Participant?.localBridgePort != undefined && Participant.localBridgeReadyAt != undefined;
    if (SessionAcceptsTravel && RouteReady && !PlayerMatchmakingResult.Ready) {
        PlayerMatchmakingResult.Ready = true;
        PlayerMatchmakingResult.Host = "127.0.0.1";
        PlayerMatchmakingResult.Port = Participant.localBridgePort!;
        logger.info({
            event: "p2p_candidate_release",
            sessionId: P2PHunt.sessionId,
            generation: P2PHunt.generation,
            accountId: PlayerId,
            candidateId: PlayerMatchmakingResult.CandidateId,
            localHost: "127.0.0.1",
            localPort: Participant.localBridgePort
        }, `P2P candidate released to loopback session=${P2PHunt.sessionId} generation=${P2PHunt.generation}`);
    }
    return {
        ...PlayerMatchmakingResult,
        Ready: SessionAcceptsTravel && RouteReady,
        Host: RouteReady ? "127.0.0.1" : "",
        Port: Participant?.localBridgePort ?? 0,
        ReadyAt: 0
    };
}

export async function P2PPartyInstance(PartyId: string): Promise<MatchmakingResult | undefined> {
    const persisted = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(PartyId);
    const first = persisted?.roster[0];
    if (persisted == undefined || first == undefined) return undefined;
    if (persisted.state === "RECOVERING" && persisted.fallbackHost != undefined && persisted.fallbackPort != undefined) {
        const recoveryAccountId = persisted.roster.find((entry) =>
            persisted.recoveryCandidateIds?.[entry.accountId] != undefined
        )?.accountId;
        if (recoveryAccountId == undefined) {
            return {
                Ready: false,
                Canceled: true,
                StatusReason: "HOST_ROUTE_FAILED",
                CandidateId: first.candidateId,
                GameSessionId: persisted.sessionId,
                HuntId: persisted.huntDefinitionId,
                Host: "",
                Port: 0,
                ReadyAt: 0
            };
        }
        return {
            Ready: true,
            CandidateId: persisted.recoveryCandidateIds![recoveryAccountId],
            GameSessionId: persisted.fallbackGameSessionId ?? persisted.sessionId,
            HuntId: persisted.fallbackHuntDefinitionId ?? "ShatteredIsles_ReturnToRamsgate",
            Host: persisted.fallbackHost,
            Port: persisted.fallbackPort,
            ReadyAt: 0
        };
    }
    return {
        Ready: ["HOST_READY", "ADMITTING", "RUNNING"].includes(persisted.state),
        CandidateId: first.candidateId,
        GameSessionId: persisted.sessionId,
        HuntId: persisted.huntDefinitionId,
        Host: "",
        Port: 0,
        ReadyAt: 0
    };
}

/**
 * [2026-10-14 cancel] The client's Cancel (DELETE /candidate/leave) of a search that is a player-hosted or realm hunt. A forming hunt
 * (IsCancellableForming, read here and again inside the abort transaction) ends ABORTED for its whole roster, with no dedicated
 * fallback: the host's offer is withdrawn, the party is freed, and the canceller keeps PLAYER_CANCELED while the others read
 * PARTY_MEMBER_CANCELED. A running hunt, or one whose member was already told to travel, is left alone (too-late). A realm hub
 * entry is never cancelled. A hunt this player is not in is left to the shared cancel.
 */
/**
 * [2026-10-14] A party member left the party or was kicked from it (controllers/party.ts): a forming hunt of his stops waiting for him.
 * The manifest is re-resolved the way the hunt was created (the test resolver when one is set).
 */
export async function P2PPartyMemberLeft(AccountId: string): Promise<void> {
    await RemoveLeaverFromFormingHunt(AccountId, {
        resolveManifest: (HuntId, ExpectedPlayers) => (ManifestResolverForTest ?? ResolveHuntLaunchManifest)(HuntId, ExpectedPlayers)
    });
}

export async function P2PCancelCandidate(PlayerId: string, Current: MatchmakingResult): Promise<CandidateLeaveResult> {
    if (Current.Source === "REALM_HUB") return { handled: true, outcome: "hub-not-cancelled", state: "realm-hub" };
    const repos = GetP2PRepositories();
    const hunt = await repos.p2pHunts.findHunt(Current.GameSessionId);
    if (hunt == undefined) return { handled: false };
    if (IsRealmHub(hunt)) return { handled: true, outcome: "hub-not-cancelled", state: `p2p:${hunt.state}` };
    const isParticipant = hunt.hostAccountId === PlayerId || hunt.roster.some((entry) => entry.accountId === PlayerId);
    if (!isParticipant) return { handled: false };
    const state = `p2p:${hunt.state}`;
    if (hunt.failureReason === "PLAYER_CANCELED") return { handled: true, outcome: "already-canceled", state };
    if (hunt.state === "ABORTED" || hunt.state === "COMPLETED") return { handled: true, outcome: "already-ended", state };
    if (!IsCancellableForming(hunt)) return { handled: true, outcome: "too-late", state };
    const cancelled = await CancelFormingHunt(hunt.sessionId, hunt.generation, PlayerId);
    if (cancelled === "CANCELED") return { handled: true, outcome: "canceled", state };
    return { handled: true, outcome: "too-late", state };
}

interface HuntLaunchManifest {
    huntId: string;
    matchmakerHuntId: string;
    mapPath: string;
    behemothPath: string;
    expectedPlayerString: string;
    /** NO_COMPLETION (2026-10-11): the Training Grounds, a no-reward session (DeployServer p2p/huntLaunchManifest.ts). */
    guardCompletionMode: "FIRST_DEFEAT" | "END_OF_HUNT" | "NO_COMPLETION";
}

/** Why a player-hosted session was not created; the route then falls back to a dedicated server (B2). */
export type PlayerHostedSetupOutcome = { created: true } | { created: false; reason: string };

/** Errors thrown inside the creation transaction that mean "use a dedicated server", not "fail the request". */
const FALLBACK_ERRORS = new Set(["P2P_STEAM_LINK_REQUIRED", "PARTY_REVISION_CONFLICT"]);

export function PlayerHostedSetupFailureReason(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : undefined;
    return message != undefined && FALLBACK_ERRORS.has(message) ? message : undefined;
}

/**
 * [2026-10-11 B2] What a request whose player-hosted route could not be set up does: the dedicated route, unless
 * dedicated hunts are disabled (P2P_DISABLE_DEDICATED_HUNTS), which cancels a hunt. A hub request (Ramsgate, the
 * Training hub as hosted Training's fallback) always keeps its dedicated server.
 */
export function DedicatedFallbackAction(isHub: boolean, dedicatedHuntsDisabled: boolean): "DEDICATED" | "CANCEL" {
    return !isHub && dedicatedHuntsDisabled ? "CANCEL" : "DEDICATED";
}

/**
 * [2026-10-14 M1] A player-hosted hunt's launch manifest. The default source resolves it here from the hunt tables
 * (src/p2p/huntManifest), with no DeployServer request; MYSTICPARADOX_HUNT_MANIFEST_SOURCE=director asks DeployServer as
 * before. A refusal (an unknown hunt, a malformed party) throws in the local source and reports undefined from DeployServer;
 * the caller treats both as HUNT_MANIFEST_UNAVAILABLE.
 */
export async function ResolveHuntLaunchManifest(HuntId: string, ExpectedPlayers: string[]): Promise<HuntLaunchManifest | undefined> {
    if (ReadHuntManifestSource() === "local") return ResolveLocalHuntLaunchManifest(HuntId, ExpectedPlayers);
    // [2026-10-15] No DeployServer (DEPLOYSERVER_URL unset): no manifest can come from one, so none is requested and the caller
    // reports HUNT_MANIFEST_UNAVAILABLE (its route then falls back to the cancel of a hunt with no dedicated route).
    if (!DedicatedServersConfigured()) {
        logger.warn(`[P2P] hunt launch manifest not requested for ${HuntId}: no DeployServer (DEPLOYSERVER_URL is unset)`);
        return undefined;
    }
    const response = await fetch("http://" + process.env.DEPLOYSERVER_URL + DEPLOYSERVER_MANIFEST_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ HuntId, ExpectedPlayers })
    });
    if (!response.ok) return undefined;
    return await response.json() as HuntLaunchManifest;
}

type HuntManifestResolver = (HuntId: string, ExpectedPlayers: string[]) => Promise<HuntLaunchManifest | undefined>;
let ManifestResolverForTest: HuntManifestResolver | undefined;

/** Tests replace the DeployServer manifest request (realm hunts and the hunt kit); `undefined` restores the real request. */
export function SetHuntManifestResolverForTest(resolver: HuntManifestResolver | undefined): void {
    ManifestResolverForTest = resolver;
}

/** A realm's hunt: the realm and its host (the realm option of CreatePlayerHostedMatchmaking, section 3.4). */
export interface RealmHuntOption {
    realmId: string;
    hostAccountId: string;
}

type SoloPartyResolver = (accountId: string, buildId: string) => Promise<{ partyId: string; revision: number }>;
let SoloPartyResolverForTest: SoloPartyResolver | undefined;

/** Tests replace the solo party of a request with no party state (the party store is not in the in-memory test kit). */
export function SetSoloPartyResolverForTest(resolver: SoloPartyResolver | undefined): void {
    SoloPartyResolverForTest = resolver;
}

/** [2026-10-14 realms S5] The requester's solo party: the party POST /party gives a player who has none (created on first use). */
async function SoloPartyOf(accountId: string, buildId: string): Promise<{ partyId: string; revision: number }> {
    if (SoloPartyResolverForTest != undefined) return SoloPartyResolverForTest(accountId, buildId);
    const party = await GetOrCreateParty(accountId, buildId);
    return { partyId: party.partyId, revision: party.revision };
}

async function CreatePlayerHostedMatchmaking(
    Context: HuntRouteContext,
    GameMode: string,
    HuntId: string,
    PartyId: string,
    PartyRevision: number,
    PartyMembers: string[],
    realm?: RealmHuntOption
): Promise<PlayerHostedSetupOutcome> {
    const existing = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(PartyId);
    if (existing != undefined) {
        // [2026-10-11 B1] Only a session still forming is reused (party members following the leader). A finished or
        // ending one - or one the requester already left - is superseded first; before, the party's next request
        // reused it (same hunt: the dead loopback port) or was refused (another hunt: a 400).
        const disposition = ClassifyExistingPartySession(existing, HuntId, Context.playerId);
        if (disposition.action === "CONFLICT") return { created: false, reason: `P2P_SESSION_${disposition.reason}` };
        if (disposition.action === "REUSE") {
            for (const participant of existing.roster) {
                Context.setCandidate(participant.accountId, {
                    Ready: false,
                    CandidateId: participant.candidateId,
                    GameSessionId: existing.sessionId,
                    HuntId,
                    Host: "",
                    Port: 0,
                    ReadyAt: 0
                });
            }
            return { created: true };
        }
        // [2026-10-15] A running Tier 0 hunt is drained, not fenced: its players keep their server until it ends (BeginDrainPartySession).
        const superseded = disposition.action === "DRAIN"
            ? await BeginDrainPartySession(existing, disposition.reason, Context.playerId)
            : await SupersedePartySession(existing, disposition.reason, Context.playerId);
        const outcome = superseded != undefined ? superseded.record.state : "already-moved-on";
        logger.info(disposition.action === "DRAIN"
            ? `[P2P] party ${PartyId} request for ${HuntId} drains session ${existing.sessionId} ` +
                `state=${existing.state} reason=${disposition.reason} outcome=${outcome}`
            : `[P2P] party ${PartyId} request for ${HuntId} supersedes session ${existing.sessionId} ` +
                `state=${existing.state} reason=${disposition.reason} ended=${outcome}`);
        if (superseded?.partyRevision != undefined) PartyRevision = superseded.partyRevision;
        else {
            // The session moved on concurrently; take the party's current revision for the new session.
            const party = await GetP2PRepositories().parties.findById(PartyId);
            if (party != undefined) PartyRevision = party.revision;
        }
    }

    let manifest: HuntLaunchManifest | undefined;
    try {
        // The Director answers a realm's hunt the same way (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 12 D1).
        manifest = await (ManifestResolverForTest ?? ResolveHuntLaunchManifest)(HuntId, PartyMembers);
    } catch (error) {
        logger.warn(`[P2P] hunt launch manifest request failed for ${HuntId}: ${error}`);
        manifest = undefined;
    }
    if (manifest == undefined) return { created: false, reason: "HUNT_MANIFEST_UNAVAILABLE" };
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const guardSeed = crypto.randomBytes(32).toString("hex");
    const contentDigest = crypto.createHash("sha256").update([
        HuntId, manifest.matchmakerHuntId, manifest.mapPath, manifest.behemothPath, manifest.expectedPlayerString,
        GameMode, manifest.guardCompletionMode,
        ReadP2PInteger("TARGET_CHANGELIST", 647472, 1, 2_147_483_647)
    ].join("\n")).digest("hex");
    const p2pPolicy = ReadP2PPolicy();
    const requestedRewardVersion = process.env.HUNT_GUARD_REWARD_TABLE_VERSION ?? "observe-no-rewards-v1";
    const rewardPolicy = p2pPolicy.trustTier === 1 ? GetAntiCheatExtension().rewards.policyStatus(HuntId, requestedRewardVersion) : undefined;
    if (rewardPolicy != undefined && !rewardPolicy.ready) {
        logger.error(`[P2P Rewards] refusing Tier 1 hunt ${HuntId}: ${rewardPolicy.reason}`);
        return { created: false, reason: "TIER1_REWARD_POLICY_UNAVAILABLE" };
    }
    const record = await WithP2PTransaction(async (repos, mongoSession) => {
        // Serialize session creation against the durable operator stop. A stop activated
        // concurrently with this transaction either wins first or conflicts and retries here.
        if (!await FenceP2PEmergencyStop(mongoSession)) return undefined;
        const concurrent = await repos.p2pHunts.findActiveHuntForParty(PartyId, mongoSession);
        if (concurrent != undefined) return concurrent;
        const canonicalParty = await repos.parties.findById(PartyId, mongoSession);
        if (canonicalParty == undefined || canonicalParty.revision !== PartyRevision ||
            PartyMembers.length < 1 || PartyMembers.length > 4 ||
            new Set(PartyMembers).size !== PartyMembers.length ||
            PartyMembers.some((member) => !canonicalParty.members.includes(member))) {
            throw new Error("PARTY_REVISION_CONFLICT");
        }
        const linked = await Promise.all(PartyMembers.map((accountId) => repos.p2pHunts.findSteamLink(accountId, mongoSession)));
        if (linked.some((link) => link == undefined || link.status !== "VERIFIED")) {
            throw new Error("P2P_STEAM_LINK_REQUIRED");
        }
        // [2026-10-13] The hunt keeps the transport it starts with; the links above already carry its peer ids.
        const { coopTransport } = await GetP2POperationsPolicy(mongoSession);
        const frozenLoadouts = await Promise.all(PartyMembers.map(async (accountId) => {
            const characters = await repos.characters.findManyByUserId(accountId, mongoSession);
            const character = characters.slice().sort((a, b) => a.characterId.localeCompare(b.characterId))[0];
            const loadout = character == undefined ? undefined : await repos.loadouts.findByCharacterIdAndUserId(character.characterId, accountId, mongoSession);
            const material = StableJson(loadout == undefined ? null : {
                characterId: loadout.characterId,
                userId: loadout.userId,
                revision: loadout.revision ?? 0,
                activeIndex: loadout.activeIndex ?? 0,
                loadouts: CanonicalStoredJson(loadout.loadouts),
                persistent: CanonicalStoredJson(loadout.persistent)
            });
            return { accountId, characterId: character?.characterId, loadoutRevision: loadout?.revision ?? 0,
                activeIndex: loadout?.activeIndex ?? 0,
                characterUpdateVersion: character?.updateVersion ?? 0,
                characterDataDigest: crypto.createHash("sha256").update(character?.data ?? "NONE").digest("hex"),
                digest: crypto.createHash("sha256").update(material).digest("hex") };
        }));
        const activity = await repos.parties.setActivity({
            partyId: PartyId,
            expectedRevision: PartyRevision,
            activity: "HOST_SELECTING",
            activeHuntSessionId: sessionId,
            now: now.toISOString()
        }, mongoSession);
        if (activity == undefined) throw new Error("PARTY_REVISION_CONFLICT");
        const hunt: P2PHuntSessionRecord = {
            sessionId,
            activePartyKey: PartyId,
            generation: 1,
            state: "HOST_SELECTING",
            stateVersion: 1,
            partyId: PartyId,
            partyRevision: activity.revision,
            huntDefinitionId: HuntId,
            gameMode: GameMode,
            build: ReadP2PInteger("TARGET_CHANGELIST", 647472, 1, 2_147_483_647),
            bridgeProtocol: ReadP2PInteger("P2P_BRIDGE_PROTOCOL", 1, 1, 255),
            // Steam P2P virtual ports are logical rendezvous channels, not UDP socket ports.
            // Valve recommends small values; keep this independent from the headless UE UDP port.
            virtualPort: ReadP2PInteger("P2P_VIRTUAL_PORT", 1, 1, 999),
            hostAccountId: "",
            hostSteamId: "",
            bridgeInstanceId: "",
            coopTransport,
            roster: PartyMembers.map((accountId, index) => ({
                accountId,
                steamId: linked[index]!.steamId,
                candidateId: crypto.randomUUID(),
                reconnectEpoch: 0,
                admissionState: "PENDING"
            })),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
            matchmakerHuntId: manifest.matchmakerHuntId,
            mapPath: manifest.mapPath,
            behemothPath: manifest.behemothPath,
            expectedPlayerString: manifest.expectedPlayerString,
            guardCompletionMode: manifest.guardCompletionMode,
            contentDigest,
            ruleVersion: process.env.HUNT_GUARD_RULE_VERSION ?? "observe-v1",
            rewardTableVersion: rewardPolicy?.ready ? rewardPolicy.snapshot.version : requestedRewardVersion,
            trustTier: p2pPolicy.trustTier,
            rewardPolicyDigest: rewardPolicy?.ready ? rewardPolicy.snapshot.digest : undefined,
            seedCommitment: crypto.createHash("sha256").update(guardSeed, "hex").digest("hex"),
            guardSeed,
            frozenLoadouts,
            guardLastSequence: 0,
            guardHeadHash: "0".repeat(64),
            guardEncounterState: "CREATED",
            guardDisposition: "OBSERVE_CLEAR",
            guardFindingCount: 0,
            // [2026-10-14 realms S3] A realm hunt runs on its realm's host: the host may or may not be one of the party (the
            // members in the realm). An official hunt has none of these fields.
            ...(realm != undefined ? {
                realmId: realm.realmId,
                hostParticipates: PartyMembers.includes(realm.hostAccountId),
                hostAccountId: realm.hostAccountId,
                hostSteamId: DeriveIcePeerId(realm.hostAccountId)
            } : {})
        };
        await repos.p2pHunts.createHunt(hunt, mongoSession);
        await repos.p2pHunts.appendHuntTransition({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            fromState: "REQUESTED",
            toState: "HOST_SELECTING",
            stateVersion: hunt.stateVersion,
            reason: "PLAYER_HOST_ROUTE_SELECTED",
            actorType: "SYSTEM",
            at: hunt.createdAt
        }, mongoSession);
        return hunt;
    }).catch((error: unknown) => {
        // [2026-10-11 B2] A missing Steam link or a party that changed under the request means "use a dedicated
        // server" (RouteP2PHunt's fallback); before, the error escaped the route and the client got a 500.
        const reason = PlayerHostedSetupFailureReason(error);
        if (reason == undefined) throw error;
        return reason;
    });
    if (typeof record === "string") return { created: false, reason: record };

    if (record == undefined) return { created: false, reason: "P2P_EMERGENCY_STOP" };

    for (const participant of record.roster) {
        Context.setCandidate(participant.accountId, {
            Ready: false,
            CandidateId: participant.candidateId,
            GameSessionId: record.sessionId,
            HuntId,
            Host: "",
            Port: 0,
            ReadyAt: 0
        });
    }
    logger.info(`[P2P] durable hunt session ${record.sessionId} froze party=${PartyId} revision=${record.partyRevision} roster=${record.roster.length}`);
    await BeginHostSelection(record.sessionId);
    return { created: true };
}

/** Route decision for one matchmaking request; `handled: false` continues with the dedicated route. */
export async function RouteP2PHunt(Context: HuntRouteContext): Promise<HuntRouteOutcome> {
    const { gameMode: GameMode, huntId: EffectiveHuntId, playerId: PlayerId, partyId: PartyId,
        partyMembers: PartyMembers, isHub } = Context;
    // [2026-10-14] Gauntlet is refused on every route until MYSTICPARADOX_GAUNTLET=on (the shared matchmaker refuses it first; this keeps
    // the route's own answer the same when it is called directly).
    if (RefusesGauntletRequest(EffectiveHuntId)) {
        return { handled: true, result: Context.cancel(EffectiveHuntId, PartyMembers ?? [PlayerId], GAUNTLET_DISABLED_REASON) };
    }
    // [2026-10-14 realms S2, design section 3.1] A member whose presence is bound to a realm is routed to that realm, and never to
    // a dedicated server: a failure to decide cancels the request. Off (or no presence) the routing below is unchanged.
    if (IsRealmHostingEnabled()) {
        let realmPresence: RealmPresenceView | undefined;
        try {
            realmPresence = await GetRealmsPort().presenceOf(PlayerId);
        } catch (error) {
            logger.error(`[RealmRoute] presence of ${PlayerId} could not be read; cancelling the request: ${error}`);
            return { handled: true, result: Context.cancel(EffectiveHuntId, PartyMembers ?? [PlayerId], "REALM_UNAVAILABLE") };
        }
        if (realmPresence != undefined) {
            return RouteRealmRequest(Context, realmPresence, {
                createRealmHunt: async (requestContext, start) => CreatePlayerHostedMatchmaking(
                    requestContext, start.gameMode, start.huntId, start.partyId, start.partyRevision, start.members,
                    { realmId: start.realmId, hostAccountId: start.hostAccountId }),
                soloParty: SoloPartyOf
            });
        }
    }
    const BasePolicy = ReadP2PPolicy();
    // [2026-10-11 B7] The shared matchmaker calls Training a hub; with P2P_TRAINING_ENABLED it may be hosted on a
    // player's PC, so it is routed like a hunt here (and falls back to the dedicated Training hub, never cancelled).
    const HostedTraining = IsP2PTrainingRequest(GameMode, EffectiveHuntId, BasePolicy);
    const RoutesAsHunt = !isHub || HostedTraining;
    let EffectivePartyRevision = Context.partyRevision;
    // [2026-10-11 B1] A hub request means the player left any player-hosted hunt; the last one out ends it cleanly.
    if (isHub && BasePolicy.enabled) {
        try {
            const ended = await NoteHubReturn(PlayerId);
            if (ended?.partyRevision != undefined && ended.partyId === PartyId) EffectivePartyRevision = ended.partyRevision;
        } catch (error) {
            logger.warn(`[P2P] hub return of ${PlayerId} not recorded: ${error}`);
        }
    }
    if (PartyId != undefined && RoutesAsHunt) {
        EffectivePartyRevision = (await CloseRecoveredSessionForParty(PartyId)) ?? EffectivePartyRevision;
    }
    const emergencyStop = (await GetP2POperationsPolicy()).p2pEmergencyStop;
    const RouteDecision = DecideHuntRoute({
        gameMode: GameMode,
        huntId: EffectiveHuntId,
        accountIds: PartyMembers ?? [PlayerId],
        partySize: PartyMembers?.length ?? 1,
        // The captured client contract does not carry a separate privacy field. For the
        // allowlisted rollout, possession of the exact canonical Mystic party ID is the
        // private-party signal; the frozen revision/roster is revalidated transactionally.
        isPrivateParty: PartyId != undefined
    }, BasePolicy, {
        playerHostedImplemented: process.env.P2P_HOST_SELECTION_ENABLED === "true",
        emergencyStop
    });
    logger.info({
        event: "hunt_route_decision",
        route: RouteDecision.route,
        reason: RouteDecision.reason,
        huntId: EffectiveHuntId,
        partyId: PartyId,
        partySize: PartyMembers?.length ?? 1,
        rolloutBucket: RouteDecision.rolloutBucket,
        p2pPolicy: P2PPolicySummary(BasePolicy),
        emergencyStop
    }, `[HuntRoute] ${RouteDecision.route} reason=${RouteDecision.reason} huntId=${EffectiveHuntId}`);

    // [2026-10-11 B2] A player-hosted route that cannot be set up falls back to the dedicated route with a logged
    // reason. It used to answer 500 (no verified Steam link: P2P_STEAM_LINK_REQUIRED thrown out of the transaction) or
    // 400 (session creation refused, and a solo "Private Hunt" from a multi-member party, which has no party state).
    // With P2P_DISABLE_DEDICATED_HUNTS a hunt is still cancelled with that reason; Training falls back to its hub.
    const Fallback = (Reason: string): HuntRouteOutcome => {
        if (DedicatedFallbackAction(isHub, BasePolicy.dedicatedHuntsDisabled) === "CANCEL") {
            logger.warn(`[HuntRoute] player-hosted setup failed and dedicated hunts are disabled; canceling huntId=${EffectiveHuntId} reason=${Reason}`);
            return { handled: true, result: Context.cancel(EffectiveHuntId, PartyMembers ?? [PlayerId], Reason) };
        }
        logger.warn({
            event: "hunt_route_dedicated_fallback",
            huntId: EffectiveHuntId,
            partyId: PartyId,
            reason: Reason
        }, `[HuntRoute] dedicated fallback reason=${Reason} huntId=${EffectiveHuntId}`);
        return { handled: false };
    };

    if (RouteDecision.route === "PLAYER_HOSTED") {
        const rewardPreflight = BasePolicy.trustTier === 1
            ? GetAntiCheatExtension().rewards.policyStatus(EffectiveHuntId, process.env.HUNT_GUARD_REWARD_TABLE_VERSION ?? "observe-no-rewards-v1")
            : undefined;
        if (rewardPreflight?.ready === false) {
            logger.error(`[P2P Rewards] routing ${EffectiveHuntId} to dedicated authority: ${rewardPreflight.reason}`);
        } else {
            if (PartyId == undefined || PartyMembers == undefined || EffectivePartyRevision == undefined) {
                return Fallback("P2P_PARTY_STATE_REQUIRED");
            }
            const outcome = await CreatePlayerHostedMatchmaking(Context, GameMode, EffectiveHuntId, PartyId, EffectivePartyRevision, PartyMembers);
            if (outcome.created) return { handled: true, result: true };
            const stopped = outcome.reason === "P2P_EMERGENCY_STOP" || (await GetP2POperationsPolicy()).p2pEmergencyStop;
            return Fallback(stopped ? "P2P_EMERGENCY_STOP" : outcome.reason);
        }
    }

    if (!isHub && BasePolicy.dedicatedHuntsDisabled) {
        logger.warn(
            `[HuntRoute] canceling non-P2P hunt because dedicated hunts are disabled ` +
            `huntId=${EffectiveHuntId} reason=${RouteDecision.reason}`
        );
        return { handled: true, result: Context.cancel(
            EffectiveHuntId,
            PartyMembers ?? [PlayerId],
            `P2P_REQUIRED_${RouteDecision.reason}`
        ) };
    }
    return { handled: false };
}
