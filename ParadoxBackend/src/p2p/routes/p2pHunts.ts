import express, { Request, Response, Router } from "express";
import { IssueSelfAdmissionTicket, ConsumeAdmissionTicket, MarkHostReady, RecordPeerDisconnected } from "../controllers/p2pAdmission";
import { HasLauncherAuth } from "../../middleware/HasLauncherAuth";
import { GetRequestId } from "../../observability/requestContext";
import { HostCapabilityAuthData, RequireHostCapability } from "../security/hostCapabilities";
import { LauncherApiError, SendLauncherError } from "../security/p2pErrors";
import { logger } from "../../logger";
import { RenewHostLease } from "../controllers/p2pHostLifecycle";
import { AbortHunt, EndHunt, GetHuntStatus, GetSelfHuntReward } from "../controllers/p2pHuntStatus";
import { GetAntiCheatExtension } from "../antiCheat";
import { IncrementMetric } from "../../observability/metrics";
import { CentralGuardRequestBudget, CentralGuardTrafficLimiter, GuardTrafficLimit, HUNT_GUARD_HOST_TRAFFIC_LIMIT, HUNT_GUARD_SESSION_TRAFFIC_LIMIT } from "../security/guardTraffic";
import { ConsumeDistributedGuardTrafficPair, IsDistributedGuardTrafficEnabled } from "../security/guardTrafficDistributed";

export const p2pHuntsRouter = Router();

interface P2PGuardTrafficDependencies {
    distributedEnabled: boolean;
    distributedConsume: (hostKey: string, sessionKey: string, bytes: number,
        hostLimit: GuardTrafficLimit, sessionLimit: GuardTrafficLimit) => Promise<boolean>;
    localConsume: (key: string, bytes: number, limit: GuardTrafficLimit) => boolean;
}

export async function EnforceP2PGuardTraffic(
    hostKey: string,
    sessionKey: string,
    bytes: number,
    dependencies: P2PGuardTrafficDependencies = {
        distributedEnabled: IsDistributedGuardTrafficEnabled(),
        distributedConsume: ConsumeDistributedGuardTrafficPair,
        localConsume: (key, size, limit) => CentralGuardTrafficLimiter.consume(key, size, limit)
    }
): Promise<void> {
    if (dependencies.distributedEnabled) {
        try {
            if (!await dependencies.distributedConsume(hostKey, sessionKey, bytes,
                HUNT_GUARD_HOST_TRAFFIC_LIMIT, HUNT_GUARD_SESSION_TRAFFIC_LIMIT)) {
                throw new LauncherApiError("GUARD_TRAFFIC_RATE_LIMITED", "Guard traffic exceeded the bounded host or hunt-session budget; retry shortly.");
            }
        } catch (error) {
            if (error instanceof LauncherApiError) throw error;
            throw new LauncherApiError("GUARD_TRAFFIC_UNAVAILABLE", "Guard traffic capacity is temporarily unavailable; retry shortly.");
        }
        return;
    }
    if (!dependencies.localConsume(hostKey, bytes, HUNT_GUARD_HOST_TRAFFIC_LIMIT) ||
        !dependencies.localConsume(sessionKey, bytes, HUNT_GUARD_SESSION_TRAFFIC_LIMIT)) {
        throw new LauncherApiError("GUARD_TRAFFIC_RATE_LIMITED", "Guard traffic exceeded the bounded host or hunt-session budget; retry shortly.");
    }
}

// Largest P2P request body: an evidence batch (at most 64 KiB of events) and its envelope.
const P2P_MAX_HTTP_BODY_BYTES = 72 * 1024;

// This router is mounted before the app-wide parser. Only P2P paths use the measured Guard
// ceiling; unrelated game APIs continue to reach the generic parser unchanged.
const ParseP2PJson = express.json({ limit: `${P2P_MAX_HTTP_BODY_BYTES}b`, strict: true });
p2pHuntsRouter.use((req, res, next) => {
    if (req.path.startsWith("/mystic/v1/hunts/") || req.path === "/internal/v1/hunt-guard/shadow-comparisons") {
        return ParseP2PJson(req, res, next);
    }
    next();
});

export type P2PHuntOperation = "event-batch" | "completion" | "shadow" | "lifecycle";

export function P2PHuntOperationOf(path: string): P2PHuntOperation {
    return path.includes("event-batches") ? "event-batch" :
        path.includes("completion") ? "completion" :
            path.includes("shadow-comparisons") ? "shadow" : "lifecycle";
}

/**
 * [2026-10-17] Whether a host-capability call counts against the Guard traffic windows (the host's and the hunt session's). Only Guard
 * traffic does. The lease and the other lifecycle calls (host-ready, admissions, peer disconnects, abort, end) used to share the windows
 * with the evidence, so a busy hunt's event batches used them up and its lease renewals got 429 too: 10 s later the hunt went SUSPECT and
 * was fenced under its players. The in-flight Guard request budget and the
 * app-wide request limit (security/rateLimit.ts, the host capability's own bucket) still bound them.
 */
