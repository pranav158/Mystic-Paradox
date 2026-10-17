import { Request } from "express";
import type { ClientSession } from "mongodb";
import { ComputeInventoryRequestHash, INVALID_STARTER_CATALOG_IDS, InventoryLedgerAnnotator } from "../../controllers/inventory";
import { ExtensionHttpResponse, ExtensionInventoryTransaction, InventoryTransactionContext } from "../../extensions/p2p";
import { logger } from "../../logger";
import { GetP2PRepositories, P2PHuntSessionRecord } from "../persistence";
import { FenceP2PEmergencyStop } from "../services/p2pOperationsPolicy";
import { ListHubPresentAccounts, PlayerHostRuntimeAuthData } from "./hostCapabilities";
import { HubPresenceView, IsRealmHubSession } from "./hubAuthorization";
import { P2PInventoryTransactionDenialReason } from "./p2pInventoryTransactions";
import { BodyAddsHostDraftPremium, HOST_DRAFT_PREMIUM_BALANCE_CAP, HOST_DRAFT_PREMIUM_ID, HostGrantDenial } from "./hostGrantPolicy";
import { DecideHostDraftPremium, HostDraftPremiumDecision, ReadHostDraftPremiumInputs } from "./hostDraftPremium";
import { HostPolicyRefuses, NoteHostPolicyWouldRefuse } from "./hostPolicyMode";
import { GetRepositories } from "../../persistence";
import { UtcDay } from "../../bountyState";

const LOOT_DENIED = "Player-hosted hunt loot grant is not authorized.";
const HOST_GRANT_DENIED = "A player host may not grant this item class.";

