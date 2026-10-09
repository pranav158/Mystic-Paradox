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
import { EntitlementRecord } from "../mapping/domainTypes";

// Entitlement names are stored as ARRAY ELEMENT VALUES, never as field names - deliberately unlike
// the wallet's `balances.<catalogId>` subdocument. The real names captured from the live service
// include hyphens (`gauntlet-season01_top_100`), so a field-name representation would need a laxer
// charset than IsValidBalanceCatalogId allows at exactly the point where field-path injection
// matters. An array of `{name, ...}` records sidesteps that entirely: the name is only ever a value
// in a filter/`$push`, so no name can introduce a dotted path or a `$`-prefixed operator key.
//
// The bound and charset below are therefore about data hygiene, not injection defence.
const SAFE_ENTITLEMENT_NAME = /^[A-Za-z0-9_.-]+$/;
export function IsValidEntitlementName(name: unknown): name is string {
    return typeof name === "string" && name.length > 0 && name.length <= 128 && SAFE_ENTITLEMENT_NAME.test(name);
}

// Repository contract for the `entitlements` collection. _id = userId.
//
// Shape follows the real captured response (DauntlessEndpointDocumentation/Auth/GetEntitlements.md):
// each entitlement is `{name, duration, activatedDate}`. `duration: 0` with `activatedDate: null` is
// the permanent case and covers every store SKU captured so far; the one timed entitlement observed
// anywhere (`exchange_slot_2`, `duration: 2400000`) carries a real `activatedDate`. Duration is
// persisted faithfully, but nothing evaluates expiry yet - see Progress/33_PLATINUM_STORE.md.
export interface EntitlementRepository {
    findByUserId(userId: string, session?: ClientSession): Promise<EntitlementRecord | undefined>;

    /**
     * Atomically creates the entitlement document only when missing, returning the existing one
     * unchanged otherwise. Same adopt-don't-reset contract as WalletRepository.createIfMissing.
     */
    createIfMissing(userId: string, session?: ClientSession): Promise<EntitlementRecord>;

    /**
     * Appends `name` only if the user does not already hold it, and reports which happened.
     *
     * Idempotent by construction: the update filters on `entitlements.name != name`, so a repeat
     * grant matches nothing and returns `granted: false` rather than duplicating the entry. This is
     * what makes a replayed store purchase safe even though the entitlement grant is not itself part
     * of the inventory idempotency ledger's stored result.
     */
    grantIfMissing(userId: string, name: string, duration: number, activatedDate: string | null, sourceSkuId: string | undefined, session?: ClientSession): Promise<{ granted: boolean }>;
}
