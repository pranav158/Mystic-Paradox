import { GetAntiCheatExtension } from "../antiCheat";
import { GetP2PRepositories, P2PHostCapabilityRecord } from "../persistence";
import { LauncherApiError } from "../security/p2pErrors";
import { IsRealmHub } from "../realm/realmHubRules";
import { EndP2PHuntSession, HOST_END_STATES, HostLossIsCleanEnd, PrepareRecovery } from "./p2pHostLifecycle";
import { EndRealmHub } from "./realmHubLifecycle";

/** The host reports an aborted hunt: start recovery of its generation. Nothing is credited. */
export async function AbortHunt(capability: P2PHostCapabilityRecord, body: any) {
    const reason = typeof body?.reason === "string" && body.reason.length <= 96 ? body.reason : "HOST_REPORTED_ABORT";
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(capability.sessionId);
    // [2026-10-13 realms S1] A realm hub has no recovery: its host reporting an abort ends it ABORTED, and the launcher starts a new one.
    if (IsRealmHub(hunt)) {
        const ended = await EndRealmHub(capability.sessionId, capability.generation, `HOST_ABORT_${reason}`.slice(0, 96), "ABORTED",
            { actorType: "HOST", actorAccountId: capability.hostAccountId });
        return { accepted: true, recoveryStarted: false, ended: ended != undefined, progressionApplied: false, rewardsApplied: false };
    }
    // [2026-10-15] A drained hunt's players are already on their way to another hunt: the abort ends the drain, without recovery.
    if (hunt?.state === "DRAINING") {
        const ended = await EndP2PHuntSession(capability.sessionId, capability.generation, `DRAIN_HOST_ABORT_${reason}`, {
            allowedStates: ["DRAINING"], actorType: "HOST", actorAccountId: capability.hostAccountId
        });
        return { accepted: true, recoveryStarted: false, ended: ended != undefined, progressionApplied: false, rewardsApplied: false };
    }
    await PrepareRecovery(capability.sessionId, capability.generation, `GUARD_ABORT_${reason}`, false);
    return { accepted: true, recoveryStarted: true, progressionApplied: false, rewardsApplied: false };
}

const END_REASON = /^[A-Z0-9_]{1,64}$/;

/**
 * [2026-10-11 P2P, plan 39_ §13.1 B1] POST /mystic/v1/hunts/:sessionId/end - the host's clean shutdown of a Tier 0
 * hunt (its server reaped after the hunt, or the host leaving after everyone else). When the Guard chain recorded the
 * hunt's completion or no participant is still in the hunt, the session ends cleanly: no rewards, no failure on the
 * host, no recovery of players already back in Ramsgate. While players are still in the hunt it is an abort (recovery
 * and a counted failure, as /abort). Tier 1 hunts end through their Guard completion. Nothing is credited either way.
 */
