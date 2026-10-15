/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { LauncherAccountRecord, UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { RegisterAccount } from "../controllers/launcherAuth";
import { ResolveOrCreateAccountForDiscordUser } from "../controllers/discordAuth";
import { AssertAccountAdmitted } from "../security/accountEligibility";
import { LauncherApiError } from "../security/launcherErrors";
import { PRIVACY_VERSION, TERMS_VERSION } from "../legal/legalPolicy";
import { LogRegistrationApprovalPolicy, ResolveRegistrationApproval } from "./registrationApproval";

// [2026-10-14] MYSTICPARADOX_REGISTRATION_APPROVAL=required|off, one switch on both providers. The pure parsing and the startup
// lines first; then launcher sign-up and Discord sign-up, run through the real controllers on a SQLite realm and on a stubbed MongoDB
// database (the Mongo repositories themselves run, against a fake collection that records inserts; no server is needed).

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

const MongoDriver = require("mongodb") as typeof import("mongodb");

function WithEnvironment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const Saved = new Map<string, string | undefined>();
    for (const [Key, Value] of Object.entries(values)) {
        Saved.set(Key, process.env[Key]);
        if (Value === undefined) delete process.env[Key];
        else process.env[Key] = Value;
    }
    const Restore = () => {
        for (const [Key, Value] of Saved) {
            if (Value === undefined) delete process.env[Key];
            else process.env[Key] = Value;
        }
    };
    return run().finally(Restore);
}

function Lines() {
    const Recorded: Array<{ level: "info" | "warn"; message: string }> = [];
    return {
        sink: {
            info: (message: string) => { Recorded.push({ level: "info", message }); },
            warn: (message: string) => { Recorded.push({ level: "warn", message }); }
        },
        Recorded
    };
}

// ---- Parsing (pure) ----

test("unset, blank or whitespace: the default off, new accounts approved at once", () => {
    for (const value of [undefined, "", "   "]) {
        const policy = ResolveRegistrationApproval(value === undefined ? {} : { MYSTICPARADOX_REGISTRATION_APPROVAL: value });
        assert.deepEqual(policy, { mode: "off", approvalStatus: "approved", isDefault: true }, `value ${JSON.stringify(value)}`);
    }
});

test("off is read case-insensitively and trimmed; it is not the default", () => {
    for (const value of ["off", "OFF", " Off "]) {
        const policy = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: value });
        assert.deepEqual(policy, { mode: "off", approvalStatus: "approved", isDefault: false }, value);
    }
});

test("required is read case-insensitively and trimmed: new accounts stay pending", () => {
    for (const value of ["required", "REQUIRED", " Required "]) {
        const policy = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: value });
        assert.deepEqual(policy, { mode: "required", approvalStatus: "pending", isDefault: false }, value);
    }
});

test("an unrecognised value fails closed: required, pending, with a refusal naming the value", () => {
    for (const value of ["on", "true", "1", "yes", "maybe", "off please", "requried"]) {
        const policy = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: value });
        assert.equal(policy.mode, "required", value);
        assert.equal(policy.approvalStatus, "pending", value);
        assert.match(policy.refusal ?? "", /must be required or off/, value);
    }
});

test("the replaced MYSTICPARADOX_REGISTRATION_AUTO_APPROVE is read only to warn: it changes nothing", () => {
    const legacyOnly = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "on" });
    assert.equal(legacyOnly.approvalStatus, "approved", "unset MYSTICPARADOX_REGISTRATION_APPROVAL is the off default");
    assert.match(legacyOnly.legacyWarning ?? "", /MYSTICPARADOX_REGISTRATION_AUTO_APPROVE is replaced by MYSTICPARADOX_REGISTRATION_APPROVAL/);

    const legacyWithRequired = ResolveRegistrationApproval({
        MYSTICPARADOX_REGISTRATION_APPROVAL: "required", MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "on"
    });
    assert.equal(legacyWithRequired.approvalStatus, "pending", "the old key never approves anyone under required");
    assert.ok(legacyWithRequired.legacyWarning);

    const legacyBlank = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "  " });
    assert.equal(legacyBlank.legacyWarning, undefined, "a blank old key is not worth a warning");
});

