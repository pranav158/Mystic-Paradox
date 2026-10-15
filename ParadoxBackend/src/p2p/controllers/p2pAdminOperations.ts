import crypto from "node:crypto";
import { Request, Response } from "express";
import { VerifyOperationsStepUp } from "../../controllers/adminOperations";
import { IncrementMetric } from "../../observability/metrics";
import { GetMongoDb } from "../../persistence/mongo/client";
import { Collections } from "../../persistence/mongo/collections";
import { OperationsOverviewExtension } from "../../extensions/p2p";
import { EvidenceBatchSummary, GetAntiCheatExtension } from "../antiCheat";
import { GetP2PRepositories, LauncherAccountRecord, P2PHuntState, WithP2PTransaction } from "../persistence";
import { P2PCollections } from "../persistence/mongo/collections";
import {
    GetP2POperationsPolicy,
    IsCoopTransport,
    RewardRolloutState,
    RewardRolloutWeakeningCodes,
    SetCoopTransport,
    SetP2PEmergencyStop,
    SetRewardRollout
} from "../services/p2pOperationsPolicy";

const ACTIVE_STATES: P2PHuntState[] = ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING",
    "RUNNING", "DRAINING", "SUSPECT", "FENCED", "ABORTING", "RECOVERING"];

/** [2026-10-15] Monitor telemetry the Guard feed cannot supply; startedAt and activePlaytime are removed once filled. */
const MONITOR_TIMING_UNKNOWN_FIELDS = ["startedAt", "activePlaytime", "repeatedRespawnKills", "behemothIdentity"];

export interface MonitorHuntTiming {
    startedAt: string | null;
    activePlaytimeMs: number | null;
    unknownFields: string[];
}

/**
 * [2026-10-15] Hunt start and active playtime for one monitor session. startedAt is the earliest RUNNING transition
 * of this session and generation: a SUSPECT -> RUNNING return is a later one, and other generations are ignored.
 * activePlaytimeMs runs from that start to the hunt's terminalAt, or to nowMs while it is still live; it is null when
 * the hunt never ran or has no end yet. transitions may hold any transition rows; only RUNNING rows are read.
 */
export function MonitorHuntTiming(
    hunt: { sessionId: string; generation: number; state?: string | null; terminalAt?: string | null },
    transitions: ReadonlyArray<{ sessionId: string; generation: number; toState: string; at: string }>,
    nowMs: number = Date.now()
): MonitorHuntTiming {
    let startMs = Number.NaN;
    for (const row of transitions) {
        if (row.sessionId !== hunt.sessionId || row.generation !== hunt.generation || row.toState !== "RUNNING") continue;
        const atMs = Date.parse(row.at);
        if (Number.isFinite(atMs) && (!Number.isFinite(startMs) || atMs < startMs)) startMs = atMs;
    }
    const startedAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
    const endedMs = Date.parse(hunt.terminalAt ?? "");
    const live = (ACTIVE_STATES as string[]).includes(hunt.state ?? "");
    const endMs = Number.isFinite(endedMs) ? endedMs : live ? nowMs : Number.NaN;
    const activePlaytimeMs = startedAt == null || !Number.isFinite(endMs) ? null : Math.max(0, endMs - startMs);
    const unknownFields = MONITOR_TIMING_UNKNOWN_FIELDS.filter((field) =>
        !(field === "startedAt" && startedAt != null) && !(field === "activePlaytime" && activePlaytimeMs != null));
    return { startedAt, activePlaytimeMs, unknownFields };
}

