import { Request } from "express";
import type { ExtensionHttpResponse, HostWriteAuthorizeOptions, HostWriteKind, HostWriteRecordInput } from "../../extensions/p2p";
import { logger } from "../../logger";
import { GetMongoDb } from "../../persistence/mongo/client";
import { GetP2PRepositories, P2PHuntSessionRecord } from "../persistence";
import { P2PCollections } from "../persistence/mongo/collections";
import { ListHubPresentAccounts, PlayerHostRuntimeAuthData } from "./hostCapabilities";
import { HostPolicyRefuses, NoteHostPolicyWouldRefuse } from "./hostPolicyMode";
import { HubPresenceView, HubWriteDenialReason, HuntAllowsWriteKind, IsRealmHubSession } from "./hubAuthorization";

/*
 * [2026-10-13 realms S3] Writes a hosting runtime makes for its players besides inventory (XP, mastery, objectives,
 * escalation, cooldowns, bounty, Slayer's Path). In a Paradox-account realm a host does what a dedicated server does and
 * the grant is instant (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md §4): this only checks that the write belongs to a
 * running hunt of that host and to one of its members, then tags it (§4.3) so behaviour analysis can find a cheating
 * host later and its sessions can be reversed. What each write may change is the route's own rule.
 *
 * [2026-10-14 realms S4] The same checks for a realm hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md §7.2): the hub
 * session is RUNNING, the write kind belongs to this kind of hub (the realm's Ramsgate: bounty, cooldown, Slayer's Path,
 * escalation, objectives, mastery, reforge, rank confirm; XP never; a Training hub nothing), and the target is present in it
 * (ADMITTED; the host counts). The tag carries the realm and the hub kind besides the session.
 */

/** Kill switch: P2P_HOST_WRITES=off refuses every host write of these kinds (inventory has its own path). */
export function HostWritesEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return !/^(0|false|off|no)$/i.test(environment.P2P_HOST_WRITES?.trim() ?? "");
}

// [2026-10-15] A drained hunt still serves its players until its server ends, so their saves keep working (BeginDrainPartySession).
const RUNNING_STATES = new Set(["RUNNING", "DRAINING"]);

/**
 * [2026-10-16] The write-kind reasons: the host policy's (hostPolicyMode.ts), which observe mode only logs. Every other reason is about
 * who may write and always refuses.
 */
export const HOST_WRITE_KIND_POLICY_REASONS: ReadonlySet<string> = new Set(["WRITE_KIND_NOT_ALLOWED_IN_HUB", "WRITE_KIND_NOT_ALLOWED"]);

/**
 * Why a host write of `kind` for `targetUserId` is refused, or undefined when it may proceed. `presence` is the hub's
 * present accounts and is read only for a hub session (without it, only the host is present). A call without `kind` checks
 * a hunt as before and refuses a hub, which allows only named kinds. [2026-10-16] `checkKind: false` leaves the write kind out and
 * checks only who may write (observe mode, after a write-kind refusal).
 */
export function HostWriteDenialReason(
    auth: Partial<PlayerHostRuntimeAuthData> | undefined,
    hunt: P2PHuntSessionRecord | undefined,
    targetUserId: string,
    kind?: HostWriteKind,
    presence?: HubPresenceView,
    options: { checkKind?: boolean } = {}
): string | undefined {
    const CheckKind = options.checkKind !== false;
    if (auth?.IsPlayerHostRuntime !== true || auth.IsGameserver !== false ||
        typeof auth.p2pSessionId !== "string" || !Number.isSafeInteger(auth.p2pGeneration)) return "PLAYER_HOST_AUTH_REQUIRED";
    if (hunt == undefined || hunt.sessionId !== auth.p2pSessionId || hunt.generation !== auth.p2pGeneration) return "HUNT_NOT_FOUND";
    const running = RUNNING_STATES.has(hunt.state) || (hunt.state === "SUSPECT" && hunt.preSuspectState === "RUNNING");
    if (!running) return "HUNT_NOT_RUNNING";
    if (IsRealmHubSession(hunt)) return HubWriteDenialReason(hunt, kind, targetUserId, presence, CheckKind);
    if (CheckKind && !HuntAllowsWriteKind(kind)) return "WRITE_KIND_NOT_ALLOWED";
    const participant = hunt.roster.find((entry) => entry.accountId === targetUserId);
    if (participant == undefined) return "NOT_A_MEMBER";
    if (targetUserId !== hunt.hostAccountId && participant.admissionState !== "ADMITTED") return "MEMBER_NOT_ADMITTED";
    return undefined;
}

export interface HostWriteContext {
    hostAccountId: string;
    sessionId: string;
    generation: number;
    /** Set for a realm session (a hub, later a realm hunt); absent on an official hunt. */
    realmId?: string;
    sessionKind?: string;
    hubKind?: string;
}

const CONTEXT_KEY = "P2PHostWriteContext";

/** The trusted tags of the session an accepted write belongs to; realm fields only when the session has them. */
function ContextOf(hunt: P2PHuntSessionRecord): HostWriteContext {
    return {
        hostAccountId: hunt.hostAccountId ?? "",
        sessionId: hunt.sessionId,
        generation: hunt.generation,
        ...(typeof hunt.realmId === "string" ? { realmId: hunt.realmId } : {}),
        ...(typeof hunt.sessionKind === "string" ? { sessionKind: hunt.sessionKind } : {}),
        ...(typeof hunt.hubKind === "string" ? { hubKind: hunt.hubKind } : {})
    };
}

