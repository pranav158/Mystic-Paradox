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

import { ClientSession } from "mongodb";
import { GetRepositories, GetUnitOfWork, InventoryTransactionAlreadyExistsError, RepositoryProvider } from "../persistence";
import { GetCharacterWithUid } from "./character";
import { logger } from "../logger";
import { ApplyCurrencyDeltas, MergeWalletIntoStacked } from "./wallet";
import { EnsureStarterBootstrapRecords, EnsureStarterBootstrapRecordsInTransaction } from "./starterManifest";
import crypto from "node:crypto";
import { MigrateInventoryStorageArrays, NormalizeInventoryGrantCollections } from "../inventoryStoragePolicy";

// [hardening] Deterministic serialization (object keys sorted recursively) so a canonical hash of
// a request body is stable regardless of JSON key ordering - a genuine client retry of the same
// body always hashes identically, while any real change to the mutation produces a different hash.
function StableStringify(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return "[" + value.map(StableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map((Key) => JSON.stringify(Key) + ":" + StableStringify(value[Key])).join(",") + "}";
}

// Canonical SHA-256 of the full mutation body. Bound to the ledger row (NOT the _id) so a
// transactionId replayed with the SAME body returns the stored result, but a transactionId reused
// with a DIFFERENT body is detected and rejected. Missing vs empty collections hash identically.
function ComputeInventoryRequestHash(InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): string {
    const Canonical = StableStringify({
        addInstancedItems: InstancedItemsToAdd ?? [],
        addStackedItems: StackedItemsToAdd ?? [],
        removeInstancedItems: InstancedItemsToRemove ?? [],
        removeStackedItems: StackedItemsToRemove ?? [],
        saveInstancedItems: InstancedItemsToSave ?? [],
    });
    return crypto.createHash("sha256").update(Canonical).digest("hex");
}

// [hardening] Monotonic updateVersion guard for an itemData save, shared by BOTH the single-item
// endpoint (UpdateInstancedItem) and the batch saveInstancedItems path in RunInventoryTransaction,
// so neither can overwrite newer itemData with an older client updateVersion (the Mongo revision
// guard only prevents DB-level races, not a semantically stale client payload). Returns the item
// to store when the save should be APPLIED, or undefined when it must NOT be written:
//   incoming <  stored                     -> stale: ignore (undefined)
//   incoming == stored, itemData identical -> no-op: nothing changed, do not report (undefined)
//   incoming == stored, itemData differs   -> divergent: apply, log a same-version conflict for
//     review (not rejected, to avoid dropping a legit save from a client that does not strictly
//     bump the per-item version on every edit - can be tightened once that is confirmed)
//   incoming >  stored                     -> apply
// catalogId identity is validated by the caller and is never changed here.
function ApplyItemDataSave(existing: any, incomingItemData: any, incomingUpdateVersion: any): any | undefined {
    const ExistingVersion = typeof existing.updateVersion === "number" ? existing.updateVersion : 0;
    const IncomingVersion = typeof incomingUpdateVersion === "number" ? incomingUpdateVersion : ExistingVersion;
    const NextItemData = incomingItemData ?? null;
    const ExistingItemData = existing.itemData ?? null;

    if (IncomingVersion < ExistingVersion) {
        logger.warn(`Ignoring stale itemData save: updateVersion ${IncomingVersion} < stored ${ExistingVersion} for instanceId ${existing.instanceId} (catalogId ${existing.catalogId})`);
        return undefined;
    }

    if (IncomingVersion === ExistingVersion) {
        if (NextItemData === ExistingItemData) {
            // Equal version, identical data: idempotent re-save. Nothing to write, nothing to
            // report as updated.
            return undefined;
        }
        // Equal version, divergent data: ambiguous same-version write - apply but flag it.
        logger.warn(`Same-version divergent itemData save for instanceId ${existing.instanceId} (catalogId ${existing.catalogId}) at updateVersion ${IncomingVersion} - applying, flagged for review`);
    }

    return { ...existing, itemData: NextItemData, updateVersion: IncomingVersion };
}

export const DEV_USER_ID = process.env.DEV_USER_ID ?? "mystpax";

// [hardening 2026-07-14] dev_inventory.json is NO LONGER LOADED AT RUNTIME. It was previously
// read here (as DEV_INVENTORY) and served verbatim + force-resynced into Mongo on every GET for
// DEV_USER_ID - the exact "continuously resetting from JSON prevents progression" problem. The
// account has been migrated to Mongo via a one-time script (_migrate_mysticparadox_bootstrap.cjs,
// archived - see the migration doc/commit for details) and now persists through the same code
// path as every other account. The file itself is kept on disk only as an archived migration
// fixture (it is no longer imported, read, or referenced by any runtime code path).

// Runtime inventory code accepts catalog IDs exactly as persisted. Historical catalog conversions,
// if ever needed, belong in explicit migrations—not in GET/POST normalization where they could
// turn a returning player's Frostfall or Terra weapon into a Recruit Sword.
export const INVALID_STARTER_CATALOG_IDS: ReadonlySet<string> = new Set([
    "DYE_BANNER_BACKGROUND_DEFAULT",
    "DYE_BANNER_SIGIL_DEFAULT",
]);

// [1.14.7 2026-10-08] Game servers create instanced items with a PLACEHOLDER instanceId equal to the catalogId
// (every created instanced item in the 1.12 [INV-CAP] logs - crafted weapons, armour, parts - and the 1.14.7
// cell-fusion token TOKEN_CELL_EXCHANGE) and expect the service to assign the real id, as the live service's
// 26-character base32 ids show. This backend stored the placeholder, and because an add first removes any item
// with the same instanceId, a second copy of the same item replaced the first and a second concurrent cell fusion
// would replace the first fusion's token (its ingredients already consumed). New instanced items without a real
// id now get a minted one, returned in createdInstancedItems.
const INSTANCE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function MintInstanceId(): string {
    const Bytes = crypto.randomBytes(17);   // 136 bits; the id uses 130
    let Bits = "";
    for (const Byte of Bytes) Bits += Byte.toString(2).padStart(8, "0");
    let Out = "";
    for (let i = 0; i < 26; i++) Out += INSTANCE_ID_ALPHABET[parseInt(Bits.slice(i * 5, i * 5 + 5), 2)];
    return Out;
}

export function NeedsMintedInstanceId(Item: any): boolean {
    if (Item == undefined || typeof Item !== "object") return false;
    const InstanceId = Item.instanceId;
    return typeof InstanceId !== "string" || InstanceId.length === 0 || InstanceId === Item.catalogId;
}

function NormalizeInstancedItems(InstancedItems: any[]){
    let Changed = false;
    const NormalizedItems: any[] = [];
    const SeenInstanceIds = new Set<string>();

    for(const Item of InstancedItems){
        if(Item == undefined || typeof Item !== "object"){
            Changed = true;
            continue;
        }

        const CatalogId = Item.catalogId;
        const InstanceId = Item.instanceId;
        if(typeof CatalogId !== "string" || CatalogId.length === 0 || INVALID_STARTER_CATALOG_IDS.has(CatalogId) ||
           typeof InstanceId !== "string" || InstanceId.length === 0 || SeenInstanceIds.has(InstanceId)){
            Changed = true;
            continue;
        }
        SeenInstanceIds.add(InstanceId);

        const NormalizedItem = {
            ...Item,
            catalogId: CatalogId,
            instanceId: InstanceId,
            // Inventory itemData is captured as null for starter items. Never inject the
            // loadout's weapon instance_data here; any non-null player-owned value is preserved.
            itemData: Item.itemData ?? null,
            updateVersion: typeof Item.updateVersion === "number" ? Item.updateVersion : 0,
        };
        if(NormalizedItem.itemData !== Item.itemData || NormalizedItem.updateVersion !== Item.updateVersion) Changed = true;
        NormalizedItems.push(NormalizedItem);
    }

    InstancedItems.splice(0, InstancedItems.length, ...NormalizedItems);
    return Changed;
}

function NormalizeStackedItems(StackedItems: any[]){
    let Changed = false;
    const NormalizedItems: any[] = [];
    const QuantitiesByCatalogId = new Map<string, number>();
    for(const Item of StackedItems){
        if(Item == undefined || typeof Item !== "object" || typeof Item.catalogId !== "string" || INVALID_STARTER_CATALOG_IDS.has(Item.catalogId)){
            Changed = true;
            continue;
        }
        const Quantity = typeof Item.quantity === "number" ? Item.quantity : 0;
        QuantitiesByCatalogId.set(Item.catalogId, (QuantitiesByCatalogId.get(Item.catalogId) ?? 0) + Quantity);
    }
    for(const [catalogId, quantity] of QuantitiesByCatalogId) NormalizedItems.push({catalogId, quantity});
    if(NormalizedItems.length !== StackedItems.length) Changed = true;
    StackedItems.splice(0, StackedItems.length, ...NormalizedItems);
    return Changed;
}

function RemoveInstancedItems(InstancedItems: any[], ItemsToRemove: any[]){
    if(!Array.isArray(ItemsToRemove) || ItemsToRemove.length === 0){
        return false;
    }

    const InstanceIdsToRemove = new Set(ItemsToRemove.map((Item) => Item?.instanceId).filter((InstanceId) => typeof InstanceId === "string" && InstanceId.length > 0));

    if(InstanceIdsToRemove.size === 0){
        return false;
    }

    // A placeholder id (== catalogId) that matches nothing means the caller kept its placeholder instead of
    // adopting the id minted for it (see MintInstanceId). Logged so that case is visible, never guessed at.
    for (const Item of ItemsToRemove) {
        if (Item && typeof Item.instanceId === "string" && Item.instanceId === Item.catalogId
            && !InstancedItems.some((Existing) => Existing.instanceId === Item.instanceId)) {
            logger.warn(`[InstanceId] remove references placeholder ${Item.instanceId} that matches no stored item - the server did not adopt a minted id`);
        }
    }

    const OriginalLength = InstancedItems.length;
    const KeptItems = InstancedItems.filter((Item) => !InstanceIdsToRemove.has(Item.instanceId));
    InstancedItems.splice(0, InstancedItems.length, ...KeptItems);

    return KeptItems.length !== OriginalLength;
}

// [hardening 2026-07-26] Thrown when a removeStackedItems entry asks to remove more of a
// NON-currency catalogId than the character actually owns. Mirrors wallet.ts's
// InsufficientBalanceError, but for the stacked-item blob: currency removals were already guarded
// atomically by ApplyCurrencyDeltas/AddCurrency, but a non-currency stacked item (cell cores,
// crafting/fusion materials, etc.) had NO such guard at all - RemoveStackedItems silently
// no-ops/clamps to 0 for an over-removal instead of rejecting it, while the SAME transaction's
// addStackedItems/addInstancedItems side still fully applies. That is exactly the mechanism
// behind the Reward Core dupe (BUG D, 2026-07-18): once a stack was already fully consumed,
// further "remove 1, add reward" requests kept succeeding because the removal quietly did
// nothing. BUG D's fix only made the CLIENT aware of the true post-removal count (so a legitimate
// client stops asking); it did not stop the SERVER from granting a reward when the matching
// removal can't actually be satisfied. This closes that at the source for every non-currency
// stacked-item cost - including cell fusion, whose exact wire contract has never been captured
// from real traffic (see Progress/20_REFORGE.md), but which goes through this same generic path.
export class InsufficientStackedItemError extends Error {
    constructor(userId: string, catalogId: string, requested: number, owned: number) {
        super(`Insufficient stacked item: user ${userId} has ${owned} of ${catalogId}, cannot remove ${requested}`);
        this.name = "InsufficientStackedItemError";
    }
}

// Validated against the ORIGINAL (pre-mutation) StackedItems snapshot, so a single request can
// never fund its own removal via an addStackedItems entry for the same catalogId in the same
// call - the check must reflect what was actually owned before this transaction, not what it
// grants itself. Currency (CURRENCY_*) is excluded here; it is already guarded atomically by
// ApplyCurrencyDeltas/AddCurrency inside the same Mongo transaction.
function ValidateStackedItemRemovals(userId: string, StackedItems: any[], ItemsToRemove: any[]){
    if(!Array.isArray(ItemsToRemove) || ItemsToRemove.length === 0){
        return;
    }

    const OwnedByCatalogId = new Map<string, number>();
    for(const Item of StackedItems){
        if(Item && typeof Item.catalogId === "string"){
            OwnedByCatalogId.set(Item.catalogId, (OwnedByCatalogId.get(Item.catalogId) ?? 0) + (Number(Item.quantity) || 0));
        }
    }

    // Multiple removeStackedItems entries for the same catalogId in one request must be summed
    // before comparing against what's owned - matches how RemoveStackedItems itself nets every
    // entry against the same merged StackedItems array, not per-entry independently.
    const RequestedByCatalogId = new Map<string, number>();
    for(const ItemToRemove of ItemsToRemove){
        const CatalogId = ItemToRemove?.catalogId;
        if(typeof CatalogId !== "string" || CatalogId.startsWith("CURRENCY_")){
            continue;
        }
        const Quantity = typeof ItemToRemove.quantity === "number" ? ItemToRemove.quantity : 0;
        RequestedByCatalogId.set(CatalogId, (RequestedByCatalogId.get(CatalogId) ?? 0) + Quantity);
    }

    for(const [CatalogId, Requested] of RequestedByCatalogId){
        const Owned = OwnedByCatalogId.get(CatalogId) ?? 0;
        if(Requested > Owned){
            throw new InsufficientStackedItemError(userId, CatalogId, Requested, Owned);
        }
    }
}

function RemoveStackedItems(StackedItems: any[], ItemsToRemove: any[]){
    if(!Array.isArray(ItemsToRemove) || ItemsToRemove.length === 0){
        return false;
    }

    let Changed = false;

    for(const ItemToRemove of ItemsToRemove){
        if(typeof ItemToRemove?.catalogId !== "string"){
            continue;
        }

        const ExistingItem = StackedItems.find((Item) => Item.catalogId === ItemToRemove.catalogId);

        if(ExistingItem == undefined){
            continue;
        }

        ExistingItem.quantity -= typeof ItemToRemove.quantity === "number" ? ItemToRemove.quantity : ExistingItem.quantity;
        Changed = true;
    }

    const KeptItems = StackedItems.filter((Item) => Item.quantity > 0);
    StackedItems.splice(0, StackedItems.length, ...KeptItems);

    return Changed;
}

async function DoesInventoryBelongToUserId(UserId: string, CharacterId: string){
    const CharacterFromDb = await GetCharacterWithUid(CharacterId, UserId);

    return CharacterFromDb != undefined;
}

export async function UpdateInstancedItem(CharacterId: string, UserId: string, InstanceId: string, CatalogId: string, ItemData: string, UpdateVersion: number){
    // [hardening] Ownership gate first: never mutate an inventory the caller does not own.
    if(!await DoesInventoryBelongToUserId(UserId, CharacterId)){
        logger.error(`UpdateInstancedItem: characterId ${CharacterId} does not belong to user ${UserId}`);
        return undefined;
    }

    // [hardening] Revision-guarded read-modify-write with a bounded retry, replacing the previous
    // unconditional full-inventory overwrite (which could clobber a concurrent gatherable/reward/
    // POST /inventory transaction). Each attempt reads the current row + revision, applies only
    // the mutable fields to the ONE targeted instance, and writes via updateBothIfRevisionMatches
    // so a concurrent writer that landed first makes this retry against fresh data instead of
    // silently overwriting it.
    const MAX_ATTEMPTS = 5;
    for(let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++){
        if(Attempt > 0){
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
        }

        const CurrentInventory = await GetRepositories().inventories.findByCharacterId(CharacterId);
        if(CurrentInventory == undefined){
            logger.error(`UpdateInstancedItem: no inventory for characterId ${CharacterId}`);
            return undefined;
        }

        const ExpectedRevision = CurrentInventory.revision ?? 0;
        const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);
        const ItemIndex = InstancedItems.findIndex((Item) => Item.instanceId === InstanceId);

        if(ItemIndex < 0){
            logger.warn(`UpdateInstancedItem: instanceId ${InstanceId} not found for characterId ${CharacterId}`);
            return undefined;
        }

        const Existing = InstancedItems[ItemIndex];

        // Identity is immutable via this endpoint: an update targets an item by instanceId to
        // persist its data only. Refuse a catalogId change (that would be an unauthorized
        // transmutation/grant, the same vector closed in the save path of RunInventoryTransaction).
        if(Existing.catalogId !== CatalogId){
            logger.warn(`UpdateInstancedItem: refusing catalogId change ${Existing.catalogId} -> ${CatalogId} for instanceId ${InstanceId} (userId ${UserId})`);
            return undefined;
        }

        // Monotonic updateVersion guard (shared with the batch save path): an update whose
        // version is strictly older than what is stored is a stale/replayed write and is ignored;
        // equal-or-newer applies. The revision guard below independently protects against true
        // concurrent writes regardless.
        const NextItem = ApplyItemDataSave(Existing, ItemData, UpdateVersion);
        if(NextItem === undefined){
            return Existing;
        }

        InstancedItems[ItemIndex] = NextItem;

        const Updated = await GetRepositories().inventories.updateBothIfRevisionMatches(
            CharacterId, JSON.stringify(InstancedItems), CurrentInventory.stackedItems, ExpectedRevision
        );

        if(Updated != undefined){
            logger.info(`Updated instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return InstancedItems[ItemIndex];
        }

        logger.warn(`UpdateInstancedItem: revision conflict for characterId ${CharacterId}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    logger.error(`UpdateInstancedItem for characterId ${CharacterId} failed after ${MAX_ATTEMPTS} revision-conflict retries`);
    return undefined;
}

// [hardening] Thrown when the SAME transactionId is still "pending" from a genuinely concurrent
// duplicate request (not yet completed) — as opposed to a replay of an already-COMPLETED
// transaction, which is handled by returning the stored result instead of throwing. The route
// should surface this as a definite, retryable conflict rather than double-applying anything.
export class InventoryTransactionConflictError extends Error {
    constructor(transactionId: string) {
        super(`Inventory transaction ${transactionId} is already in progress (concurrent duplicate request)`);
        this.name = "InventoryTransactionConflictError";
    }
}

// [hardening] Thrown when a transactionId is replayed with a DIFFERENT request body than the one
// originally stored for it (its canonical requestHash does not match). This is misuse (an id
// reused for a different mutation), not a legitimate retry, so it is rejected WITHOUT applying
// anything, distinct from the same-body replay (which returns the stored result).
export class InventoryTransactionMismatchError extends Error {
    constructor(transactionId: string) {
        super(`Inventory transaction ${transactionId} was reused with a different request body`);
        this.name = "InventoryTransactionMismatchError";
    }
}

// [hardening] Thrown internally (inside the withTransaction callback, caught immediately outside
// it) when updateBothIfRevisionMatches finds the row's revision has moved since this request read
// it - i.e. a concurrent write for the SAME characterId landed first. Always translated into an
// InventoryTransactionConflictError before leaving RunInventoryTransaction, so callers only ever
// need to handle one conflict type.
class InventoryRevisionConflictError extends Error {
    constructor(public readonly characterId: string) {
        super(`Inventory revision conflict for characterId ${characterId} - concurrent write detected`);
        this.name = "InventoryRevisionConflictError";
    }
}

export type InventoryTransactionOptions = {
    // Only use when the caller has already validated the exact userId/characterId binding through a
    // server-authenticated mechanism, such as the signed store purchase token minted by this backend.
    ownershipAlreadyValidated?: boolean;
    diagnosticLabel?: string;

    // [2026-07-30] Additional account-level grants that must commit with this transaction or not at
    // all. A Dauntless store SKU can pay out in four currencies of its own - inventory items,
    // entitlements, progression and loadout slots (FOnlineStorePhoenixOffer's Granted* fields) - and
    // only the first lives in the inventory blob. Rather than teach this function about each one, the
    // caller supplies a callback that runs INSIDE the session, after the wallet debit and before the
    // inventory write, so a failed entitlement/progression grant aborts the charge too.
    //
    // It runs only on a genuinely new transactionId: a replayed purchase returns the stored ledger
    // result without re-entering the transaction at all, which is exactly right - the grants already
    // happened the first time, and each is independently idempotent anyway.
    //
    // withTransaction may retry the callback on a transient Mongo error, so onGrant must be safe to
    // run more than once and must not have side effects outside the session.
    //
    // onGrant may return an annotator: it receives the item additions that survived normalization and
    // returns extra fields stored on the ledger row by the same completion write (no extra collection).
    onGrant?: (repos: RepositoryProvider, session: ClientSession) => Promise<InventoryLedgerAnnotator | void>;

    // [2026-10-10] Lets a season challenge's claim fund a CURRENCY_SEASONAL_COIN grant (controllers/challengeRewards.ts).
    // Set only by POST /inventory for dedicated-server requests; store purchases and every other caller leave it off.
    allowChallengeRewardFunding?: boolean;
};

export type InventoryLedgerAnnotator = (accepted: { createdInstancedItems: any[]; acceptedStackedAdds: any[] }) =>
    Record<string, unknown> | undefined;

export async function RunInventoryTransaction(UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[], Options: InventoryTransactionOptions = {}){
    const StartedAt = Date.now();
    const Timing = { ownership: 0, ledgerBegin: 0, wallet: 0, inventoryRead: 0, inventoryWrite: 0, ledgerComplete: 0 };
    const OwnershipStartedAt = Date.now();
    if(!Options.ownershipAlreadyValidated && !await DoesInventoryBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return false;
    }
    Timing.ownership = Date.now() - OwnershipStartedAt;

    // [hardening 2026-07-14] All DEV_USER_ID special-casing removed from this function per
    // explicit instruction: the account (now migrated to Mongo, see the one-time migration
    // script) persists exactly like any other account. The root cause that motivated the
    // original bypass - NormalizeInstancedItems clobbering real instance IDs with the shared
    // MYSTICPARADOX_STARTER_* constants - is fixed directly in NormalizeInstancedItems above (it now
    // prefers an item's own existing instanceId), so no per-account skip is needed here at all.

    // [hardening] transactionId is now a real idempotency key, and the currency + inventory
    // mutation is one atomic Mongo transaction — not two independent writes that could partially
    // apply if the process crashes or a write fails between them (the report's "wallet plus
    // inventory mutation is not atomic" finding). withTransaction may invoke this callback more
    // than once if Mongo reports a transient transaction error, so nothing outside the session
    // (there is nothing else here) may have a side effect before it commits.
    //
    // tryBegin THROWS (rather than returns) when transactionId was already seen — a duplicate-key
    // write inside a Mongo transaction aborts that transaction server-side, so the only safe move
    // is to unwind out of withTransaction entirely (never keep issuing operations against the now
    // -dead session). That unwind is caught HERE, outside withTransaction, once the session is no
    // longer in use.
    const RequestHash = ComputeInventoryRequestHash(InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave);

    // [1.12 inventory storage] Preserve the hash of the ORIGINAL wire body for compatibility with
    // existing idempotency-ledger rows, then correct grant representation before any wallet or
    // inventory mutation. The 1.12 catalog is authoritative here: cosmetic/transmog unlocks such
    // as WP_AC_TRIALS_00 are stackable ownership records even though their prefix resembles real
    // instanced equipment. Unknown ids retain their incoming representation rather than guessed.
    const NormalizedGrants = NormalizeInventoryGrantCollections(
        TransactionId, InstancedItemsToAdd ?? [], StackedItemsToAdd ?? []
    );
    const EffectiveInstancedItemsToAdd = NormalizedGrants.instancedItemsToAdd;
    const EffectiveStackedItemsToAdd = NormalizedGrants.stackedItemsToAdd;
    if (NormalizedGrants.corrections.length > 0) {
        logger.warn(`[InventoryStorage] transactionId ${TransactionId} normalized ${NormalizedGrants.corrections.length} grant entr${NormalizedGrants.corrections.length === 1 ? "y" : "ies"}: ${NormalizedGrants.corrections.map((Correction) => `${Correction.catalogId}:${Correction.from}->${Correction.to}x${Correction.quantity}`).join(", ")}`);
    }

    try {
        const Result = await GetUnitOfWork().withTransaction(async (Repos, Session) => {
            let StepStartedAt = Date.now();
            await Repos.inventoryTransactions.tryBegin(TransactionId, UserId, CharacterId, RequestHash, Session);
            Timing.ledgerBegin += Date.now() - StepStartedAt;
            // tryBegin returned normally (didn't throw) => transactionId is genuinely new.

            // Apply CURRENCY_* stacked deltas to the wallet FIRST (same ordering as before), now
            // inside the same transaction as the inventory write below. May throw
            // InsufficientPrestigeProgressError (a gated reward currency with no banked progress
            // to back it - see wallet.ts) in addition to InsufficientBalanceError; both abort this
            // whole transaction before anything below it runs.
            StepStartedAt = Date.now();
            const TouchedCurrencyBalances = await ApplyCurrencyDeltas(UserId, EffectiveStackedItemsToAdd, StackedItemsToRemove, Session,
                TransactionId, Options.allowChallengeRewardFunding === true);
            Timing.wallet += Date.now() - StepStartedAt;

            // Non-inventory grants (entitlements, progression) - see InventoryTransactionOptions.onGrant.
            // Runs after the debit so an unaffordable purchase never reaches it, and inside the session
            // so a throw here rolls the debit back with it.
            let LedgerAnnotator: InventoryLedgerAnnotator | undefined;
            if (Options.onGrant != undefined) {
                const Annotator = await Options.onGrant(Repos, Session);
                if (typeof Annotator === "function") LedgerAnnotator = Annotator;
            }

        // [hardening] Optimistic concurrency: capture the revision this read saw, so the final
        // write below only applies if nothing else changed the row in between (see
        // updateBothIfRevisionMatches). This closes the "Rewrites full JSON blobs, losing
        // concurrent updates" gap for the SAME characterId — the transaction above already
        // handles wallet/inventory atomicity and duplicate replay; this handles two concurrent
        // requests for the same character racing each other within a single transaction each.
        StepStartedAt = Date.now();
        let CurrentInventory = await Repos.inventories.findByCharacterId(CharacterId, Session);
        Timing.inventoryRead += Date.now() - StepStartedAt;

        if(CurrentInventory == undefined){
            logger.info(`Recovering bootstrap records for characterId ${CharacterId}`);
            const Recovery = await EnsureStarterBootstrapRecordsInTransaction(Repos, UserId, CharacterId, Session);
            CurrentInventory = Recovery.inventory;
        }

        const ExpectedRevision = CurrentInventory.revision ?? 0;

        // TODO: Large inventories may need normalized item rows instead of raw blob stringify
        let InstancedItems: any[] = JSON.parse(CurrentInventory!.instancedItems);

        let StackedItems: any[] = JSON.parse(CurrentInventory!.stackedItems);

        // [hardening 2026-07-26] Validate BEFORE any mutation, against the pre-transaction
        // snapshot - see InsufficientStackedItemError's doc comment above.
        ValidateStackedItemRemovals(UserId, StackedItems, StackedItemsToRemove ?? []);

        const CreatedInstancedItems: any[] = [];
        const UpdatedInstancedItems: any[] = [];
        const UpdatedStackedItems: any[] = [];
        const AcceptedStackedAdds: any[] = [];

        for(let NewInstancedItem of EffectiveInstancedItemsToAdd){
            if (NeedsMintedInstanceId(NewInstancedItem) && typeof NewInstancedItem?.catalogId === "string") {
                const Placeholder = NewInstancedItem.instanceId;
                NewInstancedItem = { ...NewInstancedItem, instanceId: MintInstanceId() };
                logger.info(`[InstanceId] minted ${NewInstancedItem.instanceId} for ${NewInstancedItem.catalogId} (server sent ${JSON.stringify(Placeholder ?? null)}) transactionId ${TransactionId}`);
            }
            const Items = [NewInstancedItem];
            NormalizeInstancedItems(Items);

            if(Items.length > 0){
                RemoveInstancedItems(InstancedItems, Items);
                InstancedItems.push(Items[0]);
                CreatedInstancedItems.push(Items[0]);
            }
        }

        const StackedItemsByCatalogId = new Map<string, any>();

        for(let StackedItem of StackedItems){
            StackedItemsByCatalogId.set(StackedItem.catalogId, StackedItem);
        }

        for(let NewStackedItem of EffectiveStackedItemsToAdd){
            if(INVALID_STARTER_CATALOG_IDS.has(NewStackedItem?.catalogId)){
                continue;
            }
            if (typeof NewStackedItem?.catalogId === "string" && Number.isSafeInteger(NewStackedItem?.quantity) && NewStackedItem.quantity > 0) {
                AcceptedStackedAdds.push({ catalogId: NewStackedItem.catalogId, quantity: NewStackedItem.quantity });
            }

            const ExistingStackedItem = StackedItemsByCatalogId.get(NewStackedItem.catalogId);

            if(ExistingStackedItem != undefined){
                ExistingStackedItem.quantity = ExistingStackedItem.quantity + NewStackedItem.quantity;
                UpdatedStackedItems.push(ExistingStackedItem);
            }
            else{
                StackedItems.push(NewStackedItem);
                StackedItemsByCatalogId.set(NewStackedItem.catalogId, NewStackedItem);
                UpdatedStackedItems.push(NewStackedItem);
            }
        }

        RemoveInstancedItems(InstancedItems, InstancedItemsToRemove ?? []);
        RemoveStackedItems(StackedItems, StackedItemsToRemove ?? []);

        // [BUG D fix 2026-07-18] Report the POST-removal quantity of every non-currency stacked item this
        // transaction removed, so the client updates its counts. Previously only ADDED stacked items were
        // returned in updatedStackedItems; stacked REMOVALS (e.g. opening a Reward Core at the Core Breaker,
        // which sends removeStackedItems:[{CONTAINER_CORE_* }]) were applied to the DB but omitted from the
        // response — so the client never saw the core decrement, kept offering opens, and once the DB stack
        // hit 0 the removal no-op'd while the reward ADD still applied → infinite core opens / cell dupe.
        // We include quantity 0 for a fully-consumed stack (RemoveStackedItems filters those out of
        // StackedItems) so the client zeroes it. Currency (CURRENCY_*) is EXCLUDED: it lives in the wallet
        // (ApplyCurrencyDeltas) and is projected separately, and it is not stored in this stacked blob — so
        // reporting it here as 0 would wrongly zero the client's currency display.
        {
            const StackedByCatalogAfterRemoval = new Map<string, any>();
            for(const Item of StackedItems) StackedByCatalogAfterRemoval.set(Item.catalogId, Item);
            const AlreadyReported = new Set(UpdatedStackedItems.map((Item) => Item.catalogId));
            for(const Removed of StackedItemsToRemove ?? []){
                const RemovedCatalogId = Removed?.catalogId;
                if(typeof RemovedCatalogId !== "string" || RemovedCatalogId.length === 0) continue;
                if(RemovedCatalogId.startsWith("CURRENCY_")) continue;
                if(AlreadyReported.has(RemovedCatalogId)) continue;
                AlreadyReported.add(RemovedCatalogId);
                const StillPresent = StackedByCatalogAfterRemoval.get(RemovedCatalogId);
                UpdatedStackedItems.push({ catalogId: RemovedCatalogId, quantity: StillPresent ? StillPresent.quantity : 0 });
            }
        }

        // [hardening 2026-07-26 — realtime currency fix] The gap BUG D closed for non-currency
        // stacked items above never covered CURRENCY_*: this transaction's response never told the
        // client what its new balance was after a spend, so the client's on-screen currency only
        // ever changed on its NEXT unrelated GET /inventory or GET /store/balance. Between the
        // spend actually landing and that next fetch, the display looked untouched - inviting
        // exactly the "the screen never moved, so I kept clicking" spam reported for reforge/cell
        // fuse. Report the post-transaction balance of every CURRENCY_* catalogId this call
        // touched (add or remove) in the same shape the client already reads currency in via
        // GET /inventory's wallet-into-stackedItems projection (controllers/wallet.ts's
        // MergeWalletIntoStacked), so a client that applies updatedStackedItems from this response
        // reflects the real balance immediately instead of one round-trip later.
        for(const [CatalogId, Balance] of Object.entries(TouchedCurrencyBalances)){
            UpdatedStackedItems.push({ catalogId: CatalogId, quantity: Balance });
        }

        for(const SavedItem of InstancedItemsToSave ?? []){
            const Items = [SavedItem];
            NormalizeInstancedItems(Items);

            if(Items.length === 0){
                continue;
            }

            const ExistingItemIndex = InstancedItems.findIndex((Item) => Item.instanceId === Items[0].instanceId);

            if(ExistingItemIndex < 0){
                // A save must reference an item the character already owns (by instanceId). A save
                // for an unknown instance is never an implicit grant - log it and skip.
                logger.warn(`Ignoring save for unknown instanceId ${Items[0].instanceId} (catalogId ${Items[0].catalogId}) - not owned by characterId ${CharacterId} (userId ${UserId})`);
                continue;
            }

            const Existing = InstancedItems[ExistingItemIndex];

            // [hardening] A save targets an EXISTING item by instanceId to persist its mutable
            // state (itemData/updateVersion) - it must NEVER change what the item IS. Without
            // this guard, a player-authorized save (grants/spends are gameserver-only, but
            // saves are not) could reuse an owned instanceId with a different, more valuable
            // catalogId and transmute the item - an unauthorized grant that bypasses the
            // gameserver-only mutation gate. Reject any save whose catalogId does not match the
            // stored item's catalogId, and only ever update the mutable fields.
            if(Existing.catalogId !== Items[0].catalogId){
                logger.warn(`Rejecting save that would change catalogId ${Existing.catalogId} -> ${Items[0].catalogId} for instanceId ${Existing.instanceId} (userId ${UserId})`);
                continue;
            }

            // [hardening] Same monotonic updateVersion guard as the single-item endpoint: a
            // stale (older-version) save is ignored so it cannot overwrite newer itemData.
            // Mongo revision guarding stops DB races; this stops a semantically stale payload.
            // An item is reported in updatedInstancedItems ONLY when the save actually applied.
            const NextItem = ApplyItemDataSave(Existing, Items[0].itemData, Items[0].updateVersion);
            if(NextItem !== undefined){
                InstancedItems[ExistingItemIndex] = NextItem;
                UpdatedInstancedItems.push(NextItem);
            }
        }

        StepStartedAt = Date.now();
        const UpdatedInventory = await Repos.inventories.updateBothIfRevisionMatches(
            CharacterId, JSON.stringify(InstancedItems), JSON.stringify(StackedItems), ExpectedRevision, Session
        );
        Timing.inventoryWrite += Date.now() - StepStartedAt;

        if (UpdatedInventory == undefined) {
            // Someone else's write landed on this characterId's row between our read and this
            // write, inside this same transaction attempt. Throwing here aborts the transaction
            // (nothing has committed) and is caught below as a definite, retryable conflict —
            // exactly like the ledger's InventoryTransactionAlreadyExistsError case, this must
            // unwind out of withTransaction rather than keep using the session.
            throw new InventoryRevisionConflictError(CharacterId);
        }

        const Result = {
            createdInstancedItems: CreatedInstancedItems,
            updatedInstancedItems: UpdatedInstancedItems,
            updatedStackedItems: UpdatedStackedItems,
            removedInstancedItems: InstancedItemsToRemove ?? []
        };

        // The annotator sees only item adds that survived the same normalization and persistence
        // filters as inventory; its fields are committed by the existing ledger completion write.
        const LedgerFields = LedgerAnnotator?.({ createdInstancedItems: CreatedInstancedItems, acceptedStackedAdds: AcceptedStackedAdds });

        StepStartedAt = Date.now();
        await Repos.inventoryTransactions.complete(TransactionId, UserId, CharacterId, Result, Session, LedgerFields);
        Timing.ledgerComplete += Date.now() - StepStartedAt;

        return Result;
        });
        const TotalMs = Date.now() - StartedAt;
        const AccountedMs = Timing.ownership + Timing.ledgerBegin + Timing.wallet + Timing.inventoryRead + Timing.inventoryWrite + Timing.ledgerComplete;
        if (Options.diagnosticLabel || TotalMs >= 1000) {
            logger.info(`[InventoryTiming] label=${Options.diagnosticLabel ?? "inventory"} total=${TotalMs}ms ownership=${Timing.ownership}ms ledgerBegin=${Timing.ledgerBegin}ms wallet=${Timing.wallet}ms inventoryRead=${Timing.inventoryRead}ms inventoryWrite=${Timing.inventoryWrite}ms ledgerComplete=${Timing.ledgerComplete}ms transactionOverhead=${Math.max(0, TotalMs - AccountedMs)}ms`);
        }
        return Result;
    } catch (Err) {
        if (Err instanceof InventoryRevisionConflictError) {
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} hit a revision conflict on characterId ${Err.characterId} - another write landed first, caller should retry`);
            throw new InventoryTransactionConflictError(TransactionId);
        }
        if (Err instanceof InventoryTransactionAlreadyExistsError) {
            // The transaction that hit the duplicate key has already been aborted and unwound
            // (see MongoInventoryTransactionRepository.tryBegin) — safe to act on the existing
            // record now, no session/transaction involvement left.

            // [hardening] Request-body binding: the same transactionId reused with a DIFFERENT
            // body is misuse, not a retry. Reject it without applying anything, rather than
            // silently returning the first request's result for a different intended mutation.
            //
            // requestHash was introduced after the ledger already existed: records written before
            // it have no stored requestHash. For those legacy records we CANNOT verify body
            // equality, so any reuse of the same (userId, characterId, transactionId) returns the
            // original stored result (if completed) or a conflict (if still pending) - never the
            // strict mismatch 409. This remains replay-SAFE because it never re-applies the
            // mutation (the original transaction already committed its effect; we only read back
            // its stored result). New records always carry a requestHash and get the strict
            // body-match check below, so a reused id with a changed body is rejected.
            const HasStoredRequestHash = typeof Err.existing.requestHash === "string" && Err.existing.requestHash.length > 0;
            if (HasStoredRequestHash && Err.existing.requestHash !== RequestHash) {
                logger.error(`transactionId ${TransactionId} for userId ${UserId} reused with a different request body - rejecting (stored ${Err.existing.requestHash.slice(0, 12)} != incoming ${RequestHash.slice(0, 12)})`);
                throw new InventoryTransactionMismatchError(TransactionId);
            }
            if (!HasStoredRequestHash) {
                logger.warn(`transactionId ${TransactionId} for userId ${UserId} is a legacy ledger record with no requestHash - replaying on original (pre-body-binding) semantics`);
            }
            if (Err.existing.status === "completed") {
                logger.info(`[Inventory] Replayed transactionId ${TransactionId} for userId ${UserId} - returning original stored result, not re-applying`);
                return Err.existing.result;
            }
            // Still "pending" - a genuinely concurrent duplicate request racing this one. Do not
            // guess at the eventual result; let the caller see a definite conflict and retry.
            throw new InventoryTransactionConflictError(TransactionId);
        }
        throw Err;
    }
}

// Reconciles legacy records written before the 1.12 catalog storage policy was enforced. This is
// deliberately narrower than a catalog-id migration: only catalog ids with an authoritative policy
// entry are touched, stackable instances are moved to quantity ownership, unknown ids are preserved,
// and non-stackables found in stacked storage remain unchanged for manual review. A bounded
// revision-guarded retry prevents a read-time repair from clobbering a concurrent grant/save.
async function EnsureInventoryStoragePolicyConsistency(UserId: string, CharacterId: string){
    const MAX_ATTEMPTS = 5;

    for(let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++){
        if(Attempt > 0){
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
        }

        const CurrentInventory = await GetRepositories().inventories.findByCharacterId(CharacterId);
        if(CurrentInventory == undefined){
            throw new Error(`Inventory storage reconciliation found no inventory for characterId ${CharacterId}`);
        }

        let InstancedItems: any[];
        let StackedItems: any[];
        try {
            InstancedItems = JSON.parse(CurrentInventory.instancedItems);
            StackedItems = JSON.parse(CurrentInventory.stackedItems);
            if(!Array.isArray(InstancedItems) || !Array.isArray(StackedItems)){
                throw new Error("inventory blobs are not arrays");
            }
        } catch(Err) {
            throw new Error(`Inventory storage reconciliation could not parse characterId ${CharacterId}: ${String(Err)}`);
        }

        const Migration = MigrateInventoryStorageArrays(InstancedItems, StackedItems);
        if(Migration.changes.length === 0){
            return CurrentInventory;
        }

        const Updated = await GetRepositories().inventories.updateBothIfRevisionMatches(
            CharacterId,
            JSON.stringify(Migration.instancedItems),
            JSON.stringify(Migration.stackedItems),
            CurrentInventory.revision ?? 0
        );

        if(Updated != undefined){
            const Summary = Migration.changes
                .map((Change) => `${Change.catalogId}:instanced->stacked x${Change.migratedInstances} (${Change.result})`)
                .join(", ");
            logger.warn(`[InventoryStorage] repaired legacy storage for userId ${UserId} characterId ${CharacterId}: ${Summary}`);
            if(Migration.issues.length > 0){
                logger.warn(`[InventoryStorage] characterId ${CharacterId} still has ${Migration.issues.length} stacked non-stackable entr${Migration.issues.length === 1 ? "y" : "ies"} requiring manual review`);
            }
            return Updated;
        }

        logger.warn(`[InventoryStorage] revision conflict repairing characterId ${CharacterId}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    throw new Error(`Inventory storage reconciliation for characterId ${CharacterId} failed after ${MAX_ATTEMPTS} revision-conflict retries`);
}

export async function GetInventoryForUserIdAndCharacterId(UserId: string, CharacterId: string){
    if(!await DoesInventoryBelongToUserId(UserId, CharacterId)){ // TODO: HACK: Get rid of this ugly thing, this is a workaround as we don't have a userId on our inventories table
        return undefined;
    }

    // [hardening 2026-07-14] All DEV_USER_ID special-casing removed per explicit instruction.
    // This resync branch previously forced the dev account's inventory row back to
    // dev_inventory.json's fixed contents on EVERY read, which is exactly the "continuously
    // resetting from JSON is not a safety mechanism - it prevents progression" problem: any real
    // grant/spend persisted by RunInventoryTransaction would be silently overwritten back to the
    // frozen baseline the next time this ran. The account (now migrated to Mongo via a one-time
    // migration script, dev_inventory.json no longer loaded at runtime) is read through the exact
    // same path as every other account below - Mongo is the only runtime authority now.

    // Recovery creates an absent inventory/loadout document. With both present it only appends
    // missing starter default weapon parts; after that one-time v1-to-v2 reconciliation, repeated
    // GETs are transactional no-ops and cannot reset progression, equipment, or loadout choices.
    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const InventoryFromDb = await EnsureInventoryStoragePolicyConsistency(UserId, CharacterId);


    return {
        characterId: CharacterId,
        instancedItems: JSON.parse(InventoryFromDb!.instancedItems),
        stackedItems: await MergeWalletIntoStacked(UserId, JSON.parse(InventoryFromDb!.stackedItems))
    };
}
