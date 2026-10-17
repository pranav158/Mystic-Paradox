import crypto from "node:crypto";
import {
    ArtifactHashesMatch,
    HostIneligibilityReason,
    ReadP2PArtifactPolicy,
    ReadP2PHostEligibilityPolicy,
    ReadP2PHuntDrainCapMs,
    ScoreHost
} from "../config/p2pHostPolicy";
import { IsTrainingHuntId, ReadP2PPolicy } from "../config/p2pPolicy";
import { DedicatedServersConfigured } from "../../config/dedicatedServers";
import { logger } from "../../logger";
import { GetHubGameSessionId } from "../../controllers/matchmaking";
import {
    GetP2PRepositories,
    WithP2PTransaction,
    P2PArtifactHashes,
    P2PHostCapabilityRecord,
    P2PHostOfferRecord,
    P2PHuntParticipantRecord,
    P2PHuntSessionRecord,
    P2PHuntState
} from "../persistence";
import { LauncherApiError } from "../security/p2pErrors";
import { ParseSteamTransportId } from "../security/steamTransportIdentity";
import { DeriveIcePeerId, ParseIcePeerReport } from "../security/transportPeerIds";
import { LauncherGuardRole, LauncherGuardSessionRecord } from "../../persistence/contracts/LauncherGuardRepository";
import { FenceP2PEmergencyStop, GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import { DecideRealmCapacity, IsRealmHub, RealmLowMemoryNote } from "../realm/realmHubRules";
import { IsRealmHostingEnabled, ReadRealmHubPolicy, RealmHostIneligibilityReason } from "../realm/realmHubPolicy";
import { GetRealmsPort } from "../realm/realmsPort";
import { EndRealmHub, TickRealmHub } from "./realmHubLifecycle";
import { ScheduleHuntXpMonitor } from "../observability/huntXpMonitor";
import { GuardRuleRequires, GuardVerdictRefuses, GuardWouldRefuse, NoteGuardWouldRefuse } from "../../services/guardMode";

const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";
export const P2P_LIFECYCLE_STATES: P2PHuntState[] = [
    "HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING",
    "DRAINING", "SUSPECT", "ABORTING", "RECOVERING"
];
const LIFECYCLE_SCAN_LIMIT = 100;
const HOST_PRESENCE_MAX_BODY_AGE_MS = 30_000;
const MAX_OBSERVATION_AGE_MS = 15_000;

export function SelectRecoveryParticipants(
    roster: P2PHuntParticipantRecord[],
    beforeActive: boolean
): P2PHuntParticipantRecord[] {
    if (beforeActive) return roster;
    return roster.filter((entry) =>
        entry.admissionState === "ADMITTED"
        && entry.localBridgeReadyAt != undefined
        && entry.localBridgePort != undefined
    );
}

export function ShouldUseDedicatedPreActiveFallback(
    beforeActive: boolean,
    environment: NodeJS.ProcessEnv = process.env
): boolean {
    return beforeActive && !ReadP2PPolicy(environment).dedicatedHuntsDisabled;
}

export function IsPreActiveOperatorStopState(state: P2PHuntState): boolean {
    return ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY"].includes(state);
}

function NumberIn(value: unknown, min: number, max: number): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function IntegerIn(value: unknown, min: number, max: number): number | undefined {
    const number = NumberIn(value, min, max);
    return number != undefined && Number.isInteger(number) ? number : undefined;
}

function StringIn(value: unknown, maximum: number): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0") ? value : undefined;
}

interface GuardPresence {
    role: LauncherGuardRole;
    guardSessionId: string;
}

/** Parse the independently bound Guard sessions published by the native launcher. */
export function ParseGuardPresenceSessions(body: any): GuardPresence[] {
    const raw = body?.guardSessions;
    if (raw == undefined) {
        const legacy = StringIn(body?.guardSessionId, 64);
        return legacy == undefined ? [] : [{ role: "client", guardSessionId: legacy }];
    }
    if (!Array.isArray(raw) || raw.length > 2) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The Launcher Guard session list is malformed.");
    }
    const result: GuardPresence[] = [];
    for (const entry of raw) {
        const role = entry?.role === "client" || entry?.role === "host" ? entry.role : undefined;
        const guardSessionId = StringIn(entry?.guardSessionId, 64);
        if (role == undefined || guardSessionId == undefined || !/^[0-9a-f-]{36}$/i.test(guardSessionId) ||
            result.some((item) => item.role === role)) {
            throw new LauncherApiError("P2P_TICKET_INVALID", "The Launcher Guard session list is malformed.");
        }
        result.push({ role, guardSessionId });
    }
    return result;
}

/**
 * The Guard roles a host's presence must have verified. `realmHostOnly` is the server's own confirmation that the caller runs a
 * realm session with no client (section 6.4 of the realms design): only then may the host role stand alone. The caller decides
 * it from the server's record (ConfirmsRealmHost), never from the number the launcher reports.
 */
export function ParseGuardRequiredRoles(body: any, sessions: GuardPresence[], options: { realmHostOnly?: boolean } = {}): LauncherGuardRole[] {
    const raw = body?.guardRequiredRoles;
    if (raw == undefined) return sessions.map((entry) => entry.role);
    if (!Array.isArray(raw) || raw.length > 2) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The Launcher Guard role list is malformed.");
    }
    const roles: LauncherGuardRole[] = [];
    for (const value of raw) {
        if ((value !== "client" && value !== "host") || roles.includes(value)) {
            throw new LauncherApiError("P2P_TICKET_INVALID", "The Launcher Guard role list is malformed.");
        }
        roles.push(value);
    }
    // A hosted game has two protected processes. Requiring the host role without the
    // client role would let a stale server session stand in for the actual game client.
    // [2026-10-14 realms S2] The one exception: a realm host whose client is closed, confirmed by the server.
    if (roles.includes("host") && !roles.includes("client") && !(options.realmHostOnly === true && roles.length === 1)) {
        throw new LauncherApiError("GUARD_REQUIRED", "A hosted process requires both client and host Guard roles.");
    }
    return roles;
}

/**
 * Whether the account hosts a realm with a live server session right now (the server's record, not the launcher's report).
 * False when realm hosting is off or the lookup fails: the host then needs its client role as before.
 */
export async function ConfirmsRealmHost(accountId: string): Promise<boolean> {
    if (!IsRealmHostingEnabled()) return false;
    try {
        const realm = await GetRealmsPort().findHostedRealm(accountId);
        // [2026-10-15] A running server counts here even when it is draining: the PC is still running it, so it is no limit.
        return realm != undefined && await GetP2PRepositories().p2pHunts.countRunningRealmServers(realm.realmId) > 0;
    } catch (error) {
        logger.warn(`[P2P] realm host check for ${accountId} failed; the client role stays required: ${error}`);
        return false;
    }
}

/**
 * [2026-10-13 realms plan step 5] The host's Guard session starts with the host process; its first verdict follows a
 * few seconds later, while the launcher already lists the host role as required. A presence report in between (0.45 s
 * before the first host verdict, second live ICE hunt) recovered a healthy, just-started hunt as LAUNCHER_GUARD_UNHEALTHY.
 * Within this window after the hunt was created, a host role that is merely not verified yet - the client verified -
 * rejects the report (GUARD_REQUIRED) but does not recover the hunt; the next report decides.
 */
export const HOST_GUARD_START_GRACE_MS = 90_000;

export function HostGuardStillStarting(
    hunt: Pick<P2PHuntSessionRecord, "createdAt">,
    requiredRoles: readonly LauncherGuardRole[],
    verifiedRoles: ReadonlySet<LauncherGuardRole>,
    now = Date.now()
): boolean {
    const unverified = requiredRoles.filter((role) => !verifiedRoles.has(role));
    const createdAt = Date.parse(hunt.createdAt);
    return unverified.length > 0 && unverified.every((role) => role === "host") &&
        Number.isFinite(createdAt) && now - createdAt >= 0 && now - createdAt < HOST_GUARD_START_GRACE_MS;
}

/**
 * [2026-10-14] The stored verdict of one Guard session for the observe log. A failed read is logged and gives no detail: the log never
 * fails the request it describes.
 */
