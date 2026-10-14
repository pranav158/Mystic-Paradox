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

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import {
    PartyEventType,
    PartyInviteRecord,
    PartyOutboxRecord,
    PartyRecord,
    PartyRepository
} from "../../contracts/PartyRepository";
import { Conn, SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// Durable party authority, a port of MongoPartyRepository. Membership is a separate one-row-per-account table
// (_id = accountId), so an account belongs to at most one party; party writes are revision-guarded
// (PARTY_REVISION_CONFLICT). Each public method is ONE atomic write: a savepoint inside the controller's unit of work.

function PartyFromDocument(doc: Doc | undefined): PartyRecord | undefined {
    return doc === undefined ? undefined : ({ ...doc, activity: doc.activity ?? "IDLE", partyId: String(doc._id) } as unknown as PartyRecord);
}

function InviteFromDocument(doc: Doc): PartyInviteRecord {
    return { ...doc, inviteId: String(doc._id) } as unknown as PartyInviteRecord;
}

function OutboxFromDocument(doc: Doc | undefined): PartyOutboxRecord | undefined {
    return doc === undefined ? undefined : ({ ...doc, eventId: String(doc._id) } as unknown as PartyOutboxRecord);
}

// MongoDB joins the two ids with U+0000; SQLite text cannot hold a NUL, so the unit separator (U+001F) is used instead.
// The id is opaque to every caller: it is only echoed in events.
function InviteId(recipientId: string, senderId: string): string {
    return `${recipientId}\u001f${senderId}`;
}

function SnapshotPayload(party: PartyRecord): Record<string, unknown> {
    return {
        partyId: party.partyId,
        revision: party.revision,
        leaderPlayerId: party.leaderPlayerId,
        members: party.members,
        activity: party.activity,
        activeHuntSessionId: party.activeHuntSessionId ?? null
    };
}

interface EventInput {
    partyId: string;
    partyRevision: number;
    eventType: PartyEventType;
    recipientAccountIds: string[];
    payload: Record<string, unknown>;
    now: string;
}

function FindById(c: Conn, partyId: string): PartyRecord | undefined {
    return PartyFromDocument(Tables.parties.get(c, partyId));
}

function FindByMember(c: Conn, accountId: string): PartyRecord | undefined {
    const Membership = Tables.partyMemberships.get(c, accountId);
    if (Membership === undefined || typeof Membership.partyId !== "string") return undefined;
    return FindById(c, Membership.partyId);
}

function WriteEvent(c: Conn, input: EventInput): void {
    Tables.partyOutbox.insert(c, crypto.randomUUID(), {
        partyId: input.partyId,
        partyRevision: input.partyRevision,
        eventType: input.eventType,
        recipientAccountIds: [...new Set(input.recipientAccountIds)],
        payload: input.payload,
        state: "PENDING",
        createdAt: input.now
    });
}

function GetOrCreateSolo(c: Conn, input: { accountId: string; buildId: string; newPartyId: string; now: string }): PartyRecord {
    const Existing = FindByMember(c, input.accountId);
    if (Existing !== undefined) return Existing;

    const Party: PartyRecord = {
        partyId: input.newPartyId,
        revision: 1,
        leaderPlayerId: input.accountId,
        members: [input.accountId],
        buildId: input.buildId,
        activity: "IDLE",
        createdAt: input.now,
        updatedAt: input.now
    };
    const { partyId, ...PartyDocument } = Party;
    Tables.parties.insert(c, partyId, PartyDocument);
    Tables.partyMemberships.insert(c, input.accountId, { partyId, joinedAt: input.now });
    WriteEvent(c, {
        partyId,
        partyRevision: Party.revision,
        eventType: "PARTY_CREATED",
        recipientAccountIds: Party.members,
        payload: SnapshotPayload(Party),
        now: input.now
    });
    return Party;
}

/** Replaces a party only if it is still at the revision it was read at; anything else is a conflict. */
function ReplaceParty(c: Conn, previous: PartyRecord, next: PartyRecord): void {
    const Row = Tables.parties.row(c, previous.partyId);
    if (Row === undefined || Row.doc.revision !== previous.revision) throw new Error("PARTY_REVISION_CONFLICT");
    const { partyId, ...Document } = next;
    if (partyId !== previous.partyId || !Tables.parties.replaceFrom(c, Row, Document)) throw new Error("PARTY_REVISION_CONFLICT");
}

function ConsumeRecipientInvites(c: Conn, recipientId: string, acceptedInviterId: string, now: string): void {
    const Accepted = Tables.partyInvites.row(c, InviteId(recipientId, acceptedInviterId));
    if (Accepted !== undefined && Accepted.doc.status === "PENDING") {
        Tables.partyInvites.patch(c, Accepted, { status: "ACCEPTED", consumedAt: now });
    }
    // `$ne` also matches an invite without a sender.
    for (const Row of Tables.partyInvites.rows(
        c,
        "recipientPlayerId = ? AND status = 'PENDING' AND json_extract(doc, '$.sendingPlayerId') IS NOT ?",
        [recipientId, acceptedInviterId]
    )) {
        Tables.partyInvites.patch(c, Row, { status: "REVOKED", consumedAt: now });
    }
}

function RemoveMember(c: Conn, party: PartyRecord, accountId: string, now: string, action: "LEAVE" | "KICK" | "MOVE", actorAccountId?: string): void {
    const Remaining = party.members.filter((member) => member !== accountId);
    Tables.partyMemberships.deleteById(c, accountId);
    if (Remaining.length === 0) {
        const Row = Tables.parties.row(c, party.partyId);
        if (Row !== undefined && Row.doc.revision === party.revision) Tables.parties.deleteById(c, party.partyId);
        WriteEvent(c, {
            partyId: party.partyId,
            partyRevision: party.revision + 1,
            eventType: "PARTY_MEMBERSHIP_CHANGED",
            recipientAccountIds: [accountId],
            payload: { action: "DISBAND", accountId, actorAccountId, members: [] },
            now
        });
        return;
    }

    const Next: PartyRecord = {
        ...party,
        revision: party.revision + 1,
        members: Remaining,
        leaderPlayerId: party.leaderPlayerId === accountId ? Remaining[0] : party.leaderPlayerId,
        updatedAt: now
    };
    ReplaceParty(c, party, Next);
    WriteEvent(c, {
        partyId: Next.partyId,
        partyRevision: Next.revision,
        eventType: "PARTY_MEMBERSHIP_CHANGED",
        recipientAccountIds: [...Remaining, accountId],
        payload: { ...SnapshotPayload(Next), action, accountId, actorAccountId },
        now
    });
}

export class SqlitePartyRepository implements PartyRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findById(partyId: string, session?: ClientSession): Promise<PartyRecord | undefined> {
        return this.db.read(session, (c) => FindById(c, partyId));
    }

    async findByMember(accountId: string, session?: ClientSession): Promise<PartyRecord | undefined> {
        return this.db.read(session, (c) => FindByMember(c, accountId));
    }

    async getOrCreateSolo(input: { accountId: string; buildId: string; newPartyId: string; now: string }, session: ClientSession): Promise<PartyRecord> {
        return this.db.write(session, (c) => GetOrCreateSolo(c, input));
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
        await this.db.write(session, (c) => {
            if (input.recipientId === input.senderId) return;
            const Party = GetOrCreateSolo(c, {
                accountId: input.senderId,
                buildId: input.buildId,
                newPartyId: input.newPartyId,
                now: input.now
            });
            const RecipientParty = FindByMember(c, input.recipientId);
            if (RecipientParty?.partyId === Party.partyId) return;

            const InviteKey = InviteId(input.recipientId, input.senderId);
            const Invite: Omit<PartyInviteRecord, "inviteId"> = {
                partyId: Party.partyId,
                partyRevision: Party.revision,
                sendingPlayerId: input.senderId,
                recipientPlayerId: input.recipientId,
                sendingDisplayName: input.senderDisplayName,
                sendingPlatform: input.senderPlatform,
                status: "PENDING",
                createdAt: input.now,
                expiresAt: input.expiresAt
            };
            // An upsert that $sets: an older answered invite keeps its consumedAt, as in MongoDB.
            const Existing = Tables.partyInvites.row(c, InviteKey);
            if (Existing === undefined) Tables.partyInvites.insert(c, InviteKey, Invite);
            else Tables.partyInvites.patch(c, Existing, Invite);
            WriteEvent(c, {
                partyId: Party.partyId,
                partyRevision: Party.revision,
                eventType: "PARTY_INVITE_CREATED",
                recipientAccountIds: [input.recipientId],
                payload: { ...Invite, inviteId: InviteKey },
                now: input.now
            });
        });
    }

    async listPendingInvites(recipientId: string, now: string, session?: ClientSession): Promise<PartyInviteRecord[]> {
        return this.db.read(session, (c) => Tables.partyInvites
            .find(c, "recipientPlayerId = ? AND status = 'PENDING' AND expiresAt > ?", [recipientId, now], {
                orderBy: "json_extract(doc, '$.createdAt') DESC, rowid DESC"
            })
            .map(InviteFromDocument));
    }

    async acceptInvite(input: {
        recipientId: string;
        inviterId: string;
        buildId: string;
        newPartyId: string;
        now: string;
        maxPartySize: number;
    }, session: ClientSession): Promise<PartyRecord | undefined> {
        return this.db.write(session, (c) => {
            const Invite = Tables.partyInvites.findOne(
                c,
                "_id = ? AND recipientPlayerId = ? AND json_extract(doc, '$.sendingPlayerId') = ? AND status = 'PENDING' AND expiresAt > ?",
                [InviteId(input.recipientId, input.inviterId), input.recipientId, input.inviterId, input.now]
            );
            if (Invite === undefined) return FindByMember(c, input.recipientId);

            const Target = GetOrCreateSolo(c, {
                accountId: input.inviterId,
                buildId: input.buildId,
                newPartyId: input.newPartyId,
                now: input.now
            });
            const Current = FindByMember(c, input.recipientId);
            // An invite belongs to the issuing party, not merely to the inviter account: if the inviter left or
            // switched parties, the old invite cannot become a capability to join their new party.
            if (Target.partyId !== Invite.partyId) return Current;
            if (Current?.partyId === Target.partyId) {
                ConsumeRecipientInvites(c, input.recipientId, input.inviterId, input.now);
                return Target;
            }
            if (Target.members.length >= input.maxPartySize) return Current;

            if (Current !== undefined) RemoveMember(c, Current, input.recipientId, input.now, "MOVE");

            const NextTarget: PartyRecord = {
                ...Target,
                revision: Target.revision + 1,
                members: [...Target.members, input.recipientId],
                updatedAt: input.now
            };
            ReplaceParty(c, Target, NextTarget);
            const Membership = Tables.partyMemberships.row(c, input.recipientId);
            if (Membership === undefined) Tables.partyMemberships.insert(c, input.recipientId, { partyId: Target.partyId, joinedAt: input.now });
            else Tables.partyMemberships.patch(c, Membership, { partyId: Target.partyId, joinedAt: input.now });
            ConsumeRecipientInvites(c, input.recipientId, input.inviterId, input.now);
            WriteEvent(c, {
                partyId: NextTarget.partyId,
                partyRevision: NextTarget.revision,
                eventType: "PARTY_MEMBERSHIP_CHANGED",
                recipientAccountIds: NextTarget.members,
                payload: { ...SnapshotPayload(NextTarget), action: "JOIN", accountId: input.recipientId },
                now: input.now
            });
            return NextTarget;
        });
    }

    async leave(accountId: string, now: string, session: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            const Party = FindByMember(c, accountId);
            if (Party === undefined) return;
            RemoveMember(c, Party, accountId, now, "LEAVE");
        });
    }

    async kick(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            const Party = FindByMember(c, actorId);
            if (Party === undefined || Party.leaderPlayerId !== actorId || actorId === targetId || !Party.members.includes(targetId)) return;
            RemoveMember(c, Party, targetId, now, "KICK", actorId);
        });
    }

    async promote(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            const Party = FindByMember(c, actorId);
            if (Party === undefined || Party.leaderPlayerId !== actorId || !Party.members.includes(targetId)) return;
            if (Party.leaderPlayerId === targetId) return;
            const Next: PartyRecord = { ...Party, revision: Party.revision + 1, leaderPlayerId: targetId, updatedAt: now };
            ReplaceParty(c, Party, Next);
            WriteEvent(c, {
                partyId: Next.partyId,
                partyRevision: Next.revision,
                eventType: "PARTY_LEADER_CHANGED",
                recipientAccountIds: Next.members,
                payload: SnapshotPayload(Next),
                now
            });
        });
    }

    async setActivity(input: {
        partyId: string;
        expectedRevision: number;
        activity: PartyRecord["activity"];
        activeHuntSessionId?: string;
        now: string;
    }, session: ClientSession): Promise<PartyRecord | undefined> {
        return this.db.write(session, (c) => {
            const Current = FindById(c, input.partyId);
            if (Current === undefined || Current.revision !== input.expectedRevision) return undefined;
            const Next: PartyRecord = {
                ...Current,
                revision: Current.revision + 1,
                activity: input.activity,
                activeHuntSessionId: input.activeHuntSessionId,
                updatedAt: input.now
            };
            ReplaceParty(c, Current, Next);
            WriteEvent(c, {
                partyId: Next.partyId,
                partyRevision: Next.revision,
                eventType: "PARTY_ACTIVITY_CHANGED",
                recipientAccountIds: Next.members,
                payload: {
                    ...SnapshotPayload(Next),
                    activity: Next.activity,
                    activeHuntSessionId: Next.activeHuntSessionId ?? null
                },
                now: input.now
            });
            return Next;
        });
    }

    async appendEvent(input: EventInput, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => WriteEvent(c, input));
    }

    /** Oldest pending event, or a PROCESSING one whose claim is older than `staleBefore`; marked as claimed by `owner`. */
    async claimNextOutbox(owner: string, now: string, staleBefore: string): Promise<PartyOutboxRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.partyOutbox.findOneRow(
                c,
                "state = 'PENDING' OR (state = 'PROCESSING' AND json_extract(doc, '$.claimedAt') < ?)",
                [staleBefore],
                "createdAt ASC, rowid ASC"
            );
            if (Row === undefined) return undefined;
            return OutboxFromDocument(Tables.partyOutbox.patch(c, Row, { state: "PROCESSING", claimOwner: owner, claimedAt: now }));
        });
    }

    async markOutboxPublished(eventId: string, owner: string, publishedAt: string): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.partyOutbox.row(c, eventId);
            if (Row === undefined || Row.doc.state !== "PROCESSING" || Row.doc.claimOwner !== owner) return false;
            Tables.partyOutbox.patch(c, Row, { state: "PUBLISHED", publishedAt }, ["claimOwner", "claimedAt"]);
            return true;
        });
    }

    async releaseOutbox(eventId: string, owner: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.partyOutbox.row(c, eventId);
            if (Row === undefined || Row.doc.state !== "PROCESSING" || Row.doc.claimOwner !== owner) return;
            Tables.partyOutbox.patch(c, Row, { state: "PENDING" }, ["claimOwner", "claimedAt"]);
        });
    }
}