export function CountsAgainstGuardTraffic(operation: P2PHuntOperation): boolean {
    return operation !== "lifecycle";
}

async function Handle(req: Request, res: Response, action: () => Promise<unknown>): Promise<void> {
    const operation = P2PHuntOperationOf(req.path);
    IncrementMetric("mysticparadox_p2p_requests_total", 1, { operation });
    try {
        const capability = (req as any).HostCapabilityAuthData as HostCapabilityAuthData | undefined;
        if (capability?.capability !== undefined) {
            const hostKey = `guard-host:${capability.capability.hostAccountId}`;
            const sessionKey = `guard-session:${capability.capability.sessionId}`;
            const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? null), "utf8");
            const releaseRequestBudget = CentralGuardRequestBudget.tryAcquire(bodyBytes);
            if (releaseRequestBudget === undefined) {
                throw new LauncherApiError("GUARD_REQUEST_BUDGET_EXHAUSTED", "Guard request capacity is currently exhausted; retry shortly.");
            }
            try {
                if (CountsAgainstGuardTraffic(operation)) await EnforceP2PGuardTraffic(hostKey, sessionKey, bodyBytes);
                res.status(200).json(await action());
            } finally {
                releaseRequestBudget();
            }
            return;
        }
        res.status(200).json(await action());
    } catch (error) {
        if (error instanceof LauncherApiError) {
            IncrementMetric("mysticparadox_p2p_errors_total", 1, { code: error.code });
            SendLauncherError(res, error);
            return;
        }
        IncrementMetric("mysticparadox_p2p_errors_total", 1, { code: "INTERNAL" });
        logger.error(`Unhandled P2P route error requestId=${GetRequestId() ?? "missing"}: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "The player-hosted hunt request failed."));
    }
}

p2pHuntsRouter.post("/mystic/v1/hunts/:sessionId/tickets/self", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => IssueSelfAdmissionTicket((req as any).LauncherAuthData.userId, String(req.params.sessionId)))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/host-ready",
    RequireHostCapability("HOST_READY"),
    (req, res) => Handle(req, res, () => MarkHostReady({
        sessionId: String(req.params.sessionId),
        lobbyId: req.body?.lobbyId,
        transport: req.body?.transport,
        virtualPort: req.body?.virtualPort,
        bridgeInstanceId: req.body?.bridgeInstanceId,
        capability: ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability
    }))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/event-batches",
    RequireHostCapability("EVENTS_WRITE"),
    (req, res) => Handle(req, res, () => GetAntiCheatExtension().hunts.submitEvidence(
        ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability, req.body))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/completion",
    RequireHostCapability("COMPLETE_REQUEST"),
    (req, res) => Handle(req, res, () => GetAntiCheatExtension().hunts.complete(
        ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability, req.body))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/abort",
    RequireHostCapability("ABORT"),
    (req, res) => Handle(req, res, () => AbortHunt(
        ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability, req.body))
);

// [2026-10-11 B1] The host's clean end of a Tier 0 hunt (p2pHuntStatus.ts EndHunt). Same capability scope as /abort:
// both end the generation; capabilities issued before this route already carry it.
p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/end",
    RequireHostCapability("ABORT"),
    (req, res) => Handle(req, res, () => EndHunt(
        ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability, req.body))
);

p2pHuntsRouter.get("/mystic/v1/hunts/:sessionId/status", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetHuntStatus((req as any).LauncherAuthData.userId, String(req.params.sessionId)))
);

p2pHuntsRouter.get("/mystic/v1/hunts/:sessionId/reward/self", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetSelfHuntReward((req as any).LauncherAuthData.userId, String(req.params.sessionId)))
);

p2pHuntsRouter.post("/internal/v1/hunt-guard/shadow-comparisons", (req, res) =>
    Handle(req, res, () => GetAntiCheatExtension().hunts.recordShadowComparison(req.header("x-hunt-guard-shadow-key"), req.body))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/lease",
    RequireHostCapability("LEASE_HEARTBEAT"),
    (req, res) => Handle(req, res, () => RenewHostLease(
        ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability,
        req.body
    ))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/tickets/consume",
    RequireHostCapability("PEER_ADMITTED"),
    (req, res) => Handle(req, res, () => ConsumeAdmissionTicket({
        sessionId: String(req.params.sessionId),
        ticket: req.body?.ticket,
        authenticatedSteamId: req.body?.authenticatedSteamId,
        bridgeInstanceId: req.body?.bridgeInstanceId,
        connectionHandle: req.body?.connectionHandle,
        requestId: GetRequestId() ?? "missing",
        capability: ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability
    }))
);

p2pHuntsRouter.post(
    "/mystic/v1/hunts/:sessionId/peers/:admissionId/disconnect",
    RequireHostCapability("PEER_ADMITTED"),
    (req, res) => Handle(req, res, () => RecordPeerDisconnected({
        admissionId: String(req.params.admissionId),
        capability: ((req as any).HostCapabilityAuthData as HostCapabilityAuthData).capability
    }))
);