/** The module's part of GET /admin/v1/operations/overview. */
export async function P2POperationsOverview(): Promise<OperationsOverviewExtension> {
    const db = await GetMongoDb();
    const antiCheat = GetAntiCheatExtension();
    const [activeHunts, recentFindings, rewardReceipts, policy, openAlerts, recentMonitorHunts] = await Promise.all([
        db.collection(P2PCollections.P2PHuntSessions).find({ state: { $in: ACTIVE_STATES } })
            .project({ _id: 1, sessionId: 1, generation: 1, state: 1, partyId: 1, huntDefinitionId: 1, mapPath: 1,
                hostAccountId: 1, roster: 1, createdAt: 1, leaseExpiresAt: 1,
                terminalAt: 1, guardLastSequence: 1, guardEventCount: 1,
                guardDisposition: 1, guardFindingCount: 1, trustTier: 1, rewardTableVersion: 1 })
            .sort({ createdAt: -1 }).limit(100).toArray(),
        antiCheat.operations.recentFindings(100),
        antiCheat.operations.recentReceipts(100),
        GetP2POperationsPolicy(),
        GetP2PRepositories().operationsAlerts.listOpen(100),
        db.collection(P2PCollections.P2PHuntSessions).find({ state: { $nin: ACTIVE_STATES } })
            .project({ _id: 1, sessionId: 1, generation: 1, state: 1, huntDefinitionId: 1, mapPath: 1,
                hostAccountId: 1, roster: 1, createdAt: 1, terminalAt: 1, guardLastSequence: 1,
                guardEventCount: 1 })
            .sort({ createdAt: -1 }).limit(100).toArray()
    ]);

    const monitorHunts = [...activeHunts, ...recentMonitorHunts].filter((hunt: any, index: number, rows: any[]) =>
        rows.findIndex((candidate) => String(candidate.sessionId ?? candidate._id) === String(hunt.sessionId ?? hunt._id)) === index
    ).slice(0, 100);
    const monitorSessionIds = monitorHunts.map((hunt: any) => String(hunt.sessionId ?? hunt._id));
    const sessionGenerationFilter = monitorHunts.map((hunt: any) => ({ sessionId: String(hunt.sessionId ?? hunt._id), generation: hunt.generation }));
    const [guardBatches, inventoryLedgers, runningStarts] = monitorSessionIds.length === 0
        ? [{ active: [], archived: [] }, [], []] as any
        : await Promise.all([
            antiCheat.operations.evidenceBatches(sessionGenerationFilter, 128),
            // Exact session/generation pairs prevent an older incarnation from consuming this
            // bounded recent-additions window if a session id is ever reused. Unwind on Mongo and
            // stop at 100 so large per-transaction item lists never cross the admin API boundary.
            db.collection(Collections.InventoryTransactions).aggregate([
                { $match: { $or: sessionGenerationFilter.map((pair) => ({
                    "p2pMonitor.sessionId": pair.sessionId, "p2pMonitor.generation": pair.generation
                })) } },
                { $sort: { "p2pMonitor.createdAt": -1 } },
                { $unwind: "$p2pMonitor.items" },
                { $limit: 100 },
                { $project: { _id: 0, transactionId: 1, userId: 1, characterId: 1,
                    sessionId: "$p2pMonitor.sessionId", generation: "$p2pMonitor.generation",
                    itemId: "$p2pMonitor.items.itemId", quantity: "$p2pMonitor.items.quantity",
                    createdAt: "$p2pMonitor.createdAt" } }
            ]).toArray(),
            // [2026-10-15] One row per session and generation: the earliest RUNNING transition, which is the hunt's
            // start (MonitorHuntTiming drops other generations). Uses the { sessionId, at, stateVersion } index.
            db.collection(P2PCollections.P2PHuntTransitions).aggregate([
                { $match: { sessionId: { $in: monitorSessionIds }, toState: "RUNNING" } },
                { $group: { _id: { sessionId: "$sessionId", generation: "$generation" }, startedAt: { $min: "$at" } } }
            ]).toArray()
        ]);
    // [2026-10-15] Shape the grouped rows as transition rows for MonitorHuntTiming (each is already the earliest).
    const runningTransitions = runningStarts.map((row: any) => ({ sessionId: String(row._id.sessionId),
        generation: row._id.generation, toState: "RUNNING", at: row.startedAt }));
    const activeGuardBatches: EvidenceBatchSummary[] = guardBatches.active;
    const archivedGuardBatches: EvidenceBatchSummary[] = guardBatches.archived;
    const batchesBySession = new Map<string, any[]>();
    const seenBatchIds = new Set<string>();
    for (const batch of [...activeGuardBatches, ...archivedGuardBatches]) {
        const id = String(batch._id);
        if (seenBatchIds.has(id)) continue;
        seenBatchIds.add(id);
        const key = `${batch.sessionId}:${batch.generation}`;
        const rows = batchesBySession.get(key) ?? [];
        rows.push(batch);
        batchesBySession.set(key, rows);
    }
    const batchSampled = activeGuardBatches.length >= 128 || archivedGuardBatches.length >= 128;
    const monitorSessions = monitorHunts.map((hunt: any) => {
        const sessionId = String(hunt.sessionId ?? hunt._id);
        const receivedBatches = batchesBySession.get(`${sessionId}:${hunt.generation}`) ?? [];
        const observedEventCount = receivedBatches.reduce((sum, batch) => sum + (Array.isArray(batch.events) ? batch.events.length : 0), 0);
        const lastTelemetryAt = receivedBatches.map((batch) => batch.receivedAt).filter((at) => typeof at === "string").sort().at(-1) ?? null;
        const defeats = new Map<string, number>();
        let identifiedDefeats = 0;
        for (const batch of receivedBatches) for (const event of Array.isArray(batch.events) ? batch.events : []) {
            if (event?.type !== "BEHEMOTH_DEFEATED") continue;
            // [2026-10-15] Runtime 0.2.139+ names the defeated Behemoth's class (payload.behemoth, host-reported, e.g.
            // lerawr_alpha_bp_C); older runtimes and the EndOfHuntStarted fallback send none. Never inferred from the map.
            const behemoth = typeof event?.payload?.behemoth === "string" && /^[A-Za-z0-9_]{1,96}$/.test(event.payload.behemoth)
                ? event.payload.behemoth as string : "unknown";
            if (behemoth !== "unknown") identifiedDefeats++;
            defeats.set(behemoth, (defeats.get(behemoth) ?? 0) + 1);
        }
        const createdMs = Date.parse(hunt.createdAt ?? "");
        const endedMs = Date.parse(hunt.terminalAt ?? "");
        const elapsedMs = Number.isFinite(createdMs) ? Math.max(0, (Number.isFinite(endedMs) ? endedMs : Date.now()) - createdMs) : null;
        const timing = MonitorHuntTiming({ sessionId, generation: hunt.generation, state: hunt.state, terminalAt: hunt.terminalAt ?? null },
            runningTransitions);
        const unknownFields = timing.unknownFields.filter((field) => field !== "behemothIdentity" || identifiedDefeats === 0);
        if (receivedBatches.length === 0) unknownFields.push("guardDefeatEvents");
        return {
            sessionId, generation: hunt.generation, huntDefinitionId: hunt.huntDefinitionId,
            mapPath: hunt.mapPath ?? null, state: hunt.state, hostUserId: hunt.hostAccountId,
            participantUserIds: Array.isArray(hunt.roster) ? hunt.roster.map((entry: any) => entry.accountId).filter((id: unknown) => typeof id === "string") : [],
            startedAt: timing.startedAt, activePlaytimeMs: timing.activePlaytimeMs, endedAt: hunt.terminalAt ?? null,
            sessionCreatedAt: hunt.createdAt ?? null,
            elapsedMs, elapsedBasis: "session-created", lastTelemetryAt,
            defeatsByBehemoth: [...defeats.entries()].map(([behemothId, count]) => ({ behemothId, count, source: "guard-reported", complete: false })),
            guardCoverage: { expectedEventCount: hunt.guardEventCount ?? null, observedEventCount,
                sampled: batchSampled || (Number.isSafeInteger(hunt.guardEventCount) && observedEventCount !== hunt.guardEventCount) },
            unknownFields, excludedFields: ["currencyAdditions", "removedItems", "savedItems"]
        };
    });
    const recentAdditions = inventoryLedgers.map((entry: any) => ({ ...entry, kind: "item" }));
    return {
        policy: { p2pEmergencyStop: policy.p2pEmergencyStop, rewardRollout: policy.rewardRollout,
            coopTransport: policy.coopTransport },
        sections: {
            activeHunts: activeHunts.map(({ _id, ...entry }) => ({ ...entry, sessionId: String(_id) })),
            recentFindings,
            rewardReceipts,
            antiCheatLoaded: antiCheat.loaded,
            p2pMonitor: { observedAt: new Date().toISOString(), sessions: monitorSessions, recentAdditions },
            openAlerts
        }
    };
}

