/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetP2PRepositories, P2PHuntSessionRecord } from "../persistence";
import { HubPartyKey, IsRealmHub, REALM_HUB_KINDS } from "../realm/realmHubRules";
import { GetRealmsPort } from "../realm/realmsPort";
import { LauncherApiError } from "../security/p2pErrors";

// [2026-10-14 realms S3, design section 6.2] GET /launcher/v1/realm-hosting/status: what the realm host's panel shows, read from the
// hub presence rows (ADMITTED) and the realm hunts' rosters (ADMITTED). The launcher codes against exactly these camelCase names.

export interface RealmHubStatusView {
    sessionId: string;
    state: string;
    startedAt: string;
    players: number;
}

export interface RealmHuntStatusView {
    sessionId: string;
    huntId: string;
    state: string;
    players: number;
}

export interface RealmPlayerStatusView {
    accountId: string;
    displayName: string | null;
    where: { kind: "HUB" | "TRAINING" | "HUNT"; sessionId: string; huntId?: string };
    since: string;
    route?: "relay" | "direct";
}

export interface RealmHostingStatusView {
    realm: { name: string; serving: boolean };
    hub: RealmHubStatusView | null;
    training: RealmHubStatusView | null;
    hunts: RealmHuntStatusView[];
    players: RealmPlayerStatusView[];
}

/** The host's panel status. Only the realm's host may read it (REALM_NOT_FOUND otherwise). */
export async function GetRealmHostingStatus(accountId: string): Promise<RealmHostingStatusView> {
    const realms = GetRealmsPort();
    const realm = await realms.findHostedRealm(accountId);
    if (realm == undefined || realm.hostAccountId !== accountId) throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
    const repos = GetP2PRepositories();
    const names = await realms.memberDisplayNames(accountId);
    const players: RealmPlayerStatusView[] = [];

    const hubs: Partial<Record<"RAMSGATE" | "TRAINING", RealmHubStatusView | null>> = {};
    for (const kind of REALM_HUB_KINDS) {
        const hub = await repos.p2pHunts.findActiveHuntForParty(HubPartyKey(realm.realmId, kind));
        if (hub == undefined || !IsRealmHub(hub)) {
            hubs[kind] = null;
            continue;
        }
        const rows = await repos.realmHub.listByState(hub.sessionId, hub.generation, ["ADMITTED"], 256);
        hubs[kind] = {
            sessionId: hub.sessionId,
            state: hub.state,
            startedAt: hub.hostLocalBridgeReadyAt ?? hub.createdAt,
            players: rows.length
        };
        for (const row of rows) {
            players.push({
                accountId: row.accountId,
                displayName: names.get(row.accountId) ?? null,
                where: { kind: kind === "TRAINING" ? "TRAINING" : "HUB", sessionId: hub.sessionId },
                since: row.admittedAt ?? row.requestedAt,
                ...(row.route !== undefined ? { route: row.route } : {})
            });
        }
    }

    const liveHunts = await repos.p2pHunts.listLiveRealmHunts(realm.realmId, accountId);
    const hunts: RealmHuntStatusView[] = liveHunts.map((hunt: P2PHuntSessionRecord) => {
        const admitted = hunt.roster.filter((entry) => entry.admissionState === "ADMITTED");
        for (const entry of admitted) {
            players.push({
                accountId: entry.accountId,
                displayName: names.get(entry.accountId) ?? null,
                where: { kind: "HUNT", sessionId: hunt.sessionId, huntId: hunt.huntDefinitionId },
                since: entry.localBridgeReadyAt ?? hunt.createdAt
            });
        }
        return { sessionId: hunt.sessionId, huntId: hunt.huntDefinitionId, state: hunt.state, players: admitted.length };
    });

    return {
        realm: { name: realm.name ?? "", serving: realm.serving === true },
        hub: hubs.RAMSGATE ?? null,
        training: hubs.TRAINING ?? null,
        hunts,
        players
    };
}