async function StoredGuardSession(guardSessionId: string | undefined): Promise<LauncherGuardSessionRecord | undefined> {
    if (guardSessionId == undefined) return undefined;
    try {
        return await GetP2PRepositories().launcherGuard.find(guardSessionId);
    } catch (error) {
        logger.warn(`[GuardObserve] could not read Guard session ${guardSessionId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * [2026-10-14] The detail of a would-be Guard refusal for the observe log: the account's first Guard session that is not healthy
 * (else the first one reported), with its stored verdict and reason codes. No session reported: status NONE.
 */
async function GuardSessionDetail(what: string, accountId: string, sessions: GuardPresence[],
    healthySessionIds: ReadonlySet<string>): Promise<GuardWouldRefuse> {
    const Chosen = sessions.find((entry) => !healthySessionIds.has(entry.guardSessionId)) ?? sessions[0];
    const Stored = await StoredGuardSession(Chosen?.guardSessionId);
    return {
        what, accountId,
        guardSessionId: Chosen?.guardSessionId,
        status: Stored?.status,
        riskScore: Stored?.riskScore,
        reasons: Stored?.reasons ?? []
    };
}

/** The same for a host candidate or a realm host, from its presence record (the Guard session it verified, when it has one). */
async function PresenceGuardDetail(what: string,
    presence: { accountId: string; guardSessionId?: string; guardRiskScore?: number }): Promise<GuardWouldRefuse> {
    const Stored = await StoredGuardSession(presence.guardSessionId);
    return {
        what, accountId: presence.accountId,
        guardSessionId: presence.guardSessionId,
        status: Stored?.status,
        riskScore: Stored?.riskScore ?? presence.guardRiskScore,
        reasons: Stored?.reasons ?? []
    };
}

export function ParseArtifacts(value: unknown): P2PArtifactHashes | undefined {
    if (value == undefined || typeof value !== "object") return undefined;
    const input = value as Record<string, unknown>;
    const result: P2PArtifactHashes = {
        gameExe: StringIn(input.gameExe, 64) ?? "",
        internalServer: StringIn(input.internalServer, 64) ?? "",
        winmmProxy: StringIn(input.winmmProxy, 64) ?? "",
        // Launchers since plan step 4.2 send the neutral co-op names; older ones the transport's own names.
        steamBridge: StringIn(input.transportModule ?? input.steamBridge, 64) ?? "",
        steamRuntime: StringIn(input.transportRuntime ?? input.steamRuntime, 64) ?? "",
        admissionPublicKey: StringIn(input.admissionPublicKey, 64) ?? ""
    };
    return Object.values(result).every((entry) => /^[a-f0-9]{64}$/i.test(entry)) ? result : undefined;
}

// [2026-10-11 B3] The expected hashes now come from the feed (p2pHostPolicy.ts). When one cannot be resolved (no feed,
// no co-op roles in the Guard manifest yet, no pin) the host is simply unverified - the presence report used to fail
// with an internal error instead. Logged at most once a minute.
let LastArtifactPolicyWarningAt = 0;
function HostArtifactsVerified(artifacts: P2PArtifactHashes): boolean {
    try {
        return ArtifactHashesMatch(artifacts, ReadP2PArtifactPolicy());
    } catch (error) {
        if (Date.now() - LastArtifactPolicyWarningAt > 60_000) {
            LastArtifactPolicyWarningAt = Date.now();
            logger.warn(`[P2PArtifacts] expected host artifact hashes unavailable (${error instanceof Error ? error.message : error}); hosts stay unverified`);
        }
        return false;
    }
}

export async function SubmitHostPresence(accountId: string, body: any) {
    // Launchers since plan step 4.2 send transportReady/peerId; older ones steamRuntimeReady/steamId.
    const transportReady: unknown = body?.transportReady ?? body?.steamRuntimeReady;
    const peerId: unknown = body?.peerId ?? body?.steamId;
    const artifacts = ParseArtifacts(body?.artifacts);
    const observedAt = StringIn(body?.observedAt, 40);
    const observedEpoch = observedAt == undefined ? Number.NaN : Date.parse(observedAt);
    if (artifacts == undefined || !Number.isFinite(observedEpoch) || Math.abs(Date.now() - observedEpoch) > HOST_PRESENCE_MAX_BODY_AGE_MS ||
        typeof body?.consentToHost !== "boolean" || typeof body?.powerSaver !== "boolean" ||
        typeof body?.runtimeSupported !== "boolean" || typeof transportReady !== "boolean" ||
        (body?.preflightOnly != undefined && typeof body.preflightOnly !== "boolean")) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The host presence report is malformed or stale.");
    }
    const metrics = {
        freePhysicalMemoryMiB: IntegerIn(body.freePhysicalMemoryMiB, 0, 1_048_576),
        commitHeadroomMiB: IntegerIn(body.commitHeadroomMiB, 0, 1_048_576),
        logicalCpuCount: IntegerIn(body.logicalCpuCount, 1, 1024),
        cpuLoadPercent: NumberIn(body.cpuLoadPercent, 0, 100),
        backendRttMs: NumberIn(body.backendRttMs, 0, 60_000),
        worstPeerRttMs: NumberIn(body.worstPeerRttMs, 0, 60_000),
        jitterMs: NumberIn(body.jitterMs, 0, 60_000),
        packetLossPercent: NumberIn(body.packetLossPercent, 0, 100)
    };
    if (Object.values(metrics).some((value) => value == undefined)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The host presence metrics are outside their bounds.");
    }
    const hostPolicy = ReadP2PHostEligibilityPolicy();
    const expiresAt = new Date(observedEpoch + hostPolicy.presenceMaximumAgeMs).toISOString();
    const current = await GetP2PRepositories().p2pHunts.listHostPresences([accountId], "1970-01-01T00:00:00.000Z");
    const revision = (current[0]?.revision ?? 0) + 1;
    const artifactsVerified = HostArtifactsVerified(artifacts);
    const operationsPolicy = await GetP2POperationsPolicy();
    // [2026-10-13] With the ICE transport the reported id is only the module instance; the transport link (and so the
    // roster and the admission tickets) carries the account-derived peer id instead of a SteamID.
    const ice = operationsPolicy.coopTransport === "ICE";
    const reportedPeer = ice ? ParseIcePeerReport(peerId) : ParseSteamTransportId(peerId);
    const steamId = reportedPeer == undefined ? undefined : ice ? DeriveIcePeerId(accountId) : reportedPeer;
    if ((transportReady && steamId == undefined) || (!transportReady && peerId != undefined)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The co-op transport observation is malformed.");
    }
    const guardSessions = ParseGuardPresenceSessions(body);
    // [2026-10-14 realms S2] The realm sessions the PC says it runs; only the server's own record can let the host role stand alone.
    const realmHostSessions = IntegerIn(body?.realmHostSessions, 0, 8) ?? 0;
    const realmHostOnly = realmHostSessions > 0 && await ConfirmsRealmHost(accountId);
    const guardRequiredRoles = ParseGuardRequiredRoles(body, guardSessions, { realmHostOnly });
    const guardChecks = await Promise.all(guardSessions.map(async (entry) => ({
        entry,
        guard: await GetP2PRepositories().launcherGuard.findHealthyForAccount(
            accountId, entry.guardSessionId, entry.role, new Date().toISOString())
    })));
    const healthyGuards = guardChecks.filter((item) => item.guard != undefined)
        .map((item) => item.guard!);
    const healthyByRole = new Map(healthyGuards.map((entry) => [entry.role, entry]));
    const guardVerified = guardRequiredRoles.length > 0 && guardRequiredRoles.every((role) => healthyByRole.has(role));
    // [2026-10-14] MYSTICPARADOX_GUARD_MODE: in observe (the default) the verdict refuses nothing; the refusal it would make is logged.
    if (GuardRuleRequires(operationsPolicy.guardEnforcement) && guardRequiredRoles.length > 0 && !guardVerified) {
        if (!GuardVerdictRefuses(operationsPolicy.guardEnforcement)) {
            NoteGuardWouldRefuse(await GuardSessionDetail("hosting", accountId, guardSessions,
                new Set(healthyGuards.map((entry) => entry.guardSessionId))));
        } else {
            const active = await GetP2PRepositories().p2pHunts.findActiveHuntForAccount(accountId);
            if (active != undefined && active.hostAccountId === accountId &&
                ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"].includes(active.state) &&
                !HostGuardStillStarting(active, guardRequiredRoles, new Set(healthyByRole.keys()))) {
                await PrepareRecovery(active.sessionId, active.generation, "LAUNCHER_GUARD_UNHEALTHY", false);
            }
            throw new LauncherApiError("GUARD_REQUIRED", "A current healthy Launcher Guard session is required to host.");
        }
    }
    // The launcher must ask the backend to approve its exact artifact hashes before executing the
    // Steam bridge. A verified preflight is policy evaluation only: persisting its intentionally
    // false Steam fields would create a periodic NO_ELIGIBLE_HOST race while steam-doctor runs.
    if (body.preflightOnly === true && artifactsVerified) {
        return { accepted: true, revision: current[0]?.revision ?? 0, expiresAt, artifactsVerified, guardVerified };
    }
    if (artifactsVerified && transportReady && steamId != undefined) {
        await WithP2PTransaction(async (repos, mongoSession) => {
            const current = await repos.p2pHunts.findSteamLink(accountId, mongoSession);
            if (current?.steamId !== steamId) {
                const active = await repos.p2pHunts.findActiveHuntForAccount(accountId, mongoSession);
                if (active != undefined) {
                    throw new LauncherApiError("P2P_CONFLICT", "Steam cannot switch during an active player-hosted hunt.");
                }
            }

            const previousOwner = await repos.p2pHunts.findSteamLinkBySteamId(steamId, mongoSession);
            if (previousOwner != undefined && previousOwner.accountId !== accountId) {
                const previousOwnerHunt = await repos.p2pHunts.findActiveHuntForAccount(previousOwner.accountId, mongoSession);
                if (previousOwnerHunt != undefined) {
                    throw new LauncherApiError("P2P_CONFLICT", "This Steam transport is frozen into an active hunt.");
                }
                await repos.p2pHunts.deleteSteamLink(previousOwner.accountId, mongoSession);
            }

            const now = new Date(observedEpoch).toISOString();
            await repos.p2pHunts.upsertSteamLink({
                accountId,
                steamId,
                status: "VERIFIED",
                revision: current?.steamId === steamId ? current.revision : (current?.revision ?? 0) + 1,
                verifiedAt: current?.steamId === steamId ? current.verifiedAt : now,
                lastUsedAt: now,
                verificationMethod: ice ? "ICE_ACCOUNT_DERIVED" : "STEAM_CLIENT_TRANSPORT"
            }, mongoSession);
        });
    }
    const preferredGuard = healthyByRole.get("client") ?? healthyByRole.get("host");
    await GetP2PRepositories().p2pHunts.upsertHostPresence({
        accountId,
        revision,
        consentToHost: body.consentToHost,
        observedAt: new Date(observedEpoch).toISOString(),
        expiresAt,
        freePhysicalMemoryMiB: metrics.freePhysicalMemoryMiB!,
        commitHeadroomMiB: metrics.commitHeadroomMiB!,
        logicalCpuCount: metrics.logicalCpuCount!,
        cpuLoadPercent: metrics.cpuLoadPercent!,
        powerSaver: body.powerSaver,
        runtimeSupported: body.runtimeSupported,
        steamRuntimeReady: transportReady,
        steamId,
        backendRttMs: metrics.backendRttMs!,
        worstPeerRttMs: metrics.worstPeerRttMs!,
        jitterMs: metrics.jitterMs!,
        packetLossPercent: metrics.packetLossPercent!,
        artifacts,
        artifactsVerified,
        launcherVersion: StringIn(body.launcherVersion, 64) ?? "unknown",
        guardSessionId: preferredGuard?.guardSessionId,
        guardManifestSequence: preferredGuard?.manifestSequence,
        guardSequence: preferredGuard?.lastSequence,
        guardRiskScore: preferredGuard?.riskScore,
        guardVerified,
        guardRoles: healthyGuards.map((entry) => ({
            role: entry.role,
            guardSessionId: entry.guardSessionId,
            manifestSequence: entry.manifestSequence,
            sequence: entry.lastSequence,
            riskScore: entry.riskScore
        })),
        realmHostSessions
    });
    return { accepted: true, revision, expiresAt, artifactsVerified, guardVerified };
}

interface RankedHost {
    accountId: string;
    steamId: string;
    score: number;
    breakdown: P2PHostOfferRecord["scoreBreakdown"];
}

/** The official ranking of a hunt's roster (exported for the tests: a draining host is ranked again). */
export async function RankHosts(hunt: P2PHuntSessionRecord): Promise<RankedHost[]> {
    const policy = ReadP2PHostEligibilityPolicy();
    const operationsPolicy = await GetP2POperationsPolicy();
    // [2026-10-14] Observe mode (MYSTICPARADOX_GUARD_MODE): no candidate is excluded for its Guard; the exclusion is logged.
    const guardRequired = GuardVerdictRefuses(operationsPolicy.guardEnforcement);
    const guardRule = GuardRuleRequires(operationsPolicy.guardEnforcement);
    const observedAfter = new Date(Date.now() - policy.presenceMaximumAgeMs).toISOString();
    const presences = await GetP2PRepositories().p2pHunts.listHostPresences(
        hunt.roster.map((entry) => entry.accountId),
        observedAfter
    );
    const byAccount = new Map(presences.map((presence) => [presence.accountId, presence]));
    const tried = new Set(hunt.triedHostAccountIds ?? []);
    const ranked: RankedHost[] = [];
    for (const participant of hunt.roster) {
        if (tried.has(participant.accountId)) continue;
        const presence = byAccount.get(participant.accountId);
        if (presence == undefined) continue;
        const [reliability, activeHostSessions] = await Promise.all([
            GetP2PRepositories().p2pHunts.findHostReliability(participant.accountId),
            GetP2PRepositories().p2pHunts.countActiveHostSessions(participant.accountId)
        ]);
        const reason = HostIneligibilityReason(presence, reliability, activeHostSessions, policy, guardRequired);
        if (!guardRequired && guardRule &&
            HostIneligibilityReason(presence, reliability, activeHostSessions, policy, true) === "HOST_GUARD_UNVERIFIED") {
            NoteGuardWouldRefuse(await PresenceGuardDetail("host candidate", { ...presence, accountId: participant.accountId }));
        }
        if (reason != undefined) {
            logger.info(`[P2P] host candidate ${participant.accountId} ineligible reason=${reason}`);
            continue;
        }
        const scored = ScoreHost(presence, reliability, policy, activeHostSessions);
        ranked.push({ accountId: participant.accountId, steamId: participant.steamId, ...scored });
    }
    return ranked.sort((left, right) => left.score - right.score || left.accountId.localeCompare(right.accountId));
}

/**
 * A realm hunt's host is the realm's host alone (section 3.4): its own presence (fresh, the same consent, launcher version,
 * artifacts, transport and Guard as an official host, without the RTT, jitter, loss and reliability tests), and the realm's
 * capacity: the live servers of the realm (this hunt excluded) under the host's server limit and the memory floors. A full or
 * short-of-memory host is refused with REALM_FULL, which the candidate reports with a retry hint.
 */
export interface RealmHostSelection {
    ranked: RankedHost[];
    refusal?: "REALM_FULL";
}

export async function RankRealmHost(hunt: P2PHuntSessionRecord, nowMs = Date.now()): Promise<RealmHostSelection> {
    const realmId = hunt.realmId;
    if (realmId == undefined) return { ranked: [] };
    const realm = await GetRealmsPort().findRealm(realmId);
    if (realm == undefined) return { ranked: [] };
    const host = realm.hostAccountId;
    if ((hunt.triedHostAccountIds ?? []).includes(host)) return { ranked: [] };
    const hostPolicy = ReadP2PHostEligibilityPolicy();
    const realmPolicy = ReadRealmHubPolicy();
    const operationsPolicy = await GetP2POperationsPolicy();
    const guardRequired = GuardVerdictRefuses(operationsPolicy.guardEnforcement);
    const guardRule = GuardRuleRequires(operationsPolicy.guardEnforcement);
    const repos = GetP2PRepositories();
    const [presence] = await repos.p2pHunts.listHostPresences([host], new Date(nowMs - hostPolicy.presenceMaximumAgeMs).toISOString());
    if (presence == undefined) {
        logger.info(`[P2P] realm host ${host} for realm ${realmId} has no fresh presence`);
        return { ranked: [] };
    }
    // The memory floors are the capacity's (below: a short host is REALM_FULL, not an ineligible host), so eligibility gets none.
    const reason = RealmHostIneligibilityReason(presence, hostPolicy,
        { minimumFreeMemoryMiB: 0, minimumCommitHeadroomMiB: 0 }, guardRequired, nowMs);
    if (!guardRequired && guardRule && RealmHostIneligibilityReason(presence, hostPolicy,
        { minimumFreeMemoryMiB: 0, minimumCommitHeadroomMiB: 0 }, true, nowMs) === "HOST_GUARD_UNVERIFIED") {
        NoteGuardWouldRefuse(await PresenceGuardDetail("realm host", presence));
    }
    if (reason != undefined) {
        logger.info(`[P2P] realm host ${host} for realm ${realmId} ineligible reason=${reason}`);
        return { ranked: [] };
    }
    // This hunt is itself one of the realm's live sessions (HOST_SELECTING counts), so it is not a server the host already runs.
    const otherServers = Math.max(0, await repos.p2pHunts.countActiveRealmServers(realmId) - 1);
    const capacity = DecideRealmCapacity({
        activeServers: otherServers,
        maxServers: realm.hosting?.maxServers ?? realmPolicy.defaultMaxServers,
        freePhysicalMemoryMiB: presence.freePhysicalMemoryMiB,
        commitHeadroomMiB: presence.commitHeadroomMiB,
        minimumFreeMemoryMiB: realmPolicy.minimumFreeMemoryMiB,
        minimumCommitHeadroomMiB: realmPolicy.minimumCommitHeadroomMiB
    });
    if (!capacity.ok) {
        logger.info(`[P2P] realm ${realmId} has no room on its host right now reason=${capacity.reason} servers=${otherServers}`);
        return { ranked: [], refusal: "REALM_FULL" };
    }
    if (capacity.lowFreeMemory) {
        logger.warn(RealmLowMemoryNote(realmId, `hunt ${hunt.sessionId}`, {
            freePhysicalMemoryMiB: presence.freePhysicalMemoryMiB, commitHeadroomMiB: presence.commitHeadroomMiB,
            minimumFreeMemoryMiB: realmPolicy.minimumFreeMemoryMiB
        }));
    }
    const scored = ScoreHost(presence, undefined, hostPolicy, 0);
    return { ranked: [{ accountId: host, steamId: DeriveIcePeerId(host), ...scored }] };
}

export async function BeginHostSelection(sessionId: string): Promise<void> {
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    if (hunt == undefined || hunt.state !== "HOST_SELECTING") return;
    if ((await GetP2POperationsPolicy()).p2pEmergencyStop) {
        await PrepareRecovery(sessionId, hunt.generation, "OPERATOR_P2P_STOP", true);
        return;
    }
    // Lifecycle retries still run while P2P routing is disabled so recorded hunts can
    // expire and recover, but they must not start another player-host selection.
    if (!ReadP2PPolicy().enabled) {
        await PrepareRecovery(sessionId, hunt.generation, "P2P_DISABLED", true);
        return;
    }
    // [2026-10-14 realms S2] A realm hunt has one candidate, its realm's host (RankRealmHost); an official hunt ranks its roster.
    const selection: RealmHostSelection = hunt.realmId != undefined ? await RankRealmHost(hunt) : { ranked: await RankHosts(hunt) };
    const ranked = selection.ranked;
    if (ranked.length === 0) {
        await PrepareRecovery(sessionId, hunt.generation, selection.refusal ?? "NO_ELIGIBLE_HOST", true);
        return;
    }
    const candidate = ranked[0];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ReadP2PHostEligibilityPolicy().offerLifetimeMs).toISOString();
    const offerId = crypto.randomUUID();
    let emergencyStopDuringTransaction = false;
    const offered = await WithP2PTransaction(async (repos, mongoSession) => {
        emergencyStopDuringTransaction = false;
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            emergencyStopDuringTransaction = true;
            return undefined;
        }
        const current = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (current == undefined || current.state !== "HOST_SELECTING") return undefined;
        const next = await repos.p2pHunts.compareAndSetHunt({
            sessionId,
            generation: current.generation,
            expectedStates: ["HOST_SELECTING"],
            expectedStateVersion: current.stateVersion,
            set: {
                state: "HOST_OFFERED",
                hostAccountId: candidate.accountId,
                hostSteamId: candidate.steamId,
                hostOfferId: offerId,
                offerExpiresAt: expiresAt,
                triedHostAccountIds: [...new Set([...(current.triedHostAccountIds ?? []), candidate.accountId])]
            }
        }, mongoSession);
        if (next == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId,
            generation: next.generation,
            fromState: current.state,
            toState: next.state,
            stateVersion: next.stateVersion,
            reason: "HOST_CANDIDATE_SELECTED",
            actorType: "SYSTEM",
            at: now.toISOString()
        }, mongoSession);
        await repos.p2pHunts.createHostOffer({
            offerId,
            sessionId,
            generation: next.generation,
            accountId: candidate.accountId,
            steamId: candidate.steamId,
            rank: 1,
            score: candidate.score,
            scoreBreakdown: candidate.breakdown,
            status: "OFFERED",
            offeredAt: now.toISOString(),
            expiresAt
        }, mongoSession);
        await repos.p2pHunts.enqueueControlMessage({
            accountId: candidate.accountId,
            messageType: "HOST_OFFERED",
            sessionId,
            generation: next.generation,
            payload: {
                offerId,
                huntDefinitionId: next.huntDefinitionId,
                partySize: next.roster.length,
                expiresAt,
                estimatedMemoryMiB: ReadP2PHostEligibilityPolicy().minimumCommitHeadroomMiB,
                score: candidate.score
            },
            createdAt: now.toISOString(),
            expiresAt
        }, mongoSession);
        return next;
    });
    if (emergencyStopDuringTransaction) {
        await PrepareRecovery(sessionId, hunt.generation, "OPERATOR_P2P_STOP", true);
        return;
    }
    if (offered != undefined) logger.info(`[P2P] host offer ${offerId} session=${sessionId} account=${candidate.accountId} score=${candidate.score}`);
}

export async function RespondToHostOffer(accountId: string, offerId: string, body: any) {
    if (!/^[0-9a-f-]{36}$/i.test(offerId) || typeof body?.accept !== "boolean") {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The host offer response is malformed.");
    }
    const now = new Date();
    const offer = await GetP2PRepositories().p2pHunts.findHostOffer(offerId);
    if (offer == undefined || offer.accountId !== accountId) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Host offer not found.");
    // The launcher accepts automatically and ACKs the durable control message afterward. If that
    // ACK is lost, delivery is retried; treating the same account's repeated acceptance as success
    // prevents a harmless network split from turning an already-starting hunt into a false error.
    if (body.accept && offer.status === "ACCEPTED") {
        return { accepted: true, offerId, sessionId: offer.sessionId, generation: offer.generation };
    }
    if (offer.status !== "OFFERED" || Date.parse(offer.expiresAt) <= now.getTime()) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The host offer has expired or was replaced.");
    }
    if (body.accept && !ReadP2PPolicy().enabled) {
        await PrepareRecovery(offer.sessionId, offer.generation, "P2P_DISABLED", true);
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    }
    if ((await GetP2POperationsPolicy()).p2pEmergencyStop) {
        await PrepareRecovery(offer.sessionId, offer.generation, "OPERATOR_P2P_STOP", true);
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are stopped by operations policy.");
    }
    const reason = StringIn(body?.reason, 96);
    const status = body.accept ? "ACCEPTED" : "DECLINED";
    let policyDisabledDuringTransaction = false;
    let emergencyStopDuringTransaction = false;
    await WithP2PTransaction(async (repos, mongoSession) => {
        policyDisabledDuringTransaction = false;
        emergencyStopDuringTransaction = false;
        // Re-read inside the transaction to close the request-check/use window. Environment
        // policy is process-local, so a disabled observation returns without accepting the
        // offer; recovery runs after the transaction scope has ended.
        if (body.accept && !ReadP2PPolicy().enabled) {
            policyDisabledDuringTransaction = true;
            return;
        }
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            emergencyStopDuringTransaction = true;
            return;
        }
        const updated = await repos.p2pHunts.updateHostOffer({
            offerId,
            accountId,
            expectedStatus: "OFFERED",
            status,
            respondedAt: now.toISOString(),
            responseReason: reason
        }, mongoSession);
        if (updated == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The host offer was already answered.");
        const hunt = await repos.p2pHunts.findHunt(offer.sessionId, mongoSession);
        if (hunt == undefined || hunt.generation !== offer.generation || hunt.hostOfferId !== offerId || hunt.state !== "HOST_OFFERED") {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The host offer no longer owns this generation.");
        }
        if (body.accept) {
            await repos.p2pHunts.incrementHostReliability(accountId, { offersAccepted: 1 }, now.toISOString(), undefined, mongoSession);
            await repos.p2pHunts.enqueueControlMessage({
                accountId,
                messageType: "HUNT_BOOTSTRAP",
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                payload: { sessionId: hunt.sessionId, generation: hunt.generation, role: "HOST" },
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + ReadP2PHostEligibilityPolicy().startupLifetimeMs).toISOString()
            }, mongoSession);
        } else {
            await repos.p2pHunts.incrementHostReliability(accountId, { offersDeclined: 1 }, now.toISOString(), undefined, mongoSession);
            const reset = await repos.p2pHunts.compareAndSetHunt({
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                expectedStates: ["HOST_OFFERED"],
                expectedStateVersion: hunt.stateVersion,
                set: { state: "HOST_SELECTING", hostAccountId: "", hostSteamId: "" },
                unset: ["hostOfferId", "offerExpiresAt"]
            }, mongoSession);
            if (reset == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The host generation changed.");
            await repos.p2pHunts.appendHuntTransition({
                sessionId: hunt.sessionId,
                generation: reset.generation,
                fromState: hunt.state,
                toState: reset.state,
                stateVersion: reset.stateVersion,
                reason: reason ?? "HOST_OFFER_DECLINED",
                actorType: "HOST",
                actorAccountId: accountId,
                at: now.toISOString()
            }, mongoSession);
        }
    });
    if (policyDisabledDuringTransaction) {
        await PrepareRecovery(offer.sessionId, offer.generation, "P2P_DISABLED", true);
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    }
    if (emergencyStopDuringTransaction) {
        await PrepareRecovery(offer.sessionId, offer.generation, "OPERATOR_P2P_STOP", true);
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are stopped by operations policy.");
    }
    if (!body.accept) await BeginHostSelection(offer.sessionId);
    return { accepted: body.accept, offerId, sessionId: offer.sessionId, generation: offer.generation };
}

/**
 * The DeployServer request of a recovery. A pre-active failure falls back to the same hunt on a dedicated server -
 * [2026-10-11 B7] except Training, which falls back to the persistent Training hub (SHARED, as the client asks for
 * it; ISLAND would have started the dojo map as a fresh hunt server). An active failure returns to Ramsgate.
 */
export function RecoveryDestinationRequest(hunt: Pick<P2PHuntSessionRecord, "recoveryBeforeActive" | "huntDefinitionId">):
    { gameMode: "ISLAND" | "SHARED" | "CITY"; huntId: string; persistentHub: boolean } {
    if (hunt.recoveryBeforeActive !== true) return { gameMode: "CITY", huntId: "ShatteredIsles_ReturnToRamsgate", persistentHub: true };
    if (IsTrainingHuntId(hunt.huntDefinitionId)) return { gameMode: "SHARED", huntId: hunt.huntDefinitionId, persistentHub: true };
    return { gameMode: "ISLAND", huntId: hunt.huntDefinitionId, persistentHub: false };
}

/**
 * [2026-10-11 B6] The game session id handed out with a recovery destination. A persistent hub (Ramsgate, the Training
 * hub) must get the hub's own stable id - the client turns it into its XMPP city room (City-<gameSessionId>), and the
 * random id this used to be put recovered players in a room of their own. A dedicated hunt keeps a fresh id.
 */
export function RecoveryGameSessionId(persistentHub: boolean, host: string, port: number): string {
    return persistentHub ? GetHubGameSessionId(host, port) : crypto.randomUUID();
}

async function RequestRecoveryDestination(hunt: P2PHuntSessionRecord) {
    // [2026-10-15] No DeployServer (DEPLOYSERVER_URL unset): there is no dedicated destination, and nothing is requested from one.
    // ResumeRecovery ends such a hunt before it gets here.
    if (!DedicatedServersConfigured()) throw new Error("NO_DEDICATED_SERVERS");
    const destination = RecoveryDestinationRequest(hunt);
    const response = await fetch(`http://${process.env.DEPLOYSERVER_URL}${DEPLOYSERVER_MATCHMAKING_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            GameMode: destination.gameMode,
            GameArgs: "",
            HuntId: destination.huntId,
            ExpectedPlayers: hunt.roster.map((entry) => entry.accountId)
        })
    });
    if (!response.ok) throw new Error(`DeployServer Ramsgate fallback returned ${response.status}`);
    const body = await response.json() as { host?: unknown; port?: unknown };
    if (typeof body.host !== "string" || !Number.isInteger(body.port) || Number(body.port) < 1 || Number(body.port) > 65535) {
        throw new Error("DeployServer returned an invalid Ramsgate fallback");
    }
    const port = Number(body.port);
    return { host: body.host, port, gameSessionId: RecoveryGameSessionId(destination.persistentHub, body.host, port), huntId: destination.huntId };
}

