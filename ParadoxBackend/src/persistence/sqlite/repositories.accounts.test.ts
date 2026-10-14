import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MongoServerError } from "mongodb";
import { AdminAuditRecord } from "../contracts/AdminRepository";
import { LauncherAccountRecord } from "../contracts/LauncherAccountRepository";
import { FUTURE, NOW, OpenTestRealm, PAST } from "./testSupport";

// Accounts and everything that hangs off sign-in: launcher accounts, Discord identities, refresh sessions, exchange
// codes, Discord OAuth transactions, admin sessions and audit, API keys, and the player-deletion cascade.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });
function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const IsDuplicate = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

function Account(id: string, overrides: Partial<LauncherAccountRecord> = {}): LauncherAccountRecord {
    return {
        userId: id,
        email: `${id}@example.test`,
        displayNameNormalized: `name-${id}`,
        displayName: `Name-${id}`,
        passwordHash: "argon2id$x",
        status: "active",
        approvalStatus: "pending",
        roles: ["player"],
        createdAt: NOW,
        ...overrides
    };
}

test("dev accounts: create, find, and a second create of the same id is a duplicate-key error", async () => {
    const { repos } = Realm("acc-dev");
    assert.equal(await repos.accounts.findByUserId("nobody"), undefined);
    await repos.accounts.create({ userId: "dev-1", name: "Dev One", notes: 7 });
    assert.deepEqual(await repos.accounts.findByUserId("dev-1"), { userId: "dev-1", name: "Dev One", notes: 7 });
    await assert.rejects(repos.accounts.create({ userId: "dev-1", name: "again", notes: 0 }), IsDuplicate);
    assert.equal((await repos.accounts.findByUserId("dev-1"))?.name, "Dev One");
});

test("launcher accounts share the accounts table: create seeds the game's name/notes and dev accounts stay invisible to it", async () => {
    const { repos } = Realm("acc-launcher");
    await repos.accounts.create({ userId: "dev-1", name: "Dev", notes: 0 });
    await repos.launcherAccounts.create(Account("1"));

    assert.deepEqual(await repos.accounts.findByUserId("1"), { userId: "1", name: "Name-1", notes: 0 });
    assert.equal(await repos.launcherAccounts.findByUserId("dev-1"), undefined, "no displayNameNormalized, not a launcher account");
    const Found = await repos.launcherAccounts.findByUserId("1");
    assert.equal(Found?.email, "1@example.test");
    assert.deepEqual(Found?.roles, ["player"]);
    assert.equal(Found?.lastLoginAt, undefined);
    assert.equal((await repos.launcherAccounts.findByEmail("1@example.test"))?.userId, "1");
    assert.equal((await repos.launcherAccounts.findByDisplayNameNormalized("name-1"))?.userId, "1");
    assert.equal(await repos.launcherAccounts.findByEmail("none@example.test"), undefined);
});

test("launcher accounts: email and display name are unique only where present", async () => {
    const { repos } = Realm("acc-unique");
    await repos.launcherAccounts.create(Account("1"));
    await assert.rejects(repos.launcherAccounts.create(Account("2", { email: "1@example.test" })), IsDuplicate);
    await assert.rejects(repos.launcherAccounts.create(Account("3", { displayNameNormalized: "name-1" })), IsDuplicate);
    await repos.launcherAccounts.create(Account("4", { email: undefined, passwordHash: undefined }));
    await repos.launcherAccounts.create(Account("5", { email: undefined, passwordHash: undefined }));
    assert.equal((await repos.launcherAccounts.listForAdmin({ skip: 0, limit: 50 })).total, 3);
});

