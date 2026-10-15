import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { JwtPayload } from "jsonwebtoken";
import {
    GetP2PRepositories,
    P2PHostCapabilityRecord,
    P2PHostCapabilityScope,
    P2PHuntSessionRecord
} from "../persistence";
import { HubRuntimeRoster } from "./hubAuthorization";
import { LauncherApiError, SendLauncherError } from "./p2pErrors";

const OPAQUE_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

export interface HostCapabilityAuthData {
    capability: P2PHostCapabilityRecord;
}

export interface ActiveHostRuntimeContext {
    capability: P2PHostCapabilityRecord;
    hunt: P2PHuntSessionRecord;
    /**
     * [2026-10-13 realms S1] Realm hub sessions only: the accounts present (ADMITTED) in the hub, from HubPresenceCache. A hub
     * has no frozen roster, so this plus the host account is who its runtime may act for (section 7.1 of the hub design).
     */
    presence?: { presentAccountIds: string[] };
}

/**
 * [2026-10-13 realms S1] The accounts present in a realm hub, cached for a second per process: every request of the hub's
 * runtime resolves its context, and the presence rows change only a few times a minute. A write made by this process
 * invalidates the hub's entry (InvalidateHubPresence); another process's write is seen within the cache time (a kick is up to a
 * second stale per backend instance, section 11 item 14). A load that was in flight when the entry was invalidated is not stored.
 */
export class HubPresenceCache {
    private readonly entries = new Map<string, { at: number; value?: string[]; pending?: Promise<string[]> }>();
    private readonly epochs = new Map<string, number>();

    constructor(private readonly ttlMs = 1000, private readonly maxEntries = 512, private readonly clock: () => number = () => Date.now()) {}

    async listPresent(sessionId: string, generation: number, load: () => Promise<string[]>): Promise<string[]> {
        const key = `${sessionId}:${generation}`;
        const now = this.clock();
        const entry = this.entries.get(key);
        if (entry?.value != undefined && now - entry.at < this.ttlMs) return [...entry.value];
        if (entry?.pending != undefined) return [...await entry.pending];
        const epoch = this.epochs.get(sessionId) ?? 0;
        const pending: Promise<string[]> = load().then((value) => {
            if ((this.epochs.get(sessionId) ?? 0) === epoch) {
                if (this.entries.size >= this.maxEntries) {
                    const oldest = this.entries.keys().next().value;
                    if (oldest !== undefined) this.entries.delete(oldest);
                }
                this.entries.set(key, { at: this.clock(), value: [...value] });
            } else if (this.entries.get(key)?.pending === pending) {
                this.entries.delete(key);
            }
            return value;
        }, (error) => {
            if (this.entries.get(key)?.pending === pending) this.entries.delete(key);
            throw error;
        });
        this.entries.set(key, { at: now, pending });
        return [...await pending];
    }

    /** Forgets the hub's cached presence (every generation) and keeps an in-flight load from being stored. */
    invalidate(sessionId: string): void {
        this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
        if (this.epochs.size > 4096) this.epochs.clear();
        for (const key of [...this.entries.keys()]) if (key.startsWith(`${sessionId}:`)) this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
        this.epochs.clear();
    }
}

export const HubPresence = new HubPresenceCache();

/** Call after a write that changes who is ADMITTED in the hub (and again after the transaction that did). */
export function InvalidateHubPresence(sessionId: string): void {
    HubPresence.invalidate(sessionId);
}

/** The accounts present (ADMITTED) in the hub generation, through the cache. */
export async function ListHubPresentAccounts(sessionId: string, generation: number): Promise<string[]> {
    return HubPresence.listPresent(sessionId, generation, async () =>
        (await GetP2PRepositories().realmHub.listByState(sessionId, generation, ["ADMITTED"], 256)).map((row) => row.accountId));
}

/** What ResolveActiveHostRuntimeContext reads (replaceable in tests). */
export interface HostRuntimeContextDependencies {
    findCapability(digest: string): Promise<P2PHostCapabilityRecord | undefined>;
    findHunt(sessionId: string): Promise<P2PHuntSessionRecord | undefined>;
    listPresent(sessionId: string, generation: number): Promise<string[]>;
}

