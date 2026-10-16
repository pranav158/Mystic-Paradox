import type { Collection, Db, Document } from "mongodb";
import { GetMongoDb } from "../../../persistence/mongo/client";
import { Collections } from "../../../persistence/mongo/collections";
import { DEFAULT_HOSTING, HOSTING_PATCH_KEYS, HeartbeatUpdate, NormalizeHosting } from "../../realmRules";
import {
    RealmBan,
    RealmHostingPatch,
    RealmInviteRecord,
    RealmJoinPolicy,
    RealmJoinRequest,
    RealmMember,
    RealmPlayerInvite,
    RealmPresenceRecord,
    RealmRecord
} from "../../realmTypes";
import {
    AddBanResult,
    AddJoinRequestResult,
    AddMemberResult,
    AddPlayerInviteResult,
    DisplayNameResolver,
    InsertRealmResult,
    RealmPresenceRepository,
    RealmsRepository
} from "../RealmsRepository";
import { RealmsCollections } from "./collections";
import { BackfillHubRoomIds, EnsureRealmsDatabase, INVITE_PURGE_GRACE_SECONDS } from "./indexes";

// [2026-10-13 realms S2] MongoDB implementation of the realms persistence contract. A realm is one document
// (_id = realmId) with its members and bans embedded; an invite is one document (_id = its code). Each write is a single
// update whose filter carries the precondition, so the contract's atomicity holds without transactions. Every value
// that reaches a filter has already been parsed by realmInput.ts (strings of a fixed alphabet), and the filters use $eq
// like the rest of the backend.

interface RealmCollectionPair {
    realms: Collection<any>;
    invites: Collection<any>;
}