test("launcher accounts: login time, username change (and its conflict), access state and roles", async () => {
    const { repos, uow } = Realm("acc-update");
    await repos.launcherAccounts.create(Account("1"));
    await repos.launcherAccounts.create(Account("2"));

    await repos.launcherAccounts.updateLastLogin("1", "2026-10-13T13:00:00.000Z");
    assert.equal((await repos.launcherAccounts.findByUserId("1"))?.lastLoginAt, "2026-10-13T13:00:00.000Z");
    await repos.launcherAccounts.updateLastLogin("ghost", NOW); // no such account: nothing happens

    await repos.launcherAccounts.setUsername("1", "Brand New", "brand new");
    assert.equal((await repos.accounts.findByUserId("1"))?.name, "Brand New", "the game-facing name follows");
    assert.equal((await repos.launcherAccounts.findByUserId("1"))?.usernameSet, true);
    await assert.rejects(repos.launcherAccounts.setUsername("2", "Brand New", "brand new"), IsDuplicate);
    assert.equal((await repos.launcherAccounts.findByUserId("2"))?.displayName, "Name-2", "a refused rename changes nothing");

    const Approved = await repos.launcherAccounts.setAccessState("1", {
        approvalStatus: "approved", approvalUpdatedAt: NOW, approvalUpdatedBy: "admin"
    });
    assert.equal(Approved?.approvalStatus, "approved");
    assert.equal(Approved?.approvalReason, "", "no reason stores an empty string");
    assert.equal(Approved?.status, "active");
    const Banned = await repos.launcherAccounts.setAccessState("1", {
        status: "banned", approvalUpdatedAt: NOW, approvalUpdatedBy: "admin", approvalReason: "cheating"
    });
    assert.equal(Banned?.status, "banned");
    assert.equal(Banned?.approvalStatus, "approved", "untouched fields stay");
    assert.equal(await repos.launcherAccounts.setAccessState("ghost", { approvalUpdatedAt: NOW, approvalUpdatedBy: "a" }), undefined);

    await assert.rejects(uow.withTransaction(async (r, session) => {
        const Updated = await r.launcherAccounts.updateRoles("1", ["player", "admin"], { rolesUpdatedAt: NOW, rolesUpdatedBy: "root" }, session);
        assert.deepEqual(Updated?.roles, ["player", "admin"]);
        throw new Error("abort");
    }), /abort/);
    assert.deepEqual((await repos.launcherAccounts.findByUserId("1"))?.roles, ["player"], "the roles change was part of the aborted unit");
    const Roles = await repos.launcherAccounts.updateRoles("1", ["admin"], { rolesUpdatedAt: NOW, rolesUpdatedBy: "root" });
    assert.deepEqual(Roles?.roles, ["admin"]);
    assert.equal(Roles?.rolesUpdatedBy, "root");
    assert.equal(await repos.launcherAccounts.updateRoles("ghost", [], { rolesUpdatedAt: NOW, rolesUpdatedBy: "r" }), undefined);
});

test("launcher accounts: the admin list filters, searches case-insensitively, sorts newest first and pages", async () => {
    const { repos, db } = Realm("acc-list");
    await repos.launcherAccounts.create(Account("a", { createdAt: "2026-10-01T00:00:00.000Z", approvalStatus: "approved", displayName: "Alpha.One" }));
    await repos.launcherAccounts.create(Account("b", { createdAt: "2026-10-03T00:00:00.000Z", approvalStatus: "pending", displayName: "Bravo" }));
    await repos.launcherAccounts.create(Account("c", { createdAt: "2026-10-02T00:00:00.000Z", approvalStatus: "rejected", status: "banned", displayName: "Charlie" }));
    // A legacy row written before approvalStatus existed counts as approved.
    await db.write(undefined, (c) => c.run(
        "INSERT INTO accounts (_id, doc) VALUES ('legacy', ?)",
        JSON.stringify({ userId: "legacy", email: "old@example.test", displayNameNormalized: "legacy", displayName: "Legacy", status: "active", roles: ["player"], createdAt: "2026-09-01T00:00:00.000Z" })
    ));
    await repos.accounts.create({ userId: "dev", name: "dev account", notes: 0 }); // never listed

    const All = await repos.launcherAccounts.listForAdmin({ skip: 0, limit: 10 });
    assert.deepEqual(All.accounts.map((Entry) => Entry.userId), ["b", "c", "a", "legacy"]);
    assert.equal(All.total, 4);

    const Approved = await repos.launcherAccounts.listForAdmin({ approvalStatus: "approved", skip: 0, limit: 10 });
    assert.deepEqual(Approved.accounts.map((Entry) => Entry.userId), ["a", "legacy"]);
    assert.deepEqual((await repos.launcherAccounts.listForAdmin({ approvalStatus: "pending", skip: 0, limit: 10 })).accounts.map((E) => E.userId), ["b"]);
    assert.deepEqual((await repos.launcherAccounts.listForAdmin({ status: "banned", skip: 0, limit: 10 })).accounts.map((E) => E.userId), ["c"]);

    const Search = await repos.launcherAccounts.listForAdmin({ search: "ALPHA.one", skip: 0, limit: 10 });
    assert.deepEqual(Search.accounts.map((Entry) => Entry.userId), ["a"], "case-insensitive, and the dot is literal");
    assert.equal((await repos.launcherAccounts.listForAdmin({ search: "alphaXone", skip: 0, limit: 10 })).total, 0);
    assert.deepEqual((await repos.launcherAccounts.listForAdmin({ search: "old@example", skip: 0, limit: 10 })).accounts.map((E) => E.userId), ["legacy"], "matches email");
    assert.deepEqual((await repos.launcherAccounts.listForAdmin({ search: "b", skip: 0, limit: 10 })).accounts.map((E) => E.userId), ["b"], "matches userId too");

    const Page = await repos.launcherAccounts.listForAdmin({ skip: 1, limit: 2 });
    assert.deepEqual(Page.accounts.map((Entry) => Entry.userId), ["c", "a"]);
    assert.equal(Page.total, 4, "total ignores the page");
    assert.equal((await repos.launcherAccounts.listForAdmin({ skip: 0, limit: 0 })).accounts.length, 4, "limit 0 means no limit, as in MongoDB");
});

