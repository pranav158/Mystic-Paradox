/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The MongoDB side of the one-time codes and of the registration sweep, run against an in-memory stand-in for the collections
// (no server, no network): the MongoDB client's connect and db are patched, as the registration test does, and the collection stand-in
// implements the operators these repositories use ($eq, $exists, $type, $gt, $lt, $ne, $or, null equality; $set, $unset, $inc). It checks
// the repositories' own logic and their result shapes; the MongoDB engine's semantics are not reproduced beyond these operators.
import assert from "node:assert/strict";
import test, { after } from "node:test";

const MongoDriver = require("mongodb") as typeof import("mongodb");

type Doc = Record<string, any>;

function Operator(op: string, actual: unknown, operand: unknown): boolean {
    switch (op) {
        case "$eq": return actual === operand;
        case "$ne": return actual !== operand;
        case "$exists": return (actual !== undefined) === operand;
        case "$type": return typeof actual === operand;
        case "$gt": return typeof actual === typeof operand && actual !== undefined && (actual as any) > (operand as any);
        case "$gte": return typeof actual === typeof operand && actual !== undefined && (actual as any) >= (operand as any);
        case "$lt": return typeof actual === typeof operand && actual !== undefined && (actual as any) < (operand as any);
        case "$lte": return typeof actual === typeof operand && actual !== undefined && (actual as any) <= (operand as any);
        default: throw new Error(`the test stand-in has no operator ${op}`);
    }
}

function Matches(doc: Doc, filter: Doc): boolean {
    for (const [key, expected] of Object.entries(filter)) {
        if (key === "$or") {
            if (!(expected as Doc[]).some((branch) => Matches(doc, branch))) return false;
            continue;
        }
        const actual = doc[key];
        if (expected === null) {
            if (actual !== undefined && actual !== null) return false;
        } else if (typeof expected === "object" && !Array.isArray(expected)) {
            for (const [op, operand] of Object.entries(expected)) {
                if (!Operator(op, actual, operand)) return false;
            }
        } else if (actual !== expected) {
            return false;
        }
    }
    return true;
}

function ApplyUpdate(doc: Doc, update: Doc): void {
    for (const [op, fields] of Object.entries(update)) {
        for (const [field, value] of Object.entries(fields as Doc)) {
            if (op === "$set") doc[field] = value;
            else if (op === "$unset") delete doc[field];
            else if (op === "$inc") doc[field] = (doc[field] ?? 0) + (value as number);
            else throw new Error(`the test stand-in has no update ${op}`);
        }
    }
}

class FakeCollection {
    readonly Rows: Doc[] = [];

    private Find(filter: Doc): Doc | undefined {
        return this.Rows.find((row) => Matches(row, filter));
    }

    async findOne(filter: Doc): Promise<Doc | null> {
        const Row = this.Find(filter);
        return Row === undefined ? null : { ...Row };
    }

    find(filter: Doc) {
        let Sorted = this.Rows.filter((row) => Matches(row, filter));
        let Limit = Number.POSITIVE_INFINITY;
        const Cursor = {
            sort: (spec: Record<string, 1 | -1>) => {
                const [Key, Direction] = Object.entries(spec)[0]!;
                Sorted = [...Sorted].sort((a, b) => (a[Key] < b[Key] ? -1 : a[Key] > b[Key] ? 1 : 0) * Direction);
                return Cursor;
            },
            limit: (count: number) => { Limit = count; return Cursor; },
            toArray: async () => Sorted.slice(0, Limit).map((row) => ({ ...row }))
        };
        return Cursor;
    }

    async countDocuments(filter: Doc): Promise<number> {
        return this.Rows.filter((row) => Matches(row, filter)).length;
    }