function IsDuplicateKey(error: unknown): error is { code: number; keyPattern?: Record<string, unknown>; message?: string } {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

function ToRealm(doc: Document): RealmRecord {
    const { _id, ...rest } = doc;
    const realm = { ...rest, realmId: String(_id) } as unknown as RealmRecord;
    // A hosting record written field by field (patchHosting on an old realm) may lack fields: fill them like a fresh one.
    if (realm.hosting !== undefined) realm.hosting = NormalizeHosting(realm.hosting, realm.createdAt)!;
    return realm;
}

function ToInvite(doc: Document): RealmInviteRecord {
    const { _id, purgeAt: _purgeAt, ...rest } = doc;
    return { ...rest, code: String(_id) } as unknown as RealmInviteRecord;
}

export class MongoRealmsRepository implements RealmsRepository {
    private ensured: Promise<void> | undefined;

    /** The collections, after the indexes exist (created once per process, on first use; a failure is retried next call). */
    private async collections(): Promise<RealmCollectionPair> {
        const db: Db = await GetMongoDb();
        this.ensured ??= EnsureRealmsDatabase(db).then(() => BackfillHubRoomIds(db)).then(() => undefined).catch((error) => {
            this.ensured = undefined;
            throw error;
        });
        await this.ensured;
        return { realms: db.collection(RealmsCollections.Realms), invites: db.collection(RealmsCollections.RealmInvites) };
    }

    async findById(realmId: string): Promise<RealmRecord | undefined> {
        const { realms } = await this.collections();
        const doc = await realms.findOne({ _id: { $eq: realmId as any } });
        return doc == undefined ? undefined : ToRealm(doc);
    }

    async findByName(name: string): Promise<RealmRecord | undefined> {
        const { realms } = await this.collections();
        const doc = await realms.findOne({ name: { $eq: name } });
        return doc == undefined ? undefined : ToRealm(doc);
    }

    async findByHost(hostAccountId: string): Promise<RealmRecord | undefined> {
        const { realms } = await this.collections();
        const doc = await realms.findOne({ hostAccountId: { $eq: hostAccountId } });
        return doc == undefined ? undefined : ToRealm(doc);
    }

    async findByMember(accountId: string, limit: number): Promise<RealmRecord[]> {
        const { realms } = await this.collections();
        const docs = await realms.find({ "members.accountId": { $eq: accountId } }).sort({ name: 1 }).limit(limit).toArray();
        return docs.map(ToRealm);
    }

    async listListed(limit: number, offset: number): Promise<RealmRecord[]> {
        const { realms } = await this.collections();
        const docs = await realms.find({ listed: true }).sort({ onlineUntil: -1, name: 1 }).skip(offset).limit(limit).toArray();
        return docs.map(ToRealm);
    }

    async insertRealm(realm: RealmRecord): Promise<InsertRealmResult> {
        const { realms } = await this.collections();
        const { realmId, ...document } = realm;
        try {
            await realms.insertOne({ _id: realmId as any, ...document });
            return "INSERTED";
        } catch (error) {
            if (!IsDuplicateKey(error)) throw error;
            const pattern = error.keyPattern ?? {};
            const text = String(error.message ?? "");
            if ("hostAccountId" in pattern || (Object.keys(pattern).length === 0 && text.includes("hostAccountId"))) return "HOST_HAS_REALM";
            if ("name" in pattern || (Object.keys(pattern).length === 0 && text.includes("name_1"))) return "NAME_TAKEN";
            throw error;
        }
    }

    async deleteRealmIfLastOnline(realmId: string, expectedLastOnlineAt: string | undefined): Promise<boolean> {
        const { realms, invites } = await this.collections();
        const result = await realms.deleteOne({
            _id: { $eq: realmId as any },
            lastOnlineAt: expectedLastOnlineAt === undefined ? { $exists: false } : { $eq: expectedLastOnlineAt }
        });
        if (result.deletedCount !== 1) return false;
        await invites.deleteMany({ realmId: { $eq: realmId } });
        return true;
    }

    async deleteRealmOfHost(realmId: string, hostAccountId: string): Promise<boolean> {
        const { realms, invites } = await this.collections();
        const result = await realms.deleteOne({ _id: { $eq: realmId as any }, hostAccountId: { $eq: hostAccountId } });
        if (result.deletedCount !== 1) return false;
        await invites.deleteMany({ realmId: { $eq: realmId } });
        return true;
    }

    async setSettings(
        realmId: string,
        hostAccountId: string,
        settings: { joinPolicy?: RealmJoinPolicy; listed?: boolean }
    ): Promise<boolean> {
        const set: Record<string, unknown> = {};
        if (settings.joinPolicy !== undefined) set.joinPolicy = settings.joinPolicy;
        if (settings.listed !== undefined) set.listed = settings.listed;
        if (Object.keys(set).length === 0) return true;
        const { realms } = await this.collections();
        const result = await realms.updateOne({ _id: { $eq: realmId as any }, hostAccountId: { $eq: hostAccountId } }, { $set: set });
        return result.matchedCount === 1;
    }

    async recordHeartbeat(realmId: string, hostAccountId: string, update: HeartbeatUpdate): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, hostAccountId: { $eq: hostAccountId } },
            { $set: { ...update } }
        );
        return result.matchedCount === 1;
    }

    async patchHosting(realmId: string, patch: RealmHostingPatch, updatedAtIso: string): Promise<boolean> {
        const { realms } = await this.collections();
        // Dotted paths, so the host's heartbeat and the p2p module (disjoint fields) never overwrite each other.
        const set: Record<string, unknown> = { "hosting.updatedAt": updatedAtIso };
        const unset: Record<string, ""> = {};
        for (const key of HOSTING_PATCH_KEYS) {
            const value = patch[key];
            if (value === undefined) continue;
            if (value === null) unset[`hosting.${key}`] = "";
            else set[`hosting.${key}`] = value;
        }
        // A realm with no hosting record yet gets the full defaults first (a no-op when one exists), so it is never half-filled.
        await realms.updateOne(
            { _id: { $eq: realmId as any }, hosting: { $exists: false } },
            { $set: { hosting: { ...DEFAULT_HOSTING, updatedAt: updatedAtIso } } }
        );
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any } },
            Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set }
        );
        return result.matchedCount === 1;
    }

    async markOffline(realmId: string, atIso: string): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, onlineUntil: { $gt: atIso } },
            { $set: { onlineUntil: atIso, offlineNotifiedFor: atIso } }
        );
        return result.modifiedCount === 1;
    }

    async claimLapsedHosts(nowIso: string, sinceIso: string, limit: number): Promise<RealmRecord[]> {
        const { realms } = await this.collections();
        const candidates = await realms
            .find({
                onlineUntil: { $gt: sinceIso, $lte: nowIso },
                $expr: { $ne: [{ $ifNull: ["$offlineNotifiedFor", ""] }, "$onlineUntil"] }
            })
            .limit(limit)
            .toArray();
        const claimed: RealmRecord[] = [];
        for (const candidate of candidates) {
            // The claim re-checks the lapse it saw: a heartbeat in between changed onlineUntil, so the claim then fails.
            const won = await realms.findOneAndUpdate(
                { _id: candidate._id, onlineUntil: { $eq: candidate.onlineUntil }, offlineNotifiedFor: { $ne: candidate.onlineUntil } },
                { $set: { offlineNotifiedFor: candidate.onlineUntil } },
                { returnDocument: "after" }
            );
            if (won != undefined) claimed.push(ToRealm(won));
        }
        return claimed;
    }

    async findByHubRoomId(hubRoomId: string): Promise<RealmRecord | undefined> {
        const { realms } = await this.collections();
        const doc = await realms.findOne({ hubRoomIds: { $eq: hubRoomId } });
        return doc == undefined ? undefined : ToRealm(doc);
    }

    async addMember(realmId: string, member: RealmMember, maxMembers: number): Promise<AddMemberResult> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            {
                _id: { $eq: realmId as any },
                "members.accountId": { $ne: member.accountId },
                "bans.accountId": { $ne: member.accountId },
                $expr: { $lt: [{ $size: "$members" }, maxMembers] }
            },
            // [2026-10-16] The membership answers the account's player invite (the same update; $pull on a missing list does nothing).
            { $push: { members: { ...member } as any }, $pull: { playerInvites: { accountId: member.accountId } as any } }
        );
        if (result.modifiedCount === 1) return "ADDED";
        // Nothing changed: find out which precondition failed.
        const doc = await realms.findOne({ _id: { $eq: realmId as any } }, { projection: { members: 1, bans: 1 } });
        if (doc == undefined) return "NOT_FOUND";
        if ((doc.bans ?? []).some((ban: RealmBan) => ban.accountId === member.accountId)) return "BANNED";
        if ((doc.members ?? []).some((entry: RealmMember) => entry.accountId === member.accountId)) return "ALREADY_MEMBER";
        return "FULL";
    }

    async removeMember(realmId: string, accountId: string): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, members: { $elemMatch: { accountId: { $eq: accountId }, role: "MEMBER" } } },
            { $pull: { members: { accountId, role: "MEMBER" } as any } }
        );
        return result.modifiedCount === 1;
    }

    async addBan(realmId: string, ban: RealmBan, maxBans: number): Promise<AddBanResult> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            {
                _id: { $eq: realmId as any },
                "bans.accountId": { $ne: ban.accountId },
                $expr: { $lt: [{ $size: "$bans" }, maxBans] }
            },
            {
                $push: { bans: { ...ban } as any },
                // [2026-10-15] A ban also withdraws the account's join request (the same update, so no request outlives the ban).
                $pull: {
                    members: { accountId: ban.accountId, role: "MEMBER" } as any,
                    joinRequests: { accountId: ban.accountId } as any,
                    // [2026-10-16] And the account's player invite.
                    playerInvites: { accountId: ban.accountId } as any
                }
            }
        );
        if (result.modifiedCount === 1) return "BANNED";
        const doc = await realms.findOne({ _id: { $eq: realmId as any } }, { projection: { bans: 1 } });
        if (doc == undefined) return "NOT_FOUND";
        if ((doc.bans ?? []).some((entry: RealmBan) => entry.accountId === ban.accountId)) return "ALREADY_BANNED";
        return "FULL";
    }

    async removeBan(realmId: string, accountId: string): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, "bans.accountId": { $eq: accountId } },
            { $pull: { bans: { accountId } as any } }
        );
        return result.modifiedCount === 1;
    }

    async addJoinRequest(realmId: string, request: RealmJoinRequest, maxRequests: number): Promise<AddJoinRequestResult> {
        const { realms } = await this.collections();
        // $ifNull: a realm that never had a request has no joinRequests field, and $size of a missing field is an error.
        const result = await realms.updateOne(
            {
                _id: { $eq: realmId as any },
                "bans.accountId": { $ne: request.accountId },
                "members.accountId": { $ne: request.accountId },
                "joinRequests.accountId": { $ne: request.accountId },
                $expr: { $lt: [{ $size: { $ifNull: ["$joinRequests", []] } }, maxRequests] }
            },
            { $push: { joinRequests: { ...request } as any } }
        );
        if (result.modifiedCount === 1) return "ADDED";
        // Nothing changed: find out which precondition failed (the same order as the in-memory double).
        const doc = await realms.findOne({ _id: { $eq: realmId as any } }, { projection: { members: 1, bans: 1, joinRequests: 1 } });
        if (doc == undefined) return "NOT_FOUND";
        if ((doc.bans ?? []).some((ban: RealmBan) => ban.accountId === request.accountId)) return "BANNED";
        if ((doc.members ?? []).some((member: RealmMember) => member.accountId === request.accountId)) return "ALREADY_MEMBER";
        if ((doc.joinRequests ?? []).some((entry: RealmJoinRequest) => entry.accountId === request.accountId)) return "ALREADY_REQUESTED";
        return "FULL";
    }

    async removeJoinRequest(realmId: string, accountId: string): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, "joinRequests.accountId": { $eq: accountId } },
            { $pull: { joinRequests: { accountId } as any } }
        );
        return result.modifiedCount === 1;
    }

    async addPlayerInvite(realmId: string, invite: RealmPlayerInvite, maxInvites: number): Promise<AddPlayerInviteResult> {
        const { realms } = await this.collections();
        // $ifNull: a realm that never sent an invite has no playerInvites field, and $size of a missing field is an error.
        const result = await realms.updateOne(
            {
                _id: { $eq: realmId as any },
                "bans.accountId": { $ne: invite.accountId },
                "members.accountId": { $ne: invite.accountId },
                "playerInvites.accountId": { $ne: invite.accountId },
                $expr: { $lt: [{ $size: { $ifNull: ["$playerInvites", []] } }, maxInvites] }
            },
            { $push: { playerInvites: { ...invite } as any } }
        );
        if (result.modifiedCount === 1) return "ADDED";
        // Nothing changed: find out which precondition failed (the same order as the in-memory double).
        const doc = await realms.findOne({ _id: { $eq: realmId as any } }, { projection: { members: 1, bans: 1, playerInvites: 1 } });
        if (doc == undefined) return "NOT_FOUND";
        if ((doc.bans ?? []).some((ban: RealmBan) => ban.accountId === invite.accountId)) return "BANNED";
        if ((doc.members ?? []).some((member: RealmMember) => member.accountId === invite.accountId)) return "ALREADY_MEMBER";
        if ((doc.playerInvites ?? []).some((entry: RealmPlayerInvite) => entry.accountId === invite.accountId)) return "ALREADY_INVITED";
        return "FULL";
    }

    async removePlayerInvite(realmId: string, accountId: string): Promise<boolean> {
        const { realms } = await this.collections();
        const result = await realms.updateOne(
            { _id: { $eq: realmId as any }, "playerInvites.accountId": { $eq: accountId } },
            { $pull: { playerInvites: { accountId } as any } }
        );
        return result.modifiedCount === 1;
    }

    async findByPlayerInvite(accountId: string, limit: number): Promise<RealmRecord[]> {
        const { realms } = await this.collections();
        const docs = await realms.find({ "playerInvites.accountId": { $eq: accountId } }).sort({ name: 1 }).limit(limit).toArray();
        return docs.map(ToRealm);
    }

    async insertInvite(invite: RealmInviteRecord): Promise<"INSERTED" | "DUPLICATE"> {
        const { invites } = await this.collections();
        const { code, ...document } = invite;
        const purgeAt = new Date(Date.parse(invite.expiresAt) + INVITE_PURGE_GRACE_SECONDS * 1000);
        try {
            await invites.insertOne({ _id: code as any, ...document, purgeAt });
            return "INSERTED";
        } catch (error) {
            if (IsDuplicateKey(error)) return "DUPLICATE";
            throw error;
        }
    }

    async findInvite(code: string): Promise<RealmInviteRecord | undefined> {
        const { invites } = await this.collections();
        const doc = await invites.findOne({ _id: { $eq: code as any } });
        return doc == undefined ? undefined : ToInvite(doc);
    }

    async listInvites(realmId: string, limit: number): Promise<RealmInviteRecord[]> {
        const { invites } = await this.collections();
        const docs = await invites.find({ realmId: { $eq: realmId } }).sort({ createdAt: -1 }).limit(limit).toArray();
        return docs.map(ToInvite);
    }

    async countActiveInvites(realmId: string, nowIso: string): Promise<number> {
        const { invites } = await this.collections();
        return invites.countDocuments({
            realmId: { $eq: realmId },
            revokedAt: { $exists: false },
            expiresAt: { $gt: nowIso },
            $expr: { $lt: ["$uses", "$maxUses"] }
        });
    }

    async consumeInvite(code: string, nowIso: string): Promise<RealmInviteRecord | undefined> {
        const { invites } = await this.collections();
        const doc = await invites.findOneAndUpdate(
            {
                _id: { $eq: code as any },
                revokedAt: { $exists: false },
                expiresAt: { $gt: nowIso },
                $expr: { $lt: ["$uses", "$maxUses"] }
            },
            { $inc: { uses: 1 } },
            { returnDocument: "after" }
        );
        return doc == undefined ? undefined : ToInvite(doc);
    }

    async refundInvite(code: string): Promise<void> {
        const { invites } = await this.collections();
        await invites.updateOne({ _id: { $eq: code as any }, uses: { $gt: 0 } }, { $inc: { uses: -1 } });
    }

    async revokeInvite(realmId: string, code: string, atIso: string): Promise<RealmInviteRecord | undefined> {
        const { invites } = await this.collections();
        const existing = await invites.findOne({ _id: { $eq: code as any }, realmId: { $eq: realmId } });
        if (existing == undefined) return undefined;
        if (existing.revokedAt !== undefined) return ToInvite(existing);
        const updated = await invites.findOneAndUpdate(
            { _id: { $eq: code as any }, realmId: { $eq: realmId }, revokedAt: { $exists: false } },
            { $set: { revokedAt: atIso } },
            { returnDocument: "after" }
        );
        if (updated != undefined) return ToInvite(updated);
        // Revoked by a concurrent request between the two reads.
        const latest = await invites.findOne({ _id: { $eq: code as any }, realmId: { $eq: realmId } });
        return latest == undefined ? undefined : ToInvite(latest);
    }
}

