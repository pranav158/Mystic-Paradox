/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../../logger";
import { GetP2PRepositories } from "../persistence";
import { HubPartyKey, IsRealmHub, PresencePurgeAt, REALM_HUB_KINDS } from "../realm/realmHubRules";
import { InvalidateHubPresence } from "../security/hostCapabilities";

// [2026-10-14 realms S3, design section 4.7] Travel from a realm's hub into one of its realm hunts. The member is admitted to the
// hunt (its ticket consumed); its presence in the realm's hub ends (ADMITTED -> LEFT, TRAVEL), the host stops the member's hub
// link, and the member's launcher stops its hub join. Hunt -> hub is the ordinary entry (NoteHubReturn, then the hub's entry).

/** Ends the member's presence in the realm's hubs once it has been admitted into a realm hunt. Returns how many hubs it left. */
export async function OnRealmHuntAdmitted(accountId: string, realmId: string, now = new Date()): Promise<number> {
    const repos = GetP2PRepositories();
    const at = now.toISOString();
    let left = 0;
    for (const kind of REALM_HUB_KINDS) {
        const hub = await repos.p2pHunts.findActiveHuntForParty(HubPartyKey(realmId, kind));
        if (hub == undefined || !IsRealmHub(hub) || hub.hostAccountId === accountId) continue;
        const row = await repos.realmHub.markLeft({
            sessionId: hub.sessionId, generation: hub.generation, accountId, reason: "TRAVEL", leftAt: at, purgeAt: PresencePurgeAt(now.getTime())
        });
        if (row == undefined) continue;
        left += 1;
        const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
        await repos.p2pHunts.enqueueControlMessage({
            accountId: hub.hostAccountId, messageType: "REALM_PEER_EXPECTED", sessionId: hub.sessionId, generation: hub.generation,
            payload: { sessionId: hub.sessionId, generation: hub.generation }, createdAt: at, expiresAt
        });
        await repos.p2pHunts.enqueueControlMessage({
            accountId, messageType: "REALM_SESSION_LEAVE", sessionId: hub.sessionId, generation: hub.generation,
            payload: { sessionId: hub.sessionId, generation: hub.generation, reason: "TRAVEL", hubKind: hub.hubKind, realmId },
            createdAt: at, expiresAt
        });
        InvalidateHubPresence(hub.sessionId);
        logger.info({ event: "realm_hub_travel", sessionId: hub.sessionId, realmId, hubKind: hub.hubKind },
            `[RealmHub] member left ${hub.hubKind} hub ${hub.sessionId} for a realm hunt (TRAVEL)`);
    }
    return left;
}

/** The travel hook of a realm hunt's admission (ConsumeAdmissionTicket calls it after its transaction). */
export const RealmHubTravel = { onHuntAdmitted: OnRealmHuntAdmitted };
