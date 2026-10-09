import crypto from "node:crypto";
import { ClientSession, Db } from "mongodb";
import {
    PartyEventType,
    PartyInviteRecord,
    PartyOutboxRecord,
    PartyRecord,
    PartyRepository
} from "../../contracts/PartyRepository";
import { Collections } from "../collections";
import { GetMongoDb } from "../client";

type PartyDocument = Omit<PartyRecord, "partyId"> & { _id: string };
type InviteDocument = Omit<PartyInviteRecord, "inviteId"> & { _id: string };
type OutboxDocument = Omit<PartyOutboxRecord, "eventId"> & { _id: string };

function PartyFromDocument(doc: Record<string, unknown> | null): PartyRecord | undefined {
    return doc == undefined ? undefined : ({
        ...doc,
        activity: doc.activity ?? "IDLE",
        partyId: String(doc._id)
    } as unknown as PartyRecord);
}

function InviteFromDocument(doc: Record<string, unknown>): PartyInviteRecord {
    return { ...doc, inviteId: String(doc._id) } as unknown as PartyInviteRecord;
}

function OutboxFromDocument(doc: Record<string, unknown> | null): PartyOutboxRecord | undefined {
    return doc == undefined ? undefined : ({ ...doc, eventId: String(doc._id) } as unknown as PartyOutboxRecord);
}

function InviteId(recipientId: string, senderId: string): string {
    return `${recipientId}\u0000${senderId}`;
}

