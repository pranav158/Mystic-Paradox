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

import { GetRepositories, GetUnitOfWork } from "../persistence";
import { logger } from "../logger";
import { sessionRegistry } from "./SessionRegistry";
import type { RegisteredConnection } from "./SessionRegistry";
import { escapeXml } from "./xml";

/**
 * WP5 — accepted-friend presence (plan §11). When a resource becomes available, we push the
 * account's presence to each ACCEPTED friend's live resources, and push those online friends'
 * presence back to the newly-online account. When the account's LAST resource goes away we
 * broadcast unavailable after a short reconnect grace (cancelled if it reconnects), so travel /
 * brief drops don't produce a false offline (plan §11.3, §20.4).
 *
 * Authority: MongoDB friendship edges decide who is a friend (only status === "ACCEPTED"); the
 * live session registry decides who is online. Non-friends receive nothing.
 */

const XMPP_DOMAIN = "prod.ol.epicgames.com"; // captured logical domain (plan §27)

// Hunt/city travel tears down and re-establishes the client's XMPP socket, and the round trip
// (HUNT_GO_NOW_MIN/MAX_DELAY_MS synchronized release window in matchmaking.ts, 10-20s, plus actual
// level load/streaming time) routinely exceeds a few seconds. A grace window shorter than that turns
// every hunt join/leave into a spurious "friend went offline" / "friend came online" toast pair for
// everyone on the account's friends list. 45s comfortably covers travel while still reading a real
// quit as offline in a reasonable time. Override with REALTIME_XMPP_RECONNECT_GRACE_MS if needed.
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

async function recordPartyPresence(accountId: string, state: "ONLINE" | "OFFLINE"): Promise<void> {
    try {
        const party = await GetRepositories().parties.findByMember(accountId);
        if (party == undefined) return;
        const now = new Date().toISOString();
        await GetRepositories().parties.appendEvent({
            partyId: party.partyId,
            partyRevision: party.revision,
            eventType: "PARTY_PRESENCE_CHANGED",
            recipientAccountIds: party.members,
            payload: { accountId, state, observedAt: now },
            now
        });
        // The presence service reaches OFFLINE only after the reconnect grace expires. At that
        // point remove the stale member through the durable party transaction. PartyRepository
        // deterministically promotes the first remaining member when the old leader left.
        if (state === "OFFLINE") {
            await GetUnitOfWork().withTransaction((repos, session) =>
                repos.parties.leave(accountId, now, session)
            );
        }
    } catch (error) {
        logger.error(`[XMPP] party presence outbox failed: ${error}`);
    }
}

interface PresenceRegistry {
    isOnline(accountId: string): boolean;
    connectionsFor(accountId: string): RegisteredConnection[];
    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined;
}

/**
 * Account presence is a logical state above individual XMPP resources. Keeping this state in a
 * small injectable service makes reconnect behavior deterministic and directly testable.
 */
export class PresenceService {
    private readonly pendingOffline = new Map<string, NodeJS.Timeout>();
    // Remains set throughout reconnect grace. Replacing or adding a resource is not a new online
    // transition and must not be rebroadcast to friends.
    private readonly announcedOnline = new Set<string>();

    constructor(
        private readonly registry: PresenceRegistry,
        private readonly lookupFriendIds: (accountId: string) => Promise<string[]>,
        private readonly reconnectGraceMs: number,
        private readonly recordPresence: (accountId: string, state: "ONLINE" | "OFFLINE") => Promise<void> = async () => {},
    ) {}

    /** A resource became available: sync presence both directions with online accepted friends. */
    async onResourceAvailable(accountId: string, resource: string): Promise<void> {
        const isFreshOnlineTransition = !this.announcedOnline.has(accountId);
        this.announcedOnline.add(accountId);

        const pending = this.pendingOffline.get(accountId);
        if (pending) {
            clearTimeout(pending);
            this.pendingOffline.delete(accountId);
        }

        const friends = await this.lookupFriendIds(accountId);
        // Only the newly-available resource needs the current friend snapshot. Sending it to every
        // resource on the account replays "friend came online" on already-running clients.
        const currentConn = this.registry.connectionFor(accountId, resource);
        let transitionNotified = 0;
        let snapshotSent = 0;

        for (const friendId of friends) {
            const friendConns = this.registry.connectionsFor(friendId);
            if (friendConns.length === 0) continue; // friend offline — nothing to exchange

            // Tell friends only on the account's actual offline -> online transition. Reconnects
            // within grace and additional resources preserve the already-announced online state.
            if (isFreshOnlineTransition) {
                for (const fc of friendConns) {
                    fc.send(availableFrame(accountId, resource, friendId));
                }
                transitionNotified += 1;
            }

            // Tell only this new resource which accepted friends are currently online.
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
        if (isFreshOnlineTransition) await this.recordPresence(accountId, "ONLINE");
    }

    /** A resource went away: if it was the last one, broadcast unavailable after grace. */
    async onResourceUnavailable(accountId: string): Promise<void> {
        if (this.registry.isOnline(accountId)) return; // other resources remain — no offline
        if (!this.announcedOnline.has(accountId)) return; // resource never announced available
        if (this.pendingOffline.has(accountId)) return; // already scheduled

        const timer = setTimeout(() => {
            this.pendingOffline.delete(accountId);
            if (this.registry.isOnline(accountId)) return; // reconnected during grace
            void this.broadcastUnavailable(accountId);
        }, this.reconnectGraceMs);
        timer.unref();
        this.pendingOffline.set(accountId, timer);
    }

    /** Clear pending timers during an orderly service shutdown (also keeps unit tests isolated). */
    close(): void {
        for (const timer of this.pendingOffline.values()) clearTimeout(timer);
        this.pendingOffline.clear();
        this.announcedOnline.clear();
    }

    private async broadcastUnavailable(accountId: string): Promise<void> {
        const friends = await this.lookupFriendIds(accountId);
        // The repository lookup above is asynchronous; a resource may have reconnected while it ran.
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
        await this.recordPresence(accountId, "OFFLINE");
    }
}

const presenceService = new PresenceService(sessionRegistry, acceptedFriendIds, RECONNECT_GRACE_MS, recordPartyPresence);

export async function onResourceAvailable(accountId: string, resource: string): Promise<void> {
    await presenceService.onResourceAvailable(accountId, resource);
}

export async function onResourceUnavailable(accountId: string): Promise<void> {
    await presenceService.onResourceUnavailable(accountId);
}