test("Discord identities: one subject links to one account", async () => {
    const { repos } = Realm("acc-identity");
    const Identity = { provider: "discord" as const, providerSubject: "1234", userId: "u1", providerUsername: "fox", linkedAt: NOW };
    await repos.authIdentities.create(Identity);
    assert.deepEqual(await repos.authIdentities.findByProviderSubject("discord", "1234"), { ...Identity, providerAvatarUrl: undefined });
    assert.equal((await repos.authIdentities.findByUserId("discord", "u1"))?.providerSubject, "1234");
    await assert.rejects(repos.authIdentities.create({ ...Identity, userId: "u2" }), IsDuplicate);
    assert.equal(await repos.authIdentities.findByProviderSubject("discord", "9999"), undefined);
});

test("refresh sessions: lookup, revoke one / a family / everything of a user, and family liveness", async () => {
    const { repos } = Realm("acc-refresh");
    const Session = (id: string, family: string, user: string, expiresAt = FUTURE) => ({
        id, tokenHash: `hash-${id}`, userId: user, familyId: family, deviceId: "d", deviceName: "pc", createdAt: NOW, expiresAt
    });
    await repos.refreshSessions.create(Session("1", "fam-a", "u1"));
    await repos.refreshSessions.create(Session("2", "fam-a", "u1"));
    await repos.refreshSessions.create(Session("3", "fam-b", "u1"));
    await repos.refreshSessions.create(Session("4", "fam-c", "u2", PAST));
    await assert.rejects(repos.refreshSessions.create({ ...Session("5", "fam-a", "u1"), tokenHash: "hash-1" }), IsDuplicate);

    const Found = await repos.refreshSessions.findByTokenHash("hash-1");
    assert.equal(Found?.id, "1");
    assert.equal(Found?.revokedAt, undefined);
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-a", "u1"), true);
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-a", "u2"), false, "bound to the user");
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-c", "u2"), false, "expired");

    await repos.refreshSessions.revokeById("1");
    assert.ok((await repos.refreshSessions.findByTokenHash("hash-1"))?.revokedAt);
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-a", "u1"), true, "session 2 still lives");
    await repos.refreshSessions.revokeFamily("fam-a");
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-a", "u1"), false);
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-b", "u1"), true);
    await repos.refreshSessions.revokeAllForUser("u1");
    assert.equal(await repos.refreshSessions.isFamilyActive("fam-b", "u1"), false);
});

