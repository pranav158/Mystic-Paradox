/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { LauncherApiError, RealmEntryError } from "./realmErrors";
import { ParseEntryRealm } from "./realmInput";
import { IsRealmsModuleEnabled } from "./realmsConfig";
import { GetRealmsService } from "./realmsInstance";
import { RealmsService } from "./realmsService";

// [2026-10-13 realms hub design section 2.1] The two places the rest of the Metagame touches the realms module: Play with a
// realm (controllers/launcherAuth.ts RequestGameExchangeCode) and the game login that consumes the code (routes/eos.ts). Both take
// their dependencies as optional parameters so they are tested without MongoDB and without the environment.

export interface RealmEntryDeps {
    enabled?: () => boolean;
    service?: () => Pick<RealmsService, "authorizeEntry">;
}

/**
 * The `realm` of POST /launcher/v1/game-sessions. Without one (absent or null) it answers undefined and nothing about Play changes.
 * With one: the module must be on (REALMS_DISABLED otherwise - a request that names a realm is never played as official), the
 * body must be valid, and the account must be allowed to enter (any REALM_* refusal is thrown as the route's launcher error).
 * Success names the realm the exchange code will carry.
 */
export async function AuthorizeGameSessionRealm(
    accountId: string,
    rawRealm: unknown,
    deps: RealmEntryDeps = {}
): Promise<{ realmId: string; isHost: boolean } | undefined> {
    if (rawRealm === undefined || rawRealm === null) return undefined;
    if (!(deps.enabled ?? (() => IsRealmsModuleEnabled()))()) {
        throw new LauncherApiError("REALMS_DISABLED", "Realms are not available on this server.");
    }
    const parsed = ParseEntryRealm(rawRealm);
    if (!parsed.ok) throw new LauncherApiError(parsed.code, parsed.message);
    const decision = await (deps.service ?? GetRealmsService)().authorizeEntry(accountId, parsed.value);
    if (!decision.ok) throw RealmEntryError(decision.code);
    logger.info(`[Realms] game session authorized realmId=${decision.realmId} host=${decision.isHost}`);
    return { realmId: decision.realmId, isHost: decision.isHost };
}

export interface RealmBindDeps {
    enabled?: () => boolean;
    service?: () => Pick<RealmsService, "bindPresence">;
}

/**
 * The authoritative bind at game login (routes/eos.ts): the consumed exchange code's realm (or none) becomes the account's realm
 * presence, so every login resets the context and an official Play can never keep a stale or spoofed realm. With the module off it
 * does nothing. A failure to RESET (no realm) is logged and the login goes on; a failure to BIND a realm throws, because a login
 * that meant a realm must not quietly continue as official play.
 */
export async function BindRealmPresenceAtLogin(
    accountId: string,
    realmId: string | null | undefined,
    deps: RealmBindDeps = {}
): Promise<void> {
    if (!(deps.enabled ?? (() => IsRealmsModuleEnabled()))()) return;
    const service = (deps.service ?? GetRealmsService)();
    if (realmId === undefined || realmId === null) {
        try {
            await service.bindPresence(accountId, null);
        } catch (error) {
            logger.warn(`[Realms] could not reset realm presence at login: ${error}`);
        }
        return;
    }
    await service.bindPresence(accountId, realmId);
}
