/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

export interface EconomyRollupKey {
    userId: string;
    /** UTC day, YYYY-MM-DD. */
    day: string;
    /** The currency (CURRENCY_PLATINUM for every Platinum bucket) or the Hunt Pass reward's catalog id. */
    currency: string;
}

/**
 * Per-account, per-day economy totals written by diagnostics/economyLedgerMonitor.ts. Monitoring only: nothing reads these
 * rows to decide a grant. One document per key, `_id` = `${userId}:${day}:${currency}`.
 */
export interface EconomyRollupRepository {
    /**
     * Adds `increments` (dotted field paths to numbers, e.g. "bySource.STORE.debited") to one key's document, creating it
     * when absent, and returns the document as it is after this write (atomic, so the caller sees its own before/after).
     * `ttlAt` is the time after which the storage may purge the row.
     */
    addToRollup(key: EconomyRollupKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>>;
}
