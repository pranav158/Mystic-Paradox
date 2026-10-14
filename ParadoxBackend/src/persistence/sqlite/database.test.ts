import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MongoServerError } from "mongodb";
import { BACKEND_ROOT, ReadSqliteRuntimeConfig, ResolveSqlitePath } from "./config";
import { SqliteDatabase } from "./database";
import { SqliteSchemaVersionError, CURRENT_SQLITE_SCHEMA_VERSION } from "./schema";
import { Gate, NOW, NewTestDirectory, OpenTestRealm, RemoveTestDirectory, Session, TestConfig, Tick } from "./testSupport";
import { SqliteReadOperationsPolicyRecord, SqliteUpdateOperationsPolicy } from "./directAccess";
import { AdminAuditRecord } from "../contracts/AdminRepository";

const Cleanups: Array<() => Promise<void> | void> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

async function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const Audit = (id: string, target: string): AdminAuditRecord => ({
    id, actorUserId: "admin", targetUserId: target, action: "DELETE", ip: "127.0.0.1", requestId: `req-${id}`, createdAt: NOW
});

test("config: default path sits next to the backend folder, relative paths resolve against the backend, bad values stop startup", () => {
    assert.equal(ResolveSqlitePath(undefined), path.resolve(BACKEND_ROOT, "..", "realm-data", "realm.sqlite"));
    assert.equal(ResolveSqlitePath("data/x.sqlite"), path.resolve(BACKEND_ROOT, "data", "x.sqlite"));
    assert.equal(ResolveSqlitePath(":memory:"), ":memory:");
    assert.equal(ReadSqliteRuntimeConfig({}).synchronous, "FULL");
    assert.equal(ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_SYNCHRONOUS: "Normal" }).synchronous, "NORMAL");
    assert.throws(() => ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_SYNCHRONOUS: "off" }), /full' or 'normal/);
    assert.throws(() => ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_BUSY_TIMEOUT_MS: "-1" }), /integer between/);
    assert.throws(() => ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_BACKUP_KEEP: "0" }), /integer between/);
    assert.equal(ReadSqliteRuntimeConfig({}).backupIntervalMinutes, 1440);
    assert.equal(ReadSqliteRuntimeConfig({}).queueTimeoutMs, 60_000);
    assert.throws(() => ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_QUEUE_TIMEOUT_MS: "5" }), /integer between/);
});

test("the file is WAL, the schema is versioned and a reopen keeps the data and the seeded policy", async () => {
    const Dir = NewTestDirectory("reopen");
    Cleanups.push(() => RemoveTestDirectory(Dir));
    const File = path.join(Dir, "realm.sqlite");

    const First = SqliteDatabase.open(TestConfig(File));
    assert.equal(First.upgraded, true);
    await First.write(undefined, (c) => c.run("INSERT INTO accounts (_id, doc) VALUES ('u1', '{\"userId\":\"u1\",\"name\":\"n\",\"notes\":0}')"));
    assert.equal(String((await First.read(undefined, (c) => c.get("PRAGMA journal_mode")))?.journal_mode), "wal");
    const Policy = await SqliteReadOperationsPolicyRecord(First);
    assert.deepEqual(Policy, { _id: "global", guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 0 });
    assert.equal(await SqliteUpdateOperationsPolicy(First, 0, { guardEnforcement: "OBSERVE", updatedBy: "me" }), true);
    assert.equal(await SqliteUpdateOperationsPolicy(First, 0, { guardEnforcement: "ENFORCE" }), false, "stale version is refused");
    await First.close();

    const Second = SqliteDatabase.open(TestConfig(File));
    assert.equal(Second.upgraded, false);
    assert.equal((await Second.read(undefined, (c) => c.get("SELECT COUNT(*) AS n FROM accounts")))?.n, 1);
    assert.equal(Number((await Second.read(undefined, (c) => c.get("PRAGMA user_version")))?.user_version), CURRENT_SQLITE_SCHEMA_VERSION);
    const Kept = await SqliteReadOperationsPolicyRecord(Second);
    assert.equal(Kept?.guardEnforcement, "OBSERVE", "an existing policy is never reset by a restart");
    assert.equal(Kept?.version, 1);
    await Second.close();
});