export async function AcknowledgeOperationsAlert(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const alertId = typeof req.params.alertId === "string" ? req.params.alertId.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!/^[A-Za-z0-9-]{8,128}$/.test(alertId) || reason.length < 8) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION",
            message: "A valid alert ID and an audit reason of at least 8 characters are required." } });
        return;
    }
    const requestId = crypto.randomUUID();
    const acknowledgedAt = new Date().toISOString();
    const acknowledged = await WithP2PTransaction(async (repos, session) => {
        const changed = await repos.operationsAlerts.acknowledge(alertId, actor.userId, acknowledgedAt, session);
        if (!changed) return false;
        await repos.admin.appendAudit({
            id: crypto.randomUUID(), actorUserId: actor.userId,
            action: "operations.alert.acknowledge", oldState: { alertId, status: "OPEN" },
            newState: { alertId, status: "ACKNOWLEDGED", acknowledgedAt }, reason,
            ip: req.ip ?? "unknown", requestId, createdAt: acknowledgedAt
        }, session);
        return true;
    });
    if (!acknowledged) {
        res.status(404).json({ error: { code: "ADMIN_ALERT_NOT_OPEN",
            message: "The alert is missing or has already been acknowledged." } });
        return;
    }
    IncrementMetric("mysticparadox_operations_alerts_acknowledged_total", 1, { code: "OPERATIONS_ALERT" });
    res.json({ alertId, status: "ACKNOWLEDGED", acknowledgedAt, requestId });
}

