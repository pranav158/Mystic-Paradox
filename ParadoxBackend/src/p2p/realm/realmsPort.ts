/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { RealmHubKind } from "../persistence/contracts/RealmHubRepository";

// [2026-10-13 realms S1] What the p2p module calls on the realms module (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md
// section 2.4), as a narrow interface. The dependency is one-way: p2p calls realms, realms never imports p2p (it tells p2p
// about members, releases and offline hosts through an event sink instead). Everything in the p2p module reaches the realms
// service through GetRealmsPort(), so the wiring to the real service is this file and nothing else (the event sink is installed
// from p2p/index.ts through InstallRealmEventSink below), and the tests inject a fake with SetRealmsPort().

/** A realm as the p2p module needs it. */
export interface RealmSummary {
    realmId: string;
    hostAccountId: string;
    name?: string;
    /** What the host reported with its heartbeat (advisory); absent until it did. */
    hosting?: { maxServers?: number; maxPlayers?: number; afkSeconds?: number };
    /** The host's launcher reported in within the last 90 s (realms IsRealmOnline). */
    online?: boolean;
    /** Online and the realm's Ramsgate hub running (realms IsRealmServing): the realm can be entered and hunted from. */
    serving?: boolean;
    /** [2026-10-16] The realm's join policy; SOLO means only its host may enter, hunt or be routed there. */
    joinPolicy?: string;
}

/** A member's realm context, as presenceOf answers it. */
export interface RealmPresenceView {
    realmId: string;
    boundAt: string;
    lastSeenAt: string;
    expiresAt: string;
}

export type RealmHubState = "NONE" | "STARTING" | "RUNNING" | "STOPPING";

/** The hub fields the p2p module mirrors into the realm (never self-reported by the host). `null` removes hubSessionId. */
export interface RealmHostingPatch {
    hubSessionId?: string | null;
    hubState?: RealmHubState;
    trainingState?: RealmHubState;
    activeServers?: number;
}

export interface RealmsPort {
    /** The realm this account hosts, if any. */
    findHostedRealm(hostAccountId: string): Promise<RealmSummary | undefined>;
    /** A realm by id (undefined when it does not exist). */
    findRealm(realmId: string): Promise<RealmSummary | undefined>;
    /** Display names of the members of the realm the host runs, by account id (a name the directory lacks is absent). */
    memberDisplayNames(hostAccountId: string): Promise<Map<string, string>>;
    /** The realm the account is playing in right now (bound at game login), if any. */
    presenceOf(accountId: string): Promise<RealmPresenceView | undefined>;
    isMember(realmId: string, accountId: string): Promise<boolean>;
    isBanned(realmId: string, accountId: string): Promise<boolean>;
    setHosting(realmId: string, patch: RealmHostingPatch): Promise<void>;
    /** The hub is gone: the realm is not serving until the host starts it again. */
    markOffline(realmId: string): Promise<void>;
    findByHubRoomId(hubRoomId: string): Promise<RealmSummary | undefined>;
    /** The deterministic id of a hub as the game and the chat see it (HubRoomId of the realms module). */
    hubRoomId(realmId: string, hubKind: RealmHubKind): string;
}

/** The realms module as its index exports it (typed against the module, so a change there breaks the build here). */
type RealmsModule = typeof import("../../realms");
type RealmsServiceType = ReturnType<RealmsModule["GetRealmsService"]>;

/** The port over the real realms service: the one place the p2p module touches the realms API (besides the event sink below). */
export function AdaptRealmsService(
    service: Pick<RealmsServiceType, "getRealmByHost" | "getRealm" | "getMine" | "presenceOf" | "isMember" | "isBanned" | "setHosting" |
        "markOffline" | "findByHubRoomId">,
    hubRoomIdOf: (realmId: string, hubKind: RealmHubKind) => string
): RealmsPort {
    const summarize = (realm: Awaited<ReturnType<RealmsServiceType["getRealmByHost"]>>): RealmSummary | undefined => {
        if (realm === undefined) return undefined;
        // The realms module's own rules decide "online" and "serving" (the directory's answer; the host never reports either).
        const realms = require("../../realms") as RealmsModule;
        const nowMs = Date.now();
        return {
            realmId: realm.realmId,
            hostAccountId: realm.hostAccountId,
            name: realm.name,
            hosting: realm.hosting === undefined ? undefined
                : { maxServers: realm.hosting.maxServers, maxPlayers: realm.hosting.maxPlayers, afkSeconds: realm.hosting.afkSeconds },
            online: realms.IsRealmOnline(realm, nowMs),
            serving: realms.IsRealmServing(realm, nowMs),
            joinPolicy: realm.joinPolicy
        };
    };
    return {
        async findHostedRealm(hostAccountId) {
            return summarize(await service.getRealmByHost(hostAccountId));
        },
        async findRealm(realmId) {
            return summarize(await service.getRealm(realmId));
        },
        async memberDisplayNames(hostAccountId) {
            // getMine answers the host's own view, which carries the display names of its members.
            const { hosted } = await service.getMine(hostAccountId);
            const names = new Map<string, string>();
            for (const member of hosted?.members ?? []) {
                if (member.displayName != undefined) names.set(member.accountId, member.displayName);
            }
            return names;
        },
        async presenceOf(accountId) {
            return service.presenceOf(accountId);
        },
        async isMember(realmId, accountId) {
            return service.isMember(realmId, accountId);
        },
        async isBanned(realmId, accountId) {
            return service.isBanned(realmId, accountId);
        },
        async setHosting(realmId, patch) {
            // false means the realm is gone (released); an invalid patch throws and is a bug of the caller.
            await service.setHosting(realmId, patch);
        },
        async markOffline(realmId) {
            await service.markOffline(realmId);
        },
        async findByHubRoomId(hubRoomId) {
            return summarize(await service.findByHubRoomId(hubRoomId));
        },
        hubRoomId: hubRoomIdOf
    };
}

/** What the realms module tells this module about (its RealmEvent): members removed, a realm released, a host that went offline. */
export type RealmEventLike =
    | { type: "MEMBER_REMOVED"; realmId: string; accountId: string; reason: "KICK" | "BAN" | "LEAVE" }
    | { type: "REALM_RELEASED"; realmId: string; hostAccountId: string }
    | { type: "HOST_OFFLINE"; realmId: string; hostAccountId: string };

/**
 * Registers the p2p module's handler with the realms module (`SetRealmEventSink`, section 2.4); `undefined` removes it. The
 * realms module is loaded here, on first use, not when this file is imported.
 */
export function InstallRealmEventSink(handler: ((event: RealmEventLike) => Promise<void>) | undefined): void {
    const realms = require("../../realms") as RealmsModule;
    realms.SetRealmEventSink(handler);
}

let Override: RealmsPort | undefined;
let Default: RealmsPort | undefined;

/** Tests (and any other composition root) replace the port; `undefined` restores the real service. */
export function SetRealmsPort(port: RealmsPort | undefined): void {
    Override = port;
}

/** The realms module's service as a port (GetRealmsService and HubRoomId of src/realms/index.ts), built on first use. */
export function GetRealmsPort(): RealmsPort {
    if (Override != undefined) return Override;
    if (Default == undefined) {
        // Loaded lazily: the p2p module is importable without the realms module being on.
        const realms = require("../../realms") as RealmsModule;
        Default = AdaptRealmsService(realms.GetRealmsService(), realms.HubRoomId);
    }
    return Default;
}