    async insertOne(doc: Doc) {
        if (this.Rows.some((row) => row._id === doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        this.Rows.push({ ...doc });
        return { acknowledged: true, insertedId: doc._id };
    }

    async replaceOne(filter: Doc, doc: Doc, options: { upsert?: boolean } = {}) {
        const Index = this.Rows.findIndex((row) => Matches(row, filter));
        if (Index >= 0) {
            this.Rows[Index] = { ...doc };
            return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options.upsert) this.Rows.push({ ...doc });
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: options.upsert ? 1 : 0 };
    }

    async updateOne(filter: Doc, update: Doc) {
        const Row = this.Find(filter);
        if (Row !== undefined) ApplyUpdate(Row, update);
        return { matchedCount: Row === undefined ? 0 : 1, modifiedCount: Row === undefined ? 0 : 1 };
    }

    async findOneAndUpdate(filter: Doc, update: Doc, _options: { returnDocument?: string } = {}) {
        const Row = this.Find(filter);
        if (Row === undefined) return null;
        ApplyUpdate(Row, update);
        return { ...Row };
    }

    async deleteOne(filter: Doc) {
        const Index = this.Rows.findIndex((row) => Matches(row, filter));
        if (Index < 0) return { deletedCount: 0 };
        this.Rows.splice(Index, 1);
        return { deletedCount: 1 };
    }

    async deleteMany(filter: Doc) {
        let Removed = 0;
        for (let Index = this.Rows.length - 1; Index >= 0; Index -= 1) {
            if (Matches(this.Rows[Index]!, filter)) {
                this.Rows.splice(Index, 1);
                Removed += 1;
            }
        }
        return { deletedCount: Removed };
    }
}

const Collections = new Map<string, FakeCollection>();
const FakeDb = {
    collection(name: string): FakeCollection {
        let Found = Collections.get(name);
        if (Found === undefined) {
            Found = new FakeCollection();
            Collections.set(name, Found);
        }
        return Found;
    }
};

// The client caches its database for the life of the process: the stand-in is installed once, on the driver's prototype (no network).
const Proto = MongoDriver.MongoClient.prototype as any;
const OriginalConnect = Proto.connect;
const OriginalDb = Proto.db;
Proto.connect = async function connectFake(this: unknown) { return this; };
Proto.db = function dbFake() { return FakeDb; };
process.env.PERSISTENCE_PROVIDER = "mongodb";
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/email-codes-test";
process.env.MONGODB_DB = "email-codes-test";

after(() => {
    Proto.connect = OriginalConnect;
    Proto.db = OriginalDb;
});

// Imported after the stand-in is in place: the repositories reach the database on first use.
import { MongoEmailCodeRepository } from "./MongoEmailCodeRepository";
import { MongoLauncherAccountRepository } from "./MongoLauncherAccountRepository";
import { MongoAuthIdentityRepository } from "./MongoAuthIdentityRepository";
import { MongoRefreshSessionRepository } from "./MongoRefreshSessionRepository";
import { EmailCodeHash } from "../../../security/emailCodes";

process.env.API_KEY_HASH_SECRET = "mongo-email-codes-test-secret-that-is-long-enough-4455";

const NOW = "2026-10-15T12:00:00.000Z";
const LATER = "2026-10-15T12:05:00.000Z";

function Code(userId: string, purpose: "verify" | "reset", code: string, expiresAt = LATER) {
    return { userId, purpose, codeHash: EmailCodeHash(userId, purpose, code), attempts: 0, createdAt: NOW, expiresAt };
}

test("a code is stored under <userId>:<purpose> with an expiry mirror, and the stored hash is the HMAC", async () => {
    const Repo = new MongoEmailCodeRepository();
    await Repo.replace(Code("mongo-acct-1", "verify", "482913"));
    const Row = Collections.get("emailCodes")!.Rows.find((row) => row._id === "mongo-acct-1:verify")!;
    assert.ok(Row, "the document id is the account and purpose");
    assert.equal(Row.codeHash, EmailCodeHash("mongo-acct-1", "verify", "482913"));
    assert.ok(Row.ttlAt instanceof Date, "the TTL index reads a BSON date");
    assert.equal(Row.ttlAt.toISOString(), LATER);
});

test("peekLive reads without spending a try; consume uses a right code once; a wrong hash uses nothing", async () => {
    const Repo = new MongoEmailCodeRepository();
    await Repo.replace(Code("mongo-acct-2", "verify", "111222"));
    assert.equal((await Repo.peekLive("mongo-acct-2", "verify", NOW, 5))?.attempts, 0);
    assert.equal(await Repo.consume("mongo-acct-2", "verify", EmailCodeHash("mongo-acct-2", "verify", "999999"), NOW, 5), false);
    assert.notEqual(await Repo.peekLive("mongo-acct-2", "verify", NOW, 5), undefined, "still live");
    assert.equal(await Repo.consume("mongo-acct-2", "verify", EmailCodeHash("mongo-acct-2", "verify", "111222"), NOW, 5), true);
    assert.equal(await Repo.consume("mongo-acct-2", "verify", EmailCodeHash("mongo-acct-2", "verify", "111222"), NOW, 5), false, "a second use");
});

test("reserveTry counts tries and removes the row once it is out of tries; a late expiry is refused and removed", async () => {
    const Repo = new MongoEmailCodeRepository();
    await Repo.replace(Code("mongo-acct-3", "reset", "333444"));
    assert.equal((await Repo.reserveTry("mongo-acct-3", "reset", NOW, 2))?.attempts, 1);
    assert.equal((await Repo.reserveTry("mongo-acct-3", "reset", NOW, 2))?.attempts, 2);
    assert.equal(await Repo.reserveTry("mongo-acct-3", "reset", NOW, 2), undefined, "out of tries");
    assert.equal(Collections.get("emailCodes")!.Rows.some((row) => row._id === "mongo-acct-3:reset"), false, "removed in that write");

    await Repo.replace(Code("mongo-acct-4", "verify", "555666", LATER));
    assert.equal(await Repo.reserveTry("mongo-acct-4", "verify", LATER, 5), undefined, "at the expiry: refused");
    assert.equal(Collections.get("emailCodes")!.Rows.some((row) => row._id === "mongo-acct-4:verify"), false, "expired row removed");
});

test("remove only takes the row with that hash; deleteForUser removes both purposes and counts them", async () => {
    const Repo = new MongoEmailCodeRepository();
    await Repo.replace(Code("mongo-acct-5", "verify", "777888"));
    await Repo.replace(Code("mongo-acct-5", "reset", "999000"));
    assert.equal(await Repo.remove("mongo-acct-5", "verify", EmailCodeHash("mongo-acct-5", "verify", "000000")), false);
    assert.equal(await Repo.deleteForUser("mongo-acct-5"), 2);
    assert.equal(await Repo.deleteForUser("mongo-acct-5"), 0);
});

function Account(userId: string, fields: Doc = {}): Doc {
    return {
        _id: userId, userId, displayNameNormalized: userId, displayName: userId, status: "active", approvalStatus: "approved",
        roles: ["player"], createdAt: NOW, usernameSet: false, ...fields
    };
}

test("the account write adds the verification fields only when they are set (no null fields)", async () => {
    const Repo = new MongoLauncherAccountRepository();
    const Base = { userId: "mongo-new-plain", displayNameNormalized: "mongo-new-plain", displayName: "x", status: "active" as const,
        approvalStatus: "approved" as const, roles: ["player"], createdAt: NOW, usernameSet: true };
    await Repo.create(Base);
    const Plain = Collections.get("accounts")!.Rows.find((row) => row._id === "mongo-new-plain")!;
    assert.equal("emailVerificationPendingSince" in Plain, false);
    assert.equal("emailVerifiedAt" in Plain, false);

    await Repo.create({ ...Base, userId: "mongo-new-pending", displayNameNormalized: "mongo-new-pending", emailVerificationPendingSince: NOW });
    const Pending = Collections.get("accounts")!.Rows.find((row) => row._id === "mongo-new-pending")!;
    assert.equal(Pending.emailVerificationPendingSince, NOW);
    assert.equal(Pending.emailVerifiedAt, undefined);
});

test("the registration sweep lists and removes only unverified registrations pending since before the cut-off", async () => {
    const Accounts = FakeDb.collection("accounts");
    Accounts.Rows.push(
        Account("sweep-stale", { emailVerificationPendingSince: "2026-10-13T00:00:00.000Z" }),
        Account("sweep-fresh", { emailVerificationPendingSince: "2026-10-15T11:00:00.000Z" }),
        Account("sweep-verified", { emailVerificationPendingSince: "2026-10-13T00:00:00.000Z", emailVerifiedAt: "2026-10-13T01:00:00.000Z" }),
        Account("sweep-existing", {})
    );
    const Repo = new MongoLauncherAccountRepository();
    const CutOff = "2026-10-13T12:00:00.000Z";
    const Listed = await Repo.listUnverifiedRegistrations(CutOff, 10);
    assert.deepEqual(Listed.map((account) => account.userId), ["sweep-stale"]);

    assert.equal(await Repo.deleteUnverifiedRegistration("sweep-fresh", CutOff), false, "not old enough");
    assert.equal(await Repo.deleteUnverifiedRegistration("sweep-verified", CutOff), false, "verified: kept");
    assert.equal(await Repo.deleteUnverifiedRegistration("sweep-existing", CutOff), false, "never pending: kept");
    assert.equal(await Repo.deleteUnverifiedRegistration("sweep-stale", CutOff), true);
    assert.equal(await Repo.findByUserId("sweep-stale"), undefined);
    assert.notEqual(await Repo.findByUserId("sweep-fresh"), undefined);
});

test("verifying clears the pending mark and sets the time; a password reset replaces the hash", async () => {
    const Accounts = Collections.get("accounts")!;
    Accounts.Rows.push(Account("verify-me", { emailVerificationPendingSince: NOW, passwordHash: "old-hash" }));
    const Repo = new MongoLauncherAccountRepository();
    await Repo.setEmailVerified("verify-me", "2026-10-15T12:01:00.000Z");
    const Row = Accounts.Rows.find((row) => row._id === "verify-me")!;
    assert.equal(Row.emailVerifiedAt, "2026-10-15T12:01:00.000Z");
    assert.equal("emailVerificationPendingSince" in Row, false);
    await Repo.setPasswordHash("verify-me", "new-hash");
    assert.equal(Accounts.Rows.find((row) => row._id === "verify-me")!.passwordHash, "new-hash");
});

test("the identity unlink and the session sweep delete by account (and provider, for the identity)", async () => {
    const Identities = new MongoAuthIdentityRepository();
    Collections.get("authIdentities")?.Rows.splice(0);
    await Identities.create({ provider: "discord", providerSubject: "mongo-discord-1", userId: "mongo-link", providerUsername: "u", linkedAt: NOW });
    assert.equal(await Identities.deleteForUser("discord", "mongo-link"), 1);
    assert.equal(await Identities.deleteForUser("discord", "mongo-link"), 0);

    const Sessions = new MongoRefreshSessionRepository();
    await Sessions.create({ id: "s-1", tokenHash: "t-1", userId: "mongo-sess", familyId: "f-1", deviceId: "d", deviceName: "n", createdAt: NOW, expiresAt: LATER });
    await Sessions.create({ id: "s-2", tokenHash: "t-2", userId: "mongo-other", familyId: "f-2", deviceId: "d", deviceName: "n", createdAt: NOW, expiresAt: LATER });
    await Sessions.deleteAllForUser("mongo-sess");
    assert.equal(Collections.get("refreshSessions")!.Rows.some((row) => row.userId === "mongo-sess"), false);
    assert.equal(Collections.get("refreshSessions")!.Rows.some((row) => row.userId === "mongo-other"), true);
});
