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

import { DocTable } from "./docTable";

// The tables the repositories use, named exactly like the MongoDB collections (see mongo/collections.ts).
export const Tables = {
    accounts: new DocTable("accounts"),
    characters: new DocTable("characters"),
    inventories: new DocTable("inventories"),
    loadouts: new DocTable("loadouts"),
    wallets: new DocTable("wallets"),
    playerJourney: new DocTable("playerJourney"),
    breadcrumbs: new DocTable("breadcrumbs"),
    encounteredContent: new DocTable("encounteredContent"),
    gameServerApiKeys: new DocTable("gameServerApiKeys"),
    userApiKeys: new DocTable("userApiKeys"),
    progressionTracks: new DocTable("progressionTracks"),
    progressionObjectives: new DocTable("progressionObjectives"),
    progressionObjectiveEvents: new DocTable("progressionObjectiveEvents"),
    progressionTransactions: new DocTable("progressionTransactions"),
    escalationProgress: new DocTable("escalationProgress"),
    bountyStates: new DocTable("bountyStates"),
    cooldownStates: new DocTable("cooldownStates"),
    economyDaily: new DocTable("economyDaily"),
    playerActivityDaily: new DocTable("playerActivityDaily"),
    activityHunts: new DocTable("activityHunts"),
    slayersPathUnlocks: new DocTable("slayersPathUnlocks"),
    activityFlags: new DocTable("activityFlags"),
    inventoryTransactions: new DocTable("inventoryTransactions"),
    authIdentities: new DocTable("authIdentities"),
    refreshSessions: new DocTable("refreshSessions"),
    gameExchangeCodes: new DocTable("gameExchangeCodes"),
    discordOAuthTransactions: new DocTable("discordOAuthTransactions"),
    emailCodes: new DocTable("emailCodes"),
    adminSessions: new DocTable("adminSessions"),
    adminAudit: new DocTable("adminAudit"),
    friendships: new DocTable("friendships"),
    launcherGuardSessions: new DocTable("launcherGuardSessions"),
    guardFindings: new DocTable("guardFindings"),
    operationsPolicy: new DocTable("operationsPolicy"),
    // [2026-10-15] The launcher notices singleton (_id "current"), as launcherNotices in MongoDB.
    launcherNotices: new DocTable("launcherNotices"),
    entitlements: new DocTable("entitlements"),
    parties: new DocTable("parties"),
    partyMemberships: new DocTable("partyMemberships"),
    partyInvites: new DocTable("partyInvites"),
    partyOutbox: new DocTable("partyOutbox")
} as const;

/** `<field> IS NULL` in the "null or missing" sense of a MongoDB `{ field: null }` filter. */
export function IsNullOrMissing(field: string): string {
    return `json_extract(doc, '$.${field}') IS NULL`;
}

/** The "field is absent" sense of `{ field: { $exists: false } }` (a stored null does NOT count as absent). */
export function IsAbsent(field: string): string {
    return `json_type(doc, '$.${field}') IS NULL`;
}

/** The "field is present" sense of `{ field: { $exists: true } }` (a stored null counts as present). */
export function IsPresent(field: string): string {
    return `json_type(doc, '$.${field}') IS NOT NULL`;
}
