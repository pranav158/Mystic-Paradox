/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The SQLite side of the one-time codes: one row per account and purpose, the conditional write that uses a code, the removal
// of an expired or exhausted row in the same write that finds it, the deletion of an account's codes, and the purge of expired rows.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { OpenTestRealm, TestRealm } from "./testSupport";
import { EmailCodeRecord } from "../contracts/EmailCodeRepository";

let Realm: TestRealm;

const NOW = "2026-10-15T12:00:00.000Z";
const LATER = "2026-10-15T12:05:00.000Z";

function Record(userId: string, purpose: "verify" | "reset", codeHash: string, expiresAt = LATER): EmailCodeRecord {
    return { userId, purpose, codeHash, attempts: 0, createdAt: NOW, expiresAt };
}

function Hash(label: string): string {
    return label.padEnd(64, "0");
}

Realm = OpenTestRealm("sqlite-email-codes");

test("one row per account and purpose: replace swaps the code and resets its tries", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-replace", "verify", Hash("old")));
    assert.equal((await Repos.reserveTry("acct-replace", "verify", NOW, 5))?.attempts, 1);
    await Repos.replace(Record("acct-replace", "verify", Hash("new")));
    const Current = await Repos.reserveTry("acct-replace", "verify", NOW, 5);
    assert.equal(Current?.codeHash, Hash("new"));
    assert.equal(Current?.attempts, 1, "the new code starts at zero tries");
    assert.equal(await Repos.remove("acct-replace", "verify", Hash("old")), false, "the old code is not there any more");
});

test("remove is conditional on the hash: the wrong hash removes nothing, the right one removes once", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-remove", "verify", Hash("right")));
    assert.equal(await Repos.remove("acct-remove", "verify", Hash("wrong")), false);
    assert.notEqual(await Repos.reserveTry("acct-remove", "verify", NOW, 5), undefined, "still there");
    assert.equal(await Repos.remove("acct-remove", "verify", Hash("right")), true);
    assert.equal(await Repos.remove("acct-remove", "verify", Hash("right")), false, "a second removal finds nothing");
});

test("a try on an exhausted code finds nothing, and the row is removed in that same write", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-exhausted", "reset", Hash("x")));
    for (let Try = 0; Try < 2; Try += 1) assert.notEqual(await Repos.reserveTry("acct-exhausted", "reset", NOW, 2), undefined);
    assert.equal(await Repos.reserveTry("acct-exhausted", "reset", NOW, 2), undefined, "the third try is refused");
    assert.equal(await Repos.remove("acct-exhausted", "reset", Hash("x")), false, "and the row is gone");
});

test("a try after the expiry finds nothing, and the expired row is removed", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-expired", "verify", Hash("e"), LATER));
    assert.equal(await Repos.reserveTry("acct-expired", "verify", "2026-10-15T12:05:00.000Z", 5), undefined, "at the expiry: refused");
    assert.equal(await Repos.remove("acct-expired", "verify", Hash("e")), false, "removed");
});

test("deleteForUser removes both purposes of the account and reports the count; other accounts keep theirs", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-del", "verify", Hash("a")));
    await Repos.replace(Record("acct-del", "reset", Hash("b")));
    await Repos.replace(Record("acct-keep", "verify", Hash("c")));
    assert.equal(await Repos.deleteForUser("acct-del"), 2);
    assert.equal(await Repos.deleteForUser("acct-del"), 0);
    assert.notEqual(await Repos.reserveTry("acct-keep", "verify", NOW, 5), undefined);
});

test("peekLive reads without spending a try, and shows nothing once expired or out of tries", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-peek", "verify", Hash("q")));
    assert.equal((await Repos.peekLive("acct-peek", "verify", NOW, 2))?.attempts, 0, "reading spends no try");
    assert.equal((await Repos.peekLive("acct-peek", "verify", NOW, 2))?.attempts, 0);
    assert.equal(await Repos.peekLive("acct-peek", "verify", "2026-10-15T12:05:00.000Z", 2), undefined, "expired at the expiry");
    await Repos.reserveTry("acct-peek", "verify", NOW, 2);
    await Repos.reserveTry("acct-peek", "verify", NOW, 2);
    assert.equal(await Repos.peekLive("acct-peek", "verify", NOW, 2), undefined, "out of tries");
});

test("consume uses a code only while the row still holds it, unexpired and with tries left, and only once", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-consume", "verify", Hash("c1")));
    assert.equal(await Repos.consume("acct-consume", "verify", Hash("other"), NOW, 5), false, "a different hash uses nothing");
    assert.notEqual(await Repos.peekLive("acct-consume", "verify", NOW, 5), undefined, "and the code is still there");
    assert.equal(await Repos.consume("acct-consume", "verify", Hash("c1"), NOW, 5), true);
    assert.equal(await Repos.consume("acct-consume", "verify", Hash("c1"), NOW, 5), false, "a second use finds nothing");

    await Repos.replace(Record("acct-consume-late", "verify", Hash("c2"), LATER));
    assert.equal(await Repos.consume("acct-consume-late", "verify", Hash("c2"), LATER, 5), false, "not after the expiry");

    await Repos.replace(Record("acct-consume-dead", "verify", Hash("c3")));
    await Repos.reserveTry("acct-consume-dead", "verify", NOW, 1);
    assert.equal(await Repos.consume("acct-consume-dead", "verify", Hash("c3"), NOW, 1), false, "out of tries: not usable");
});

test("the stored row holds the hash and the expiry mirror, never a plain code", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-shape", "verify", Hash("h")));
    const Row = await Realm.db.read(undefined, (c) => c.get("SELECT doc FROM emailCodes WHERE _id = ?", "acct-shape:verify"));
    const Doc = JSON.parse(String(Row?.doc));
    assert.deepEqual(Object.keys(Doc).sort(), ["attempts", "codeHash", "createdAt", "expiresAt", "purpose", "ttlAt", "userId"].sort());
    assert.equal(Doc.ttlAt, LATER);
});

test("purgeExpired removes the codes past their expiry (the storage backstop), and keeps the live ones", async () => {
    const Repos = Realm.repos.emailCodes;
    await Repos.replace(Record("acct-purge-old", "verify", Hash("p1"), "2026-10-15T11:00:00.000Z"));
    await Repos.replace(Record("acct-purge-live", "verify", Hash("p2"), "2099-01-01T00:00:00.000Z"));
    const Removed = await Realm.db.purgeExpired(NOW);
    assert.equal(Removed.emailCodes, 1);
    assert.equal(await Repos.remove("acct-purge-old", "verify", Hash("p1")), false);
    assert.equal(await Repos.remove("acct-purge-live", "verify", Hash("p2")), true);
});

after(async () => {
    await Realm.cleanup();
});