test("a database written by a newer build is refused", async () => {
    const Dir = NewTestDirectory("newer");
    Cleanups.push(() => RemoveTestDirectory(Dir));
    const File = path.join(Dir, "realm.sqlite");
    await SqliteDatabase.open(TestConfig(File)).close();
    await Tick(20);
    const Raw = new DatabaseSync(File);
    Raw.exec("PRAGMA user_version = 99");
    Raw.close();
    assert.throws(() => SqliteDatabase.open(TestConfig(File)), SqliteSchemaVersionError);
});

test("a unit of work commits everything or nothing", async () => {
    const { repos, uow } = await Realm("commit");
    await uow.withTransaction(async (r, session) => {
        await r.wallets.create({ userId: "a", balances: { GOLD: 1 } }, session);
        await r.wallets.incrementBalance("a", "GOLD", 4, session);
    });
    assert.equal((await repos.wallets.findByUserId("a"))?.balances.GOLD, 5);

    await assert.rejects(uow.withTransaction(async (r, session) => {
        await r.wallets.create({ userId: "b", balances: {} }, session);
        await r.wallets.incrementBalance("a", "GOLD", 100, session);
        throw new Error("boom");
    }), /boom/);
    assert.equal(await repos.wallets.findByUserId("b"), undefined);
    assert.equal((await repos.wallets.findByUserId("a"))?.balances.GOLD, 5, "the increment was rolled back too");
});

test("a repository call inside the unit of work joins it even when it does not pass the session", async () => {
    const { repos, uow } = await Realm("ambient");
    await assert.rejects(uow.withTransaction(async (r) => {
        await r.accounts.create({ userId: "x", name: "ambient", notes: 0 }); // no session argument
        assert.equal((await r.accounts.findByUserId("x"))?.name, "ambient", "reads its own uncommitted write");
        throw new Error("abort");
    }), /abort/);
    assert.equal(await repos.accounts.findByUserId("x"), undefined);
});

test("outside the unit of work reads see committed data only, and writes wait for it", async () => {
    const { repos, uow } = await Realm("isolation");
    const Hold = Gate();
    const Inside = Gate();
    const Work = uow.withTransaction(async (r, session) => {
        await r.accounts.create({ userId: "pending", name: "p", notes: 0 });
        Inside.open();
        await Hold.wait;
        void session;
    });
    await Inside.wait;

    assert.equal(await repos.accounts.findByUserId("pending"), undefined, "no dirty read");

    let OutsideWriteDone = false;
    const OutsideWrite = repos.accounts.create({ userId: "outside", name: "o", notes: 0 }).then(() => { OutsideWriteDone = true; });
    await Tick(50);
    assert.equal(OutsideWriteDone, false, "a write outside the unit of work queues behind it");

    Hold.open();
    await Work;
    await OutsideWrite;
    assert.equal((await repos.accounts.findByUserId("pending"))?.name, "p");
    assert.equal((await repos.accounts.findByUserId("outside"))?.name, "o");
});

test("units of work never interleave: 40 concurrent revision-guarded read-modify-write transactions all land", async () => {
    const { repos, uow } = await Realm("serialize");
    await repos.inventories.create({ characterId: "c1", userId: "u", instancedItems: "[]", stackedItems: "[]" });
    await Promise.all(Array.from({ length: 40 }, () => uow.withTransaction(async (r, session) => {
        const Inventory = await r.inventories.findByCharacterId("c1", session);
        await Tick(1); // the interleaving window a real handler has
        const Updated = await r.inventories.updateBothIfRevisionMatches("c1", "[]", "[]", Inventory!.revision!, session);
        assert.ok(Updated, "no revision conflict can occur while transactions are serialized");
    })));
    assert.equal((await repos.inventories.findByCharacterId("c1"))?.revision, 40);
});

test("concurrent plain increments all land, and concurrent debits never overspend", async () => {
    const { repos } = await Realm("atomic");
    await repos.wallets.create({ userId: "w", balances: { GOLD: 0 } });
    await Promise.all(Array.from({ length: 100 }, () => repos.wallets.incrementBalance("w", "GOLD", 1)));
    assert.equal((await repos.wallets.findByUserId("w"))?.balances.GOLD, 100);

    const Results = await Promise.all(Array.from({ length: 130 }, () => repos.wallets.incrementBalance("w", "GOLD", -1)));
    assert.equal(Results.filter((Result) => Result !== undefined).length, 100);
    assert.equal((await repos.wallets.findByUserId("w"))?.balances.GOLD, 0);
});

