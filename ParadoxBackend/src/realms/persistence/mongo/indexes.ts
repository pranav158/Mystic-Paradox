import { Db } from "mongodb";
import { HubRoomIdsOf } from "../../realmRules";
import { RealmsCollections } from "./collections";

// [2026-10-13 realms S2] Indexes of the realms module. Not part of the shared startup migration (that file belongs to
// other work): the Mongo repositories call this once, lazily, on first use, so a server with the module off never
// creates the collections. createIndex is idempotent, so a restart or a second server repeats it harmlessly.

/** Invites stay readable (as expired) this long after they stop being usable, then MongoDB removes them. */
export const INVITE_PURGE_GRACE_SECONDS = 7 * 24 * 3600;

export async function EnsureRealmsDatabase(Db: Db): Promise<void> {
    const Realms = Db.collection(RealmsCollections.Realms);
    const Invites = Db.collection(RealmsCollections.RealmInvites);
    const Presence = Db.collection(RealmsCollections.RealmPresence);

    // One realm per name (stored lower-case, so this is the "unique lower-cased name" index) and one per host account.
    await Realms.createIndex({ name: 1 }, { unique: true });
    await Realms.createIndex({ hostAccountId: 1 }, { unique: true });
    // "Which realms am I in" for the launcher's server list.
    await Realms.createIndex({ "members.accountId": 1 });
    // [2026-10-16] "Which realms invited me" for the launcher's invitations (sparse: most realms never send one).
    await Realms.createIndex({ "playerInvites.accountId": 1 }, { sparse: true });
    // The public listing: online realms first.
    await Realms.createIndex({ onlineUntil: -1, name: 1 }, { partialFilterExpression: { listed: true } });
    // [hub design 2.3] The sweeper's "whose online state just lapsed" query (realms that were never online have no onlineUntil).
    await Realms.createIndex({ onlineUntil: 1 }, { sparse: true });
    // [hub design 2.4] A hub room id finds its realm (multikey over the realm's two ids).
    await Realms.createIndex({ hubRoomIds: 1 });

    // The invite code is the document _id (unique by construction). The host's list, newest first.
    await Invites.createIndex({ realmId: 1, createdAt: -1 });
    // `purgeAt` (a Date written with each invite) is storage cleanup only.
    await Invites.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });

    // [hub design 2.2] Presence: `expiresAt` is a Date; the TTL index is cleanup only (reads check expiry themselves).
    await Presence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // The player count of a realm.
    await Presence.createIndex({ realmId: 1, expiresAt: 1 });
}

/**
 * Gives every realm created before hub room ids existed its two ids (idempotent: only documents without the field are touched,
 * and each update re-checks that). Runs once per process after the indexes, so findByHubRoomId also answers for old realms.
 */
export async function BackfillHubRoomIds(Db: Db): Promise<number> {
    const Realms = Db.collection(RealmsCollections.Realms);
    let updated = 0;
    let batch: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
    const Flush = async () => {
        if (batch.length === 0) return;
        const result = await Realms.bulkWrite(batch as any, { ordered: false });
        updated += result.modifiedCount;
        batch = [];
    };
    for await (const doc of Realms.find({ hubRoomIds: { $exists: false } }, { projection: { _id: 1 } })) {
        const realmId = String(doc._id);
        batch.push({
            updateOne: {
                filter: { _id: { $eq: realmId }, hubRoomIds: { $exists: false } },
                update: { $set: { hubRoomIds: HubRoomIdsOf(realmId) } }
            }
        });
        if (batch.length >= 500) await Flush();
    }
    await Flush();
    return updated;
}