/** [2026-10-14 cancel] The player whose Cancel ends a forming hunt (CancelFormingHunt). */
export interface FormingHuntCancel {
    cancelledBy: string;
}

export const CANCELLABLE_FORMING_STATES: P2PHuntState[] = ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING"];

/**
 * [2026-10-14 cancel] A forming hunt its player may cancel: before RUNNING, with no roster member admitted and no member's route
 * released (a member whose route is released is already told to travel, so its candidate status is IN_PROGRESS).
 */
export function IsCancellableForming(hunt: Pick<P2PHuntSessionRecord, "state" | "roster">): boolean {
    return CANCELLABLE_FORMING_STATES.includes(hunt.state)
        && !hunt.roster.some((entry) => entry.admissionState === "ADMITTED" || entry.localBridgePort != undefined || entry.localBridgeReadyAt != undefined);
}

/**
 * [2026-10-14 cancel] The player's Cancel of a forming hunt: "CANCELED" when this call aborted it, "TOO_LATE" when it is running,
 * a member was admitted or told to travel, or it already ended.
 */
export async function CancelFormingHunt(sessionId: string, generation: number, cancelledBy: string): Promise<"CANCELED" | "TOO_LATE"> {
    const cancelled = await PrepareRecovery(sessionId, generation, "PLAYER_CANCELED", true, { cancelledBy });
    return cancelled ? "CANCELED" : "TOO_LATE";
}

