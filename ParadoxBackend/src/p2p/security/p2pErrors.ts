// Launcher API error codes of the player-hosted hunt module. Every module file that throws or sends
// these imports LauncherApiError from here, so the statuses are registered before first use.
import { Response } from "express";
import { LauncherApiError, RegisterLauncherErrorStatuses, SendLauncherError } from "../../security/launcherErrors";
// [2026-10-13 realms S1] The realm hub code throws the realms module's REALM_* codes (REALM_NOT_FOUND, REALM_BANNED,
// REALM_NOT_MEMBER, REALM_FULL ...); importing its error file registers their statuses even when the module's routes are
// not mounted (p2p depends on realms, never the other way round).
import "../../realms/realmErrors";

export { LauncherApiError, SendLauncherError } from "../../security/launcherErrors";

/** A launcher error whose response also carries machine-readable fields (for example `reason`) next to code and message. */
export class DetailedLauncherApiError extends LauncherApiError {
    constructor(code: ConstructorParameters<typeof LauncherApiError>[0], message: string, readonly details: Record<string, string | number | boolean>) {
        super(code, message);
        this.name = "DetailedLauncherApiError";
    }
}

/** SendLauncherError, with the details of a DetailedLauncherApiError merged into the error object of the body. */
export function SendDetailedLauncherError(res: Response, error: LauncherApiError): void {
    if (!(error instanceof DetailedLauncherApiError)) {
        SendLauncherError(res, error);
        return;
    }
    const send = res.json.bind(res);
    res.json = ((body: any) => send({ error: { ...body?.error, ...error.details } })) as typeof res.json;
    SendLauncherError(res, error);
}

const P2P_ERROR_STATUSES = {
    P2P_DISABLED: 503,
    P2P_EMERGENCY_STOP: 503,
    P2P_SESSION_NOT_FOUND: 404,
    P2P_SESSION_NOT_READY: 409,
    P2P_NOT_ROSTERED: 403,
    P2P_STEAM_LINK_REQUIRED: 409,
    P2P_TICKET_INVALID: 400,
    P2P_TICKET_EXPIRED: 410,
    P2P_TICKET_REPLAYED: 409,
    P2P_CAPABILITY_INVALID: 401,
    P2P_GENERATION_FENCED: 409,
    P2P_CONFLICT: 409,
    // [2026-10-13] ICE co-op transport (controllers/p2pIce.ts).
    P2P_TRANSPORT_MISMATCH: 409,
    P2P_ICE_UNAVAILABLE: 503,
    P2P_RELAY_RATE_LIMITED: 429,
    P2P_SIGNAL_INVALID: 400,
    P2P_SIGNAL_LIMIT: 429,
    // [2026-10-13 realms S1] A realm host's hub (controllers/realmHubLifecycle.ts). REALM_NOT_FOUND, REALM_BANNED,
    // REALM_NOT_MEMBER, REALM_FULL and REALM_VALIDATION_FAILED are the realms module's own codes.
    REALM_HUB_EXISTS: 409,
    REALM_HOST_INELIGIBLE: 409,
    REALM_TRANSPORT_UNSUPPORTED: 409,
    // [2026-10-14 realms S2] The refusals of a realm member's request (controllers/p2pRealmRouting.ts). Thrown inside the routing
    // and answered as the candidate's cancel reason; REALM_HUB_START_TIMEOUT is only ever a cancel reason (a candidate status).
    REALM_HOST_OFFLINE: 409,
    REALM_HUB_FULL: 409,
    REALM_HUNT_RUNTIME_INCOMPATIBLE: 409,
    REALM_UNAVAILABLE: 503,
    // [2026-10-14] A host already runs a game server on every port of its range (controllers/p2pLauncher.ts PickHostServerUdpPort).
    P2P_HOST_PORTS_EXHAUSTED: 409,
    GUARD_REQUIRED: 403,
    GUARD_BATCH_INVALID: 400,
    GUARD_BATCH_TOO_LARGE: 413,
    GUARD_BATCH_REPLAY: 409,
    GUARD_EVIDENCE_LIMIT: 409,
    GUARD_TRAFFIC_RATE_LIMITED: 429,
    GUARD_REQUEST_BUDGET_EXHAUSTED: 503,
    GUARD_TRAFFIC_UNAVAILABLE: 503,
    GUARD_FINALIZATION_BUSY: 503,
    GUARD_CHAIN_CONFLICT: 409,
    GUARD_CHAIN_FROZEN: 409,
    GUARD_COMPLETION_INVALID: 409,
    GUARD_COMPLETION_CONFLICT: 409,
    GUARD_COMPLETION_PENDING: 409,
    GUARD_SHADOW_INVALID: 403,
    REWARD_CAPACITY_RECONCILIATION_REQUIRED: 503,
    // Without the anti-cheat module (antiCheat.ts) no evidence is collected and no reward is granted.
    HUNT_EVIDENCE_NOT_COLLECTED: 404,
    HUNT_REWARDS_UNAVAILABLE: 404
} as const;

type P2PErrorStatuses = typeof P2P_ERROR_STATUSES;

declare module "../../security/launcherErrors" {
    interface ExtensionLauncherErrorCodes extends P2PErrorStatuses {}
}

RegisterLauncherErrorStatuses(P2P_ERROR_STATUSES);