test("game exchange codes: consumed at most once, never after expiry, revoked when unused", async () => {
    const { repos } = Realm("acc-codes");
    const Code = (hash: string, user: string, expiresAt = FUTURE) => ({
        codeHash: hash, userId: user, launcherSessionId: "s", buildChangelist: 647472, executableSha256: "exe",
        runtimeChannel: "stable" as const, runtimeSha256: "rt", runtimeManifestVersion: "61", runtimeArtifactSetSha256: "set",
        createdAt: NOW, expiresAt
    });
    await repos.gameExchangeCodes.create(Code("c1", "u1"));
    await repos.gameExchangeCodes.create(Code("c2", "u1"));
    await repos.gameExchangeCodes.create(Code("old", "u1", PAST));

    const First = await repos.gameExchangeCodes.consumeByCodeHash("c1");
    assert.equal(First?.userId, "u1");
    assert.ok(First?.consumedAt);
    assert.equal(await repos.gameExchangeCodes.consumeByCodeHash("c1"), undefined, "single use");
    assert.equal(await repos.gameExchangeCodes.consumeByCodeHash("old"), undefined, "expired");
    assert.equal(await repos.gameExchangeCodes.consumeByCodeHash("nope"), undefined);

    const Racers = await Promise.all(Array.from({ length: 10 }, () => repos.gameExchangeCodes.consumeByCodeHash("c2")));
    assert.equal(Racers.filter((Entry) => Entry !== undefined).length, 1, "exactly one concurrent consumer wins");

    await repos.gameExchangeCodes.create(Code("c3", "u9"));
    await repos.gameExchangeCodes.revokeUnusedForUser("u9");
    assert.equal(await repos.gameExchangeCodes.consumeByCodeHash("c3"), undefined);

    // A realm Play's code carries the realm it was authorised for; an official code has no realmId key at all.
    await repos.gameExchangeCodes.create({ ...Code("r1", "u3"), realmId: "realm-1" });
    assert.equal((await repos.gameExchangeCodes.consumeByCodeHash("r1"))?.realmId, "realm-1");
    await repos.gameExchangeCodes.create(Code("o1", "u3"));
    assert.equal("realmId" in (await repos.gameExchangeCodes.consumeByCodeHash("o1"))!, false);
});

test("Discord OAuth transactions: state is single-use, then the completion code is single-use", async () => {
    const { repos } = Realm("acc-oauth");
    await repos.discordOAuthTransactions.create({ state: "st1", codeVerifier: "verifier", createdAt: NOW, expiresAt: FUTURE });
    await repos.discordOAuthTransactions.create({ state: "stOld", codeVerifier: "v", createdAt: NOW, expiresAt: PAST });

    assert.equal(await repos.discordOAuthTransactions.consumeByState("stOld"), undefined, "expired");
    const Consumed = await repos.discordOAuthTransactions.consumeByState("st1");
    assert.equal(Consumed?.codeVerifier, "verifier");
    assert.ok(Consumed?.consumedAt);
    assert.equal(await repos.discordOAuthTransactions.consumeByState("st1"), undefined);

    await repos.discordOAuthTransactions.attachCompletionCode("st1", "completion-hash", FUTURE, "u1");
    await repos.discordOAuthTransactions.attachCompletionCode("ghost", "other-hash", FUTURE, "u1"); // nothing to attach to
    assert.equal(await repos.discordOAuthTransactions.consumeByCompletionCodeHash("other-hash"), undefined);
    const Completed = await repos.discordOAuthTransactions.consumeByCompletionCodeHash("completion-hash");
    assert.equal(Completed?.userId, "u1");
    assert.ok(Completed?.completionConsumedAt);
    assert.equal(await repos.discordOAuthTransactions.consumeByCompletionCodeHash("completion-hash"), undefined);

    await repos.discordOAuthTransactions.create({ state: "st2", codeVerifier: "v2", createdAt: NOW, expiresAt: FUTURE });
    await repos.discordOAuthTransactions.attachCompletionCode("st2", "late-hash", PAST, "u2");
    assert.equal(await repos.discordOAuthTransactions.consumeByCompletionCodeHash("late-hash"), undefined, "completion window over");
});