test("the decision does not depend on the persistence provider (mongodb, sqlite or unset)", () => {
    const expected = ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: "required" });
    for (const provider of [undefined, "mongodb", "sqlite"]) {
        const environment: NodeJS.ProcessEnv = { MYSTICPARADOX_REGISTRATION_APPROVAL: "required" };
        if (provider !== undefined) environment.PERSISTENCE_PROVIDER = provider;
        assert.deepEqual(ResolveRegistrationApproval(environment), expected, String(provider));
    }
});

// ---- Startup lines ----

test("startup: one info line with the active mode; warnings only for an unrecognised value or the replaced switch", () => {
    const Required = Lines();
    LogRegistrationApprovalPolicy(ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: "required" }), Required.sink);
    assert.deepEqual(Required.Recorded.map((line) => line.level), ["info"]);
    assert.match(Required.Recorded[0]!.message, /MYSTICPARADOX_REGISTRATION_APPROVAL=required: new accounts need approval/);

    const Off = Lines();
    LogRegistrationApprovalPolicy(ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: "off" }), Off.sink);
    assert.deepEqual(Off.Recorded.map((line) => line.level), ["info"]);
    assert.match(Off.Recorded[0]!.message, /MYSTICPARADOX_REGISTRATION_APPROVAL=off: new accounts are approved at once/);

    const Default = Lines();
    LogRegistrationApprovalPolicy(ResolveRegistrationApproval({}), Default.sink);
    assert.deepEqual(Default.Recorded.map((line) => line.level), ["info"]);
    assert.match(Default.Recorded[0]!.message, /not set \(default off\): new accounts are approved at once/);

    const Bad = Lines();
    LogRegistrationApprovalPolicy(ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_APPROVAL: "on" }), Bad.sink);
    assert.deepEqual(Bad.Recorded.map((line) => line.level), ["warn", "info"]);
    assert.match(Bad.Recorded[0]!.message, /WARNING: MYSTICPARADOX_REGISTRATION_APPROVAL must be required or off/);
    assert.match(Bad.Recorded[1]!.message, /new accounts need approval/, "an unrecognised value is logged as required");

    const Legacy = Lines();
    LogRegistrationApprovalPolicy(ResolveRegistrationApproval({ MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "on" }), Legacy.sink);
    assert.deepEqual(Legacy.Recorded.map((line) => line.level), ["warn", "info"]);
    assert.match(Legacy.Recorded[0]!.message, /has no effect now/);
});

// ---- Launcher sign-up on both providers ----

const TestConsent = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, ageConfirmed: true };
let ipCounter = 0;
function NextIp(): string { ipCounter += 1; return `198.51.100.${ipCounter}`; }

function Signup(label: string) {
    return {
        displayName: `Slayer${label}`,
        email: `${label.toLowerCase()}@example.test`,
        password: "correct horse battery"
    };
}

// The Mongo client caches its database for the life of the process, so the fake is installed once per file on the driver's
// prototype (connect and db; no network) and its recorded writes are cleared before each Mongo test.
type MongoInsert = { collection: string; doc: Record<string, any> };
let FakeMongo: { Inserted: MongoInsert[] } | undefined;

function InstallFakeMongo(): { Inserted: MongoInsert[] } {
    if (FakeMongo !== undefined) {
        FakeMongo.Inserted.length = 0;
        return FakeMongo;
    }
    const Inserted: MongoInsert[] = [];
    const Db = {
        collection(name: string) {
            return {
                findOne: async () => null,
                insertOne: async (doc: Record<string, any>) => { Inserted.push({ collection: name, doc }); return { acknowledged: true }; },
                updateOne: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 })
            };
        }
    };
    const Proto = MongoDriver.MongoClient.prototype as any;
    const OriginalConnect = Proto.connect;
    const OriginalDb = Proto.db;
    Proto.connect = async function connectFake(this: unknown) { return this; };
    Proto.db = function dbFake() { return Db; };
    Cleanups.push(async () => { Proto.connect = OriginalConnect; Proto.db = OriginalDb; });
    FakeMongo = { Inserted };
    return FakeMongo;
}