function ToPresence(doc: Document): RealmPresenceRecord {
    return {
        accountId: String(doc._id),
        realmId: String(doc.realmId),
        boundAt: String(doc.boundAt),
        lastSeenAt: String(doc.lastSeenAt),
        expiresAt: (doc.expiresAt as Date).toISOString()
    };
}

/**
 * MongoDB implementation of the presence contract: one document per account (_id = accountId). `expiresAt` is stored as a Date
 * (not an ISO string like the rest of the module) because the TTL index cleaning the rows up needs one; the record API is ISO.
 */
export class MongoRealmPresenceRepository implements RealmPresenceRepository {
    private ensured: Promise<void> | undefined;

    private async presence(): Promise<Collection<any>> {
        const db: Db = await GetMongoDb();
        this.ensured ??= EnsureRealmsDatabase(db).catch((error) => {
            this.ensured = undefined;
            throw error;
        });
        await this.ensured;
        return db.collection(RealmsCollections.RealmPresence);
    }

    async bind(row: RealmPresenceRecord): Promise<void> {
        const presence = await this.presence();
        await presence.updateOne(
            { _id: { $eq: row.accountId as any } },
            { $set: { realmId: row.realmId, boundAt: row.boundAt, lastSeenAt: row.lastSeenAt, expiresAt: new Date(row.expiresAt) } },
            { upsert: true }
        );
    }

