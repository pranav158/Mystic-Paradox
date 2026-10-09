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
import { GetRepositories, RepositoryProvider } from "../persistence";
import { IsValidEntitlementName } from "../persistence/contracts/EntitlementRepository";
import { logger } from "../logger";

const NO_PLAYER_SENTINEL = "INVALID";

// [2026-07-30] Entitlements are the third grant kind a Dauntless store SKU can carry (alongside
// inventory items and progression), and until now the only one with no implementation at all -
// GET /entitlementsv2 was a stub returning an empty payload. They matter beyond cosmetics: an
// entitlement is also how Hunt Pass Premium ownership is expressed, which
// Progress/30_REWARD_CACHE_STORE.md identified as the blocker for honouring the season track's
// `premium_rewards` rate ("no such entitlement/purchase tracking exists anywhere in this codebase
// yet").
//
// Response shape is the real captured one (DauntlessEndpointDocumentation/Auth/GetEntitlements.md):
// `{"entitlements": [{activatedDate, duration, name}, ...]}`, sorted by name exactly as the capture
// presents it. Our audit fields (grantedAt/sourceSkuId) are deliberately NOT serialized.
export type EntitlementGrant = { name: string; duration?: number };

export async function GetEntitlementsForUser(userId: string): Promise<{ activatedDate: string | null; duration: number; name: string }[]> {
    if (!userId || userId === NO_PLAYER_SENTINEL) return [];

    const Record = await GetRepositories().entitlements.findByUserId(userId);
    if (Record == undefined) return [];

    return Record.entitlements
        .map((Entitlement) => ({
            activatedDate: Entitlement.activatedDate ?? null,
            duration: Entitlement.duration ?? 0,
            name: Entitlement.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function DoesUserHoldEntitlement(userId: string, name: string): Promise<boolean> {
    if (!userId || userId === NO_PLAYER_SENTINEL) return false;

    const Record = await GetRepositories().entitlements.findByUserId(userId);
    return (Record?.entitlements ?? []).some((Entitlement) => Entitlement.name === name);
}

/**
 * Grants entitlements inside an existing transaction (the store purchase path passes its session, so
 * the grant either commits with the currency debit or not at all).
 *
 * Each grant is individually idempotent at the repository level, so a replayed purchase cannot
 * duplicate an entry. Returns only the names this call actually added, for logging - an
 * already-held entitlement is a normal, non-error outcome.
 */
export async function GrantEntitlementsInTransaction(repos: RepositoryProvider, userId: string, grants: EntitlementGrant[], sourceSkuId: string | undefined, session: ClientSession): Promise<string[]> {
    if (!userId || userId === NO_PLAYER_SENTINEL || !Array.isArray(grants) || grants.length === 0) {
        return [];
    }

    const Added: string[] = [];
    for (const Grant of grants) {
        const Name = Grant?.name;
        if (!IsValidEntitlementName(Name)) {
            // Refuse rather than skip silently: an unparseable entitlement name in vendored SKU data
            // is a data defect, and aborting the transaction surfaces it instead of selling a
            // player something that grants nothing.
            throw new Error(`Refusing entitlement grant for ${userId}: unsafe or missing entitlement name ${JSON.stringify(Name)}`);
        }

        const Duration = Number(Grant.duration ?? 0) || 0;
        // Every store entitlement captured so far is permanent (`duration: 0`, `activatedDate: null`).
        // A non-zero duration is stamped with an activation time so an expiry evaluator has what it
        // needs later; nothing evaluates expiry today.
        const ActivatedDate = Duration > 0 ? new Date().toISOString() : null;

        const Result = await repos.entitlements.grantIfMissing(userId, Name, Duration, ActivatedDate, sourceSkuId, session);
        if (Result.granted) {
            Added.push(Name);
        }
    }

    if (Added.length > 0) {
        logger.info(`[Entitlement] ${userId} granted ${Added.join(", ")}${sourceSkuId ? ` (sku=${sourceSkuId})` : ""}`);
    }

    return Added;
}