/**
 * [2026-10-14 cancel] With `cancel`, the hunt must still be a forming one when the transaction reads it (IsCancellableForming); it then
 * ends ABORTED with PLAYER_CANCELED, the canceller recorded, with no dedicated fallback and no host start-failure count. Resolves true
 * when this call ended the hunt as a cancel.
 */
export async function PrepareRecovery(sessionId: string, generation: number, reason: string, beforeActive: boolean,
    cancel?: FormingHuntCancel): Promise<boolean> {
    const now = new Date();
    let CancelledHere = false;
    const aborting = await WithP2PTransaction(async (repos, mongoSession) => {
        const hunt = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        // [2026-10-15] A drained hunt is never recovered: its players are on their way to another hunt, and recovery would move
        // them to a dedicated fallback. It ends through the monitor, RenewHostLease, AbortHunt or EndHunt instead.
        if (hunt == undefined || hunt.generation !== generation || ["COMPLETED", "ABORTED", "RECOVERING", "DRAINING"].includes(hunt.state)) return undefined;
        // Checked before anything is revoked: a hunt that is running, or whose member is already travelling, is left alone.
        if (cancel != undefined && !IsCancellableForming(hunt)) return undefined;
        if (hunt.state === "ABORTING") return hunt;
        await repos.p2pHunts.revokeGeneration(sessionId, generation, now.toISOString(), mongoSession);
        await repos.p2pHunts.revokeAdmissionTickets(sessionId, generation, mongoSession);
        const fenced = await repos.p2pHunts.compareAndSetHunt({
            sessionId,
            generation,
            expectedStates: [hunt.state],
            expectedStateVersion: hunt.stateVersion,
            set: { state: "FENCED", failureReason: reason }
        }, mongoSession);
        if (fenced == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId,
            generation,
            fromState: hunt.state,
            toState: "FENCED",
            stateVersion: fenced.stateVersion,
            reason,
            actorType: "SYSTEM",
            at: now.toISOString()
        }, mongoSession);
        // [2026-10-14 realms S2, section 3.4] A realm hunt never falls back to a dedicated server: before it is active it is
        // cancelled like any hunt without a fallback.
        const realmHunt = hunt.realmId != undefined;
        // [2026-10-14 cancel] A player's Cancel never falls back to a dedicated server, whatever kind of hunt it is.
        if (beforeActive && (realmHunt || cancel != undefined || !ShouldUseDedicatedPreActiveFallback(true))) {
            const terminal = await repos.p2pHunts.compareAndSetHunt({
                sessionId,
                generation,
                expectedStates: ["FENCED"],
                expectedStateVersion: fenced.stateVersion,
                set: {
                    state: "ABORTED", terminalAt: now.toISOString(), failureReason: reason,
                    ...(cancel != undefined ? { cancelledByAccountId: cancel.cancelledBy } : {})
                },
                unset: ["activePartyKey", "hostOfferId", "offerExpiresAt", "startupDeadline", "recoveryRetryAt"]
            }, mongoSession);
            if (terminal == undefined) return undefined;
            await repos.p2pHunts.appendHuntTransition({
                sessionId,
                generation,
                fromState: "FENCED",
                toState: "ABORTED",
                stateVersion: terminal.stateVersion,
                reason: `${reason}_P2P_ONLY`,
                actorType: "SYSTEM",
                at: now.toISOString()
            }, mongoSession);
            const party = await repos.parties.findById(hunt.partyId, mongoSession);
            if (party != undefined && party.activeHuntSessionId === sessionId) {
                await repos.parties.setActivity({
                    partyId: party.partyId,
                    expectedRevision: party.revision,
                    activity: "IDLE",
                    now: now.toISOString()
                }, mongoSession);
            }
            for (const participant of hunt.roster) {
                await repos.p2pHunts.enqueueControlMessage({
                    accountId: participant.accountId,
                    messageType: "HOST_OFFER_CANCELLED",
                    sessionId,
                    generation,
                    payload: { reason, recoveryAction: "CANCEL_MATCHMAKING" },
                    createdAt: now.toISOString(),
                    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
                }, mongoSession);
            }
            // A realm host that is not in the party still holds the offer it was made (a realm hunt without its own client); a
            // player's cancel withdraws the offer from its host whatever the hunt is ([2026-10-14 cancel]).
            if ((realmHunt || cancel != undefined) && hunt.hostAccountId && !hunt.roster.some((entry) => entry.accountId === hunt.hostAccountId)) {
                await repos.p2pHunts.enqueueControlMessage({
                    accountId: hunt.hostAccountId,
                    messageType: "HOST_OFFER_CANCELLED",
                    sessionId,
                    generation,
                    payload: { reason, recoveryAction: "CANCEL_MATCHMAKING" },
                    createdAt: now.toISOString(),
                    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
                }, mongoSession);
            }
            // [2026-10-14 cancel] A player's Cancel is not a failure of the host: no start-failure count against it.
            if (hunt.hostAccountId && cancel == undefined) {
                await repos.p2pHunts.incrementHostReliability(
                    hunt.hostAccountId,
                    { startsFailed: 1 },
                    now.toISOString(),
                    new Date(now.getTime() + 5 * 60_000).toISOString(),
                    mongoSession
                );
            }
            logger.warn(`[P2P] pre-active failure canceled without dedicated hunt fallback session=${sessionId} reason=${reason}`);
            CancelledHere = cancel != undefined;
            return terminal;
        }
        // [2026-10-14 realms S2, section 3.4] An active realm hunt that fails ends at once: ABORTED with the reason, every member
        // fenced, the party freed. No RECOVERING and no recovery destination: the members land at the menu or login, and their
        // next request goes to the realm's hub (the realm's Ramsgate keeps running on the host's PC).
        // [2026-10-15] Without a DeployServer an active hunt that is not a realm's has no recovery destination either, so it ends the same way.
        const noDedicatedServer = !DedicatedServersConfigured();
        if (!beforeActive && (realmHunt || noDedicatedServer)) {
            const terminal = await repos.p2pHunts.compareAndSetHunt({
                sessionId,
                generation,
                expectedStates: ["FENCED"],
                expectedStateVersion: fenced.stateVersion,
                set: { state: "ABORTED", terminalAt: now.toISOString(), failureReason: reason },
                unset: ["activePartyKey", "leaseExpiresAt", "startupDeadline", "recoveryRetryAt", "offerExpiresAt", "suspectDeadline", "suspectSince"]
            }, mongoSession);
            if (terminal == undefined) return undefined;
            await repos.p2pHunts.appendHuntTransition({
                sessionId,
                generation,
                fromState: "FENCED",
                toState: "ABORTED",
                stateVersion: terminal.stateVersion,
                reason: `${reason}_REALM_ONLY`,
                actorType: "SYSTEM",
                at: now.toISOString()
            }, mongoSession);
            const party = await repos.parties.findById(hunt.partyId, mongoSession);
            if (party != undefined && party.activeHuntSessionId === sessionId) {
                await repos.parties.setActivity({
                    partyId: party.partyId,
                    expectedRevision: party.revision,
                    activity: "IDLE",
                    now: now.toISOString()
                }, mongoSession);
            }
            // The realm host runs the hunt's server even when its own client is not a member, so it is fenced too.
            const fenceAccountIds = new Set(hunt.roster.map((entry) => entry.accountId));
            if (hunt.hostAccountId) fenceAccountIds.add(hunt.hostAccountId);
            for (const accountId of fenceAccountIds) {
                await repos.p2pHunts.enqueueControlMessage({
                    accountId,
                    messageType: "FENCE_NOW",
                    sessionId,
                    generation,
                    payload: { reason, recoveryAction: "NONE" },
                    createdAt: now.toISOString(),
                    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
                }, mongoSession);
            }
            if (hunt.hostAccountId) {
                await repos.p2pHunts.incrementHostReliability(
                    hunt.hostAccountId,
                    { unexpectedFailures: 1 },
                    now.toISOString(),
                    new Date(now.getTime() + 5 * 60_000).toISOString(),
                    mongoSession
                );
            }
            logger.warn(realmHunt
                ? `[P2P] active realm hunt failed; ended without recovery session=${sessionId} reason=${reason}`
                : `[P2P] active hunt failed with no dedicated server (DEPLOYSERVER_URL is unset); ended without recovery session=${sessionId} reason=${reason}`);
            return undefined;
        }
        const aborting = await repos.p2pHunts.compareAndSetHunt({
            sessionId,
            generation,
            expectedStates: ["FENCED"],
            expectedStateVersion: fenced.stateVersion,
            set: {
                state: "ABORTING",
                recoveryBeforeActive: beforeActive,
                recoveryRetryAt: now.toISOString()
            }
        }, mongoSession);
        if (aborting == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId,
            generation,
            fromState: "FENCED",
            toState: "ABORTING",
            stateVersion: aborting.stateVersion,
            reason,
            actorType: "SYSTEM",
            at: now.toISOString()
        }, mongoSession);
        for (const participant of hunt.roster) {
            await repos.p2pHunts.enqueueControlMessage({
                accountId: participant.accountId,
                messageType: beforeActive ? "HOST_OFFER_CANCELLED" : "FENCE_NOW",
                sessionId,
                generation,
                payload: { reason, recoveryAction: "RETURN_TO_RAMSGATE" },
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
            }, mongoSession);
        }
        if (hunt.hostAccountId) {
            await repos.p2pHunts.incrementHostReliability(
                hunt.hostAccountId,
                beforeActive ? { startsFailed: 1 } : { unexpectedFailures: 1 },
                now.toISOString(),
                new Date(now.getTime() + 5 * 60_000).toISOString(),
                mongoSession
            );
        }
        return aborting;
    });
    // [diagnostics 2026-10-14] The per-hunt XP report for a session that this call ended (a no-op for any other state).
    ScheduleHuntXpMonitor(sessionId);
    if (aborting != undefined) await ResumeRecovery(aborting);
    return CancelledHere;
}

