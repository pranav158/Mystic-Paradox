/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The 48 h sweep: only registrations made under required, still unverified after 48 h, are removed, with their codes and
// sessions. Existing accounts, verified ones and fresh ones stay. The conditional delete keeps an account verified in the meantime.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { CreateSessionForUser } from "./launcherAuth";
import { UsePersistenceForTest } from "../persistence";
import type { LauncherAccountRecord } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { EmailCodeHash } from "../security/emailCodes";
import { HashOpaqueToken } from "../security/launcherTokens";
import { SweepUnverifiedRegistrations, UNVERIFIED_REGISTRATION_TTL_MS } from "./launcherEmail";

let Realm: TestRealm;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

before(() => {
    process.env.API_KEY_HASH_SECRET = "sweep-test-secret-that-is-long-enough-3456789012";
    // A session is signed for the stale registration's sign-in check, so the launcher token keys are needed here too.
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey).toString("base64");
    Realm = OpenTestRealm("email-sweep");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
});

after(async () => {
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
});

async function Make(label: string, fields: Partial<LauncherAccountRecord>): Promise<string> {
    const userId = crypto.randomUUID();
    const Record: LauncherAccountRecord = {
        userId, email: `${label}@example.test`, displayNameNormalized: userId, displayName: userId, status: "active",
        approvalStatus: "approved", roles: ["player"], createdAt: new Date(NOW - 50 * HOUR).toISOString(), usernameSet: false,
        ...fields
    };
    await Realm.repos.launcherAccounts.create(Record);
    return userId;
}

test("the sweep removes only unverified registrations pending for more than 48 hours, with their codes and sessions", async () => {
    const Stale = await Make("stale", { emailVerificationPendingSince: new Date(NOW - 49 * HOUR).toISOString() });
    const Fresh = await Make("fresh", { emailVerificationPendingSince: new Date(NOW - 1 * HOUR).toISOString() });
    const Verified = await Make("verified", {
        emailVerificationPendingSince: new Date(NOW - 49 * HOUR).toISOString(),
        emailVerifiedAt: new Date(NOW - 48 * HOUR).toISOString()
    });
    const Existing = await Make("existing", {});
    const ExistingOld = await Make("existing-old", { createdAt: new Date(NOW - 400 * 24 * HOUR).toISOString() });

    // Codes and a session of the stale registration: both must go with it.
    const Later = new Date(NOW + 60_000).toISOString();
    await Realm.repos.emailCodes.replace({ userId: Stale, purpose: "verify", codeHash: EmailCodeHash(Stale, "verify", "123456"),
        attempts: 0, createdAt: new Date(NOW - 49 * HOUR).toISOString(), expiresAt: Later });
    const Session = await CreateSessionForUser(Stale, "device", "PC");
    assert.ok(Session.refreshToken);

    const Removed = await SweepUnverifiedRegistrations(NOW);
    assert.equal(Removed, 1, "only the stale registration");

    assert.equal(await Realm.repos.launcherAccounts.findByUserId(Stale), undefined, "the stale registration is gone");
    assert.notEqual(await Realm.repos.launcherAccounts.findByUserId(Fresh), undefined, "a registration pending for 1 hour stays");
    assert.notEqual(await Realm.repos.launcherAccounts.findByUserId(Verified), undefined, "a verified registration stays");
    assert.notEqual(await Realm.repos.launcherAccounts.findByUserId(Existing), undefined, "an account from before the switch stays");
    assert.notEqual(await Realm.repos.launcherAccounts.findByUserId(ExistingOld), undefined, "however old, an account that was never pending stays");

    assert.equal(await Realm.repos.refreshSessions.findByTokenHash(HashOpaqueToken(Session.refreshToken)), undefined,
        "the session of the removed account is gone");
    const CodeRows = await Realm.db.read(undefined, (c) => Number(c.get("SELECT COUNT(*) AS n FROM emailCodes WHERE userId = ?", Stale)?.n ?? 0));
    assert.equal(CodeRows, 0, "its codes are gone");
});

test("a second sweep removes nothing more, and the freed address can register again", async () => {
    assert.equal(await SweepUnverifiedRegistrations(NOW), 0);
    const Address = "stale@example.test";
    assert.equal(await Realm.repos.launcherAccounts.findByEmail(Address), undefined, "the address is free");
});

test("the conditional delete keeps an account verified after it was listed", async () => {
    const Pending = await Make("late-verify", { emailVerificationPendingSince: new Date(NOW - 49 * HOUR).toISOString() });
    const CutOff = new Date(NOW - UNVERIFIED_REGISTRATION_TTL_MS).toISOString();
    await Realm.repos.launcherAccounts.setEmailVerified(Pending, new Date(NOW - 1000).toISOString());
    assert.equal(await Realm.repos.launcherAccounts.deleteUnverifiedRegistration(Pending, CutOff), false, "verified meanwhile: kept");
    assert.notEqual(await Realm.repos.launcherAccounts.findByUserId(Pending), undefined);
});