test("a nested unit of work is a savepoint: a failure the outer code catches leaves the outer work intact", async () => {
    const { repos, uow } = await Realm("nested");
    await uow.withTransaction(async (r) => {
        await r.accounts.create({ userId: "outer", name: "o", notes: 0 });
        await assert.rejects(uow.withTransaction(async (inner) => {
            await inner.accounts.create({ userId: "inner", name: "i", notes: 0 });
            throw new Error("inner failed");
        }), /inner failed/);
    });
    assert.ok(await repos.accounts.findByUserId("outer"));
    assert.equal(await repos.accounts.findByUserId("inner"), undefined);
});

test("a failing multi-statement repository call leaves no partial effect, inside or outside a unit of work", async () => {
    const { repos, uow } = await Realm("savepoint");
    // A dev account (no displayNameNormalized) with data: deletePlayerData deletes the data and THEN finds no launcher account.
    await repos.accounts.create({ userId: "dev", name: "d", notes: 0 });
    await repos.wallets.create({ userId: "dev", balances: { GOLD: 3 } });
    await repos.characters.create({ characterId: "c1", userId: "dev", createdDate: NOW, lastModifiedDate: NOW, name: "n", updateVersion: 1, data: "{}" });

    await assert.rejects(repos.admin.deletePlayerData("dev", Audit("a1", "dev")), /disappeared/);
    assert.equal((await repos.wallets.findByUserId("dev"))?.balances.GOLD, 3);
    assert.equal((await repos.characters.findManyByUserId("dev")).length, 1);

    await uow.withTransaction(async (r, session) => {
        await r.wallets.incrementBalance("dev", "GOLD", 1, session);
        await assert.rejects(r.admin.deletePlayerData("dev", Audit("a2", "dev")), /disappeared/);
    });
    assert.equal((await repos.wallets.findByUserId("dev"))?.balances.GOLD, 4, "the earlier work stayed, the failed call left nothing");
    assert.equal((await repos.characters.findManyByUserId("dev")).length, 1);
    assert.equal((await repos.admin.listAudit(undefined, 0, 10)).total, 0);
});

test("a session whose unit of work is over cannot be reused", async () => {
    const { repos, uow } = await Realm("ended");
    let Kept: Session | undefined;
    await uow.withTransaction(async (_r, session) => { Kept = session; });
    await assert.rejects(repos.wallets.findByUserId("w", Kept), /SQLITE_SESSION_ENDED/);
});

test("a unique-index violation is the E11000 error the controllers already handle", async () => {
    const { repos } = await Realm("duplicate");
    const Account = (id: string, email: string | undefined, name: string) => ({
        userId: id, email, displayNameNormalized: name, displayName: name, status: "active" as const,
        roles: ["player"], createdAt: NOW
    });
    await repos.launcherAccounts.create(Account("1", "a@x.io", "alpha"));
    await assert.rejects(repos.launcherAccounts.create(Account("2", "a@x.io", "beta")), (error: unknown) =>
        error instanceof MongoServerError && error.code === 11000);
    await assert.rejects(repos.launcherAccounts.create(Account("3", "c@x.io", "alpha")), (error: unknown) =>
        error instanceof MongoServerError && error.code === 11000);
    await repos.launcherAccounts.create(Account("4", undefined, "gamma"));
    await repos.launcherAccounts.create(Account("5", undefined, "delta")); // absent emails never collide
    await assert.rejects(repos.accounts.create({ userId: "1", name: "same id", notes: 0 }), (error: unknown) =>
        error instanceof MongoServerError && error.code === 11000);
});

test("a backup is a consistent copy that leaves out an unfinished unit of work and refuses to overwrite", async () => {
    const { db, repos, uow, dir } = await Realm("backup");
    await repos.accounts.create({ userId: "kept", name: "k", notes: 0 });
    const Hold = Gate();
    const Inside = Gate();
    const Work = uow.withTransaction(async (r) => {
        await r.accounts.create({ userId: "unfinished", name: "u", notes: 0 });
        Inside.open();
        await Hold.wait;
    });
    await Inside.wait;

    const Target = path.join(dir, "copy", "backup.sqlite");
    await db.backup(Target);
    await assert.rejects(db.backup(Target), /SQLITE_BACKUP_EXISTS/);
    Hold.open();
    await Work;

    const Copy = new DatabaseSync(Target, { readOnly: true });
    const Ids = Copy.prepare("SELECT _id FROM accounts ORDER BY _id").all().map((Row) => Row._id);
    Copy.close();
    assert.deepEqual(Ids, ["kept"]);
    assert.ok(await repos.accounts.findByUserId("unfinished"), "the live database has it");
});