export async function EndHunt(capability: P2PHostCapabilityRecord, body: any) {
    const reason = typeof body?.reason === "string" && END_REASON.test(body.reason) ? body.reason : "HOST_CLEAN_SHUTDOWN";
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(capability.sessionId);
    if (hunt == undefined || hunt.generation !== capability.generation || hunt.hostAccountId !== capability.hostAccountId) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The hunt generation no longer belongs to this host.");
    }
    // [2026-10-13 realms S1] The host's clean shutdown of its hub: a clean end (COMPLETED), whoever is still in it is told to leave.
    if (IsRealmHub(hunt)) {
        const ended = await EndRealmHub(capability.sessionId, capability.generation, `HOST_END_${reason}`.slice(0, 96), "COMPLETED",
            { actorType: "HOST", actorAccountId: capability.hostAccountId });
        if (ended == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The hub generation no longer accepts a clean end.");
        return { accepted: true, cleanEnd: true, state: ended.record.state, recoveryStarted: false,
            progressionApplied: false, rewardsApplied: false };
    }
    // [2026-10-15] A drained hunt's host ends its server: the drain ends cleanly (its players left; nothing is recovered).
    if (hunt.state === "DRAINING") {
        const ended = await EndP2PHuntSession(capability.sessionId, capability.generation, `DRAIN_HOST_END_${reason}`, {
            allowedStates: ["DRAINING"], actorType: "HOST", actorAccountId: capability.hostAccountId
        });
        if (ended == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The hunt generation no longer accepts a clean end.");
        return { accepted: true, cleanEnd: true, state: ended.record.state, recoveryStarted: false,
            progressionApplied: false, rewardsApplied: false };
    }
    if ((hunt.trustTier ?? 0) !== 0) {
        throw new LauncherApiError("P2P_CONFLICT", "A Tier 1 hunt ends through its Guard completion.");
    }
    const cleanEnd = HostLossIsCleanEnd(hunt);
    if (cleanEnd == undefined) {
        await PrepareRecovery(capability.sessionId, capability.generation, `HOST_END_${reason}`, false);
        return { accepted: true, cleanEnd: false, recoveryStarted: true, progressionApplied: false, rewardsApplied: false };
    }
    const ended = await EndP2PHuntSession(capability.sessionId, capability.generation, `${cleanEnd}_HOST_END_${reason}`, {
        allowedStates: HOST_END_STATES, actorType: "HOST", actorAccountId: capability.hostAccountId
    });
    if (ended == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The hunt generation no longer accepts a clean end.");
    return { accepted: true, cleanEnd: true, state: ended.record.state, recoveryStarted: false,
        progressionApplied: false, rewardsApplied: false };
}

/** Lifecycle and evidence state of a hunt for one of its participants, with the anti-cheat verdict if any. */
export async function GetHuntStatus(accountId: string, sessionId: string) {
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    // [2026-10-13 realms S1] A hub's status for its host and for members with an entry: the state, no evidence and no rewards.
    if (IsRealmHub(hunt)) {
        const known = hunt!.hostAccountId === accountId ||
            await GetP2PRepositories().realmHub.findPresence(sessionId, accountId) != undefined;
        if (!known) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hub session not found.");
        return { schema: 1, sessionId, generation: hunt!.generation, state: hunt!.state, sessionKind: hunt!.sessionKind,
            hubKind: hunt!.hubKind, trustTier: 0, observeOnly: true, evidenceCollected: false,
            progressionApplied: false, rewardsApplied: false };
    }
    if (!hunt || !hunt.roster.some((entry) => entry.accountId === accountId)) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt Guard session not found.");
    const antiCheat = GetAntiCheatExtension();
    const result = await antiCheat.hunts.result(sessionId, hunt.generation);
    return { schema: 1, sessionId, generation: hunt.generation, state: hunt.state,
        encounterState: hunt.guardEncounterState, lastSequence: hunt.guardLastSequence, headHash: hunt.guardHeadHash,
        disposition: hunt.guardDisposition, findingCount: hunt.guardFindingCount ?? 0,
        evidence: { batchCount: hunt.guardBatchCount ?? 0, eventCount: hunt.guardEventCount ?? 0,
            eventBytes: hunt.guardEventBytes ?? 0, lastReceivedAt: hunt.guardLastReceivedAt,
            nativeHuntSuccessful: hunt.guardNativeHuntSuccessful,
            nativeHuntOutcomeSource: hunt.guardNativeHuntOutcomeSource }, result,
        evidenceCollected: antiCheat.loaded,
        trustTier: hunt.trustTier ?? 0, observeOnly: (hunt.trustTier ?? 0) === 0,
        progressionApplied: result?.progressionApplied ?? false, rewardsApplied: result?.rewardsApplied ?? false };
}

/** The caller's central reward receipt of a hunt. */
export async function GetSelfHuntReward(accountId: string, sessionId: string) {
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    if (!hunt || !hunt.roster.some((entry) => entry.accountId === accountId)) {
        throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt reward receipt not found.");
    }
    const antiCheat = GetAntiCheatExtension();
    if (!antiCheat.loaded) throw new LauncherApiError("HUNT_REWARDS_UNAVAILABLE", "This server grants no player-hosted hunt rewards.");
    const receipt = await antiCheat.hunts.rewardReceipt(sessionId, hunt.generation, accountId);
    if (receipt == undefined) throw new LauncherApiError("GUARD_COMPLETION_PENDING", "The central receipt is not available yet.");
    return { schema: 1, receipt };
}