    async findActive(accountId: string, nowIso: string): Promise<RealmPresenceRecord | undefined> {
        const presence = await this.presence();
        const doc = await presence.findOne({ _id: { $eq: accountId as any }, expiresAt: { $gt: new Date(nowIso) } });
        return doc == undefined ? undefined : ToPresence(doc);
    }

    async touch(accountId: string, nowIso: string, expiresAtIso: string): Promise<RealmPresenceRecord | undefined> {
        const presence = await this.presence();
        const doc = await presence.findOneAndUpdate(
            { _id: { $eq: accountId as any }, expiresAt: { $gt: new Date(nowIso) } },
            { $set: { lastSeenAt: nowIso, expiresAt: new Date(expiresAtIso) } },
            { returnDocument: "after" }
        );
        return doc == undefined ? undefined : ToPresence(doc);
    }

    async remove(accountId: string, realmId?: string): Promise<boolean> {
        const presence = await this.presence();
        const filter: Record<string, unknown> = { _id: { $eq: accountId as any } };
        if (realmId !== undefined) filter.realmId = { $eq: realmId };
        const result = await presence.deleteOne(filter);
        return result.deletedCount === 1;
    }

    async removeForRealm(realmId: string): Promise<number> {
        const presence = await this.presence();
        const result = await presence.deleteMany({ realmId: { $eq: realmId } });
        return result.deletedCount;
    }

    async countActiveByRealm(realmIds: string[], nowIso: string): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (realmIds.length === 0) return counts;
        const presence = await this.presence();
        const rows = await presence
            .aggregate([
                { $match: { realmId: { $in: realmIds }, expiresAt: { $gt: new Date(nowIso) } } },
                { $group: { _id: "$realmId", count: { $sum: 1 } } }
            ])
            .toArray();
        for (const row of rows) counts.set(String(row._id), Number(row.count));
        return counts;
    }
}

/** Display names from the shared accounts collection, one query for the whole list (read only). */
export const ResolveDisplayNamesFromMongo: DisplayNameResolver = async (accountIds) => {
    const names = new Map<string, string>();
    const unique = [...new Set(accountIds)].slice(0, 1000);
    if (unique.length === 0) return names;
    const db = await GetMongoDb();
    const docs = await db.collection(Collections.Accounts)
        .find({ _id: { $in: unique as any[] } }, { projection: { displayName: 1 } })
        .toArray();
    for (const doc of docs) {
        if (typeof doc.displayName === "string" && doc.displayName.length > 0) names.set(String(doc._id), doc.displayName);
    }
    return names;
};