/** The environment a Mongo test runs under: the provider, a URI (never contacted: connect is faked) and the approval mode. */
function MongoEnvironment(mode: string | undefined): Record<string, string | undefined> {
    return { PERSISTENCE_PROVIDER: "mongodb", MONGODB_URI: "mongodb://127.0.0.1:1/registration-approval-test", MYSTICPARADOX_REGISTRATION_APPROVAL: mode };
}

function SqliteProvider(label: string): TestRealm {
    const Realm = OpenTestRealm(label);
    Cleanups.push(Realm.cleanup);
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    return Realm;
}

async function RegisterWith(mode: Record<string, string | undefined>, label: string) {
    const Signed = Signup(label);
    return WithEnvironment({ ...mode }, () =>
        RegisterAccount(Signed.displayName, Signed.email, Signed.password, "Test PC", "device-" + label, NextIp(), TestConsent));
}

test("sqlite, default (unset): launcher sign-up approves at once and the stored account is admitted", async () => {
    const Realm = SqliteProvider("regapproval-default");
    const Result = await RegisterWith({ PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_REGISTRATION_APPROVAL: undefined }, "Default");
    assert.equal(Result.approvalRequired, false);
    assert.equal(Result.account.approvalStatus, "approved");
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Result.account.userId) as LauncherAccountRecord;
    assert.equal(Stored.approvalStatus, "approved");
    assert.doesNotThrow(() => AssertAccountAdmitted(Stored));
});

test("sqlite, required: launcher sign-up stays pending and the account is refused until approved (today's behaviour)", async () => {
    const Realm = SqliteProvider("regapproval-required");
    const Result = await RegisterWith({ PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_REGISTRATION_APPROVAL: "required" }, "Required");
    assert.equal(Result.approvalRequired, true);
    assert.equal(Result.account.approvalStatus, "pending");
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Result.account.userId) as LauncherAccountRecord;
    assert.equal(Stored.approvalStatus, "pending");
    assert.throws(() => AssertAccountAdmitted(Stored), (error: unknown) =>
        error instanceof LauncherApiError && error.code === "AUTH_APPROVAL_PENDING");
});

test("sqlite, off: launcher sign-up approves at once", async () => {
    const Realm = SqliteProvider("regapproval-off");
    const Result = await RegisterWith({ PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_REGISTRATION_APPROVAL: "off" }, "Off");
    assert.equal(Result.approvalRequired, false);
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Result.account.userId) as LauncherAccountRecord;
    assert.equal(Stored.approvalStatus, "approved");
});

test("sqlite: the replaced AUTO_APPROVE switch set to on under required keeps the account pending", async () => {
    const Realm = SqliteProvider("regapproval-legacy");
    const Result = await RegisterWith({
        PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_REGISTRATION_APPROVAL: "required", MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "on"
    }, "Legacy");
    assert.equal(Result.approvalRequired, true);
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Result.account.userId) as LauncherAccountRecord;
    assert.equal(Stored.approvalStatus, "pending");
});

test("mongodb (fake database): default approves at once and the inserted account is approved", async () => {
    const Mongo = InstallFakeMongo();
    UsePersistenceForTest(undefined);
    const Result = await RegisterWith(MongoEnvironment(undefined), "MDefault");
    assert.equal(Result.approvalRequired, false);
    const Accounts = Mongo.Inserted.filter((entry) => entry.collection === "accounts");
    assert.equal(Accounts.length, 1);
    assert.equal(Accounts[0]!.doc.approvalStatus, "approved");
});

