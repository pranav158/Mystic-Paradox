/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The MongoDB side of the launcher notices, run against an in-memory stand-in for the collection (no server, no network), as
// MongoEmailCodes.test.ts does. The stand-in implements only the operators this repository uses; it checks the repository's own logic
// (the first save, the version-checked replacement, the duplicate insert) and the shape of its results.
import assert from "node:assert/strict";
import test, { after } from "node:test";

const MongoDriver = require("mongodb") as typeof import("mongodb");

type Doc = Record<string, any>;

function Operator(op: string, actual: unknown, operand: unknown): boolean {
    switch (op) {
        case "$eq": return actual === operand;
        case "$ne": return actual !== operand;
        default: throw new Error(`the test stand-in has no operator ${op}`);
    }
}

function Matches(doc: Doc, filter: Doc): boolean {
    for (const [key, expected] of Object.entries(filter)) {
        const actual = doc[key];
        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            for (const [op, operand] of Object.entries(expected)) {
                if (!Operator(op, actual, operand)) return false;
            }
        } else if (actual !== expected) {
            return false;
        }
    }
    return true;
}

class FakeCollection {
    readonly Rows: Doc[] = [];

    async findOne(filter: Doc): Promise<Doc | null> {
        const Row = this.Rows.find((row) => Matches(row, filter));
        return Row === undefined ? null : structuredClone(Row);
    }

    async insertOne(doc: Doc) {
        if (this.Rows.some((row) => row._id === doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        this.Rows.push(structuredClone(doc));
        return { acknowledged: true, insertedId: doc._id };
    }

    async replaceOne(filter: Doc, doc: Doc) {
        const Index = this.Rows.findIndex((row) => Matches(row, filter));
        if (Index < 0) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        this.Rows[Index] = structuredClone(doc);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
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
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/launcher-notices-test";
process.env.MONGODB_DB = "launcher-notices-test";

after(() => {
    Proto.connect = OriginalConnect;
    Proto.db = OriginalDb;
});

// Imported after the stand-in is in place: the repository reaches the database on first use.
import { MongoLauncherNoticesRepository } from "./MongoLauncherNoticesRepository";
import { LauncherNoticesRecord } from "../../contracts/LauncherNoticesRepository";

function Notices(version: number, text = "Notice"): LauncherNoticesRecord {
    return {
        version,
        updatedAt: "2026-10-15T12:00:00.000Z",
        updatedBy: "manager:1",
        announcements: [{ id: "a1", text, tone: "warning", eventAt: "2026-10-16T00:00:00.000Z" }],
        tags: [{ id: "t1", text: "EXPERIMENTAL BUILD", tone: "warning" }]
    };
}

test("nothing saved reads as undefined; only version 0 may create the document", async () => {
    const Repo = new MongoLauncherNoticesRepository();
    assert.equal(await Repo.get(), undefined);
    assert.equal(await Repo.replaceIfVersion(Notices(1), 1), false, "a first save must expect version 0");
    assert.equal(await Repo.get(), undefined);
    assert.equal(await Repo.replaceIfVersion(Notices(1, "First"), 0), true);
    assert.equal((await Repo.get())?.announcements[0]?.text, "First");
});

test("the document is one singleton _id \"current\" in the launcherNotices collection", async () => {
    const Rows = Collections.get("launcherNotices")?.Rows ?? [];
    assert.equal(Rows.length, 1);
    assert.equal(Rows[0]!._id, "current");
    assert.equal(Rows[0]!.version, 1);
});

test("a second first save finds the document already there and is refused, not overwritten", async () => {
    const Repo = new MongoLauncherNoticesRepository();
    assert.equal(await Repo.replaceIfVersion(Notices(1, "Racing"), 0), false);
    assert.equal((await Repo.get())?.announcements[0]?.text, "First");
});

test("a save replaces the document only while the stored version is the one the caller read", async () => {
    const Repo = new MongoLauncherNoticesRepository();
    assert.equal(await Repo.replaceIfVersion(Notices(3, "Skipped"), 2), false);
    assert.equal(await Repo.replaceIfVersion(Notices(2, "Second"), 1), true);
    assert.equal(await Repo.replaceIfVersion(Notices(2, "Stale"), 1), false, "the second writer read version 1 and is now stale");
    const Stored = await Repo.get();
    assert.equal(Stored?.version, 2);
    assert.equal(Stored?.announcements[0]?.text, "Second");
    assert.equal(Stored?.updatedBy, "manager:1");
});

test("absent metadata is not stored and is not invented on read", async () => {
    const Repo = new MongoLauncherNoticesRepository();
    await Repo.replaceIfVersion({ version: 2, announcements: [], tags: [] }, 2);
    assert.deepEqual(await Repo.get(), { version: 2, announcements: [], tags: [] });
});