/** Item additions recorded on the ledger row for the operations monitor (currency and starter sentinels excluded). */
export function BuildP2PMonitorItems(instancedItems: any[], acceptedStackedAdds: any[]): Array<{ itemId: string; quantity: number }> {
    const quantities = new Map<string, number>();
    for (const item of instancedItems ?? []) {
        const itemId = item?.catalogId;
        if (typeof itemId === "string" && itemId.length > 0 && !itemId.startsWith("CURRENCY_") &&
            !INVALID_STARTER_CATALOG_IDS.has(itemId)) {
            quantities.set(itemId, (quantities.get(itemId) ?? 0) + 1);
        }
    }
    for (const item of acceptedStackedAdds ?? []) {
        const itemId = item?.catalogId;
        const quantity = item?.quantity;
        if (typeof itemId !== "string" || itemId.length === 0 || itemId.startsWith("CURRENCY_") ||
            INVALID_STARTER_CATALOG_IDS.has(itemId) || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
        quantities.set(itemId, (quantities.get(itemId) ?? 0) + quantity);
    }
    return [...quantities.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/** The trusted realm tags of a session, stored on the ledger row next to its id (only the ones the session has). */
export interface P2PMonitorTags {
    realmId?: string;
    hubKind?: string;
}

/**
 * Ledger annotator: the trusted hunt session/generation plus the accepted item additions. [2026-10-14 realms S4] A realm
 * session also tags its realm and, for a hub, the hub kind (plan section 4.3); a hunt without them keeps its shape.
 */
export function P2PMonitorAnnotator(sessionId: string, generation: number, tags: P2PMonitorTags = {}): InventoryLedgerAnnotator {
    return ({ createdInstancedItems, acceptedStackedAdds }) => {
        const items = BuildP2PMonitorItems(createdInstancedItems, acceptedStackedAdds);
        return items.length === 0 ? undefined : { p2pMonitor: {
            sessionId, generation,
            ...(typeof tags.realmId === "string" ? { realmId: tags.realmId } : {}),
            ...(typeof tags.hubKind === "string" ? { hubKind: tags.hubKind } : {}),
            createdAt: new Date().toISOString(), items
        } };
    };
}

/** The accounts present in a hub through the cache; undefined for a hunt (its roster is on the record). */
async function HubPresenceForCheck(hunt: P2PHuntSessionRecord | undefined): Promise<HubPresenceView | undefined> {
    if (hunt == undefined || !IsRealmHubSession(hunt)) return undefined;
    return { presentAccountIds: await ListHubPresentAccounts(hunt.sessionId, hunt.generation) };
}

/**
 * The same view read inside the inventory transaction (the member's own row, no cache): a member removed or lost between the
 * first check and the commit is seen. The host is always allowed by the rule itself.
 */
async function HubPresenceInTransaction(hunt: P2PHuntSessionRecord | undefined, accountId: string, session: ClientSession): Promise<HubPresenceView | undefined> {
    if (hunt == undefined || !IsRealmHubSession(hunt)) return undefined;
    const row = await GetP2PRepositories().realmHub.findPresence(hunt.sessionId, accountId, session);
    return { presentAccountIds: row != undefined && row.generation === hunt.generation && row.state === "ADMITTED" ? [accountId] : [] };
}

const DRAFT_PREMIUM_DENIAL_PREFIX = "P2P_LOOT_GRANT_DRAFT_PREMIUM_";

/**
 * Whether this transaction (same id, same body) was already accepted. The ledger then replays its stored result and applies nothing
 * (RunInventoryTransaction), so the draft premium decision must not refuse it now that the token it granted is in the balance.
 * [2026-10-15] Only a completed row with the same request hash counts; a changed body is not a replay and is decided as before.
 */
async function IsAcceptedReplay(context: InventoryTransactionContext, body: any): Promise<boolean> {
    const Stored = await GetRepositories().inventoryTransactions.findRecord(context.userId, context.characterId, context.transactionId);
    if (Stored?.status !== "completed") return false;
    return Stored.requestHash === ComputeInventoryRequestHash(body.addInstancedItems, body.addStackedItems,
        body.removeInstancedItems, body.removeStackedItems, body.saveInstancedItems);
}

/**
 * POST /inventory from a player-host runtime: the native loot transaction of an admitted participant
 * of the running hunt, bound to the character frozen for it. The checks repeat inside the inventory
 * transaction, fenced against the emergency stop.
 *
 * [2026-10-14 realms S4] For a realm hub (hub design section 7.3) the participant is a member present in the hub (or the
 * host) and there is no frozen character: the character must belong to the account, the existing ownership check below. The
 * realm's Ramsgate keeps the grant class deny list and the claim-funded coin rule of a hunt but not the blanket no-reward
 * refusal, which a Training hub keeps (HostGrantDenial); the ledger row carries the realm and hub kind next to the session.
 */
export async function AuthorizeP2PInventoryTransaction(req: Request, context: InventoryTransactionContext):
    Promise<ExtensionInventoryTransaction | ExtensionHttpResponse> {
    const runtimeAuth = (req as any).AuthData as PlayerHostRuntimeAuthData;
    const body = req.body;
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(runtimeAuth.p2pSessionId);
    const denial = P2PInventoryTransactionDenialReason(runtimeAuth, hunt, body, await HubPresenceForCheck(hunt));
    if (denial != undefined) {
        logger.warn(`[P2PInventory] rejected code=${denial} account=${runtimeAuth.userId} session=${runtimeAuth.p2pSessionId} generation=${runtimeAuth.p2pGeneration}`);
        return { status: 403, body: { code: "P2P_LOOT_GRANT_DENIED", message: LOOT_DENIED, payload: null } };
    }
    // [2026-10-11 B9, decision 1 of 39_ §13] Hard deny list (hostGrantPolicy.ts): Platinum and premium currency, Hunt
    // Pass items, cosmetics and entitlements never come from a host, and a no-reward session (Training, B7) grants and
    // spends nothing. The whole transaction is refused - a legitimate hunt never sends these, so a transaction that does
    // is not trusted with the rest of its contents either. [2026-10-16] Only in enforce mode (MYSTICPARADOX_HOST_POLICY): in
    // observe, the default, the refusal is logged as [HostPolicyObserve] and the transaction proceeds (hostPolicyMode.ts). Who may
    // write (the denial above, the character check below, the emergency stop) is enforced in both modes.
    // [2026-10-13 realms S3] The one Hunt Pass item let through is the claim-funded season-challenge coin grant
    // (hostGrantPolicy.ts IsClaimFundedCoinGrant); whether it is paid is the wallet's call (one claim, one grant).
    // [2026-10-15] The daily premium draft token (hostDraftPremium.ts): read here for the early refusal, and decided again inside the
    // transaction from that transaction's own reads (onGrant below), which is the decision that counts. A replay of an accepted
    // transaction is not decided here at all: the ledger returns its stored result, so the token it granted cannot refuse it.
    const DraftPremiumReplay = BodyAddsHostDraftPremium(body) && await IsAcceptedReplay(context, body);
    const DraftPremiumPrecheck = BodyAddsHostDraftPremium(body) && !DraftPremiumReplay
        ? DecideHostDraftPremium(body, await ReadHostDraftPremiumInputs(GetRepositories(), context.userId, context.characterId))
        : undefined;
    const grantDenial = HostGrantDenial(hunt, body, undefined, { draftPremium: DraftPremiumReplay || DraftPremiumPrecheck?.allowed === true });
    if (grantDenial != undefined) {
        const grantTags = `account=${context.userId} session=${runtimeAuth.p2pSessionId} generation=${runtimeAuth.p2pGeneration} ` +
            `transaction=${context.transactionId} classes=${grantDenial.classes.join(",")} denied=${grantDenial.summary}` +
            (DraftPremiumPrecheck !== undefined && !DraftPremiumPrecheck.allowed ? ` draftPremium=${DraftPremiumPrecheck.reason}` : "") +
            (hunt?.hubKind != undefined ? ` hub=${hunt.hubKind}` : "");
        // [2026-10-16] Observe mode (MYSTICPARADOX_HOST_POLICY, the default): the
        // class deny list and the no-reward session are logged and the transaction proceeds; the ledger row and [GrantMon] record it.
        if (!HostPolicyRefuses()) {
            NoteHostPolicyWouldRefuse("grant", grantTags);
        } else {
            logger.warn(`[HostGrantDeny] ${grantTags}`);
            return { status: 403, body: { code: "P2P_HOST_GRANT_DENIED", message: HOST_GRANT_DENIED, payload: { classes: grantDenial.classes } } };
        }
    }
    // Bind the transaction to the character frozen for this admitted participant. The
    // inventory controller also verifies account ownership before entering its transaction.
    const ownsCharacter = await GetP2PRepositories().characters.findByCharacterIdAndUserId(context.characterId, context.userId);
    if (ownsCharacter == undefined) {
        logger.warn(`[P2PInventory] rejected code=CHARACTER_NOT_OWNED account=${context.userId} session=${runtimeAuth.p2pSessionId} generation=${runtimeAuth.p2pGeneration}`);
        return { status: 403, body: { code: "P2P_LOOT_GRANT_DENIED", message: LOOT_DENIED, payload: null } };
    }
    // The realm tags come from the stored session (never from the request), and only a realm session has them.
    const realmTags: P2PMonitorTags = {
        ...(typeof hunt!.realmId === "string" ? { realmId: hunt!.realmId } : {}),
        ...(typeof hunt!.hubKind === "string" ? { hubKind: hunt!.hubKind } : {})
    };
    // The decision the transaction applied and the day it recorded, for the [HostGrantAllow] line once the transaction is accepted.
    let GrantedDraftPremium: { decision: HostDraftPremiumDecision; day: string } | undefined;
    const tags = `account=${context.userId} character=${context.characterId} session=${runtimeAuth.p2pSessionId} ` +
        `generation=${runtimeAuth.p2pGeneration} transaction=${context.transactionId}` +
        (realmTags.realmId !== undefined ? ` realm=${realmTags.realmId}` : "") +
        (realmTags.hubKind !== undefined ? ` hub=${realmTags.hubKind}` : "");
    return {
        options: {
            diagnosticLabel: "p2p-native-inventory",
            // [diagnostics 2026-10-14] The economy ledger names a player-host transaction by its session and host (a Platinum
            // spend is logged with them; the trusted values come from the stored session, never from the request).
            economy: { source: "INVENTORY_HOST", p2pSessionId: runtimeAuth.p2pSessionId, hostAccountId: hunt!.hostAccountId },
            onGrant: async (repos, session) => {
                if (!await FenceP2PEmergencyStop(session)) throw new Error("P2P_EMERGENCY_STOP");
                const currentHunt = await GetP2PRepositories().p2pHunts.findHunt(runtimeAuth.p2pSessionId, session);
                const currentDenial = P2PInventoryTransactionDenialReason(runtimeAuth, currentHunt, body,
                    await HubPresenceInTransaction(currentHunt, runtimeAuth.userId, session));
                if (currentDenial != undefined) throw new Error(`P2P_LOOT_GRANT_${currentDenial}`);
                // The draft premium token is decided again from this transaction's reads: the balance and the pass as they are now.
                // [2026-10-16] Nothing is recorded on the account any more (no once-per-day rule, hostDraftPremium.ts); the day is kept
                // for the [HostGrantAllow] line only.
                if (BodyAddsHostDraftPremium(body)) {
                    const Inputs = await ReadHostDraftPremiumInputs(repos, context.userId, context.characterId, session);
                    const Decision = DecideHostDraftPremium(body, Inputs);
                    if (Decision === undefined || !Decision.allowed) {
                        const Reason = Decision?.reason ?? "NOT_A_GRANT";
                        if (HostPolicyRefuses()) throw new Error(`${DRAFT_PREMIUM_DENIAL_PREFIX}${Reason}`);
                        // [2026-10-16] Observe mode: the cap is logged, the token is granted.
                        NoteHostPolicyWouldRefuse("draft premium", `${tags} item=${HOST_DRAFT_PREMIUM_ID} reason=${Reason} at=transaction` +
                            (Decision?.balanceBefore !== undefined ? ` balance=${Decision.balanceBefore}->${Decision.balanceAfter} cap=${HOST_DRAFT_PREMIUM_BALANCE_CAP}` : ""));
                    } else {
                        GrantedDraftPremium = { decision: Decision, day: UtcDay() };
                    }
                }

                // Record the accepted item additions with the existing idempotency ledger completion.
                // The trusted session/generation come from host capability auth; request-body
                // metadata cannot select a hunt. No extra write is introduced, and replay skips this.
                return P2PMonitorAnnotator(runtimeAuth.p2pSessionId, runtimeAuth.p2pGeneration, realmTags);
            }
        },
        errorResponse(error) {
            if (!(error instanceof Error) || (error.message !== "P2P_EMERGENCY_STOP" && !error.message.startsWith("P2P_LOOT_GRANT_"))) {
                return undefined;
            }
            logger.warn(`[P2PInventory] transaction denied code=${error.message} ${tags}`);
            // [2026-10-15] A refused draft premium grant is a host-grant refusal too, with the reason the transaction decided.
            if (error.message.startsWith(DRAFT_PREMIUM_DENIAL_PREFIX)) {
                logger.warn(`[HostGrantDeny] account=${context.userId} session=${runtimeAuth.p2pSessionId} generation=${runtimeAuth.p2pGeneration} ` +
                    `transaction=${context.transactionId} item=${HOST_DRAFT_PREMIUM_ID} quantity=1 ` +
                    `reason=${error.message.slice(DRAFT_PREMIUM_DENIAL_PREFIX.length)} at=transaction`);
            }
            return { status: 403, body: { code: error.message, message: LOOT_DENIED, payload: null } };
        },
        report(phase) {
            const counts = phase !== "applying" ? "" :
                ` addInstanced=${body.addInstancedItems?.length ?? 0} addStacked=${body.addStackedItems?.length ?? 0}` +
                ` removeInstanced=${body.removeInstancedItems?.length ?? 0} removeStacked=${body.removeStackedItems?.length ?? 0}` +
                ` saveInstanced=${body.saveInstancedItems?.length ?? 0}`;
            const message = `[P2PInventory] ${phase === "applying" ? "applying" : `transaction ${phase}`} ${tags}${counts}`;
            if (phase === "failed") logger.error(message);
            else logger.info(message);
            if (phase === "accepted" && GrantedDraftPremium !== undefined) {
                const { decision, day } = GrantedDraftPremium;
                logger.info(`[HostGrantAllow] account=${context.userId} session=${runtimeAuth.p2pSessionId} generation=${runtimeAuth.p2pGeneration} ` +
                    `transaction=${context.transactionId} item=${HOST_DRAFT_PREMIUM_ID} quantity=1 reason=${decision.reason} day=${day} ` +
                    `balance=${decision.balanceBefore}->${decision.balanceAfter} cap=${HOST_DRAFT_PREMIUM_BALANCE_CAP}`);
            }
        }
    };
}