const DEFAULT_CONTEXT_DEPENDENCIES: HostRuntimeContextDependencies = {
    findCapability: (digest) => GetP2PRepositories().p2pHunts.findHostCapabilityByDigest(digest),
    findHunt: (sessionId) => GetP2PRepositories().p2pHunts.findHunt(sessionId),
    listPresent: ListHubPresentAccounts
};

// [2026-10-15] A drained hunt's server keeps serving the players still in it until it ends; its capability is not revoked
// (BeginDrainPartySession). No new admission needs this state: TICKETABLE_STATES (p2pAdmission.ts) still refuses it.
const HUNT_RUNTIME_STATES = ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "DRAINING"];
// A hub keeps serving through a missed lease (SUSPECT): its members are still connected, and the lifecycle monitor ends it
// after the suspect window if the host does not come back.
const HUB_RUNTIME_STATES = ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];

export interface PlayerHostRuntimeAuthData extends JwtPayload {
    userId: string;
    IsGameserver: false;
    IsPlayerHostRuntime: true;
    p2pSessionId: string;
    p2pGeneration: number;
    /**
     * [2026-10-11] The accounts of this generation's frozen roster: the only accounts this runtime may read
     * per-account state for or fetch a UDP key for (security/runtimeRoster.ts, plan 39_ §13.1 B5/B8).
     */
    RuntimeRosterAccountIds: string[];
}

export interface PlayerHostRuntimeIdentityHint {
    /** Account identity carried by an authoritative per-player route/body. */
    requestedUserId?: string;
}

export interface PlayerHostRuntimeRequestIdentityInput {
    params?: Record<string, unknown>;
    path?: unknown;
    body?: unknown;
}

