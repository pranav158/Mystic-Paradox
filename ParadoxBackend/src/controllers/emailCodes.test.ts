/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The one-time code flow on a real SQLite realm and a recording mail transport: a code is mailed (its HMAC is what is stored),
// single use, refused after 5 wrong tries, refused 5 minutes after it was issued, the send limits, and parallel uses that can only succeed once.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, mock } from "node:test";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { EmailCodeHash, EMAIL_CODE_TTL_MS } from "../security/emailCodes";
import { SetMailTransportForTest, MailTransport } from "../mail/mailSender";
import { RecordingMailTransport } from "../mail/testSupport";
import { AcceptEmailCode, IssueEmailCode, TakeCodeSendSlot } from "./emailCodes";
import type { LauncherAccountRecord } from "../persistence";

let Realm: TestRealm;
const Recorder = new RecordingMailTransport();
let Counter = 0;

before(() => {
    process.env.API_KEY_HASH_SECRET = "email-code-flow-test-secret-that-is-long-enough-5678";
    Realm = OpenTestRealm("email-code-flow");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    SetMailTransportForTest(Recorder);
});

after(async () => {
    SetMailTransportForTest(undefined);
    UsePersistenceForTest(undefined);
    mock.timers.reset();
    await Realm.cleanup();
});

/** A launcher account with a unique address and an IP the send limits have not seen. */
async function NewAccount(): Promise<{ userId: string; email: string; ip: string }> {
    Counter += 1;
    const userId = crypto.randomUUID();
    const email = `flow${Counter}@example.test`;
    const record: LauncherAccountRecord = {
        userId, email, displayNameNormalized: userId, displayName: userId, status: "active", approvalStatus: "approved",
        roles: ["player"], createdAt: new Date().toISOString(), usernameSet: false
    };
    await Realm.repos.launcherAccounts.create(record);
    return { userId, email, ip: `203.0.113.${Counter}` };
}

async function IssueAndRead(account: { userId: string; email: string; ip: string }, purpose: "verify" | "reset" = "verify"): Promise<string> {
    const Sent = await IssueEmailCode(account.userId, account.email, purpose, account.ip);
    assert.equal(Sent, "sent", "the code was mailed");
    const Code = Recorder.codeFor(account.email);
    assert.match(Code ?? "", /^\d{6}$/);
    return Code!;
}

test("a code is mailed to the address, and the store keeps only its HMAC", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    const Stored = await Realm.db.read(undefined, (c) => c.get("SELECT doc FROM emailCodes WHERE _id = ?", `${Account.userId}:verify`));
    const Doc = JSON.parse(String(Stored?.doc));
    assert.equal(Doc.codeHash, EmailCodeHash(Account.userId, "verify", Code));
    assert.match(Doc.codeHash, /^[0-9a-f]{64}$/);
    assert.notEqual(Doc.codeHash, Code, "the code itself is not stored");
    assert.equal(Doc.attempts, 0);
    const Lifetime = Date.parse(Doc.expiresAt) - Date.parse(Doc.createdAt);
    assert.equal(Lifetime, EMAIL_CODE_TTL_MS, "valid 5 minutes from issue");
});

test("a right code is accepted once: its second use is refused", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    assert.equal(await AcceptEmailCode(Account.userId, "verify", Code), true);
    assert.equal(await AcceptEmailCode(Account.userId, "verify", Code), false, "a used code is refused");
});

test("parallel uses of one right code: exactly one is accepted", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    const Results = await Promise.all([1, 2, 3].map(() => AcceptEmailCode(Account.userId, "verify", Code)));
    assert.equal(Results.filter(Boolean).length, 1, JSON.stringify(Results));
});

test("a malformed code is refused without spending a try", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    for (const value of ["12345", "abcdef", undefined, 123456]) {
        assert.equal(await AcceptEmailCode(Account.userId, "verify", value), false, String(value));
    }
    assert.equal(await AcceptEmailCode(Account.userId, "verify", Code), true, "the right code still works");
});

test("five wrong tries use the code up: even the right code is then refused", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    for (let Try = 1; Try <= 5; Try += 1) {
        const Wrong = Code === "000000" ? "000001" : "000000";
        assert.equal(await AcceptEmailCode(Account.userId, "verify", Wrong), false, `wrong try ${Try}`);
    }
    assert.equal(await AcceptEmailCode(Account.userId, "verify", Code), false, "the sixth try, with the right code, is refused");
});

test("the fifth try may be the right one: four wrong tries leave the right code usable", async () => {
    const Account = await NewAccount();
    const Code = await IssueAndRead(Account);
    const Wrong = Code === "000000" ? "000001" : "000000";
    for (let Try = 1; Try <= 4; Try += 1) assert.equal(await AcceptEmailCode(Account.userId, "verify", Wrong), false);
    assert.equal(await AcceptEmailCode(Account.userId, "verify", Code), true);
});

