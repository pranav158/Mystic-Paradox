import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { BACKEND_ROOT } from "./config";
import { NewTestDirectory, RemoveTestDirectory } from "./testSupport";
import { ReadPersistenceProvider } from "../index";

const Directories: string[] = [];
after(() => { for (const Dir of Directories) RemoveTestDirectory(Dir); });

test("PERSISTENCE_PROVIDER: MongoDB by default, SQLite on request, anything else stops startup", () => {
    assert.equal(ReadPersistenceProvider({}), "mongodb");
    assert.equal(ReadPersistenceProvider({ PERSISTENCE_PROVIDER: "" }), "mongodb");
    assert.equal(ReadPersistenceProvider({ PERSISTENCE_PROVIDER: "mongodb" }), "mongodb");
    assert.equal(ReadPersistenceProvider({ PERSISTENCE_PROVIDER: " Mongo " }), "mongodb");
    assert.equal(ReadPersistenceProvider({ PERSISTENCE_PROVIDER: "SQLite" }), "sqlite");
    assert.throws(() => ReadPersistenceProvider({ PERSISTENCE_PROVIDER: "postgres" }), /must be "mongodb" or "sqlite"/);
    assert.throws(() => ReadPersistenceProvider({ PERSISTENCE_PROVIDER: "sqlite3" }), /must be "mongodb" or "sqlite"/);
});

// The barrel caches its providers per process, so the real wiring is exercised in a child process: it starts the
// lifecycle, writes through the repositories and a unit of work, and reopens the file in a second process.
function RunChild(script: string, environment: Record<string, string>): string {
    const Result = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, ...environment, NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
        timeout: 120_000
    });
    assert.equal(Result.status, 0, `child failed:\n${Result.stderr}\n${Result.stdout}`);
    return Result.stdout.trim();
}

test("the persistence barrel serves the SQLite provider end to end when PERSISTENCE_PROVIDER=sqlite", () => {
    const Dir = NewTestDirectory("provider");
    Directories.push(Dir);
    const Database = path.join(Dir, "data", "realm.sqlite"); // the folder does not exist yet: it is created
    const Barrel = path.join(BACKEND_ROOT, "src", "persistence", "index").replace(/\\/g, "/");

    const Writer = path.join(Dir, "writer.ts");
    fs.writeFileSync(Writer, `
        import { GetPersistenceLifecycle, GetRepositories, GetUnitOfWork } from "${Barrel}";
        async function main() {
            const Lifecycle = GetPersistenceLifecycle();
            await Lifecycle.start();
            const Healthy = await Lifecycle.isHealthy();
            const Repos = GetRepositories();
            await Repos.wallets.create({ userId: "u1", balances: { GOLD: 10 } });
            await GetUnitOfWork().withTransaction(async (r, session) => {
                await r.wallets.incrementBalance("u1", "GOLD", 5, session);
                await r.accounts.create({ userId: "u1", name: "Realm Player", notes: 0 });
            });
            let RolledBack = false;
            try {
                await GetUnitOfWork().withTransaction(async (r, session) => {
                    await r.wallets.incrementBalance("u1", "GOLD", 1000, session);
                    throw new Error("abort");
                });
            } catch { RolledBack = true; }
            const Gold = (await Repos.wallets.findByUserId("u1"))?.balances.GOLD;
            await Lifecycle.stop();
            console.log(JSON.stringify({ Healthy, RolledBack, Gold, HealthyAfterStop: await Lifecycle.isHealthy() }));
        }
        main().catch((error) => { console.error(error); process.exit(1); });
    `);
    const First = JSON.parse(RunChild(Writer, { PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_SQLITE_PATH: Database, MYSTICPARADOX_SQLITE_BACKUP_INTERVAL_MINUTES: "0" }));
    assert.deepEqual(First, { Healthy: true, RolledBack: true, Gold: 15, HealthyAfterStop: false });
    assert.ok(fs.existsSync(Database), "the database file was created, folder included");

    const Reader = path.join(Dir, "reader.ts");
    fs.writeFileSync(Reader, `
        import { GetPersistenceLifecycle, GetRepositories } from "${Barrel}";
        async function main() {
            await GetPersistenceLifecycle().start();
            const Repos = GetRepositories();
            console.log(JSON.stringify({ Gold: (await Repos.wallets.findByUserId("u1"))?.balances.GOLD, Name: (await Repos.accounts.findByUserId("u1"))?.name }));
            await GetPersistenceLifecycle().stop();
        }
        main().catch((error) => { console.error(error); process.exit(1); });
    `);
    const Second = JSON.parse(RunChild(Reader, { PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_SQLITE_PATH: Database, MYSTICPARADOX_SQLITE_BACKUP_INTERVAL_MINUTES: "0" }));
    assert.deepEqual(Second, { Gold: 15, Name: "Realm Player" });
});