async function ResumeRecovery(aborting: P2PHuntSessionRecord): Promise<void> {
    if (aborting.state !== "ABORTING") return;
    // [2026-10-15] No DeployServer: a hunt still ABORTING (recorded before the server had none) has no recovery destination. It ends
    // here through the same end path as any session, instead of retrying a request that can never be answered.
    if (!DedicatedServersConfigured()) {
        logger.warn(`[P2P] ending ${aborting.sessionId} instead of recovering it: no dedicated server (DEPLOYSERVER_URL is unset) reason=${aborting.failureReason ?? "HOST_FAILED"}`);
        await EndP2PHuntSession(aborting.sessionId, aborting.generation, "NO_DEDICATED_SERVERS", {
            allowedStates: ["ABORTING"], actorType: "SYSTEM"
        });
        return;
    }
    let fallback: Awaited<ReturnType<typeof RequestRecoveryDestination>>;
    try {
        fallback = await RequestRecoveryDestination(aborting);
    } catch (error) {
        const retryAt = new Date(Date.now() + 5_000).toISOString();
        await GetP2PRepositories().p2pHunts.compareAndSetHunt({
            sessionId: aborting.sessionId,
            generation: aborting.generation,
            expectedStates: ["ABORTING"],
            expectedStateVersion: aborting.stateVersion,
            set: { state: "ABORTING", recoveryRetryAt: retryAt }
        });
        throw error;
    }
    const now = new Date();
    await WithP2PTransaction(async (repos, mongoSession) => {
        const hunt = await repos.p2pHunts.findHunt(aborting.sessionId, mongoSession);
        if (hunt == undefined || hunt.generation !== aborting.generation || hunt.state !== "ABORTING") return;
        const beforeActive = hunt.recoveryBeforeActive === true;
        const reason = hunt.failureReason ?? "HOST_FAILED";
        // A pre-active failure is a normal dedicated fallback, so every participant still needs
        // the replacement hunt candidate. Once a player-host route was active, however, only
        // participants that completed Steam admission and published a loopback route can have
        // left Ramsgate. Sending an ISSUED/PENDING participant to ReturnToRamsgate creates a
        // redundant same-map travel and can tear down a perfectly healthy Ramsgate client.
        const recoveryParticipants = SelectRecoveryParticipants(hunt.roster, beforeActive);
        const recoveryCandidateIds = Object.fromEntries(
            recoveryParticipants.map((entry) => [entry.accountId, crypto.randomUUID()])
        );
        const recovered = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            expectedStates: ["ABORTING"],
            expectedStateVersion: hunt.stateVersion,
            set: {
                state: "RECOVERING",
                fallbackHost: fallback.host,
                fallbackPort: fallback.port,
                fallbackGameSessionId: fallback.gameSessionId,
                fallbackHuntDefinitionId: fallback.huntId,
                recoveryCandidateIds,
                recoveryDeadline: new Date(now.getTime() + 10 * 60_000).toISOString()
            } as Partial<P2PHuntSessionRecord>,
            unset: ["leaseExpiresAt", "startupDeadline", "offerExpiresAt", "suspectDeadline", "suspectSince", "recoveryRetryAt"]
        }, mongoSession);
        if (recovered == undefined) return;
        await repos.p2pHunts.appendHuntTransition({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            fromState: "ABORTING",
            toState: "RECOVERING",
            stateVersion: recovered.stateVersion,
            reason,
            actorType: "SYSTEM",
            at: now.toISOString()
        }, mongoSession);
        const party = await repos.parties.findById(hunt.partyId, mongoSession);
        if (party != undefined) {
            const activity = await repos.parties.setActivity({
                partyId: party.partyId,
                expectedRevision: party.revision,
                activity: "RECOVERING",
                activeHuntSessionId: hunt.sessionId,
                now: now.toISOString()
            }, mongoSession);
            if (activity != undefined) {
                await repos.parties.appendEvent({
                    partyId: party.partyId,
                    partyRevision: activity.revision,
                    eventType: "PARTY_HUNT_STATUS_CHANGED",
                    recipientAccountIds: hunt.roster.map((entry) => entry.accountId),
                    payload: { sessionId: hunt.sessionId, generation: hunt.generation, state: "RECOVERING", reason, recoveryAction: "RETURN_TO_RAMSGATE" },
                    now: now.toISOString()
                }, mongoSession);
            }
        }
        for (const participant of recoveryParticipants) {
            await repos.p2pHunts.enqueueControlMessage({
                accountId: participant.accountId,
                messageType: beforeActive ? "DEDICATED_FALLBACK_READY" : "RETURN_TO_RAMSGATE",
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                payload: beforeActive
                    ? {
                        candidateId: recoveryCandidateIds[participant.accountId],
                        gameSessionId: fallback.gameSessionId,
                        huntId: fallback.huntId,
                        host: fallback.host,
                        port: fallback.port,
                        reason
                    }
                    : {
                        candidateId: recoveryCandidateIds[participant.accountId],
                        gameSessionId: fallback.gameSessionId,
                        huntId: fallback.huntId,
                        host: fallback.host,
                        port: fallback.port,
                        reason,
                        automatic: false
                    },
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
            }, mongoSession);
        }
    });
}

async function FinalizeRecovery(hunt: P2PHuntSessionRecord, reason: string): Promise<number | undefined> {
    const Revision = await WithP2PTransaction(async (repos, mongoSession) => {
        const current = await repos.p2pHunts.findHunt(hunt.sessionId, mongoSession);
        if (current == undefined || current.state !== "RECOVERING" || current.generation !== hunt.generation) return undefined;
        const now = new Date().toISOString();
        const terminal = await repos.p2pHunts.compareAndSetHunt({
            sessionId: current.sessionId,
            generation: current.generation,
            expectedStates: ["RECOVERING"],
            expectedStateVersion: current.stateVersion,
            set: { state: "ABORTED", terminalAt: now, failureReason: reason },
            unset: ["activePartyKey", "recoveryDeadline"]
        }, mongoSession);
        if (terminal == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId: current.sessionId,
            generation: current.generation,
            fromState: "RECOVERING",
            toState: "ABORTED",
            stateVersion: terminal.stateVersion,
            reason,
            actorType: "SYSTEM",
            at: now
        }, mongoSession);
        const party = await repos.parties.findById(current.partyId, mongoSession);
        if (party == undefined || party.activeHuntSessionId !== current.sessionId) return party?.revision;
        const idle = await repos.parties.setActivity({
            partyId: party.partyId,
            expectedRevision: party.revision,
            activity: "IDLE",
            now
        }, mongoSession);
        return idle?.revision;
    });
    // [diagnostics 2026-10-14] The per-hunt XP report, after the ABORTED commit above.
    ScheduleHuntXpMonitor(hunt.sessionId);
    return Revision;
}

export async function CloseRecoveredSessionForParty(partyId: string): Promise<number | undefined> {
    const hunt = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(partyId);
    if (hunt == undefined || hunt.state !== "RECOVERING") return undefined;
    return FinalizeRecovery(hunt, "PARTY_STARTED_NEW_ACTIVITY");
}

/*
 * [2026-10-11 P2P on 1.14.7, plan 39_ §13.1 B1] A clean end for Tier 0 hunts.
 *
 * Only a Tier 1 Guard completion ever set COMPLETED; a Tier 0 completion deliberately keeps the generation alive (the
 * result and travel screens still need the relay), and nothing ended it afterwards. Every Tier 0 hunt therefore ended
 * as a missed lease: SUSPECT, then FENCE_NOW / RETURN_TO_RAMSGATE to players already back in Ramsgate and
 * unexpectedFailures + 1 on the host, and until then the party's next request found the stale session (same hunt: the
 * dead loopback port; another hunt: a refused request). A session now ends cleanly, without rewards and without a
 * failure on the host, when:
 *   - every admitted participant has asked for a hub again (NoteHubReturn),
 *   - the host's lease ends after the Guard chain recorded the hunt's completion, or after everyone had left
 *     (HostLossIsCleanEnd: lifecycle monitor, an unhealthy-host lease, the host's explicit end route),
 *   - a new matchmaking request of the party supersedes a finished, ending or abandoned session
 *     (ClassifyExistingPartySession, used by p2pMatchmaking.ts).
 * A host that disappears while players are still in the hunt is unchanged: SUSPECT, recovery, a counted failure.
 */

