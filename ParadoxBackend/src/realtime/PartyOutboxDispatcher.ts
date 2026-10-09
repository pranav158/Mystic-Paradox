import crypto from "node:crypto";
import { GetRepositories, PartyOutboxRecord } from "../persistence";
import { logger } from "../logger";
import { roomService } from "./RoomService";
import { sessionRegistry } from "./SessionRegistry";
import { escapeXml } from "./xml";

const XMPP_DOMAIN = "prod.ol.epicgames.com";
const POLL_MS = 250;
const CLAIM_STALE_MS = 30_000;
const MAX_BATCH = 64;
const FAILURE_LOG_INTERVAL_MS = 30_000;

function PublicEvent(record: PartyOutboxRecord): Record<string, unknown> {
    const eventNames: Record<PartyOutboxRecord["eventType"], string> = {
        PARTY_CREATED: "party.created",
        PARTY_INVITE_CREATED: "party.invited",
        PARTY_MEMBERSHIP_CHANGED: "party.membership_changed",
        PARTY_LEADER_CHANGED: "party.leader_changed",
        PARTY_ACTIVITY_CHANGED: "party.activity_changed",
        PARTY_PRESENCE_CHANGED: "party.presence_changed",
        PARTY_HUNT_STATUS_CHANGED: "party.hunt_status_changed"
    };
    return {
        eventId: record.eventId,
        eventType: eventNames[record.eventType],
        schemaVersion: 1,
        occurredAt: record.createdAt,
        partyId: record.partyId,
        partyRevision: record.partyRevision,
        payload: record.payload
    };
}

function HeadlineFrame(accountId: string, record: PartyOutboxRecord): string {
    const body = escapeXml(JSON.stringify(PublicEvent(record)));
    return `<message type="headline" from="party-events@${XMPP_DOMAIN}" ` +
        `to="${escapeXml(accountId)}@${XMPP_DOMAIN}" id="${escapeXml(record.eventId)}">` +
        `<body>${body}</body></message>`;
}

export class PartyOutboxDispatcher {
    private readonly owner = crypto.randomUUID();
    private timer: NodeJS.Timeout | undefined;
    private draining = false;
    private consecutiveFailures = 0;
    private lastFailureLogAt = 0;

    start(): void {
        if (this.timer != undefined) return;
        this.timer = setInterval(() => { void this.drain(); }, POLL_MS);
        this.timer.unref();
        void this.drain();
    }

    stop(): void {
        if (this.timer != undefined) clearInterval(this.timer);
        this.timer = undefined;
    }

    async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            for (let count = 0; count < MAX_BATCH; count += 1) {
                const now = new Date();
                const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
                const event = await GetRepositories().parties.claimNextOutbox(this.owner, now.toISOString(), staleBefore);
                if (event == undefined) break;
                try {
                    this.publish(event);
                    await GetRepositories().parties.markOutboxPublished(event.eventId, this.owner, new Date().toISOString());
                } catch (error) {
                    await GetRepositories().parties.releaseOutbox(event.eventId, this.owner);
                    logger.error(`[PartyOutbox] publish failed event=${event.eventId}: ${error}`);
                    break;
                }
            }
            if (this.consecutiveFailures > 0) {
                logger.info(`[PartyOutbox] database polling recovered after ${this.consecutiveFailures} failed attempt(s)`);
                this.consecutiveFailures = 0;
                this.lastFailureLogAt = 0;
            }
        } catch (error) {
            // A temporary Mongo/Internet outage must not become an unhandled rejection. Node 24
            // terminates the process for an unhandled rejected promise, which previously took down
            // HTTPS/XMPP even though the Mongo driver could reconnect on a later polling attempt.
            this.consecutiveFailures += 1;
            const now = Date.now();
            if (this.lastFailureLogAt === 0 || now - this.lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
                this.lastFailureLogAt = now;
                logger.error({
                    error,
                    consecutiveFailures: this.consecutiveFailures
                }, "[PartyOutbox] database polling failed; dispatcher will retry");
            }
        } finally {
            this.draining = false;
        }
    }

    private publish(event: PartyOutboxRecord): void {
        const accountId = typeof event.payload.accountId === "string" ? event.payload.accountId : undefined;
        const action = typeof event.payload.action === "string" ? event.payload.action : undefined;
        if (accountId != undefined && ["LEAVE", "DISBAND", "KICK", "MOVE"].includes(action ?? "")) {
            roomService.evictPartyMember(event.partyId, accountId);
        }

        for (const recipient of event.recipientAccountIds) {
            const frame = HeadlineFrame(recipient, event);
            for (const connection of sessionRegistry.connectionsFor(recipient)) connection.send(frame);
        }
        logger.info({
            event: "party_outbox_published",
            eventId: event.eventId,
            eventType: event.eventType,
            partyId: event.partyId,
            partyRevision: event.partyRevision,
            recipientCount: event.recipientAccountIds.length
        }, `[PartyOutbox] ${event.eventType} party=${event.partyId} revision=${event.partyRevision}`);
    }
}

export const partyOutboxDispatcher = new PartyOutboxDispatcher();
