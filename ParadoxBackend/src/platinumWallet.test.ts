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

import test from "node:test";
import assert from "node:assert/strict";
import {
    PLATINUM_AGGREGATE_ID,
    IsPlatinumCatalogId,
    ProjectBalances,
    ResolvePlatinumSpend,
    SumPlatinum,
} from "./platinumWallet";

// The exact live case from the 2026-07-26 capture: a Hunt Pass rank paid out
// `CURRENCY_PLATINUM_UNIV +50` and the client showed 0, because nothing aggregated the buckets.
test("hunt pass platinum granted to the _UNIV bucket is displayed as CURRENCY_PLATINUM", () => {
    const Projected = ProjectBalances({ CURRENCY_PLATINUM_UNIV: 50 }, { CURRENCY_PLATINUM: 0, id_currency_platinum: 0 });

    assert.equal(Projected.CURRENCY_PLATINUM, 50);
    assert.equal(Projected.id_currency_platinum, 50);
    // the bucket itself is still reported verbatim under both naming forms
    assert.equal(Projected.CURRENCY_PLATINUM_UNIV, 50);
    assert.equal(Projected.id_currency_platinum_univ, 50);
});

test("aggregate sums every bucket, paid and promotional alike", () => {
    const Wallet = {
        CURRENCY_PLATINUM: 5,
        CURRENCY_PLATINUM_UNIV: 50,
        CURRENCY_PLATINUM_PLATFORM: 1000,
        CURRENCY_PLATINUM_PLATFORM_BONUS: 150,
        CURRENCY_PLATINUM_EPIC: 200,
        CURRENCY_NOTES: 6200,
    };

    assert.equal(SumPlatinum(Wallet), 1405);
    assert.equal(ProjectBalances(Wallet).CURRENCY_PLATINUM, 1405);
    // unrelated currencies are untouched by the platinum projection
    assert.equal(ProjectBalances(Wallet).CURRENCY_NOTES, 6200);
});

test("an account with no platinum keeps the captured stub value instead of gaining an invented key", () => {
    const Projected = ProjectBalances({ CURRENCY_NOTES: 5000 }, { CURRENCY_PLATINUM: 0, id_currency_platinum: 0 });

    assert.equal(Projected.CURRENCY_PLATINUM, 0);
    assert.equal(Projected.id_currency_platinum, 0);
});

test("spend consumes promotional buckets before anything a payment produced", () => {
    const Plan = ResolvePlatinumSpend(
        { CURRENCY_PLATINUM_PLATFORM: 1000, CURRENCY_PLATINUM_UNIV: 50, CURRENCY_PLATINUM_CS: 25 },
        60
    );

    assert.equal(Plan.ok, true);
    assert.deepEqual(Plan.ok && Plan.deltas, [
        { catalogId: "CURRENCY_PLATINUM_CS", delta: -25 },
        { catalogId: "CURRENCY_PLATINUM_UNIV", delta: -35 },
    ]);
    // the paid bucket was not touched at all
    assert.equal(Plan.ok && Plan.deltas.some((d) => d.catalogId === "CURRENCY_PLATINUM_PLATFORM"), false);
});

test("spend spills into paid buckets only once the free balances are exhausted", () => {
    const Plan = ResolvePlatinumSpend({ CURRENCY_PLATINUM_UNIV: 50, CURRENCY_PLATINUM_PLATFORM: 1000 }, 250);

    assert.equal(Plan.ok, true);
    assert.deepEqual(Plan.ok && Plan.deltas, [
        { catalogId: "CURRENCY_PLATINUM_UNIV", delta: -50 },
        { catalogId: "CURRENCY_PLATINUM_PLATFORM", delta: -200 },
    ]);
});

test("an exact-total spend drains every bucket and leaves zero", () => {
    const Wallet = { CURRENCY_PLATINUM_UNIV: 50, CURRENCY_PLATINUM_EPIC_BONUS: 100, CURRENCY_PLATINUM_EPIC: 100 };
    const Plan = ResolvePlatinumSpend(Wallet, 250);

    assert.equal(Plan.ok, true);
    const Applied = { ...Wallet };
    for (const Delta of Plan.ok ? Plan.deltas : []) {
        Applied[Delta.catalogId as keyof typeof Applied] += Delta.delta;
    }
    assert.equal(SumPlatinum(Applied), 0);
});

test("an overdraw is rejected outright, never planned as a partial debit", () => {
    const Plan = ResolvePlatinumSpend({ CURRENCY_PLATINUM_UNIV: 50, CURRENCY_PLATINUM_CS: 25 }, 100);

    assert.equal(Plan.ok, false);
    assert.deepEqual(Plan, { ok: false, available: 75, requested: 100 });
});

// A store SKU priced in `id_currency_platinum` maps to the aggregate id, which must be recognised as
// platinum so ApplyCurrencyDeltas routes it to the bucket-splitting path.
test("the aggregate id and every bucket are recognised as platinum; look-alikes are not", () => {
    assert.equal(IsPlatinumCatalogId(PLATINUM_AGGREGATE_ID), true);
    assert.equal(IsPlatinumCatalogId("CURRENCY_PLATINUM_UNIV"), true);
    assert.equal(IsPlatinumCatalogId("CURRENCY_PLATINUM_SWITCH_BONUS"), true);
    // not a 1.12 catalog row - must not be treated as spendable platinum
    assert.equal(IsPlatinumCatalogId("CURRENCY_PLATINUM_STEAM"), false);
    assert.equal(IsPlatinumCatalogId("ID_CURRENCY_PLATINUM"), false);
    assert.equal(IsPlatinumCatalogId("CURRENCY_NOTES"), false);
});