export function ResolvePlayerHostRuntimeRequestIdentity(
    request: PlayerHostRuntimeRequestIdentityInput
): string | undefined {
    for (const key of ["userId", "accountId", "phxAccountId"]) {
        const value = request.params?.[key];
        if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }

    const path = typeof request.path === "string" ? request.path.toLowerCase() : "";
    if ((path === "/inventory" || path === "/inventory/instanceditem" || path === "/character") &&
        request.body != null && typeof request.body === "object" && !Array.isArray(request.body)) {
        const value = (request.body as Record<string, unknown>).accountId;
        if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
}

// This is intentionally separate from the global gameserver API key. A player-host
// capability is accepted only while its exact P2P session/generation is live. Requests
// without player context map to the host; signed per-player requests are restricted to
// admitted members of the frozen roster. It never sets IsGameserver.
// [2026-10-11] Correction: inventory grants are NOT central-server-only for a host. POST /inventory has
// one narrow exception (p2pInventoryAuthorization.ts): the native loot transaction of an admitted
// participant of the RUNNING hunt, bound to its frozen character, may grant items and Rams - minus
// the forbidden classes a host may never grant (hostGrantPolicy.ts: Platinum and premium currency,
// entitlements, cosmetics, Hunt Pass items) and nothing at all in a no-reward session (Training).
// Per-hunt caps and the risk meter come next (decision 1 of 39_ §13).
export async function ResolveActiveHostRuntimeContext(
    raw: unknown,
    dependencies: HostRuntimeContextDependencies = DEFAULT_CONTEXT_DEPENDENCIES,
    now = Date.now()
): Promise<ActiveHostRuntimeContext | undefined> {
    if (typeof raw !== "string" || !OPAQUE_CAPABILITY.test(raw)) return undefined;
    const capability = await dependencies.findCapability(HashHostCapabilitySecret(raw));
    if (capability == undefined || capability.revokedAt != undefined ||
        Date.parse(capability.expiresAt) <= now || !capability.scopes.includes("GAME_SERVER_RUNTIME")) {
        return undefined;
    }
    const hunt = await dependencies.findHunt(capability.sessionId);
    if (hunt == undefined || hunt.generation !== capability.generation ||
        hunt.hostAccountId !== capability.hostAccountId || hunt.hostSteamId !== capability.hostSteamId) {
        return undefined;
    }
    if (hunt.sessionKind === "REALM_HUB") {
        if (!HUB_RUNTIME_STATES.includes(hunt.state)) return undefined;
        return { capability, hunt, presence: { presentAccountIds: await dependencies.listPresent(hunt.sessionId, hunt.generation) } };
    }
    if (!HUNT_RUNTIME_STATES.includes(hunt.state)) return undefined;
    return { capability, hunt };
}

export async function ResolveActiveHostRuntimeCapability(raw: unknown): Promise<P2PHostCapabilityRecord | undefined> {
    return (await ResolveActiveHostRuntimeContext(raw))?.capability;
}

// The host process forwards the game client's Bearer token on per-player data
// requests. Accept that identity only after Steam admission has placed it in this
// exact generation's frozen roster. The host itself is allowed during startup,
// before its participant row necessarily reaches ADMITTED.
export function BuildPlayerHostRuntimeAuthData(
    context: ActiveHostRuntimeContext,
    payload?: JwtPayload,
    hint: PlayerHostRuntimeIdentityHint = {}
): PlayerHostRuntimeAuthData | undefined {
    if (payload != undefined && typeof payload.userId !== "string") return undefined;
    if (hint.requestedUserId != undefined && typeof hint.requestedUserId !== "string") return undefined;

    // A normal client-forwarded request carries a Bearer JWT and that signed identity
    // always wins. Some UE gameserver data-loader calls omit Authorization and identify
    // the player only through a route/body accountId. In that case bind the request to
    // that exact frozen-roster member instead of silently falling back to the host.
    const requestedUserId = hint.requestedUserId?.trim();
    const userId = payload?.userId ?? requestedUserId ?? context.capability.hostAccountId;
    // [2026-10-13 realms S1] A realm hub has no frozen roster: its runtime acts for the members present in the hub and the
    // host (security/hubAuthorization.ts). A present member is ADMITTED by definition.
    if (context.presence != undefined) {
        const hubRoster = HubRuntimeRoster(context.capability.hostAccountId, context.presence.presentAccountIds);
        if (!hubRoster.includes(userId)) return undefined;
        return {
            ...(payload ?? {}),
            userId,
            IsGameserver: false,
            IsPlayerHostRuntime: true,
            p2pSessionId: context.capability.sessionId,
            p2pGeneration: context.capability.generation,
            RuntimeRosterAccountIds: hubRoster
        };
    }
    const participant = context.hunt.roster.find((entry) => entry.accountId === userId);
    const rosterAccountIds = context.hunt.roster.map((entry) => entry.accountId);
    if (participant == undefined) {
        // [2026-10-14 realms S3, design section 4.8] A realm host that does not play its realm hunt is an identity-resolution
        // member only: its own identity (a request with no player context) resolves to it. Its writes stay refused, since it is
        // no roster member (HostWriteDenialReason NOT_A_MEMBER); no other account resolves without a roster row.
        if (context.hunt.hostParticipates !== false || userId !== context.capability.hostAccountId) return undefined;
    } else if (userId !== context.capability.hostAccountId && participant.admissionState !== "ADMITTED") {
        return undefined;
    }
    return {
        ...(payload ?? {}),
        userId,
        // Set reserved authority fields after the JWT payload so even a malformed
        // signed payload cannot promote a player-host process to central gameserver.
        IsGameserver: false,
        IsPlayerHostRuntime: true,
        p2pSessionId: context.capability.sessionId,
        p2pGeneration: context.capability.generation,
        RuntimeRosterAccountIds: participant == undefined ? [...rosterAccountIds, userId] : rosterAccountIds
    };
}

// [2026-10-11 P2P, plan 39_ §13.1 B4] Request-budget bucket of a host capability (security/rateLimit.ts). Hosts used
// to share the per-address client budget (600/min) with their own launcher and Guard traffic. Only a capability that
// exists, is unrevoked and unexpired gets its own bucket; anything else keeps the per-address bucket, so a made-up
// header value cannot mint fresh budgets. The lookup is cached briefly per digest (the bucket grants no authority:
// the routes still authenticate the capability themselves).
const RATE_LIMIT_BUCKET_CACHE_MS = 10_000;
const RATE_LIMIT_BUCKET_CACHE_MAX = 1024;
const RateLimitBucketCache = new Map<string, { bucket: string | undefined; at: number }>();

export async function ResolveHostRateLimitBucket(
    raw: unknown,
    find: (digest: string) => Promise<P2PHostCapabilityRecord | undefined> =
        (digest) => GetP2PRepositories().p2pHunts.findHostCapabilityByDigest(digest),
    now = Date.now()
): Promise<string | undefined> {
    if (typeof raw !== "string" || !OPAQUE_CAPABILITY.test(raw)) return undefined;
    const digest = HashHostCapabilitySecret(raw);
    const cached = RateLimitBucketCache.get(digest);
    if (cached != undefined && now - cached.at < RATE_LIMIT_BUCKET_CACHE_MS) return cached.bucket;
    let bucket: string | undefined;
    try {
        const capability = await find(digest);
        bucket = capability == undefined || capability.revokedAt != undefined || Date.parse(capability.expiresAt) <= now
            ? undefined
            : `host:${capability.capabilityId}`;
    } catch {
        bucket = undefined;
    }
    if (RateLimitBucketCache.size >= RATE_LIMIT_BUCKET_CACHE_MAX) {
        const oldest = RateLimitBucketCache.keys().next().value;
        if (oldest !== undefined) RateLimitBucketCache.delete(oldest);
    }
    RateLimitBucketCache.set(digest, { bucket, at: now });
    return bucket;
}

export function ResetHostRateLimitBucketCacheForTest(): void {
    RateLimitBucketCache.clear();
}

export function ParseOptionalHostRuntimeBearerToken(raw: unknown): string | undefined {
    if (raw == undefined) return undefined;
    if (typeof raw !== "string") throw new Error("malformed Authorization header");
    const match = /^bearer ([^\s]+)$/i.exec(raw);
    if (match == undefined) throw new Error("malformed Bearer authorization");
    return match[1];
}

export function GenerateHostCapabilitySecret(): { secret: string; digest: string } {
    const secret = crypto.randomBytes(32).toString("base64url");
    return { secret, digest: HashHostCapabilitySecret(secret) };
}

export function HashHostCapabilitySecret(secret: string): string {
    if (!OPAQUE_CAPABILITY.test(secret)) throw new Error("invalid host capability secret");
    return crypto.createHash("sha256").update(secret, "ascii").digest("hex");
}

export function RequireHostCapability(scope: P2PHostCapabilityScope) {
    return async function HostCapabilityMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const raw = req.headers["x-mystic-host-capability"];
            if (typeof raw !== "string" || !OPAQUE_CAPABILITY.test(raw)) {
                throw new LauncherApiError("P2P_CAPABILITY_INVALID", "A valid hunt host capability is required.");
            }
            const capability = await GetP2PRepositories().p2pHunts.findHostCapabilityByDigest(HashHostCapabilitySecret(raw));
            const sessionId = String(req.params.sessionId ?? "");
            if (capability == undefined || capability.revokedAt != undefined ||
                Date.parse(capability.expiresAt) <= Date.now() || capability.sessionId !== sessionId ||
                !capability.scopes.includes(scope)) {
                throw new LauncherApiError("P2P_CAPABILITY_INVALID", "The hunt host capability is invalid or expired.");
            }
            (req as any).HostCapabilityAuthData = { capability } satisfies HostCapabilityAuthData;
            next();
        } catch (error) {
            if (error instanceof LauncherApiError) {
                SendLauncherError(res, error);
                return;
            }
            SendLauncherError(res, new LauncherApiError("P2P_CAPABILITY_INVALID", "The hunt host capability could not be verified."));
        }
    };
}