test("backupIfDue writes at most one backup per interval and keeps only the newest few", async () => {
    const { db, repos, dir } = await Realm("rotation");
    await repos.accounts.create({ userId: "a", name: "a", notes: 0 });
    const Folder = path.join(dir, "backups");
    const Hour = 3_600_000;
    const Base = Date.now();

    const First = await db.backupIfDue(60, 2, Base);
    assert.ok(First && fs.existsSync(First));
    assert.equal(await db.backupIfDue(60, 2, Base + 10 * 60_000), undefined, "still fresh");
    assert.ok(await db.backupIfDue(60, 2, Base + 2 * Hour));
    assert.ok(await db.backupIfDue(60, 2, Base + 4 * Hour));
    const Remaining = fs.readdirSync(Folder).sort();
    assert.equal(Remaining.length, 2, "rotation keeps two");
    assert.equal(fs.existsSync(First), false, "the oldest was removed");
    assert.equal(await db.backupIfDue(0, 2, Base + 9 * Hour), undefined, "interval 0 disables backups");
});

test("purgeExpired removes rows whose TTL mirror has passed and nothing else", async () => {
    const { db, repos } = await Realm("purge");
    const Session = (id: string, expiresAt: string) => ({
        id, tokenHash: `hash-${id}`, userId: "u", familyId: "f", deviceId: "d", deviceName: "pc", createdAt: NOW, expiresAt
    });
    await repos.refreshSessions.create(Session("old", "2020-01-01T00:00:00.000Z"));
    await repos.refreshSessions.create(Session("live", "2099-01-01T00:00:00.000Z"));
    await repos.gameExchangeCodes.create({
        codeHash: "c1", userId: "u", launcherSessionId: "s", buildChangelist: 1, executableSha256: "x", runtimeChannel: "stable",
        runtimeSha256: "r", runtimeManifestVersion: "1", runtimeArtifactSetSha256: "a", createdAt: NOW, expiresAt: "2020-01-01T00:00:00.000Z"
    });
    const Removed = await db.purgeExpired();
    assert.equal(Removed.refreshSessions, 1);
    assert.equal(Removed.gameExchangeCodes, 1);
    assert.equal(await repos.refreshSessions.findByTokenHash("hash-old"), undefined);
    assert.ok(await repos.refreshSessions.findByTokenHash("hash-live"));
});

test("operations after close fail loudly", async () => {
    const Opened = OpenTestRealm("closed");
    await Opened.cleanup();
    await assert.rejects(Opened.repos.accounts.findByUserId("x"), /SQLITE_CLOSED/);
    assert.equal(await Opened.db.isHealthy(), false);
});

test("a second connection in another process-like handle sees committed data (WAL)", async () => {
    const { db, repos, databasePath } = await Realm("wal");
    await repos.accounts.create({ userId: "wal", name: "w", notes: 0 });
    const Other = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(Other.prepare("SELECT COUNT(*) AS n FROM accounts").get()?.n, 1);
    Other.close();
    assert.equal(await db.isHealthy(), true);
});

test("a NUL character is rejected as a key instead of silently truncating it to another row, and survives inside document text", async () => {
    const { repos } = await Realm("nul");
    const Nul = String.fromCharCode(0);
    await repos.accounts.create({ userId: "ab", name: "target", notes: 0 });
    await assert.rejects(repos.accounts.findByUserId(`a${Nul}b`), /SQLITE_NUL_IN_TEXT/);
    await assert.rejects(repos.accounts.create({ userId: `ab${Nul}x`, name: "x", notes: 0 }), /SQLITE_NUL_IN_TEXT/);
    await assert.rejects(repos.friendships.upsert({ ownerId: `a${Nul}b`, otherId: "c", status: "ACCEPTED", created: NOW }), /SQLITE_NUL_IN_TEXT/);

    await repos.characters.create({ characterId: "c1", userId: "ab", createdDate: NOW, lastModifiedDate: NOW, name: "n", updateVersion: 1, data: `left${Nul}right` });
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c1", "ab"))?.data, `left${Nul}right`, "NUL inside a stored string is escaped by the JSON document");
});