/** States a host-side clean end may close: the session had a live host. */
export const HOST_END_STATES: P2PHuntState[] = ["HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];
/** States the last hub return closes: the host lease is live (a lost host keeps the failure path). */
export const HUB_RETURN_END_STATES: P2PHuntState[] = ["HOST_READY", "ADMITTING", "RUNNING"];
/** States a party's new request may supersede (RECOVERING is closed by CloseRecoveredSessionForParty). */
export const SUPERSEDE_STATES: P2PHuntState[] = [
    "HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT", "ABORTING"
];
const STARTED_STATES: P2PHuntState[] = ["HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];
/** [2026-10-15] The completion reason of a drained session with no more specific one (BeginDrainPartySession writes it). */
export const DRAIN_COMPLETION_REASON = "SUPERSEDED_REQUESTER_LEFT_HUNT";

function HuntRan(hunt: Pick<P2PHuntSessionRecord, "state" | "preSuspectState">): boolean {
    // [2026-10-15] A drained hunt ran: its players were in it until they left, so its clean end is COMPLETED.
    return hunt.state === "RUNNING" || hunt.state === "DRAINING" || (hunt.state === "SUSPECT" && hunt.preSuspectState === "RUNNING");
}

/**
 * Participants still in the hunt: not back in a hub, and admitted - or the host, who plays on its own server whatever
 * its admission row says, until it leaves (a LOST host connection counts as gone).
 */
export function ParticipantsStillInHunt(roster: readonly P2PHuntParticipantRecord[], hostAccountId?: string): string[] {
    return roster.filter((entry) => entry.returnedToHubAt == undefined && (entry.admissionState === "ADMITTED" ||
        (entry.accountId === hostAccountId && entry.admissionState !== "LOST")))
        .map((entry) => entry.accountId);
}

/**
 * COMPLETED for a Tier 0 session that ran (players were admitted); ABORTED for one that never started, and for Tier 1,
 * whose COMPLETED stays the Guard completion's (with its receipts).
 */
export function CleanEndTerminalState(hunt: Pick<P2PHuntSessionRecord, "state" | "preSuspectState" | "trustTier">): "COMPLETED" | "ABORTED" {
    return (hunt.trustTier ?? 0) === 0 && HuntRan(hunt) ? "COMPLETED" : "ABORTED";
}

/**
 * Why losing this Tier 0 session's host is a clean end rather than a failure, or undefined: the Guard chain recorded
 * the hunt's completion, or the hunt ran and no participant is still in it (the empty host's reap is expected).
 */
export function HostLossIsCleanEnd(hunt: Pick<P2PHuntSessionRecord, "state" | "preSuspectState" | "trustTier" | "guardEncounterState" | "roster" | "hostAccountId">): string | undefined {
    if ((hunt.trustTier ?? 0) !== 0 || !STARTED_STATES.includes(hunt.state)) return undefined;
    if (hunt.guardEncounterState === "COMPLETION_REQUESTED") return "TIER0_HUNT_COMPLETED";
    if (HuntRan(hunt) && ParticipantsStillInHunt(hunt.roster, hunt.hostAccountId).length === 0) return "TIER0_PARTY_LEFT";
    return undefined;
}

/** The roster with `accountId` marked back in a hub, or undefined when that participant was never in the hunt. */
export function MarkParticipantReturnedToHub(roster: readonly P2PHuntParticipantRecord[], accountId: string, at: string, hostAccountId?: string):
    { roster: P2PHuntParticipantRecord[]; changed: boolean; stillInHunt: string[] } | undefined {
    const participant = roster.find((entry) => entry.accountId === accountId);
    if (participant == undefined || (accountId !== hostAccountId &&
        participant.admissionState !== "ADMITTED" && participant.admissionState !== "LOST")) return undefined;
    const changed = participant.returnedToHubAt == undefined;
    const next = roster.map((entry) => entry.accountId === accountId && changed ? { ...entry, returnedToHubAt: at } : entry);
    return { roster: next, changed, stillInHunt: ParticipantsStillInHunt(next, hostAccountId) };
}

export type ExistingPartySessionAction =
    | { action: "REUSE"; reason: "PARTY_FAN_OUT" }
    | { action: "SUPERSEDE"; reason: string }
    // [2026-10-15] A running Tier 0 hunt the requester left keeps its server for the players still in it (BeginDrainPartySession).
    | { action: "DRAIN"; reason: string }
    | { action: "CONFLICT"; reason: string };

/**
 * What a party's new player-hosted request does with the party's current session. REUSE is the fan-out of a session
 * still forming (members follow the leader into the same hunt seconds later). A finished, ending or abandoned session
 * is superseded; so is one the requester has already left, except that a running Tier 0 hunt is drained rather than
 * fenced. A running hunt the requester was never part of (a member who joined the party after the roster froze) is a
 * conflict, routed to a dedicated server.
 */
export function ClassifyExistingPartySession(existing: P2PHuntSessionRecord, huntId: string, requesterId: string, now = Date.now()): ExistingPartySessionAction {
    const action = ClassifyPartySessionBeforeDrain(existing, huntId, requesterId, now);
    // [2026-10-15] Any supersede of a running Tier 0 hunt drains instead of fencing: a finished hunt (HUNT_FINISHED) still shows
    // its results and its players travel only later, and a party that changed hunt or roster may still have players in the old
    // one. The drain keeps the server and its lease until the server empties and stops. A lapsed lease and an ending session
    // stay superseded (there is no live server to keep); a realm hub has its own lifecycle.
    if (action.action === "SUPERSEDE" && existing.state === "RUNNING" && (existing.trustTier ?? 0) === 0 &&
        existing.sessionKind !== "REALM_HUB" && action.reason !== "HOST_LEASE_EXPIRED" && action.reason !== "SESSION_ENDING") {
        return { action: "DRAIN", reason: action.reason };
    }
    return action;
}

function ClassifyPartySessionBeforeDrain(existing: P2PHuntSessionRecord, huntId: string, requesterId: string, now: number): ExistingPartySessionAction {
    if (existing.state === "ABORTING" || existing.state === "SUSPECT") return { action: "SUPERSEDE", reason: "SESSION_ENDING" };
    if (existing.guardEncounterState === "COMPLETION_REQUESTED" || existing.guardEncounterState === "ABORTED") {
        return { action: "SUPERSEDE", reason: "HUNT_FINISHED" };
    }
    const started = STARTED_STATES.includes(existing.state);
    if (started && existing.leaseExpiresAt != undefined && Date.parse(existing.leaseExpiresAt) <= now) {
        return { action: "SUPERSEDE", reason: "HOST_LEASE_EXPIRED" };
    }
    const participant = existing.roster.find((entry) => entry.accountId === requesterId);
    // The host of a running hunt asking for a hunt again has left its own server too (its admission row may lag).
    if (started && participant != undefined && (participant.admissionState === "ADMITTED" ||
        participant.admissionState === "LOST" || participant.returnedToHubAt != undefined ||
        (existing.state === "RUNNING" && requesterId === existing.hostAccountId))) {
        // [2026-10-15] The players still in a running Tier 0 hunt keep their server until it ends (the drain), not a fence.
        // A realm hub is never drained (it has its own lifecycle).
        if (existing.state === "RUNNING" && (existing.trustTier ?? 0) === 0 && existing.sessionKind !== "REALM_HUB") {
            return { action: "DRAIN", reason: "REQUESTER_LEFT_HUNT" };
        }
        return { action: "SUPERSEDE", reason: "REQUESTER_LEFT_HUNT" };
    }
    if (existing.huntDefinitionId !== huntId) return { action: "SUPERSEDE", reason: "PARTY_CHANGED_HUNT" };
    if (participant == undefined) {
        return existing.state === "RUNNING" || existing.state === "ADMITTING"
            ? { action: "CONFLICT", reason: "ROSTER_FROZEN" }
            : { action: "SUPERSEDE", reason: "ROSTER_CHANGED" };
    }
    return { action: "REUSE", reason: "PARTY_FAN_OUT" };
}

/**
 * Ends a session without rewards and without a failure on the host: revokes the generation, closes the session
 * (CleanEndTerminalState), frees the party, cancels an open host offer and fences every bridge of the generation.
 * A COMPLETED end counts as a clean completion for the host. Returns undefined when the session had already moved on
 * (another generation, or a state outside `allowedStates`), else the terminal record and the party's new revision.
 */
export async function EndP2PHuntSession(sessionId: string, generation: number, reason: string, options: {
    allowedStates: readonly P2PHuntState[];
    actorType: "SYSTEM" | "HOST" | "PARTICIPANT";
    actorAccountId?: string;
    /** Send FENCE_NOW to every participant's launcher (default). See NoteHubReturn for the exception. */
    fence?: boolean;
}): Promise<{ record: P2PHuntSessionRecord; partyRevision?: number } | undefined> {
    const now = new Date();
    const ended = await WithP2PTransaction(async (repos, mongoSession) => {
        const hunt = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (hunt == undefined || hunt.generation !== generation || !options.allowedStates.includes(hunt.state)) return undefined;
        const terminalState = CleanEndTerminalState(hunt);
        await repos.p2pHunts.revokeGeneration(sessionId, generation, now.toISOString(), mongoSession);
        await repos.p2pHunts.revokeAdmissionTickets(sessionId, generation, mongoSession);
        const terminal = await repos.p2pHunts.compareAndSetHunt({
            sessionId,
            generation,
            expectedStates: [hunt.state],
            expectedStateVersion: hunt.stateVersion,
            set: {
                state: terminalState,
                terminalAt: now.toISOString(),
                completionReason: reason,
                ...(terminalState === "ABORTED" ? { failureReason: reason } : {})
            },
            unset: ["activePartyKey", "leaseExpiresAt", "suspectSince", "suspectDeadline", "preSuspectState",
                "offerExpiresAt", "startupDeadline", "recoveryRetryAt", "drainDeadline"]
        }, mongoSession);
        if (terminal == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId,
            generation,
            fromState: hunt.state,
            toState: terminalState,
            stateVersion: terminal.stateVersion,
            reason,
            actorType: options.actorType,
            actorAccountId: options.actorAccountId,
            at: now.toISOString()
        }, mongoSession);
        if (hunt.state === "HOST_OFFERED" && hunt.hostOfferId != undefined && hunt.hostAccountId) {
            await repos.p2pHunts.updateHostOffer({
                offerId: hunt.hostOfferId,
                accountId: hunt.hostAccountId,
                expectedStatus: "OFFERED",
                status: "CANCELLED",
                respondedAt: now.toISOString(),
                responseReason: reason
            }, mongoSession);
        }
        if (terminalState === "COMPLETED" && hunt.hostAccountId) {
            await repos.p2pHunts.incrementHostReliability(hunt.hostAccountId, { cleanCompletions: 1 }, now.toISOString(), undefined, mongoSession);
        }
        // Nothing was started while a host was still being selected; every later state may have running bridges.
        if (hunt.state !== "HOST_SELECTING" && options.fence !== false) {
            for (const participant of hunt.roster) {
                await repos.p2pHunts.enqueueControlMessage({
                    accountId: participant.accountId,
                    messageType: "FENCE_NOW",
                    sessionId,
                    generation,
                    payload: { reason, recoveryAction: "NONE", cleanEnd: true },
                    createdAt: now.toISOString(),
                    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
                }, mongoSession);
            }
        }
        let partyRevision: number | undefined;
        const party = await repos.parties.findById(hunt.partyId, mongoSession);
        if (party != undefined) {
            partyRevision = party.revision;
            if (party.activeHuntSessionId === sessionId) {
                const idle = await repos.parties.setActivity({
                    partyId: party.partyId,
                    expectedRevision: party.revision,
                    activity: "IDLE",
                    now: now.toISOString()
                }, mongoSession);
                partyRevision = idle?.revision ?? partyRevision;
            }
        }
        return { record: terminal, partyRevision };
    });
    if (ended != undefined) {
        // [diagnostics 2026-10-14] The per-hunt XP report, after the terminal commit (never blocks the end).
        ScheduleHuntXpMonitor(sessionId);
        logger.info({
            event: "p2p_hunt_clean_end",
            sessionId,
            generation,
            state: ended.record.state,
            reason,
            actorType: options.actorType
        }, `[P2P] session ${sessionId} generation=${generation} ended cleanly state=${ended.record.state} reason=${reason}`);
    }
    return ended;
}

/**
 * [2026-10-11 B1] A roster member asked for a hub (Ramsgate, the Training hub): it has left its player-hosted hunt.
 * Once no admitted participant is still in the hunt, the session ends cleanly. Returns the party's new revision when
 * that end changed the party (with its id), so a request that goes on to create a session uses the current revision.
 */
export async function NoteHubReturn(accountId: string): Promise<{ partyId: string; partyRevision?: number } | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const hunt = await GetP2PRepositories().p2pHunts.findActiveHuntForAccount(accountId);
        if (hunt == undefined || !HUB_RETURN_END_STATES.includes(hunt.state)) return undefined;
        const marked = MarkParticipantReturnedToHub(hunt.roster, accountId, new Date().toISOString(), hunt.hostAccountId);
        if (marked == undefined) return undefined;
        if (marked.changed) {
            const updated = await GetP2PRepositories().p2pHunts.compareAndSetHunt({
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                expectedStates: [hunt.state],
                expectedStateVersion: hunt.stateVersion,
                set: { roster: marked.roster }
            });
            if (updated == undefined) continue;   // a concurrent update (admission, another return): read again
            logger.info(`[P2P] participant ${accountId} returned to a hub from session ${hunt.sessionId} generation=${hunt.generation}` +
                ` stillInHunt=${marked.stillInHunt.length}`);
        }
        if (marked.stillInHunt.length > 0) return undefined;
        // [2026-10-15] A running Tier 0 hunt drains instead of ending. Ending it revoked the host's credential: the host's transport
        // then had its lease refused twice within seconds and fenced its own server while the last player was still on the results
        // screen (Escalation, 15 Oct 16:50 UTC: hub request 1.4 s after the hunt ended, server gone 3.6 s later, travel timed out).
        // The drain keeps the generation and the lease; the server exits 50 s after its last connection, and the drain then ends on
        // the lapsed lease without a fence. The party is freed at once, as the end freed it.
        if (hunt.state === "RUNNING" && (hunt.trustTier ?? 0) === 0 && hunt.sessionKind !== "REALM_HUB") {
            const drained = await BeginDrainPartySession(hunt, "PARTY_RETURNED_TO_HUB", accountId, "PARTY_RETURNED_TO_HUB");
            if (drained == undefined) continue;   // the session moved on concurrently: read it again
            return { partyId: hunt.partyId, partyRevision: drained.partyRevision };
        }
        // [2026-10-13 realms plan step 5] No FENCE_NOW here. This request is the last player's hub matchmaking: its
        // client is still connected to the host and travels only once the hub answers. Fencing the host (or a joiner's
        // bridge) now killed that connection ~1 s before the travel, and the client sat in the hunt with a dead server
        // until its connection timed out (22 s, "axe stuck, lantern dead"; 2 s when the host stayed up). Everyone has
        // asked for a hub, so nobody is left to fence: the session ends and the host's credential is revoked as before,
        // and the host process ends itself 50 s after its last connection (runtime empty-server reap).
        const ended = await EndP2PHuntSession(hunt.sessionId, hunt.generation, "PARTY_RETURNED_TO_HUB", {
            allowedStates: HUB_RETURN_END_STATES,
            actorType: "PARTICIPANT",
            actorAccountId: accountId,
            fence: false
        });
        return ended == undefined ? undefined : { partyId: hunt.partyId, partyRevision: ended.partyRevision };
    }
    logger.warn(`[P2P] hub return of ${accountId} not recorded after 3 concurrent updates; the session ends by its lease`);
    return undefined;
}

/** [2026-10-11 B1] Ends a party's session for its new request (ClassifyExistingPartySession said SUPERSEDE). */
export async function SupersedePartySession(existing: P2PHuntSessionRecord, reason: string, requesterId: string) {
    return EndP2PHuntSession(existing.sessionId, existing.generation, `SUPERSEDED_${reason}`, {
        allowedStates: SUPERSEDE_STATES,
        actorType: "PARTICIPANT",
        actorAccountId: requesterId
    });
}