export async function AuthorizeHostWrite(req: Request, kind: HostWriteKind, targetUserId: string,
    options: HostWriteAuthorizeOptions = {}): Promise<ExtensionHttpResponse | undefined> {
    const auth = (req as any).AuthData as Partial<PlayerHostRuntimeAuthData> | undefined;
    const quiet = options.probe === true || options.parity === true;
    if (!HostWritesEnabled()) {
        if (!quiet) logger.warn(`[HostWrite] refused kind=${kind} target=${targetUserId} reason=HOST_WRITES_OFF`);
        return { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "Host writes are switched off.", payload: null } };
    }
    // [2026-10-17] Dedicated parity (extensions/p2p.ts HostWriteAuthorizeOptions.parity): observe mode only, never in enforce.
    if (options.parity === true && HostPolicyRefuses()) {
        return { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not do a dedicated server's work here.", payload: null } };
    }
    const hunt = typeof auth?.p2pSessionId === "string" ? await GetP2PRepositories().p2pHunts.findHunt(auth.p2pSessionId) : undefined;
    // A hub has no frozen roster: who is present comes from its presence rows (cached for a second, as the runtime's own
    // identity check read them).
    const presence = hunt != undefined && IsRealmHubSession(hunt) && hunt.sessionId === auth?.p2pSessionId
        ? { presentAccountIds: await ListHubPresentAccounts(hunt.sessionId, hunt.generation) }
        : undefined;
    if (options.parity === true) {
        // Who may write, as for every host write; the write kind is not part of a dedicated server's own work for its player.
        if (HostWriteDenialReason(auth, hunt, targetUserId, kind, presence, { checkKind: false }) !== undefined) {
            return { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };
        }
        (req as any)[CONTEXT_KEY] = ContextOf(hunt!);
        return undefined;
    }
    let denial = HostWriteDenialReason(auth, hunt, targetUserId, kind, presence);
    const hubTag = hunt?.hubKind != undefined ? ` hub=${hunt.hubKind}` : "";
    // [2026-10-16] Observe mode (hostPolicyMode.ts): a write kind this session does not take is logged, not refused, once the
    // write passes every check of who may write. A probe (the XP route trying its kinds) is never let through this way.
    if (denial !== undefined && HOST_WRITE_KIND_POLICY_REASONS.has(denial) && options.probe !== true && !HostPolicyRefuses()) {
        const identity = HostWriteDenialReason(auth, hunt, targetUserId, kind, presence, { checkKind: false });
        if (identity === undefined) {
            NoteHostPolicyWouldRefuse(`write kind=${kind}`, `target=${targetUserId} session=${auth?.p2pSessionId ?? "-"} reason=${denial}${hubTag}`);
            (req as any)[CONTEXT_KEY] = ContextOf(hunt!);
            return undefined;
        }
        denial = identity;
    }
    if (denial != undefined) {
        if (options.probe !== true) {
            logger.warn(`[HostWrite] refused kind=${kind} target=${targetUserId} session=${auth?.p2pSessionId ?? "-"} reason=${denial}${hubTag}`);
        }
        return { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };
    }
    (req as any)[CONTEXT_KEY] = ContextOf(hunt!);
    return undefined;
}

/** One stored `p2pHostWrites` row. Realm fields exist only for realm sessions, so an official hunt's row keeps its shape. */
export interface HostWriteRow {
    kind: HostWriteKind;
    targetUserId: string;
    hostAccountId: string;
    sessionId: string;
    generation: number;
    realmId?: string;
    sessionKind?: string;
    hubKind?: string;
    summary: Record<string, unknown>;
    /** ISO-8601 UTC time of the write (the field the collection's indexes sort on). */
    at: string;
}

/** The row an accepted write is stored as (pure). */
export function BuildHostWriteRow(context: HostWriteContext, write: HostWriteRecordInput, at: string): HostWriteRow {
    return {
        kind: write.kind,
        targetUserId: write.targetUserId,
        hostAccountId: context.hostAccountId,
        sessionId: context.sessionId,
        generation: context.generation,
        ...(context.realmId !== undefined ? { realmId: context.realmId } : {}),
        ...(context.sessionKind !== undefined ? { sessionKind: context.sessionKind } : {}),
        ...(context.hubKind !== undefined ? { hubKind: context.hubKind } : {}),
        summary: write.summary,
        at
    };
}

export type HostWriteSink = (row: HostWriteRow) => Promise<void>;

const MongoHostWriteSink: HostWriteSink = async (row) => {
    const db = await GetMongoDb();
    await db.collection(P2PCollections.P2PHostWrites).insertOne({ ...row });
};

let Sink: HostWriteSink = MongoHostWriteSink;

/** Tests: store the rows somewhere else (undefined restores MongoDB). */
export function UseHostWriteSinkForTest(sink: HostWriteSink | undefined): void {
    Sink = sink ?? MongoHostWriteSink;
}

export async function RecordHostWrite(req: Request, write: HostWriteRecordInput): Promise<void> {
    const context = (req as any)[CONTEXT_KEY] as HostWriteContext | undefined;
    if (context == undefined) {
        logger.warn(`[HostWrite] record without authorize kind=${write.kind} target=${write.targetUserId}`);
        return;
    }
    const at = new Date().toISOString();
    logger.info(`[HostWrite] kind=${write.kind} target=${write.targetUserId} host=${context.hostAccountId} ` +
        `session=${context.sessionId} generation=${context.generation}` +
        (context.realmId !== undefined ? ` realm=${context.realmId}` : "") +
        (context.hubKind !== undefined ? ` hub=${context.hubKind}` : "") +
        ` summary=${JSON.stringify(write.summary).slice(0, 400)}`);
    try {
        await Sink(BuildHostWriteRow(context, write, at));
    } catch (error) {
        logger.error(`[HostWrite] tag not stored kind=${write.kind} target=${write.targetUserId} session=${context.sessionId}: ${error}`);
    }
}