test("admin sessions and audit trail", async () => {
    const { repos } = Realm("acc-admin");
    const Session = (id: string, hash: string, expiresAt = FUTURE) => ({
        id, tokenHash: hash, userId: "admin-1", csrfToken: "csrf", createdAt: NOW, expiresAt, ip: "127.0.0.1", userAgent: "test"
    });
    await repos.admin.createSession(Session("s1", "t1"));
    await repos.admin.createSession(Session("s2", "t2", PAST));
    await assert.rejects(repos.admin.createSession(Session("s3", "t1")), IsDuplicate);

    assert.equal((await repos.admin.findActiveSessionByTokenHash("t1"))?.id, "s1");
    assert.equal(await repos.admin.findActiveSessionByTokenHash("t2"), undefined, "expired");
    await repos.admin.revokeSession("s1");
    assert.equal(await repos.admin.findActiveSessionByTokenHash("t1"), undefined, "revoked");

    const Audit = (id: string, target: string | undefined, createdAt: string): AdminAuditRecord => ({
        id, actorUserId: "admin-1", targetUserId: target, action: "X", oldState: { a: 1 }, ip: "127.0.0.1", requestId: `r-${id}`, createdAt
    });
    await repos.admin.appendAudit(Audit("a1", "u1", "2026-10-01T00:00:00.000Z"));
    await repos.admin.appendAudit(Audit("a2", "u2", "2026-10-02T00:00:00.000Z"));
    await repos.admin.appendAudit(Audit("a3", "u1", "2026-10-03T00:00:00.000Z"));
    await repos.admin.appendAudit(Audit("a4", undefined, "2026-10-04T00:00:00.000Z"));

    const Everything = await repos.admin.listAudit(undefined, 0, 10);
    assert.deepEqual(Everything.records.map((Record) => Record.id), ["a4", "a3", "a2", "a1"]);
    assert.equal(Everything.total, 4);
    assert.deepEqual(Everything.records[3].oldState, { a: 1 });
    assert.equal(Everything.records[0].targetUserId, undefined);
    const ForU1 = await repos.admin.listAudit("u1", 0, 10);
    assert.deepEqual(ForU1.records.map((Record) => Record.id), ["a3", "a1"]);
    assert.equal(ForU1.total, 2);
    const Paged = await repos.admin.listAudit(undefined, 1, 2);
    assert.deepEqual(Paged.records.map((Record) => Record.id), ["a3", "a2"]);
    assert.equal(Paged.total, 4);
});

test("API keys: only hashes, the gameserver set can be replaced, user keys are unique per account", async () => {
    const { repos } = Realm("acc-keys");
    await repos.apiKeys.insertGameServerKeyHash("h1");
    await repos.apiKeys.insertGameServerKeyHash("h2");
    assert.deepEqual(await repos.apiKeys.findAllGameServerKeyHashes(), [{ id: 0, keyHash: "h1" }, { id: 1, keyHash: "h2" }]);

    await repos.apiKeys.replaceGameServerKeyHashes(["h2", "h3"]);
    assert.deepEqual((await repos.apiKeys.findAllGameServerKeyHashes()).map((Entry) => Entry.keyHash), ["h2", "h3"]);
    await repos.apiKeys.replaceGameServerKeyHashes(["h2", "h3"]);
    assert.equal((await repos.apiKeys.findAllGameServerKeyHashes()).length, 2, "replacing with the same set is idempotent");
    await repos.apiKeys.replaceGameServerKeyHashes([]);
    assert.deepEqual(await repos.apiKeys.findAllGameServerKeyHashes(), []);

    await repos.apiKeys.insertUserKeyHash("u1", "k1");
    await assert.rejects(repos.apiKeys.insertUserKeyHash("u1", "k2"), IsDuplicate);
    assert.deepEqual(await repos.apiKeys.findAllUserKeyHashes(), [{ userId: "u1", keyHash: "k1" }]);

    assert.deepEqual(await repos.apiKeys.findAllGameServerKeysToRegister(), []);
    assert.deepEqual(await repos.apiKeys.findAllUserKeysToRegister(), []);
    await repos.apiKeys.clearGameServerKeysToRegister();
    await repos.apiKeys.clearUserKeysToRegister();
});