/**
 * [2026-10-15] Drains a party's running Tier 0 session for its new request (ClassifyExistingPartySession said DRAIN). The
 * session admits nobody new (its tickets are revoked) and frees the party, but nothing is fenced: the generation stays live,
 * the host's lease keeps renewing and its server serves the players still in it. The server ends by itself (its lease
 * lapses, or the host reports it stopped), or the drain ends at its cap when one is configured (P2P_HUNT_DRAIN_GRACE_MS). With no
 * cap no deadline is set, so the drain runs as long as the server does. Same return as EndP2PHuntSession; undefined when the session
 * had already moved on.
 */
export async function BeginDrainPartySession(existing: P2PHuntSessionRecord, reason: string, requesterId: string,
    completionReason = `SUPERSEDED_${reason}`):
    Promise<{ record: P2PHuntSessionRecord; partyRevision?: number } | undefined> {
    const now = new Date();
    // [2026-10-15] A deadline only when a cap is configured: the default drain has none (see ReadP2PHuntDrainCapMs).
    const capMs = ReadP2PHuntDrainCapMs();
    const drainDeadline = capMs === undefined ? undefined : new Date(now.getTime() + capMs).toISOString();
    const drained = await WithP2PTransaction(async (repos, mongoSession) => {
        const hunt = await repos.p2pHunts.findHunt(existing.sessionId, mongoSession);
        if (hunt == undefined || hunt.generation !== existing.generation || hunt.state !== "RUNNING") return undefined;
        // activePartyKey goes too: the party's new request and findActiveHuntForAccount no longer see this session, and the
        // unique index on activePartyKey lets the party's next hunt start.
        const draining = await repos.p2pHunts.compareAndSetHunt({
            sessionId: existing.sessionId,
            generation: existing.generation,
            expectedStates: ["RUNNING"],
            expectedStateVersion: hunt.stateVersion,
            set: {
                state: "DRAINING",
                ...(drainDeadline !== undefined ? { drainDeadline } : {}),
                completionReason
            },
            unset: ["activePartyKey"]
        }, mongoSession);
        if (draining == undefined) return undefined;
        await repos.p2pHunts.revokeAdmissionTickets(existing.sessionId, existing.generation, mongoSession);
        await repos.p2pHunts.appendHuntTransition({
            sessionId: existing.sessionId,
            generation: existing.generation,
            fromState: "RUNNING",
            toState: "DRAINING",
            stateVersion: draining.stateVersion,
            reason: `DRAIN_${reason}`,
            actorType: "PARTICIPANT",
            actorAccountId: requesterId,
            at: now.toISOString()
        }, mongoSession);
        // The party is freed as EndP2PHuntSession frees it.
        let partyRevision: number | undefined;
        const party = await repos.parties.findById(hunt.partyId, mongoSession);
        if (party != undefined) {
            partyRevision = party.revision;
            if (party.activeHuntSessionId === existing.sessionId) {
                const idle = await repos.parties.setActivity({
                    partyId: party.partyId,
                    expectedRevision: party.revision,
                    activity: "IDLE",
                    now: now.toISOString()
                }, mongoSession);
                partyRevision = idle?.revision ?? partyRevision;
            }
        }
        return { record: draining, partyRevision };
    });
    if (drained != undefined) {
        logger.info({
            event: "p2p_hunt_draining",
            sessionId: existing.sessionId,
            generation: existing.generation,
            reason,
            drainDeadline
        }, `[P2P] session ${existing.sessionId} generation=${existing.generation} draining reason=${reason} ` +
            `deadline=${drainDeadline ?? "none"}`);
    }
    return drained;
}

/** Admitted peers a hunt's host may report, and a realm hub's (a hub takes up to 64 players). */
const HUNT_ADMITTED_PEER_LIMIT = 4;
const HUB_ADMITTED_PEER_LIMIT = 64;

export async function RenewHostLease(capability: P2PHostCapabilityRecord, body: any) {
    const sequence = IntegerIn(body?.leaseSequence, 1, Number.MAX_SAFE_INTEGER);
    if (sequence == undefined || typeof body?.bridgeAlive !== "boolean" || typeof body?.serverReady !== "boolean" ||
        IntegerIn(body?.admittedPeerCount, 0, HUB_ADMITTED_PEER_LIMIT) == undefined || IntegerIn(body?.queuePressure, 0, 100) == undefined) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The host heartbeat is malformed.");
    }
    // [2026-10-13 realms S1] Only a realm hub may report more than a hunt's four admitted peers.
    if (IntegerIn(body?.admittedPeerCount, 0, HUNT_ADMITTED_PEER_LIMIT) == undefined) {
        const session = await GetP2PRepositories().p2pHunts.findHunt(capability.sessionId);
        if (!IsRealmHub(session)) throw new LauncherApiError("P2P_TICKET_INVALID", "The host heartbeat is malformed.");
    }
    if (!body.bridgeAlive || !body.serverReady) {
        // [2026-10-11 B1] A host whose server exits after the hunt was completed or left (its empty-hunt reap) is not
        // a failure: end the session cleanly instead of recovering players who are already back in Ramsgate.
        const current = await GetP2PRepositories().p2pHunts.findHunt(capability.sessionId);
        // [2026-10-13 realms S1] A hub whose server is gone ends ABORTED (HOST_PROCESS_UNHEALTHY); the launcher then starts
        // a new hub. None of the hunt recovery applies.
        if (IsRealmHub(current)) {
            await EndRealmHub(capability.sessionId, capability.generation, "HOST_PROCESS_UNHEALTHY", "ABORTED",
                { actorType: "HOST", actorAccountId: capability.hostAccountId });
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The host process reported a fatal failure.");
        }
        // [2026-10-15] A drained hunt whose server stopped (its empty-server reap, or a crash) ends cleanly. Its players are on
        // their way to another hunt, so nothing is recovered.
        if (current?.state === "DRAINING" && current.generation === capability.generation) {
            await EndP2PHuntSession(capability.sessionId, capability.generation, current.completionReason ?? DRAIN_COMPLETION_REASON, {
                allowedStates: ["DRAINING"], actorType: "HOST", actorAccountId: capability.hostAccountId
            });
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The host process reported a fatal failure.");
        }
        const cleanEnd = current != undefined && current.generation === capability.generation ? HostLossIsCleanEnd(current) : undefined;
        if (cleanEnd != undefined) {
            await EndP2PHuntSession(capability.sessionId, capability.generation, `${cleanEnd}_HOST_STOPPED`, {
                allowedStates: HOST_END_STATES, actorType: "HOST", actorAccountId: capability.hostAccountId
            });
        } else {
            await PrepareRecovery(capability.sessionId, capability.generation, "HOST_PROCESS_UNHEALTHY", false);
        }
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The host process reported a fatal failure.");
    }
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + ReadP2PHostEligibilityPolicy().leaseLifetimeMs).toISOString();
    const hunt = await WithP2PTransaction(async (repos, mongoSession) => {
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunt operations are temporarily stopped.");
        }
        const advanced = await repos.p2pHunts.advanceHostCapabilitySequence(capability.capabilityId, sequence, mongoSession);
        if (!advanced) throw new LauncherApiError("P2P_GENERATION_FENCED", "The lease sequence is stale.");
        const renewed = await repos.p2pHunts.renewHostLease({
            sessionId: capability.sessionId,
            generation: capability.generation,
            hostSteamId: capability.hostSteamId,
            bridgeInstanceId: capability.bridgeInstanceId,
            leaseSequence: sequence,
            heartbeatAt: now.toISOString(),
            leaseExpiresAt
        }, mongoSession);
        if (renewed == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The hunt generation no longer accepts heartbeats.");
        return renewed;
    });
    return { renewed: true, sessionId: hunt.sessionId, generation: hunt.generation, leaseExpiresAt, state: hunt.state };
}

export async function RecordParticipantObservation(accountId: string, sessionId: string, body: any) {
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    // [2026-10-13 realms S1] A hub keeps no participant-observation quorum (its health is the host's lease): an observation from
    // the host or a member with an entry is accepted and dropped, so a launcher that reports for every session is not told it
    // was fenced; anyone else is told the session is not theirs.
    if (IsRealmHub(hunt)) {
        const known = hunt!.hostAccountId === accountId ||
            await GetP2PRepositories().realmHub.findPresence(hunt!.sessionId, accountId) != undefined;
        if (!known || hunt!.generation !== body?.generation) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The observation is not bound to the active hub generation.");
        }
        return { accepted: true, sessionId, generation: hunt!.generation, stored: false, state: hunt!.state };
    }
    // [2026-10-16] An ended hunt (COMPLETED or ABORTED) keeps no observations: a roster member's report is accepted, not stored, and the
    // answer names the state, so a launcher from 0.1.72 stops observing it (0.1.71 kept reporting every 5 s until it closed: repro
    // 16 Oct 05:25-05:28 UTC). Every answer carries `state` since then (older launchers ignore it).
    if (hunt?.state === "COMPLETED" || hunt?.state === "ABORTED") {
        if (hunt.generation !== body?.generation || !hunt.roster.some((entry) => entry.accountId === accountId)) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The observation is not bound to the active roster generation.");
        }
        return { accepted: true, sessionId, generation: hunt.generation, stored: false, state: hunt.state };
    }
    // [2026-10-15] A drained hunt keeps no participant quorum (the monitor never marks it SUSPECT): a member's observation is
    // accepted and dropped, so its launcher is not told the session was fenced while the players are still on its server.
    if (hunt?.state === "DRAINING") {
        if (hunt.generation !== body?.generation || !hunt.roster.some((entry) => entry.accountId === accountId)) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The observation is not bound to the active roster generation.");
        }
        return { accepted: true, sessionId, generation: hunt.generation, stored: false, state: hunt.state };
    }
    const participant = hunt?.roster.find((entry) => entry.accountId === accountId);
    if (hunt == undefined || participant == undefined || hunt.generation !== body?.generation) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The observation is not bound to the active roster generation.");
    }
    const observedAt = StringIn(body?.observedAt, 40);
    const observedEpoch = observedAt == undefined ? Number.NaN : Date.parse(observedAt);
    const routeKind = body?.routeKind;
    const metricsAvailable = body?.metricsAvailable === true;
    const metricsValid = metricsAvailable
        ? routeKind !== "UNKNOWN" &&
            IntegerIn(body?.lastPacketAgeMs, 0, 600_000) != undefined &&
            NumberIn(body?.pingMs, 0, 60_000) != undefined &&
            NumberIn(body?.jitterMs, 0, 60_000) != undefined &&
            NumberIn(body?.packetLossPercent, 0, 100) != undefined
        : routeKind === "UNKNOWN" && body?.lastPacketAgeMs == undefined && body?.pingMs == undefined &&
            body?.jitterMs == undefined && body?.packetLossPercent == undefined;
    if (!Number.isFinite(observedEpoch) || Math.abs(Date.now() - observedEpoch) > MAX_OBSERVATION_AGE_MS ||
        typeof body?.hostReachable !== "boolean" || typeof body?.localBridgeAlive !== "boolean" ||
        !["DIRECT", "RELAY", "CONNECTING", "UNKNOWN"].includes(routeKind) ||
        typeof body?.metricsAvailable !== "boolean" || !metricsValid) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The participant observation is malformed or stale.");
    }
    const observation = {
        observationId: crypto.randomUUID(),
        sessionId,
        generation: hunt.generation,
        accountId,
        steamId: participant.steamId,
        hostReachable: body.hostReachable,
        localBridgeAlive: body.localBridgeAlive,
        metricsAvailable,
        lastPacketAgeMs: metricsAvailable ? body.lastPacketAgeMs : undefined,
        routeKind,
        pingMs: metricsAvailable ? body.pingMs : undefined,
        jitterMs: metricsAvailable ? body.jitterMs : undefined,
        packetLossPercent: metricsAvailable ? body.packetLossPercent : undefined,
        observedAt: new Date(observedEpoch).toISOString()
    } as const;
    await WithP2PTransaction(async (repos, mongoSession) => {
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunt operations are temporarily stopped.");
        }
        const current = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (current == undefined || current.generation !== hunt.generation ||
            !current.roster.some((entry) => entry.accountId === accountId)) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The observation is not bound to the active roster generation.");
        }
        await repos.p2pHunts.recordParticipantObservation(observation, mongoSession);
    });
    return { accepted: true, sessionId, generation: hunt.generation, state: hunt.state };
}