test("mongodb (fake database): required inserts the account as pending and no session is issued", async () => {
    const Mongo = InstallFakeMongo();
    UsePersistenceForTest(undefined);
    const Result = await RegisterWith(MongoEnvironment("required"), "MRequired");
    assert.equal(Result.approvalRequired, true);
    const Accounts = Mongo.Inserted.filter((entry) => entry.collection === "accounts");
    assert.equal(Accounts.length, 1);
    assert.equal(Accounts[0]!.doc.approvalStatus, "pending");
});

// ---- Discord on both providers: sign-in never creates an account [2026-10-15] ----

function DiscordUser(id: string) {
    return { id, username: `discord${id}`, global_name: null, avatar: null };
}

// Discord sign-in only resolves a linked Discord user now. No Discord account is created, so the approval switch does not apply to it:
// an unlinked Discord user is refused under either value, and a linked one keeps the account's own approval.
test("sqlite: an unlinked Discord user is refused under either switch, and no account or identity is created", async () => {
    const Realm = SqliteProvider("discord-no-create");
    for (const mode of ["off", "required"]) {
        await WithEnvironment({ MYSTICPARADOX_REGISTRATION_APPROVAL: mode, PERSISTENCE_PROVIDER: "sqlite" }, async () => {
            const Id = mode === "off" ? "100000000000000001" : "100000000000000002";
            await assert.rejects(ResolveOrCreateAccountForDiscordUser(DiscordUser(Id)), (error: unknown) =>
                error instanceof LauncherApiError && error.code === "AUTH_DISCORD_NOT_LINKED");
        });
    }
    const Accounts = await Realm.db.read(undefined, (c) => Number(c.get("SELECT COUNT(*) AS n FROM accounts")?.n ?? 0));
    assert.equal(Accounts, 0, "no account was created");
    assert.equal(await Realm.repos.authIdentities.findByProviderSubject("discord", "100000000000000001"), undefined);
});

test("sqlite: a linked Discord user resolves to its account, and the account keeps its own approval", async () => {
    const Realm = SqliteProvider("discord-linked");
    const CreatedAt = new Date().toISOString();
    const Account: LauncherAccountRecord = {
        userId: "linked-account-1", displayNameNormalized: "linkedslayer", displayName: "LinkedSlayer", status: "active",
        approvalStatus: "pending", roles: ["player"], createdAt: CreatedAt, usernameSet: true
    };
    await Realm.repos.launcherAccounts.create(Account);
    await Realm.repos.authIdentities.create({
        provider: "discord", providerSubject: "100000000000000003", userId: Account.userId, providerUsername: "linked", linkedAt: CreatedAt
    });
    await WithEnvironment({ MYSTICPARADOX_REGISTRATION_APPROVAL: "off", PERSISTENCE_PROVIDER: "sqlite" }, async () => {
        assert.equal(await ResolveOrCreateAccountForDiscordUser(DiscordUser("100000000000000003")), Account.userId);
    });
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Account.userId) as LauncherAccountRecord;
    assert.equal(Stored.approvalStatus, "pending", "resolving never changes the approval");
    assert.throws(() => AssertAccountAdmitted(Stored), (error: unknown) =>
        error instanceof LauncherApiError && error.code === "AUTH_APPROVAL_PENDING");
});

test("mongodb (fake database): Discord never creates an account, under either switch", async () => {
    const Mongo = InstallFakeMongo();
    UsePersistenceForTest(undefined);
    for (const mode of [undefined, "required"]) {
        const Id = mode === undefined ? "200000000000000001" : "200000000000000002";
        await assert.rejects(WithEnvironment(MongoEnvironment(mode), () => ResolveOrCreateAccountForDiscordUser(DiscordUser(Id))), (error: unknown) =>
            error instanceof LauncherApiError && error.code === "AUTH_DISCORD_NOT_LINKED");
    }
    assert.equal(Mongo.Inserted.length, 0, "no account and no identity row was written");
});
