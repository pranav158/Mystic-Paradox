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

import { GetRepositories } from "../persistence";
import { logger } from "../logger";
import { sessionRegistry } from "./SessionRegistry";
import type { RegisteredConnection } from "./SessionRegistry";
import { escapeXml } from "./xml";



const XMPP_DOMAIN = "prod.ol.epicgames.com"; 







function ReadGraceMs(): number {
    const Value = Number(process.env.REALTIME_XMPP_RECONNECT_GRACE_MS);
    return Number.isFinite(Value) && Value > 0 ? Math.floor(Value) : 45_000;
}
const RECONNECT_GRACE_MS = ReadGraceMs();

function bareJid(accountId: string): string {
    return `${escapeXml(accountId)}@${XMPP_DOMAIN}`;
}

function availableFrame(fromAccountId: string, fromResource: string, toAccountId: string): string {
    return `<presence from="${bareJid(fromAccountId)}/${escapeXml(fromResource)}" to="${bareJid(toAccountId)}"/>`;
}

function unavailableFrame(fromAccountId: string, toAccountId: string): string {
    return `<presence type="unavailable" from="${bareJid(fromAccountId)}" to="${bareJid(toAccountId)}"/>`;
}

async function acceptedFriendIds(accountId: string): Promise<string[]> {
    try {
        const edges = await GetRepositories().friendships.listForOwner(accountId);
        return edges.filter((e) => e.status === "ACCEPTED").map((e) => e.otherId);
    } catch (e) {
        logger.error(`[XMPP] presence: friend lookup failed for account: ${e}`);
        return [];
    }
}

interface PresenceRegistry {
    isOnline(accountId: string): boolean;
    connectionsFor(accountId: string): RegisteredConnection[];
    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined;
}


export class PresenceService {
    private readonly pendingOffline = new Map<string, NodeJS.Timeout>();
    
    
    private readonly announcedOnline = new Set<string>();

    constructor(
        private readonly registry: PresenceRegistry,
        private readonly lookupFriendIds: (accountId: string) => Promise<string[]>,
        private readonly reconnectGraceMs: number,
    ) {}

    
    async onResourceAvailable(accountId: string, resource: string): Promise<void> {
        const isFreshOnlineTransition = !this.announcedOnline.has(accountId);
        this.announcedOnline.add(accountId);

        const pending = this.pendingOffline.get(accountId);
        if (pending) {
            clearTimeout(pending);
            this.pendingOffline.delete(accountId);
        }

        const friends = await this.lookupFriendIds(accountId);
        
        
        const currentConn = this.registry.connectionFor(accountId, resource);
        let transitionNotified = 0;
        let snapshotSent = 0;

        for (const friendId of friends) {
            const friendConns = this.registry.connectionsFor(friendId);
            if (friendConns.length === 0) continue; 

            
            
            if (isFreshOnlineTransition) {
                for (const fc of friendConns) {
                    fc.send(availableFrame(accountId, resource, friendId));
                }
                transitionNotified += 1;
            }

            
            for (const fc of friendConns) {
                const friendResource = fc.resource ?? "";
                if (currentConn) {
                    currentConn.send(availableFrame(friendId, friendResource, accountId));
                    snapshotSent += 1;
                }
            }
        }
        logger.info(
            `[XMPP] presence available resource="${resource}" transition=${isFreshOnlineTransition ? "online" : "resume"} ` +
            `onlineFriendsNotified=${transitionNotified} friendSnapshotFrames=${snapshotSent}`,
        );
    }

    
    async onResourceUnavailable(accountId: string): Promise<void> {
        if (this.registry.isOnline(accountId)) return; 
        if (!this.announcedOnline.has(accountId)) return; 
        if (this.pendingOffline.has(accountId)) return; 

        const timer = setTimeout(() => {
            this.pendingOffline.delete(accountId);
            if (this.registry.isOnline(accountId)) return; 
            void this.broadcastUnavailable(accountId);
        }, this.reconnectGraceMs);
        timer.unref();
        this.pendingOffline.set(accountId, timer);
    }

    
    close(): void {
        for (const timer of this.pendingOffline.values()) clearTimeout(timer);
        this.pendingOffline.clear();
        this.announcedOnline.clear();
    }

    private async broadcastUnavailable(accountId: string): Promise<void> {
        const friends = await this.lookupFriendIds(accountId);
        
        if (this.registry.isOnline(accountId)) return;
        if (!this.announcedOnline.delete(accountId)) return;

        let notified = 0;
        for (const friendId of friends) {
            for (const fc of this.registry.connectionsFor(friendId)) {
                fc.send(unavailableFrame(accountId, friendId));
                notified += 1;
            }
        }
        logger.info(`[XMPP] presence unavailable friendsNotified=${notified}`);
    }
}

const presenceService = new PresenceService(sessionRegistry, acceptedFriendIds, RECONNECT_GRACE_MS);

export async function onResourceAvailable(accountId: string, resource: string): Promise<void> {
    await presenceService.onResourceAvailable(accountId, resource);
}

export async function onResourceUnavailable(accountId: string): Promise<void> {
    await presenceService.onResourceUnavailable(accountId);
}
