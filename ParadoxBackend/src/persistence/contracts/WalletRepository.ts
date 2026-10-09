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
import { WalletRecord } from "../mapping/domainTypes";

// A balance catalogId is interpolated into a Mongo update field PATH (`balances.<catalogId>`) and
// into a query filter key. It MUST be validated before use so it can never introduce a dotted
// sub-path (`balances.a.b`), a `$`-prefixed operator-like key, or any other field-path/injection
// vector. Restrict to a strict identifier charset with a sane length bound. This is the single
// source of truth used by both the controller (early reject) and the Mongo repo (authoritative
// guard at the actual injection point).
const SAFE_BALANCE_FIELD = /^[A-Za-z0-9_]+$/;
export function IsValidBalanceCatalogId(catalogId: unknown): catalogId is string {
    return typeof catalogId === "string" && catalogId.length > 0 && catalogId.length <= 128 && SAFE_BALANCE_FIELD.test(catalogId);
}

// Repository contract for the `wallets` collection.
//
// [hardening] balances is a real BSON number-field subdocument (see WalletRecord), and mutation
// is atomic ($inc with a query-filter guard), never a read-modify-write JSON blob replace. This
// closes a real lost-update race: two concurrent AddCurrency calls for the same user/catalogId
// used to read the same starting balance, compute independently, and the second writer's full
// blob replace would silently clobber the first writer's result.
export interface WalletRepository {
    findByUserId(userId: string, session?: ClientSession): Promise<WalletRecord | undefined>;

    create(wallet: WalletRecord, session?: ClientSession): Promise<void>;

    /**
     * Atomically creates the wallet only when it is missing. Existing wallets are returned
     * unchanged, which lets character bootstrap adopt a balance row created earlier by a
     * balance request without a duplicate-key failure or a starter-balance reset.
     */
    createIfMissing(wallet: WalletRecord, session?: ClientSession): Promise<WalletRecord>;

    /**
     * Atomically applies `delta` to `balances[catalogId]` via Mongo's native $inc — never a
     * read-modify-write. When `delta` is negative, the update is filtered so it only applies if
     * the current balance is >= `-delta` (i.e. never lets a balance go negative); if the filter
     * doesn't match (insufficient funds, or the wallet doesn't exist yet), returns `undefined`
     * instead of applying anything, so the caller can reject the request rather than silently
     * clamping to zero.
     */
    incrementBalance(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<WalletRecord | undefined>;

    /**
     * One-time, idempotent migration hook: if a wallet's `balances` field is still the legacy
     * JSON-string blob (pre-hardening shape), parses it and rewrites it as a real BSON number
     * subdocument in place. No-ops if the document is already in the new shape or doesn't exist.
     * Called once at startup (see persistence/mongo/indexes.ts) — never from request handlers.
     */
    migrateLegacyStringBalances(userId: string): Promise<void>;
}