async function ExpireOffer(hunt: P2PHuntSessionRecord): Promise<void> {
    if (hunt.hostOfferId == undefined) return;
    const now = new Date().toISOString();
    await WithP2PTransaction(async (repos, mongoSession) => {
        const expired = await repos.p2pHunts.updateHostOffer({
            offerId: hunt.hostOfferId!,
            accountId: hunt.hostAccountId,
            expectedStatus: "OFFERED",
            status: "EXPIRED",
            respondedAt: now,
            responseReason: "TIMEOUT"
        }, mongoSession);
        if (expired == undefined) return;
        await repos.p2pHunts.incrementHostReliability(hunt.hostAccountId, { offersExpired: 1 }, now, undefined, mongoSession);
        const reset = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            expectedStates: ["HOST_OFFERED"],
            expectedStateVersion: hunt.stateVersion,
            set: { state: "HOST_SELECTING", hostAccountId: "", hostSteamId: "" },
            unset: ["hostOfferId", "offerExpiresAt"]
        }, mongoSession);
        if (reset != undefined) {
            await repos.p2pHunts.appendHuntTransition({
                sessionId: hunt.sessionId,
                generation: reset.generation,
                fromState: hunt.state,
                toState: reset.state,
                stateVersion: reset.stateVersion,
                reason: "HOST_OFFER_EXPIRED",
                actorType: "SYSTEM",
                at: now
            }, mongoSession);
        }
    });
    await BeginHostSelection(hunt.sessionId);
}

async function RetryPreActiveHost(hunt: P2PHuntSessionRecord, reason: string): Promise<void> {
    const now = new Date();
    const retried = await WithP2PTransaction(async (repos, mongoSession) => {
        await repos.p2pHunts.revokeGeneration(hunt.sessionId, hunt.generation, now.toISOString(), mongoSession);
        await repos.p2pHunts.revokeAdmissionTickets(hunt.sessionId, hunt.generation, mongoSession);
        const next = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            expectedStates: [hunt.state],
            expectedStateVersion: hunt.stateVersion,
            set: {
                generation: hunt.generation + 1,
                state: "HOST_SELECTING",
                hostAccountId: "",
                hostSteamId: "",
                bridgeInstanceId: "",
                failureReason: reason
            },
            unset: ["hostOfferId", "offerExpiresAt", "startupDeadline", "lobbyId", "leaseExpiresAt", "metadataNonce"]
        }, mongoSession);
        if (next != undefined) {
            await repos.p2pHunts.appendHuntTransition({
                sessionId: hunt.sessionId,
                generation: next.generation,
                fromState: hunt.state,
                toState: next.state,
                stateVersion: next.stateVersion,
                reason,
                actorType: "SYSTEM",
                at: now.toISOString()
            }, mongoSession);
        }
        if (next != undefined && hunt.hostAccountId) {
            await repos.p2pHunts.incrementHostReliability(hunt.hostAccountId, { startsFailed: 1 }, now.toISOString(), undefined, mongoSession);
            await repos.p2pHunts.enqueueControlMessage({
                accountId: hunt.hostAccountId,
                messageType: "FENCE_NOW",
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                payload: { reason },
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString()
            }, mongoSession);
        }
        return next;
    });
    if (retried != undefined) await BeginHostSelection(hunt.sessionId);
}

async function MarkSuspect(hunt: P2PHuntSessionRecord, reason: string): Promise<void> {
    const now = new Date();
    await WithP2PTransaction(async (repos, mongoSession) => {
        const suspect = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            expectedStates: [hunt.state],
            expectedStateVersion: hunt.stateVersion,
            set: {
                state: "SUSPECT",
                preSuspectState: hunt.state,
                suspectSince: now.toISOString(),
                suspectDeadline: new Date(now.getTime() + ReadP2PHostEligibilityPolicy().suspectLifetimeMs).toISOString(),
                failureReason: reason
            }
        }, mongoSession);
        if (suspect != undefined) {
            await repos.p2pHunts.appendHuntTransition({
                sessionId: hunt.sessionId,
                generation: hunt.generation,
                fromState: hunt.state,
                toState: "SUSPECT",
                stateVersion: suspect.stateVersion,
                reason,
                actorType: "SYSTEM",
                at: now.toISOString()
            }, mongoSession);
        }
    });
}

/**
 * [2026-10-15] One lifecycle tick of a drained hunt (BeginDrainPartySession). A lease lapsed for longer than the suspect window
 * means its server has ended by itself, so the session ends without a fence (no server is left to fence); a shorter gap (a
 * network blip) is waited out as a running hunt's SUSPECT window would be, since the lease renews from DRAINING. Otherwise the drain
 * runs while its server does: it ends by the host's own report (RenewHostLease, AbortHunt, EndHunt), at an operator stop (fenced
 * now), or at its cap when one is set (drainDeadline; fenced). A drain with no cap has no deadline and holds while its lease renews.
 * A drained hunt is never marked SUSPECT or recovered.
 */
async function TickDrainingHunt(hunt: P2PHuntSessionRecord, now: number, emergencyStop: boolean): Promise<void> {
    const reason = hunt.completionReason ?? DRAIN_COMPLETION_REASON;
    const leaseLapsed = hunt.leaseExpiresAt == undefined ||
        Date.parse(hunt.leaseExpiresAt) + ReadP2PHostEligibilityPolicy().suspectLifetimeMs <= now;
    if (leaseLapsed && !emergencyStop) {
        await EndP2PHuntSession(hunt.sessionId, hunt.generation, reason, {
            allowedStates: ["DRAINING"], actorType: "SYSTEM", fence: false
        });
    } else if (emergencyStop || (hunt.drainDeadline != undefined && Date.parse(hunt.drainDeadline) <= now)) {
        await EndP2PHuntSession(hunt.sessionId, hunt.generation, reason, { allowedStates: ["DRAINING"], actorType: "SYSTEM" });
    }
}

export class P2PHuntLifecycleMonitor {
    private timer: NodeJS.Timeout | undefined;
    private running = false;

    start(): void {
        if (this.timer != undefined) return;
        this.timer = setInterval(() => { void this.tick(); }, 1000);
        this.timer.unref();
        void this.tick();
    }

    stop(): void {
        if (this.timer != undefined) clearInterval(this.timer);
        this.timer = undefined;
    }

    async tick(): Promise<void> {
        // Keep lifecycle cleanup active when P2P routing is disabled. New routes and
        // admissions are gated separately; this monitor owns already-recorded hunts.
        if (this.running) return;
        this.running = true;
        try {
            const hunts = await GetP2PRepositories().p2pHunts.listLifecycleHunts(P2P_LIFECYCLE_STATES, LIFECYCLE_SCAN_LIMIT);
            const now = Date.now();
            const emergencyStop = (await GetP2POperationsPolicy()).p2pEmergencyStop;
            for (const hunt of hunts) {
                // [2026-10-13 realms S1] A realm hub has its own lifecycle (realmHubLifecycle.ts TickRealmHub): none of the hunt
                // logic below - clean end, participant quorum, recovery - applies to it. A failure of one hub must not stop the
                // others or the hunts.
                if (IsRealmHub(hunt)) {
                    try {
                        await TickRealmHub(hunt, now, { emergencyStop });
                    } catch (error) {
                        logger.error(`[P2P Lifecycle] realm hub ${hunt.sessionId} tick failed: ${error}`);
                    }
                    continue;
                }
                // [2026-10-15] A drained hunt (BeginDrainPartySession) never goes SUSPECT and never recovers: its players are on their
                // way to another hunt. This branch comes before the operator-stop branch below, which would recover it.
                if (hunt.state === "DRAINING") {
                    await TickDrainingHunt(hunt, now, emergencyStop);
                    continue;
                }
                if (emergencyStop && !["ABORTING", "RECOVERING"].includes(hunt.state)) {
                    const beforeActive = IsPreActiveOperatorStopState(hunt.state);
                    await PrepareRecovery(hunt.sessionId, hunt.generation, "OPERATOR_P2P_STOP", beforeActive);
                    continue;
                }
                if (hunt.state === "HOST_SELECTING") {
                    // Resume persisted selections after restart. BeginHostSelection routes
                    // disabled policy through recovery before it can rank or offer a host.
                    await BeginHostSelection(hunt.sessionId);
                    continue;
                }
                if (hunt.state === "HOST_OFFERED" && hunt.offerExpiresAt != undefined && Date.parse(hunt.offerExpiresAt) <= now) {
                    await ExpireOffer(hunt);
                    continue;
                }
                if (hunt.state === "STARTING" && hunt.startupDeadline != undefined && Date.parse(hunt.startupDeadline) <= now) {
                    await RetryPreActiveHost(hunt, "HOST_STARTUP_TIMEOUT");
                    continue;
                }
                if (["HOST_READY", "ADMITTING", "RUNNING"].includes(hunt.state)) {
                    const leaseLapsed = hunt.leaseExpiresAt != undefined && Date.parse(hunt.leaseExpiresAt) <= now;
                    // [2026-10-11 B1] The host's lease ending after the hunt was completed or left is its clean exit.
                    const cleanEnd = leaseLapsed ? HostLossIsCleanEnd(hunt) : undefined;
                    if (cleanEnd != undefined) {
                        await EndP2PHuntSession(hunt.sessionId, hunt.generation, `${cleanEnd}_LEASE_RELEASED`, {
                            allowedStates: HOST_END_STATES, actorType: "SYSTEM"
                        });
                        continue;
                    }
                    const observedAfter = new Date(now - MAX_OBSERVATION_AGE_MS).toISOString();
                    const observations = await GetP2PRepositories().p2pHunts.listRecentParticipantObservations(hunt.sessionId, hunt.generation, observedAfter);
                    const failingObservers = new Set(observations.filter((entry) => !entry.hostReachable || !entry.localBridgeAlive).map((entry) => entry.accountId));
                    if (leaseLapsed || failingObservers.size >= Math.min(2, hunt.roster.length)) {
                        await MarkSuspect(hunt, failingObservers.size >= 2 ? "PARTICIPANT_FAILURE_QUORUM" : "HOST_LEASE_MISSED");
                    }
                    continue;
                }
                if (hunt.state === "SUSPECT") {
                    if (hunt.leaseExpiresAt != undefined && Date.parse(hunt.leaseExpiresAt) > now && hunt.preSuspectState != undefined) {
                        await GetP2PRepositories().p2pHunts.compareAndSetHunt({
                            sessionId: hunt.sessionId,
                            generation: hunt.generation,
                            expectedStates: ["SUSPECT"],
                            expectedStateVersion: hunt.stateVersion,
                            set: { state: hunt.preSuspectState, failureReason: "LEASE_RECOVERED" },
                            unset: ["suspectSince", "suspectDeadline", "preSuspectState"]
                        });
                    } else if (hunt.suspectDeadline != undefined && Date.parse(hunt.suspectDeadline) <= now) {
                        const cleanEnd = HostLossIsCleanEnd(hunt);
                        if (cleanEnd != undefined) {
                            await EndP2PHuntSession(hunt.sessionId, hunt.generation, `${cleanEnd}_LEASE_RELEASED`, {
                                allowedStates: HOST_END_STATES, actorType: "SYSTEM"
                            });
                        } else if (hunt.preSuspectState === "HOST_READY") await RetryPreActiveHost(hunt, "HOST_FAILED_BEFORE_RELEASE");
                        else await PrepareRecovery(hunt.sessionId, hunt.generation, hunt.failureReason ?? "HOST_FAILED", false);
                    }
                    continue;
                }
                if (hunt.state === "RECOVERING" && hunt.recoveryDeadline != undefined && Date.parse(hunt.recoveryDeadline) <= now) {
                    await FinalizeRecovery(hunt, "RECOVERY_WINDOW_EXPIRED");
                    continue;
                }
                if (hunt.state === "ABORTING" && (hunt.recoveryRetryAt == undefined || Date.parse(hunt.recoveryRetryAt) <= now)) {
                    await ResumeRecovery(hunt);
                }
            }
        } catch (error) {
            logger.error(`[P2P Lifecycle] monitor tick failed: ${error}`);
        } finally {
            this.running = false;
        }
    }
}

export const p2pHuntLifecycleMonitor = new P2PHuntLifecycleMonitor();
