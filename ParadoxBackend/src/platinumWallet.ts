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

// [2026-07-30] Platinum is the only currency in the 1.12 catalog that is stored as MANY ledgers but
// displayed as ONE number. See Progress/33_PLATINUM_STORE.md for the full derivation; the short
// version, all verified rather than assumed:
//
//  - Items_Analysis/catalog_1_12.jsonl contains 13 `CURRENCY_PLATINUM*` rows, all sharing one display
//    name ("Platinum"), one icon and one rarity. The suffixes are real-money accounting buckets:
//    which storefront took the payment (_EPIC/_XBOX/_PSN/_SWITCH/_PLATFORM), whether the grant was
//    paid or promotional (`_BONUS`), universal/non-platform (_UNIV) and customer-support (_CS).
//  - The client displays exactly ONE key. AArchonPlayerController::GetCharacterPlatinumAmount and
//    UArchonUserWidget::GetCachedCharacterPlatinumAmount both read IOnlineStoreExt's last queried
//    balances, and the response-parse path (Ghidra FUN_141afd4f0) constructs the literal
//    L"CURRENCY_PLATINUM" and indexes the parsed balance map with that single key. The real 2.1.1
//    /balance and /reconcile captures agree: they carry `CURRENCY_PLATINUM`/`id_currency_platinum`
//    and no per-platform keys at all. So the server holds the split and publishes the aggregate.
//  - Our own progression_config.json already grants platinum as CURRENCY_PLATINUM_UNIV (431 reward
//    entries), and that has fired in production: `[Wallet] ... CURRENCY_PLATINUM_UNIV +50 -> 50`
//    (2026-07-26 capture). Before this module, that player's UI showed 0 platinum, because
//    /balance hardcoded `CURRENCY_PLATINUM: 0` and the wallet overlay only echoed keys that
//    literally existed in the wallet.
//
// This module is pure (no Mongo, no I/O) so the aggregation and spend-resolution rules are unit
// testable on their own; controllers/wallet.ts is the only caller that touches the database.

export const PLATINUM_AGGREGATE_ID = "CURRENCY_PLATINUM";

// Spend order, most-disposable first. Promotional/granted platinum is consumed before anything a
// real payment produced, so a paid bucket is only ever drawn down once the free balances are gone.
// That ordering is a deliberate accounting choice for this server (nothing in the client depends on
// it - the client only ever sees the aggregate), and it keeps the paid ledgers meaningful if a
// platform refund/reconciliation question is ever asked of them.
export const PLATINUM_SPEND_ORDER: readonly string[] = [
    "CURRENCY_PLATINUM_CS",
    "CURRENCY_PLATINUM_UNIV",
    "CURRENCY_PLATINUM_PLATFORM_BONUS",
    "CURRENCY_PLATINUM_EPIC_BONUS",
    "CURRENCY_PLATINUM_XBOX_BONUS",
    "CURRENCY_PLATINUM_PSN_BONUS",
    "CURRENCY_PLATINUM_SWITCH_BONUS",
    PLATINUM_AGGREGATE_ID,
    "CURRENCY_PLATINUM_PLATFORM",
    "CURRENCY_PLATINUM_EPIC",
    "CURRENCY_PLATINUM_XBOX",
    "CURRENCY_PLATINUM_PSN",
    "CURRENCY_PLATINUM_SWITCH",
];

// Every id above is a real 1.12 catalog row; this set is what "is this platinum?" means everywhere
// else. Kept as a Set so a stray CURRENCY_PLATINUM-prefixed id that ISN'T in the catalog (a typo in
// vendored reward data, say) is not silently treated as spendable platinum.
const PLATINUM_IDS = new Set<string>(PLATINUM_SPEND_ORDER);

export function IsPlatinumCatalogId(catalogId: string): boolean {
    return PLATINUM_IDS.has(catalogId);
}

/** Total spendable platinum across every bucket - what the client is shown. */
export function SumPlatinum(balances: Record<string, number>): number {
    let Total = 0;
    for (const Id of PLATINUM_SPEND_ORDER) {
        const Amount = balances[Id];
        if (typeof Amount === "number" && Number.isFinite(Amount)) {
            Total += Amount;
        }
    }
    return Total;
}

export type PlatinumSpend =
    | { ok: true; deltas: { catalogId: string; delta: number }[] }
    | { ok: false; available: number; requested: number };

/**
 * Resolves a platinum debit into per-bucket deltas, drawing down PLATINUM_SPEND_ORDER until the
 * amount is covered. Returns ok:false (never a partial plan) when the total across all buckets is
 * short, so the caller rejects instead of overdrawing one ledger.
 *
 * The plan is computed from a balance snapshot. controllers/wallet.ts applies each delta through
 * the same guarded `$inc` every other debit uses, inside the caller's Mongo transaction - so a
 * concurrent spend that invalidates the snapshot fails that one bucket's guard and aborts the whole
 * transaction rather than driving a balance negative.
 */
export function ResolvePlatinumSpend(balances: Record<string, number>, amount: number): PlatinumSpend {
    const Requested = Math.trunc(amount);
    if (!Number.isFinite(Requested) || Requested <= 0) {
        return { ok: true, deltas: [] };
    }

    const Available = SumPlatinum(balances);
    if (Available < Requested) {
        return { ok: false, available: Available, requested: Requested };
    }

    const Deltas: { catalogId: string; delta: number }[] = [];
    let Outstanding = Requested;
    for (const Id of PLATINUM_SPEND_ORDER) {
        if (Outstanding <= 0) break;
        const Held = balances[Id];
        if (typeof Held !== "number" || !Number.isFinite(Held) || Held <= 0) continue;
        const Take = Math.min(Held, Outstanding);
        Deltas.push({ catalogId: Id, delta: -Take });
        Outstanding -= Take;
    }
    return { ok: true, deltas: Deltas };
}

/**
 * Projects a wallet into the /balance + /reconcile response shape: every stored currency under both
 * naming forms (`CURRENCY_X` and `id_currency_x`), then the platinum aggregate written over both of
 * its forms so the client's single-key read reflects the sum of the buckets.
 *
 * Pure, and applied identically by GET /balance and POST /reconcile so the two can never disagree.
 */
export function ProjectBalances(balances: Record<string, number>, base: Record<string, number> = {}): Record<string, number> {
    const Out: Record<string, number> = { ...base };

    for (const [CatalogId, Amount] of Object.entries(balances)) {
        Out[CatalogId] = Amount;
        Out["id_currency_" + CatalogId.replace(/^CURRENCY_/, "").toLowerCase()] = Amount;
    }

    // Only overwrite when the wallet actually holds platinum somewhere, so an account with none
    // keeps whatever the caller's base dict said (the captured stub reports 0) instead of this
    // projection inventing a key on every response.
    const PlatinumTotal = SumPlatinum(balances);
    if (PlatinumTotal !== 0 || PLATINUM_AGGREGATE_ID in balances) {
        Out[PLATINUM_AGGREGATE_ID] = PlatinumTotal;
        Out["id_currency_platinum"] = PlatinumTotal;
    }

    return Out;
}
