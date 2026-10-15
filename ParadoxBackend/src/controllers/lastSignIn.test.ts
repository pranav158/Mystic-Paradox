/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { CreateSessionForUser, LAST_SIGN_IN_WRITE_INTERVAL_MS, NoteSignIn, RefreshSession } from "./launcherAuth";
import { GetRepositories, UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import type { LauncherAccountRecord } from "../persistence/contracts/LauncherAccountRepository";

// [2026-10-15] "Last sign-in" stayed at the last password sign-in: the launcher restores its saved session and Discord signs in by
// OAuth, and neither wrote lastLoginAt. NoteSignIn records both, at most once every LAST_SIGN_IN_WRITE_INTERVAL_MS.

const ENV_KEYS = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64"] as const;
const SAVED_ENV = new Map<string, string | undefined>();
let Realm: TestRealm;

function Account(userId: string, lastLoginAt?: string): LauncherAccountRecord {
    return {
        userId,
        email: `${userId}@example.test`,
        displayNameNormalized: userId,
        displayName: userId,
        status: "active",
        approvalStatus: "approved",
        roles: ["player"],
        createdAt: "2026-07-01T00:00:00.000Z",
        usernameSet: true,
        ...(lastLoginAt === undefined ? {} : { lastLoginAt })
    } as LauncherAccountRecord;
}

before(() => {
    for (const key of ENV_KEYS) SAVED_ENV.set(key, process.env[key]);
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey).toString("base64");
    Realm = OpenTestRealm("last-sign-in");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
});

after(async () => {
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
    for (const [key, value] of SAVED_ENV) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test("NoteSignIn writes a stale or missing last sign-in, and skips one written within the interval", async () => {
    const Now = new Date("2026-10-15T14:00:00.000Z");
    await GetRepositories().launcherAccounts.create(Account("stale-user", "2026-08-16T10:00:00.000Z"));
    const Written = await NoteSignIn((await GetRepositories().launcherAccounts.findByUserId("stale-user"))!, Now);
    assert.equal(Written.lastLoginAt, Now.toISOString());
    assert.equal((await GetRepositories().launcherAccounts.findByUserId("stale-user"))!.lastLoginAt, Now.toISOString());

    const Soon = new Date(Now.getTime() + LAST_SIGN_IN_WRITE_INTERVAL_MS - 1_000);
    const Skipped = await NoteSignIn(Written, Soon);
    assert.equal(Skipped.lastLoginAt, Now.toISOString(), "a write within the interval is skipped");

    await GetRepositories().launcherAccounts.create(Account("never-user"));
    const First = await NoteSignIn((await GetRepositories().launcherAccounts.findByUserId("never-user"))!, Now);
    assert.equal(First.lastLoginAt, Now.toISOString(), "an account that never signed in gets its first date");
});

test("a restored session (refresh) updates the last sign-in the dashboard shows", async () => {
    await GetRepositories().launcherAccounts.create(Account("refresh-user", "2026-08-16T10:00:00.000Z"));
    const Session = await CreateSessionForUser("refresh-user", "device-1", "Test PC");
    const Before = Date.now();
    await RefreshSession(Session.refreshToken, "device-1", "Test PC");
    const Stored = Date.parse((await GetRepositories().launcherAccounts.findByUserId("refresh-user"))!.lastLoginAt ?? "");
    assert.ok(Stored >= Before - 1_000, "the stored last sign-in is the refresh time");
});