/** Separate operator action: deliberately independent from launcher account approval/roles. */
export async function UpdateP2PEmergencyStop(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const enabled = req.body?.enabled;
    const expectedVersion = Number(req.body?.expectedVersion);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || reason.length < 8) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION",
            message: "A boolean enabled value, expectedVersion, and audit reason of at least 8 characters are required." } });
        return;
    }

    const requestId = crypto.randomUUID();
    const outcome = await WithP2PTransaction(async (repos, mongoSession) => {
        const before = await GetP2POperationsPolicy(mongoSession);
        if (before.version !== expectedVersion) return { kind: "CONFLICT" as const, before };
        if (!enabled && before.p2pEmergencyStop && !VerifyOperationsStepUp(actor.userId, req.body?.breakGlassTotp)) {
            const createdAt = new Date().toISOString();
            await repos.admin.appendAudit({
                id: crypto.randomUUID(), actorUserId: actor.userId,
                action: "operations.p2p_emergency_stop.clear_rejected",
                oldState: before, newState: { p2pEmergencyStop: false }, reason,
                ip: req.ip ?? "unknown", requestId, createdAt
            }, mongoSession);
            return { kind: "STEP_UP_REQUIRED" as const, before };
        }
        const after = await SetP2PEmergencyStop(enabled, actor.userId, expectedVersion, mongoSession);
        if (after == undefined) return { kind: "CONFLICT" as const, before };
        await repos.admin.appendAudit({
            id: crypto.randomUUID(), actorUserId: actor.userId,
            action: enabled ? "operations.p2p_emergency_stop.activate" : "operations.p2p_emergency_stop.clear",
            oldState: before, newState: after, reason,
            ip: req.ip ?? "unknown", requestId, createdAt: new Date().toISOString()
        }, mongoSession);
        return { kind: "UPDATED" as const, after };
    });
    if (outcome.kind === "CONFLICT") {
        res.status(409).json({ error: { code: "ADMIN_POLICY_CONFLICT",
            message: "The operations policy changed. Refresh it before trying again." }, policy: outcome.before });
        return;
    }
    if (outcome.kind === "STEP_UP_REQUIRED") {
        res.status(403).json({ error: { code: "ADMIN_POLICY_STEP_UP_REQUIRED",
            message: "A fresh operations authenticator code is required to clear the P2P emergency stop." },
            policy: outcome.before });
        return;
    }
    res.json({ policy: outcome.after, requestId });
}

/**
 * [2026-10-13] The co-op transport for player-hosted hunts: ICE (default) or the experimental Steam transport.
 * Audited like every policy change; hunts already running keep the transport they started with.
 */
