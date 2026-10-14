import assert from "node:assert/strict";
import test from "node:test";
import { GameExchangeCodeRecord } from "../../contracts/GameExchangeCodeRepository";
import { Collections } from "../collections";
import { GetMongoDb, MongoPersistenceLifecycle } from "../client";
import { MongoGameExchangeCodeRepository } from "./MongoGameExchangeCodeRepository";

// Opt-in like the other Mongo integration checks (an isolated database only):
//   ALLOW_DB_INTEGRATION_TESTS=true MONGODB_URI=<scratch> MONGODB_DB=<scratch> node --import tsx --test <this file>
const SKIP = process.env.ALLOW_DB_INTEGRATION_TESTS !== "true"
    && "set ALLOW_DB_INTEGRATION_TESTS=true with an isolated MONGODB_URI and MONGODB_DB";

function Code(codeHash: string, overrides: Partial<GameExchangeCodeRecord> = {}): GameExchangeCodeRecord {
    return {
        codeHash,
        userId: "user-1",
        launcherSessionId: "session-1",
        buildChangelist: 647472,
        executableSha256: "a".repeat(64),
        runtimeChannel: "stable",
        runtimeSha256: "b".repeat(64),
        runtimeManifestVersion: "0.2.132",
        runtimeArtifactSetSha256: "c".repeat(64),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

test("MongoDB: an exchange code carries the realm it was issued for through create and consume; an official one has no realmId at all", { skip: SKIP }, async () => {
    assert.ok(process.env.MONGODB_URI && process.env.MONGODB_DB, "an isolated MONGODB_URI and MONGODB_DB are required");
    const db = await GetMongoDb();
    const repo = new MongoGameExchangeCodeRepository();
    await db.collection(Collections.GameExchangeCodes).deleteMany({ codeHash: { $in: ["official-code", "realm-code"] } });

    await repo.create(Code("official-code"));
    await repo.create(Code("realm-code", { realmId: "realm-1" }));

    const realm = await repo.consumeByCodeHash("realm-code");
    assert.equal(realm?.realmId, "realm-1");
    assert.equal(await repo.consumeByCodeHash("realm-code"), undefined, "still single use");

    const official = await repo.consumeByCodeHash("official-code");
    assert.ok(official);
    assert.equal("realmId" in official, false, "an official code has no realmId key");

    await db.collection(Collections.GameExchangeCodes).deleteMany({ codeHash: { $in: ["official-code", "realm-code"] } });
});

test("MongoDB: close the connection (exchange code repository)", { skip: SKIP }, async () => {
    await new MongoPersistenceLifecycle().stop();
});