test("deleting a player removes everything they own in one transaction and leaves one tombstone", async () => {
    const { repos } = Realm("acc-delete");
    for (const Id of ["victim", "bystander"]) {
        await repos.launcherAccounts.create(Account(Id));
        await repos.characters.create({ characterId: `${Id}-c1`, userId: Id, createdDate: NOW, lastModifiedDate: NOW, name: "n", updateVersion: 1, data: "{}" });
        await repos.characters.create({ characterId: `${Id}-c2`, userId: Id, createdDate: NOW, lastModifiedDate: NOW, name: "n2", updateVersion: 1, data: "{}" });
        for (const CharacterId of [`${Id}-c1`, `${Id}-c2`]) {
            await repos.inventories.create({ characterId: CharacterId, userId: Id, instancedItems: "[]", stackedItems: "[]" });
            await repos.loadouts.create({ characterId: CharacterId, userId: Id, loadouts: "[{}]", persistent: "{}" });
            await repos.breadcrumbs.create({ characterId: CharacterId, userId: Id, breadcrumbs: "[]", updateVersion: 1 });
            await repos.encounteredContent.create({ characterId: CharacterId, userId: Id, encounteredcontent: "[]" });
        }
        await repos.wallets.create({ userId: Id, balances: { GOLD: 1 } });
        await repos.playerJourney.createIfAbsent({ userId: Id, nodes: "{}", updateVersion: 1, revision: 0 });
        await repos.progressionTracks.increment(Id, "ExperienceTrack_X", 5);
        await repos.progressionTracks.setObjectiveIfGreater(Id, "Obj", 1, 0);
        await repos.progressionTracks.appendObjectiveEvent({ userId: Id, rawBody: "{}", receivedAt: NOW });
        await repos.apiKeys.insertUserKeyHash(Id, `key-${Id}`);
        await repos.authIdentities.create({ provider: "discord", providerSubject: `s-${Id}`, userId: Id, providerUsername: "u", linkedAt: NOW });
        await repos.refreshSessions.create({ id: `rs-${Id}`, tokenHash: `th-${Id}`, userId: Id, familyId: `f-${Id}`, deviceId: "d", deviceName: "p", createdAt: NOW, expiresAt: FUTURE });
        await repos.friendships.upsert({ ownerId: Id, otherId: Id === "victim" ? "bystander" : "victim", status: "ACCEPTED", created: NOW });
    }

    const Result = await repos.admin.deletePlayerData("victim", {
        id: "tombstone", actorUserId: "admin", targetUserId: "victim", action: "PLAYER_DELETE", ip: "127.0.0.1", requestId: "r", createdAt: NOW
    });
    assert.equal(Result.characterCount, 2);
    assert.equal(Result.deletedCounts.accounts, 1);
    assert.equal(Result.deletedCounts.characters, 2);
    assert.equal(Result.deletedCounts.inventories, 2);
    assert.equal(Result.deletedCounts.loadouts, 2);
    assert.equal(Result.deletedCounts.wallets, 1);
    assert.equal(Result.deletedCounts.refreshSessions, 1);
    assert.equal(Result.deletedCounts.friendships, 2, "both directions of the friendship");

    assert.equal(await repos.accounts.findByUserId("victim"), undefined);
    assert.equal((await repos.characters.findManyByUserId("victim")).length, 0);
    assert.equal(await repos.wallets.findByUserId("victim"), undefined);
    assert.equal(await repos.refreshSessions.findByTokenHash("th-victim"), undefined);
    assert.equal((await repos.progressionTracks.getAllForUser("victim")).length, 0);
    assert.equal((await repos.progressionTracks.getAllObjectivesForUser("victim")).length, 0);
    assert.equal(await repos.authIdentities.findByUserId("discord", "victim"), undefined);

    // The bystander is untouched, except that the edge pointing at the victim goes with them.
    assert.equal((await repos.characters.findManyByUserId("bystander")).length, 2);
    assert.equal((await repos.wallets.findByUserId("bystander"))?.balances.GOLD, 1);
    assert.ok(await repos.launcherAccounts.findByUserId("bystander"));
    assert.equal((await repos.friendships.listForOwner("bystander")).length, 0);
    assert.equal((await repos.admin.listAudit("victim", 0, 5)).records[0]?.id, "tombstone");
});