export class MongoPartyRepository implements PartyRepository {
    async findById(partyId: string, session?: ClientSession): Promise<PartyRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection<PartyDocument>(Collections.Parties).findOne({ _id: partyId }, { session });
        return PartyFromDocument(doc as unknown as Record<string, unknown> | null);
    }

    async findByMember(accountId: string, session?: ClientSession): Promise<PartyRecord | undefined> {
        const db = await GetMongoDb();
        const membership = await db.collection(Collections.PartyMemberships).findOne(
            { _id: accountId as never },
            { session }
        );
        if (membership == undefined || typeof membership.partyId !== "string") return undefined;
        return this.findById(membership.partyId, session);
    }

    async getOrCreateSolo(input: {
        accountId: string;
        buildId: string;
        newPartyId: string;
        now: string;
    }, session: ClientSession): Promise<PartyRecord> {
        const existing = await this.findByMember(input.accountId, session);
        if (existing != undefined) return existing;

        const db = await GetMongoDb();
        const party: PartyRecord = {
            partyId: input.newPartyId,
            revision: 1,
            leaderPlayerId: input.accountId,
            members: [input.accountId],
            buildId: input.buildId,
            activity: "IDLE",
            createdAt: input.now,
            updatedAt: input.now
        };
        const { partyId, ...partyDocument } = party;
        await db.collection(Collections.Parties).insertOne({ _id: partyId as never, ...partyDocument }, { session });
        await db.collection(Collections.PartyMemberships).insertOne(
            { _id: input.accountId as never, partyId, joinedAt: input.now },
            { session }
        );
        await this.writeEvent(db, {
            partyId,
            partyRevision: party.revision,
            eventType: "PARTY_CREATED",
            recipientAccountIds: party.members,
            payload: this.snapshotPayload(party),
            now: input.now
        }, session);
        return party;
    }

    async createInvite(input: {
        senderId: string;
        recipientId: string;
        buildId: string;
        senderDisplayName: string;
        senderPlatform: string;
        newPartyId: string;
        now: string;
        expiresAt: string;
    }, session: ClientSession): Promise<void> {
        if (input.recipientId === input.senderId) return;
        const party = await this.getOrCreateSolo({
            accountId: input.senderId,
            buildId: input.buildId,
            newPartyId: input.newPartyId,
            now: input.now
        }, session);
        const recipientParty = await this.findByMember(input.recipientId, session);
        if (recipientParty?.partyId === party.partyId) return;

        const db = await GetMongoDb();
        const inviteId = InviteId(input.recipientId, input.senderId);
        const invite: Omit<PartyInviteRecord, "inviteId"> = {
            partyId: party.partyId,
            partyRevision: party.revision,
            sendingPlayerId: input.senderId,
            recipientPlayerId: input.recipientId,
            sendingDisplayName: input.senderDisplayName,
            sendingPlatform: input.senderPlatform,
            status: "PENDING",
            createdAt: input.now,
            expiresAt: input.expiresAt
        };
        await db.collection(Collections.PartyInvites).updateOne(
            { _id: inviteId as never },
            { $set: invite },
            { upsert: true, session }
        );
        await this.writeEvent(db, {
            partyId: party.partyId,
            partyRevision: party.revision,
            eventType: "PARTY_INVITE_CREATED",
            recipientAccountIds: [input.recipientId],
            payload: { ...invite, inviteId },
            now: input.now
        }, session);
    }

    async listPendingInvites(recipientId: string, now: string, session?: ClientSession): Promise<PartyInviteRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection<InviteDocument>(Collections.PartyInvites)
            .find({ recipientPlayerId: recipientId, status: "PENDING", expiresAt: { $gt: now } }, { session })
            .sort({ createdAt: -1 })
            .toArray();
        return docs.map((doc) => InviteFromDocument(doc as unknown as Record<string, unknown>));
    }

    async acceptInvite(input: {
        recipientId: string;
        inviterId: string;
        buildId: string;
        newPartyId: string;
        now: string;
        maxPartySize: number;
    }, session: ClientSession): Promise<PartyRecord | undefined> {
        const db = await GetMongoDb();
        const invite = await db.collection<InviteDocument>(Collections.PartyInvites).findOne({
            _id: InviteId(input.recipientId, input.inviterId),
            recipientPlayerId: input.recipientId,
            sendingPlayerId: input.inviterId,
            status: "PENDING",
            expiresAt: { $gt: input.now }
        }, { session });
        if (invite == undefined) return this.findByMember(input.recipientId, session);

        const target = await this.getOrCreateSolo({
            accountId: input.inviterId,
            buildId: input.buildId,
            newPartyId: input.newPartyId,
            now: input.now
        }, session);
        const current = await this.findByMember(input.recipientId, session);
        // An invite belongs to the issuing party, not merely to the inviter account. If the
        // inviter left or switched parties, the old invite cannot become a capability to join
        // their new party.
        if (target.partyId !== invite.partyId) return current;
        if (current?.partyId === target.partyId) {
            await this.consumeRecipientInvites(db, input.recipientId, input.inviterId, input.now, session);
            return target;
        }
        if (target.members.length >= input.maxPartySize) return current;

        if (current != undefined) {
            await this.removeMember(db, current, input.recipientId, input.now, session, "MOVE");
        }

        const nextTarget: PartyRecord = {
            ...target,
            revision: target.revision + 1,
            members: [...target.members, input.recipientId],
            updatedAt: input.now
        };
        await this.replaceParty(db, target, nextTarget, session);
        await db.collection(Collections.PartyMemberships).updateOne(
            { _id: input.recipientId as never },
            { $set: { partyId: target.partyId, joinedAt: input.now } },
            { upsert: true, session }
        );
        await this.consumeRecipientInvites(db, input.recipientId, input.inviterId, input.now, session);
        await this.writeEvent(db, {
            partyId: nextTarget.partyId,
            partyRevision: nextTarget.revision,
            eventType: "PARTY_MEMBERSHIP_CHANGED",
            recipientAccountIds: nextTarget.members,
            payload: { ...this.snapshotPayload(nextTarget), action: "JOIN", accountId: input.recipientId },
            now: input.now
        }, session);
        return nextTarget;
    }

    async leave(accountId: string, now: string, session: ClientSession): Promise<void> {
        const party = await this.findByMember(accountId, session);
        if (party == undefined) return;
        await this.removeMember(await GetMongoDb(), party, accountId, now, session, "LEAVE");
    }

    async kick(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void> {
        const party = await this.findByMember(actorId, session);
        if (party == undefined || party.leaderPlayerId !== actorId || actorId === targetId || !party.members.includes(targetId)) return;
        await this.removeMember(await GetMongoDb(), party, targetId, now, session, "KICK", actorId);
    }

    async promote(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void> {
        const party = await this.findByMember(actorId, session);
        if (party == undefined || party.leaderPlayerId !== actorId || !party.members.includes(targetId)) return;
        if (party.leaderPlayerId === targetId) return;
        const next: PartyRecord = { ...party, revision: party.revision + 1, leaderPlayerId: targetId, updatedAt: now };
        const db = await GetMongoDb();
        await this.replaceParty(db, party, next, session);
        await this.writeEvent(db, {
            partyId: next.partyId,
            partyRevision: next.revision,
            eventType: "PARTY_LEADER_CHANGED",
            recipientAccountIds: next.members,
            payload: this.snapshotPayload(next),
            now
        }, session);
    }

    async setActivity(input: {
        partyId: string;
        expectedRevision: number;
        activity: PartyRecord["activity"];
        activeHuntSessionId?: string;
        now: string;
    }, session: ClientSession): Promise<PartyRecord | undefined> {
        const current = await this.findById(input.partyId, session);
        if (current == undefined || current.revision !== input.expectedRevision) return undefined;
        const next: PartyRecord = {
            ...current,
            revision: current.revision + 1,
            activity: input.activity,
            activeHuntSessionId: input.activeHuntSessionId,
            updatedAt: input.now
        };
        const db = await GetMongoDb();
        await this.replaceParty(db, current, next, session);
        await this.writeEvent(db, {
            partyId: next.partyId,
            partyRevision: next.revision,
            eventType: "PARTY_ACTIVITY_CHANGED",
            recipientAccountIds: next.members,
            payload: {
                ...this.snapshotPayload(next),
                activity: next.activity,
                activeHuntSessionId: next.activeHuntSessionId ?? null
            },
            now: input.now
        }, session);
        return next;
    }

    async appendEvent(input: {
        partyId: string;
        partyRevision: number;
        eventType: PartyEventType;
        recipientAccountIds: string[];
        payload: Record<string, unknown>;
        now: string;
    }, session?: ClientSession): Promise<void> {
        await this.writeEvent(await GetMongoDb(), input, session);
    }

    async claimNextOutbox(owner: string, now: string, staleBefore: string): Promise<PartyOutboxRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection<OutboxDocument>(Collections.PartyOutbox).findOneAndUpdate(
            {
                $or: [
                    { state: "PENDING" },
                    { state: "PROCESSING", claimedAt: { $lt: staleBefore } }
                ]
            },
            { $set: { state: "PROCESSING", claimOwner: owner, claimedAt: now } },
            { sort: { createdAt: 1 }, returnDocument: "after" }
        );
        return OutboxFromDocument(doc as unknown as Record<string, unknown> | null);
    }

    async markOutboxPublished(eventId: string, owner: string, publishedAt: string): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(Collections.PartyOutbox).updateOne(
            { _id: eventId as never, state: "PROCESSING", claimOwner: owner },
            { $set: { state: "PUBLISHED", publishedAt }, $unset: { claimOwner: "", claimedAt: "" } }
        );
        return result.modifiedCount === 1;
    }

    async releaseOutbox(eventId: string, owner: string): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(Collections.PartyOutbox).updateOne(
            { _id: eventId as never, state: "PROCESSING", claimOwner: owner },
            { $set: { state: "PENDING" }, $unset: { claimOwner: "", claimedAt: "" } }
        );
    }

    private async removeMember(
        db: Db,
        party: PartyRecord,
        accountId: string,
        now: string,
        session: ClientSession,
        action: "LEAVE" | "KICK" | "MOVE",
        actorAccountId?: string
    ): Promise<void> {
        const remaining = party.members.filter((member) => member !== accountId);
        await db.collection(Collections.PartyMemberships).deleteOne({ _id: accountId as never }, { session });
        if (remaining.length === 0) {
            await db.collection(Collections.Parties).deleteOne({ _id: party.partyId as never, revision: party.revision }, { session });
            await this.writeEvent(db, {
                partyId: party.partyId,
                partyRevision: party.revision + 1,
                eventType: "PARTY_MEMBERSHIP_CHANGED",
                recipientAccountIds: [accountId],
                payload: { action: "DISBAND", accountId, actorAccountId, members: [] },
                now
            }, session);
            return;
        }

        const next: PartyRecord = {
            ...party,
            revision: party.revision + 1,
            members: remaining,
            leaderPlayerId: party.leaderPlayerId === accountId ? remaining[0] : party.leaderPlayerId,
            updatedAt: now
        };
        await this.replaceParty(db, party, next, session);
        await this.writeEvent(db, {
            partyId: next.partyId,
            partyRevision: next.revision,
            eventType: "PARTY_MEMBERSHIP_CHANGED",
            recipientAccountIds: [...remaining, accountId],
            payload: { ...this.snapshotPayload(next), action, accountId, actorAccountId },
            now
        }, session);
    }

    private async replaceParty(db: Db, previous: PartyRecord, next: PartyRecord, session: ClientSession): Promise<void> {
        const { partyId, ...document } = next;
        const result = await db.collection(Collections.Parties).replaceOne(
            { _id: previous.partyId as never, revision: previous.revision },
            { _id: partyId as never, ...document },
            { session }
        );
        if (result.modifiedCount !== 1) throw new Error("PARTY_REVISION_CONFLICT");
    }

    private async consumeRecipientInvites(
        db: Db,
        recipientId: string,
        acceptedInviterId: string,
        now: string,
        session: ClientSession
    ): Promise<void> {
        await db.collection(Collections.PartyInvites).updateOne(
            { _id: InviteId(recipientId, acceptedInviterId) as never, status: "PENDING" },
            { $set: { status: "ACCEPTED", consumedAt: now } },
            { session }
        );
        await db.collection(Collections.PartyInvites).updateMany(
            {
                recipientPlayerId: recipientId,
                sendingPlayerId: { $ne: acceptedInviterId },
                status: "PENDING"
            },
            { $set: { status: "REVOKED", consumedAt: now } },
            { session }
        );
    }

    private snapshotPayload(party: PartyRecord): Record<string, unknown> {
        return {
            partyId: party.partyId,
            revision: party.revision,
            leaderPlayerId: party.leaderPlayerId,
            members: party.members,
            activity: party.activity,
            activeHuntSessionId: party.activeHuntSessionId ?? null
        };
    }

    private async writeEvent(db: Db, input: {
        partyId: string;
        partyRevision: number;
        eventType: PartyEventType;
        recipientAccountIds: string[];
        payload: Record<string, unknown>;
        now: string;
    }, session?: ClientSession): Promise<void> {
        await db.collection(Collections.PartyOutbox).insertOne({
            _id: crypto.randomUUID() as never,
            partyId: input.partyId,
            partyRevision: input.partyRevision,
            eventType: input.eventType,
            recipientAccountIds: [...new Set(input.recipientAccountIds)],
            payload: input.payload,
            state: "PENDING",
            createdAt: input.now
        }, { session });
    }
}