export async function UpdateCoopTransport(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const coopTransport = req.body?.coopTransport;
    const expectedVersion = Number(req.body?.expectedVersion);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!IsCoopTransport(coopTransport) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || reason.length < 8) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION",
            message: "coopTransport (ICE or STEAM_EXPERIMENTAL), expectedVersion, and an audit reason of at least 8 characters are required." } });
        return;
    }
    const requestId = crypto.randomUUID();
    const outcome = await WithP2PTransaction(async (repos, mongoSession) => {
        const before = await GetP2POperationsPolicy(mongoSession);
        if (before.version !== expectedVersion) return { kind: "CONFLICT" as const, before };
        const after = await SetCoopTransport(coopTransport, actor.userId, expectedVersion, mongoSession);
        if (after == undefined) return { kind: "CONFLICT" as const, before };
        await repos.admin.appendAudit({
            id: crypto.randomUUID(), actorUserId: actor.userId, action: "operations.coop_transport.update",
            oldState: before, newState: after, reason,
            ip: req.ip ?? "unknown", requestId, createdAt: new Date().toISOString()
        }, mongoSession);
        return { kind: "UPDATED" as const, after };
    });
    if (outcome.kind === "CONFLICT") {
        res.status(409).json({ error: { code: "ADMIN_POLICY_CONFLICT",
            message: "The operations policy changed. Refresh it before trying again." }, policy: outcome.before });
        return;
    }
    res.json({ policy: outcome.after, requestId });
}

/** Central reward rollout; enabling Tier 1 grants is a safety reduction that needs operator step-up. */
export async function UpdateRewardRollout(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const raw = req.body?.rewardRollout;
    const rewardRollout: RewardRolloutState | undefined =
        raw != undefined && Number.isSafeInteger(raw.version) && raw.version >= 0 &&
        typeof raw.tier0ShadowEnabled === "boolean" && typeof raw.tier1GrantsEnabled === "boolean"
            ? { version: raw.version, tier0ShadowEnabled: raw.tier0ShadowEnabled, tier1GrantsEnabled: raw.tier1GrantsEnabled }
            : undefined;
    const expectedVersion = Number(req.body?.expectedVersion);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (rewardRollout == undefined || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || reason.length < 8) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION",
            message: "A complete reward rollout, expectedVersion, and audit reason of at least 8 characters are required." } });
        return;
    }
    const requestId = crypto.randomUUID();
    const outcome = await WithP2PTransaction(async (repos, mongoSession) => {
        const before = await GetP2POperationsPolicy(mongoSession);
        if (before.version !== expectedVersion) return { kind: "CONFLICT" as const, before };
        if (rewardRollout.version <= (before.rewardRollout?.version ?? 0)) {
            return { kind: "ROLLOUT_CONFLICT" as const, before };
        }
        const weakeningCodes = RewardRolloutWeakeningCodes(before, rewardRollout);
        if (weakeningCodes.length > 0 && !VerifyOperationsStepUp(actor.userId, req.body?.breakGlassTotp)) {
            await repos.admin.appendAudit({
                id: crypto.randomUUID(), actorUserId: actor.userId,
                action: "operations.policy.weakening_rejected", oldState: before,
                newState: { rewardRollout, weakeningCodes }, reason,
                ip: req.ip ?? "unknown", requestId, createdAt: new Date().toISOString()
            }, mongoSession);
            return { kind: "STEP_UP_REQUIRED" as const, before, weakeningCodes };
        }
        const after = await SetRewardRollout(rewardRollout, actor.userId, expectedVersion, mongoSession);
        if (after == undefined) return { kind: "CONFLICT" as const, before };
        await repos.admin.appendAudit({
            id: crypto.randomUUID(), actorUserId: actor.userId, action: "operations.reward_rollout.update",
            oldState: before, newState: { ...after, weakeningCodes }, reason,
            ip: req.ip ?? "unknown", requestId, createdAt: new Date().toISOString()
        }, mongoSession);
        return { kind: "UPDATED" as const, after };
    });
    if (outcome.kind === "CONFLICT") {
        res.status(409).json({ error: { code: "ADMIN_POLICY_CONFLICT",
            message: "The operations policy changed. Refresh it before trying again." }, policy: outcome.before });
        return;
    }
    if (outcome.kind === "ROLLOUT_CONFLICT") {
        res.status(409).json({ error: { code: "ADMIN_REWARD_ROLLOUT_CONFLICT",
            message: "The reward rollout version must advance beyond the current central version." }, policy: outcome.before });
        return;
    }
    if (outcome.kind === "STEP_UP_REQUIRED") {
        res.status(403).json({ error: { code: "ADMIN_POLICY_STEP_UP_REQUIRED",
            message: "A fresh operations authenticator code is required for this safety reduction." },
            policy: outcome.before, weakeningCodes: outcome.weakeningCodes });
        return;
    }
    res.json({ policy: outcome.after, requestId });
}