test("the three direct reads in core code (operations policy, daily claim, Guard overview) use SQLite when selected", () => {
    const Dir = NewTestDirectory("direct");
    Directories.push(Dir);
    const Database = path.join(Dir, "realm.sqlite");
    const Barrel = path.join(BACKEND_ROOT, "src", "persistence", "index").replace(/\\/g, "/");
    const Policy = path.join(BACKEND_ROOT, "src", "services", "operationsPolicy").replace(/\\/g, "/");
    const Script = path.join(Dir, "direct.ts");
    fs.writeFileSync(Script, `
        import { GetPersistenceLifecycle, GetSqliteDirectAccess } from "${Barrel}";
        import { GetOperationsPolicy, SetOperationsPolicy } from "${Policy}";
        async function main() {
            await GetPersistenceLifecycle().start();
            const Direct = GetSqliteDirectAccess()!;
            const Before = await GetOperationsPolicy();
            const Stale = await SetOperationsPolicy({ guardEnforcement: "OBSERVE", diagnosticsProfile: "PRODUCTION" }, "op", 7);
            const Applied = await SetOperationsPolicy({ guardEnforcement: "OBSERVE", diagnosticsProfile: "PRODUCTION" }, "op", 0);
            const Claim = await Direct.findInventoryLedgerClaim("u1", "T1");
            const Guard = await Direct.listLauncherGuardSessions(5);
            await GetPersistenceLifecycle().stop();
            console.log("RESULT " + JSON.stringify({ Before: [Before.guardEnforcement, Before.version], Stale: Stale === undefined,
                After: [Applied?.guardEnforcement, Applied?.version], Claim: Claim ?? null, Guard: Guard.length }));
        }
        main().catch((error) => { console.error(error); process.exit(1); });
    `);
    // MONGO_URI points nowhere: a call site that still reached MongoDB would fail instead of passing silently.
    // The policy service logs through the console too; the result is the tagged line.
    const Lines = RunChild(Script, { PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_SQLITE_PATH: Database,
        MYSTICPARADOX_SQLITE_BACKUP_INTERVAL_MINUTES: "0", MONGO_URI: "mongodb://127.0.0.1:1/none", MONGODB_URI: "mongodb://127.0.0.1:1/none" })
        .split(/\r?\n/);
    const Output = JSON.parse(Lines.find((Line) => Line.startsWith("RESULT "))!.slice("RESULT ".length));
    assert.deepEqual(Output, { Before: ["ENFORCE", 0], Stale: true, After: ["OBSERVE", 1], Claim: null, Guard: 0 });
});

test("an unknown PERSISTENCE_PROVIDER stops the process at the first use instead of falling back to MongoDB", () => {
    const Dir = NewTestDirectory("provider-bad");
    Directories.push(Dir);
    const Barrel = path.join(BACKEND_ROOT, "src", "persistence", "index").replace(/\\/g, "/");
    const Script = path.join(Dir, "bad.ts");
    fs.writeFileSync(Script, `
        import { GetRepositories } from "${Barrel}";
        try { GetRepositories(); console.log("started"); } catch (error) { console.log("refused: " + String(error)); }
    `);
    const Output = RunChild(Script, { PERSISTENCE_PROVIDER: "sqlite-ish" });
    assert.match(Output, /^refused: .*must be "mongodb" or "sqlite"/);
});
