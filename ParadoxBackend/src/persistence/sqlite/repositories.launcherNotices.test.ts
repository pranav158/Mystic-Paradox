/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The SQLite side of the launcher notices: the empty read, the first save (version 0 only), the compare-and-set by version,
// the stale writer, the round trip of the optional fields, and the rollback of a save inside a unit of work.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { OpenTestRealm, TestRealm } from "./testSupport";
import { LauncherNoticesRecord } from "../contracts/LauncherNoticesRepository";

const Realm: TestRealm = OpenTestRealm("sqlite-launcher-notices");
after(async () => { await Realm.cleanup(); });

function Notices(version: number, text = "Notice", extra: Partial<LauncherNoticesRecord> = {}): LauncherNoticesRecord {
    return {
        version,
        updatedAt: "2026-10-15T12:00:00.000Z",
        updatedBy: "manager:1",
        announcements: [{ id: "a1", text, tone: "warning", eventAt: "2026-10-16T00:00:00.000Z" }],
        tags: [{ id: "t1", text: "EXPERIMENTAL BUILD", tone: "warning" }],
        ...extra
    };
}

test("nothing saved reads as undefined, and only version 0 may create the first document", async () => {
    const Repo = Realm.repos.launcherNotices;
    assert.equal(await Repo.get(), undefined);
    assert.equal(await Repo.replaceIfVersion(Notices(1), 1), false, "a first save must expect version 0");
    assert.equal(await Repo.get(), undefined);
    assert.equal(await Repo.replaceIfVersion(Notices(1, "First"), 0), true);
    assert.equal((await Repo.get())?.announcements[0]?.text, "First");
});

test("a save expects the stored version: a stale or racing writer gets false and nothing changes", async () => {
    const Repo = Realm.repos.launcherNotices;
    assert.equal(await Repo.replaceIfVersion(Notices(1, "Again"), 0), false, "the row exists now, so a version-0 insert loses");
    assert.equal(await Repo.replaceIfVersion(Notices(3, "Skipped"), 2), false, "a version that does not match is refused");
    assert.equal(await Repo.replaceIfVersion(Notices(2, "Second"), 1), true);
    assert.equal(await Repo.replaceIfVersion(Notices(2, "Stale"), 1), false, "the second writer read version 1 and is now stale");
    const Stored = await Repo.get();
    assert.equal(Stored?.version, 2);
    assert.equal(Stored?.announcements[0]?.text, "Second");
});

test("the optional fields round-trip: absent metadata stays absent, present fields come back as stored", async () => {
    const Repo = Realm.repos.launcherNotices;
    const Saved = await Repo.get();
    assert.equal(Saved?.updatedBy, "manager:1");
    assert.deepEqual(Saved?.tags, [{ id: "t1", text: "EXPERIMENTAL BUILD", tone: "warning" }]);

    const Fresh = OpenTestRealm("sqlite-launcher-notices-bare");
    try {
        await Fresh.repos.launcherNotices.replaceIfVersion({ version: 1, announcements: [], tags: [] }, 0);
        const Bare = await Fresh.repos.launcherNotices.get();
        assert.deepEqual(Bare, { version: 1, announcements: [], tags: [] }, "no updatedAt or updatedBy invented");
    } finally {
        await Fresh.cleanup();
    }
});

test("a save inside a unit of work that fails is rolled back with it", async () => {
    const Repo = Realm.repos.launcherNotices;
    const Before = await Repo.get();
    await assert.rejects(Realm.uow.withTransaction(async (repos, session) => {
        assert.equal(await repos.launcherNotices.replaceIfVersion(Notices((Before?.version ?? 0) + 1, "Rolled back"),
            Before?.version ?? 0, session), true);
        throw new Error("the audit record failed");
    }), /the audit record failed/);
    assert.deepEqual(await Repo.get(), Before, "the document is as it was before the failed unit of work");
});