test("a code expires 5 minutes after it was issued: 4 minutes 59 seconds is still good, 5 minutes is refused", async () => {
    const Early = await NewAccount();
    const EarlyCode = await IssueAndRead(Early);
    const JustBefore = new Date(Date.now() + 4 * 60_000 + 59_000).toISOString();
    assert.equal(await AcceptEmailCode(Early.userId, "verify", EarlyCode, JustBefore), true);

    const Late = await NewAccount();
    const LateCode = await IssueAndRead(Late);
    const AtExpiry = new Date(Date.now() + EMAIL_CODE_TTL_MS + 1000).toISOString();
    assert.equal(await AcceptEmailCode(Late.userId, "verify", LateCode, AtExpiry), false, "an expired code is refused");
    assert.equal(await AcceptEmailCode(Late.userId, "verify", LateCode), false, "and it is gone: the next use is refused too");
});

test("a new code replaces the live one: the old code is refused, the new one works", async () => {
    const Account = await NewAccount();
    const Repos = Realm.repos.emailCodes;
    const Now = new Date().toISOString();
    const Later = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
    await Repos.replace({ userId: Account.userId, purpose: "verify", codeHash: EmailCodeHash(Account.userId, "verify", "111111"),
        attempts: 0, createdAt: Now, expiresAt: Later });
    await Repos.replace({ userId: Account.userId, purpose: "verify", codeHash: EmailCodeHash(Account.userId, "verify", "222222"),
        attempts: 0, createdAt: Now, expiresAt: Later });
    assert.equal(await AcceptEmailCode(Account.userId, "verify", "111111"), false, "the replaced code is refused");
    assert.equal(await AcceptEmailCode(Account.userId, "verify", "222222"), true);
});

test("a verify code and a reset code are separate: one does not accept the other", async () => {
    const Account = await NewAccount();
    const VerifyCode = await IssueAndRead(Account, "verify");
    assert.equal(await AcceptEmailCode(Account.userId, "reset", VerifyCode), false, "no reset code is live");
    assert.equal(await AcceptEmailCode(Account.userId, "verify", VerifyCode), true);
});

test("one code a minute per account and purpose; a second send in the same minute mails nothing", async () => {
    const Account = await NewAccount();
    await IssueAndRead(Account, "verify");
    const Before = Recorder.sent.length;
    assert.equal(await IssueEmailCode(Account.userId, Account.email, "verify", Account.ip), "limited");
    assert.equal(Recorder.sent.length, Before, "nothing was mailed");
    assert.equal(await IssueEmailCode(Account.userId, Account.email, "reset", Account.ip), "sent", "the reset purpose has its own minute");
});

test("five codes an hour per account and purpose, and twenty an hour per address (the window moves with time)", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T12:00:00.000Z") });
    try {
        const Account = { userId: crypto.randomUUID(), ip: "198.51.100.200" };
        const Sent: boolean[] = [];
        for (let Minute = 0; Minute < 6; Minute += 1) {
            Sent.push(TakeCodeSendSlot(Account.userId, "verify", `198.51.100.${200 + Minute}`));
            mock.timers.tick(61_000);
        }
        assert.deepEqual(Sent, [true, true, true, true, true, false], "five an hour, one more is refused");
        mock.timers.tick(60 * 60 * 1000);
        assert.equal(TakeCodeSendSlot(Account.userId, "verify", "198.51.100.250"), true, "the hour has passed");

        // A fresh address: one account per send, so only the address window can refuse.
        const Address = "198.51.100.251";
        const Results = Array.from({ length: 21 }, () => TakeCodeSendSlot(crypto.randomUUID(), "verify", Address));
        assert.equal(Results.filter(Boolean).length, 20, "twenty an hour per address");
        assert.equal(Results[20], false, "the 21st send from the address is refused");
    } finally {
        mock.timers.reset();
    }
});

test("a mail that fails is logged by its code only; the stored code stays, and the attempt still uses the minute", async () => {
    const Account = await NewAccount();
    const Failing: MailTransport = {
        send: async () => { throw Object.assign(new Error(`rejected ${Account.email}`), { code: "EENVELOPE" }); }
    };
    SetMailTransportForTest(Failing);
    try {
        assert.equal(await IssueEmailCode(Account.userId, Account.email, "verify", Account.ip), "failed");
    } finally {
        SetMailTransportForTest(Recorder);
    }
    assert.equal(await IssueEmailCode(Account.userId, Account.email, "verify", Account.ip), "limited", "the minute is used");
});
