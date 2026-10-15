/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { GetRepositories } from "../persistence";
import { MongoRealmPresenceRepository, MongoRealmsRepository, ResolveDisplayNamesFromMongo } from "./persistence/mongo/MongoRealmsRepository";
import { CreateRealmsService, RealmsService } from "./realmsService";
import { ReadRealmLimits } from "./realmsConfig";
import { RealmEvent } from "./realmTypes";

// [2026-10-13 realms hub design section 2.3-2.4] The module's one service on the shared MongoDB, the event sink the p2p module
// registers, and the 15 s sweeper. Kept apart from index.ts so entry.ts can use the service without importing the module's entry.

let CachedService: RealmsService | undefined;
let EventSink: ((event: RealmEvent) => Promise<void>) | undefined;

/**
 * [2026-10-15] The account a launcher username belongs to (the host's "add player" route). Launcher usernames are stored normalized
 * (trimmed, lower case) as displayNameNormalized, which the account repository matches exactly; the caller's text is normalized here.
 * Works on either persistence provider.
 */
async function ResolveUsernameAccount(username: string): Promise<string | undefined> {
    const normalized = username.trim().toLowerCase();
    if (normalized.length === 0) return undefined;
    const account = await GetRepositories().launcherAccounts.findByDisplayNameNormalized(normalized);
    return account?.userId;
}

/**
 * The module's service on the shared MongoDB (created on first use; connecting and creating the indexes happen on the first
 * request). The p2p module reaches the realms only through this accessor and the sink below.
 */
export function GetRealmsService(): RealmsService {
    CachedService ??= CreateRealmsService({
        repository: new MongoRealmsRepository(),
        presence: new MongoRealmPresenceRepository(),
        displayNames: ResolveDisplayNamesFromMongo,
        limits: ReadRealmLimits(),
        events: (event) => (EventSink === undefined ? Promise.resolve() : EventSink(event)),
        resolveUsername: ResolveUsernameAccount
    });
    return CachedService;
}

/**
 * Registers the one receiver of RealmEvents (MEMBER_REMOVED, REALM_RELEASED, HOST_OFFLINE). The p2p module calls it at startup;
 * realms never imports p2p. A second call replaces the first; undefined removes the sink (events are then dropped).
 */
export function SetRealmEventSink(sink: ((event: RealmEvent) => Promise<void>) | undefined): void {
    EventSink = sink;
}

/** How often the sweeper looks for hosts whose online state just lapsed. */
export const REALM_SWEEP_INTERVAL_MS = 15_000;

let SweepTimer: ReturnType<typeof setInterval> | undefined;

/** Starts the sweeper (once; a second call does nothing). The timer is unref-ed, so it never keeps the process alive. */
export function StartRealmsSweeper(service: () => RealmsService = GetRealmsService, intervalMs: number = REALM_SWEEP_INTERVAL_MS): void {
    if (SweepTimer !== undefined) return;
    let running = false;
    SweepTimer = setInterval(() => {
        if (running) return; // a slow sweep is not overlapped
        running = true;
        service()
            .sweepLapsedHosts()
            .catch((error) => logger.warn(`[Realms] sweep failed: ${error}`))
            .finally(() => { running = false; });
    }, intervalMs);
    SweepTimer.unref();
}

export function StopRealmsSweeper(): void {
    if (SweepTimer !== undefined) clearInterval(SweepTimer);
    SweepTimer = undefined;
}

export function IsRealmsSweeperRunning(): boolean {
    return SweepTimer !== undefined;
}