test("a unit of work that never finishes makes waiting writes fail loudly instead of hanging, and the queue recovers", async () => {
    const Opened = OpenTestRealm("queue-timeout", { queueTimeoutMs: 150 });
    Cleanups.push(Opened.cleanup);
    const { repos, uow } = Opened;
    const Hold = Gate();
    const Inside = Gate();
    const Stuck = uow.withTransaction(async (r) => {
        await r.accounts.create({ userId: "stuck", name: "s", notes: 0 });
        Inside.open();
        await Hold.wait; // never settles until the test lets it
    });
    await Inside.wait;

    await assert.rejects(repos.accounts.create({ userId: "waiting", name: "w", notes: 0 }), /SQLITE_QUEUE_TIMEOUT/);
    await assert.rejects(uow.withTransaction(async () => undefined), /SQLITE_QUEUE_TIMEOUT/);
    assert.equal(await repos.accounts.findByUserId("waiting"), undefined, "a timed-out write never runs later");

    Hold.open();
    await Stuck;
    await repos.accounts.create({ userId: "after", name: "a", notes: 0 }); // the abandoned places did not jam the queue
    assert.ok(await repos.accounts.findByUserId("stuck"));
    assert.ok(await repos.accounts.findByUserId("after"));
    assert.equal(await repos.accounts.findByUserId("waiting"), undefined);
});

test("an in-memory database works for scratch use: one connection, reads wait for an open unit of work", async () => {
    const Db = SqliteDatabase.open(TestConfig(":memory:"));
    try {
        const { CreateSqliteRepositoryProvider } = await import("./index");
        const { SqliteUnitOfWork } = await import("./SqliteUnitOfWork");
        const Repos = CreateSqliteRepositoryProvider(Db);
        const Uow = new SqliteUnitOfWork(Db, Repos);
        await Repos.wallets.create({ userId: "m", balances: { GOLD: 1 } });
        await assert.rejects(Uow.withTransaction(async (r, session) => {
            await r.wallets.incrementBalance("m", "GOLD", 9, session);
            throw new Error("abort");
        }), /abort/);
        assert.equal((await Repos.wallets.findByUserId("m"))?.balances.GOLD, 1);

        const Hold = Gate();
        const Inside = Gate();
        const Work = Uow.withTransaction(async (r, session) => {
            await r.wallets.incrementBalance("m", "GOLD", 4, session);
            Inside.open();
            await Hold.wait;
        });
        await Inside.wait;
        let ReadDone = false;
        const Read = Repos.wallets.findByUserId("m").then((Wallet) => { ReadDone = true; return Wallet; });
        await Tick(40);
        assert.equal(ReadDone, false, "a read outside the unit of work waits instead of seeing uncommitted data");
        Hold.open();
        await Work;
        assert.equal((await Read)?.balances.GOLD, 5);
        assert.equal(await Db.isHealthy(), true);
    } finally {
        await Db.close();
    }
});

test("closing while a unit of work is stuck still shuts down (after the queue timeout) and rolls the unit back", async () => {
    const Opened = OpenTestRealm("close-stuck", { queueTimeoutMs: 150 });
    const { db, uow, databasePath } = Opened;
    const Hold = Gate();
    const Inside = Gate();
    const Stuck = uow.withTransaction(async (r) => {
        await r.accounts.create({ userId: "never-committed", name: "n", notes: 0 });
        Inside.open();
        await Hold.wait;
    }).then(() => "committed", (error) => String(error));
    await Inside.wait;

    await db.close();
    assert.equal(db.isOpen, false);
    Hold.open();
    assert.match(await Stuck, /SQLITE_CLOSED|committed|invalid state|not open|closed/i);

    const Raw = new DatabaseSync(databasePath, { readOnly: true });
    const Rows = Raw.prepare("SELECT COUNT(*) AS n FROM accounts").get()?.n;
    Raw.close();
    assert.equal(Rows, 0, "the unfinished unit of work left nothing behind");
    RemoveTestDirectory(Opened.dir);
});
