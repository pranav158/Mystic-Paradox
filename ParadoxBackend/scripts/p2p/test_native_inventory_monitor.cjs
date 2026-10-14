/*
 * Focused real-Mongo check for P2P monitor metadata attached to the native
 * inventory idempotency ledger. Run only through the disposable local Mongo
 * harness; this script refuses unapproved or non-dedicated database settings.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const uri = process.env.MONGODB_URI || "";
const testDatabase = (process.env.MONGODB_TEST_DB || "").trim();
const mainDatabase = process.env.MONGODB_DB || "mystpax";
if (process.env.ALLOW_DB_INTEGRATION_TESTS !== "true") throw new Error("set ALLOW_DB_INTEGRATION_TESTS=true");
if (!uri || !/^mongodb:\/\/127\.0\.0\.1(?::\d+)?\//.test(uri)) throw new Error("MONGODB_URI must target loopback MongoDB");
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(testDatabase) || testDatabase === mainDatabase) {
  throw new Error("MONGODB_TEST_DB must be a dedicated database name different from MONGODB_DB");
}

process.env.MONGODB_DB = testDatabase;
const { GetMongoDb, GetMongoClient } = require("../../build/persistence/mongo/client");
const { Collections } = require("../../build/persistence/mongo/collections");
const { RunInventoryTransaction, InventoryTransactionMismatchError } = require("../../build/controllers/inventory");
const { GetOperationsOverview } = require("../../build/controllers/adminOperations");
const { P2PCollections } = require("../../build/p2p/persistence/mongo/collections");
const { P2PMonitorAnnotator } = require("../../build/p2p/security/p2pInventoryAuthorization");

const runId = crypto.randomBytes(9).toString("hex");
const userId = `monitor-user-${runId}`;
const characterId = `monitor-char-${runId}`;
const transactionPrefix = `monitor-tx-${runId}-`;
const sessionId = `monitor-session-${runId}`;
const generation = 17;
const inventoryFilter = { _id: characterId };
const ledgerFilter = { userId, characterId, transactionId: { $regex: `^${transactionPrefix}` } };
// The same ledger annotator a player-host runtime's transaction uses.
const monitorGrant = async () => P2PMonitorAnnotator(sessionId, generation);

(async () => {
  const db = await GetMongoDb();
  const inventories = db.collection(Collections.Inventories);
  const ledger = db.collection(Collections.InventoryTransactions);
  try {
    await inventories.deleteMany(inventoryFilter);
    await ledger.deleteMany(ledgerFilter);
    await inventories.insertOne({ _id: characterId, characterId, userId, instancedItems: "[]", stackedItems: "[]", revision: 0 });

    const accepted = [{ catalogId: "PART_MONITOR_SAMPLE", quantity: 3 }];
    const filteredStarter = [{ catalogId: "DYE_BANNER_BACKGROUND_DEFAULT", quantity: 8 }];
    const firstTx = `${transactionPrefix}accepted`;
    const firstResult = await RunInventoryTransaction(userId, characterId, firstTx, [], [...accepted, ...filteredStarter], [], [], [], {
      ownershipAlreadyValidated: true, onGrant: monitorGrant
    });
    assert.ok(firstResult, "first native inventory transaction committed");

    const firstLedger = await ledger.findOne({ userId, characterId, transactionId: firstTx });
    assert.equal(firstLedger.status, "completed");
    assert.deepEqual(firstLedger.p2pMonitor, {
      sessionId,
      generation,
      createdAt: firstLedger.p2pMonitor.createdAt,
      items: [{ itemId: "PART_MONITOR_SAMPLE", quantity: 3 }]
    });
    assert.ok(Number.isFinite(Date.parse(firstLedger.p2pMonitor.createdAt)));

    const storedInventoryAfterFirst = await inventories.findOne(inventoryFilter);
    const parsedStackedAfterFirst = JSON.parse(storedInventoryAfterFirst.stackedItems);
    assert.deepEqual(parsedStackedAfterFirst, [{ catalogId: "PART_MONITOR_SAMPLE", quantity: 3 }]);
    assert.equal(JSON.parse(storedInventoryAfterFirst.instancedItems).some((item) => item.catalogId === "DYE_BANNER_BACKGROUND_DEFAULT"), false,
      "filtered invalid starter additions do not persist as instances");

    const replayResult = await RunInventoryTransaction(userId, characterId, firstTx, [], [...accepted, ...filteredStarter], [], [], [], {
      ownershipAlreadyValidated: true, onGrant: monitorGrant
    });
    assert.deepEqual(replayResult, firstResult, "same-body replay returns original result");
    const afterReplay = await inventories.findOne(inventoryFilter);
    assert.equal(JSON.parse(afterReplay.stackedItems).find((item) => item.catalogId === "PART_MONITOR_SAMPLE").quantity, 3);
    assert.deepEqual((await ledger.findOne({ userId, characterId, transactionId: firstTx })).p2pMonitor, firstLedger.p2pMonitor,
      "same-body replay does not change monitor metadata");

    await assert.rejects(
      () => RunInventoryTransaction(userId, characterId, firstTx, [], [{ catalogId: "PART_MONITOR_CHANGED", quantity: 9 }], [], [], [], {
        ownershipAlreadyValidated: true, onGrant: monitorGrant
      }),
      (error) => error instanceof InventoryTransactionMismatchError
    );
    const afterMismatch = await inventories.findOne(inventoryFilter);
    assert.equal(JSON.parse(afterMismatch.stackedItems).some((item) => item.catalogId === "PART_MONITOR_CHANGED"), false,
      "changed-body replay never mutates inventory");
    assert.equal((await ledger.findOne({ userId, characterId, transactionId: firstTx })).p2pMonitor.items[0].itemId, "PART_MONITOR_SAMPLE");

    const failedTx = `${transactionPrefix}failed`;
    await assert.rejects(() => RunInventoryTransaction(userId, characterId, failedTx, [], [
      { catalogId: "PART_MONITOR_ABORTED", quantity: 2 }
    ], [], [], [], {
      ownershipAlreadyValidated: true,
      onGrant: async () => { throw new Error("MONITOR_FIXTURE_ABORT"); }
    }), /MONITOR_FIXTURE_ABORT/);
    assert.equal(await ledger.findOne({ userId, characterId, transactionId: failedTx }), null,
      "aborted Mongo transaction leaves no committed ledger or monitor record");
    const afterAbort = await inventories.findOne(inventoryFilter);
    assert.equal(JSON.parse(afterAbort.stackedItems).some((item) => item.catalogId === "PART_MONITOR_ABORTED"), false);

    const ordinaryTx = `${transactionPrefix}ordinary`;
    await RunInventoryTransaction(userId, characterId, ordinaryTx, [], [
      { catalogId: "PART_MONITOR_ORDINARY", quantity: 1 }
    ], [], [], [], { ownershipAlreadyValidated: true });
    const ordinaryLedger = await ledger.findOne({ userId, characterId, transactionId: ordinaryTx });
    assert.equal(ordinaryLedger.status, "completed");
    assert.equal(ordinaryLedger.p2pMonitor, undefined, "transactions without trusted P2P context have no monitor metadata");

    // Exercise the actual admin projection over Mongo with the same session ID
    // reused at an older generation. Only the current generation may be shown.
    const hunts = db.collection(P2PCollections.P2PHuntSessions);
    await hunts.insertOne({ _id: sessionId, sessionId, generation, state: "COMPLETED",
      huntDefinitionId: "monitor-fixture-hunt", mapPath: "monitor-fixture-map", hostAccountId: userId,
      roster: [{ accountId: userId }], createdAt: new Date().toISOString(), terminalAt: new Date().toISOString() });
    const staleTx = `${transactionPrefix}stale-generation`;
    await ledger.insertOne({ _id: `${staleTx}-old`, transactionId: staleTx, userId, characterId, status: "completed",
      p2pMonitor: { sessionId, generation: generation - 1, createdAt: new Date().toISOString(),
        items: [{ itemId: "PART_STALE_GENERATION", quantity: 77 }] } });
    let overview;
    await GetOperationsOverview({}, { json: (body) => { overview = body; } });
    const monitorSession = overview.p2pMonitor.sessions.find((entry) => entry.sessionId === sessionId);
    assert.equal(monitorSession?.generation, generation, "admin view resolves the exact current session generation");
    const currentGenerationRows = overview.p2pMonitor.recentAdditions.filter((entry) => entry.sessionId === sessionId);
    assert.equal(currentGenerationRows.some((entry) => entry.generation === generation && entry.itemId === "PART_MONITOR_SAMPLE"), true,
      "admin view returns the committed current-generation item addition");
    assert.equal(currentGenerationRows.some((entry) => entry.generation === generation - 1 || entry.itemId === "PART_STALE_GENERATION"), false,
      "admin view excludes stale-generation item additions for a reused session ID");

    const isolatedRows = await ledger.find(ledgerFilter).toArray();
    assert.equal(isolatedRows.filter((row) => row.p2pMonitor?.sessionId === sessionId && row.p2pMonitor?.generation === generation).length, 1,
      "only committed P2P additions from this generation appear for the isolated session");
    console.log("Native inventory monitor Mongo integration PASS; cases=commit,replay,changed-body,abort,ordinary-path,filtered-starter,generation-isolation");
  } finally {
    await inventories.deleteMany(inventoryFilter);
    await ledger.deleteMany(ledgerFilter);
    await db.collection(P2PCollections.P2PHuntSessions).deleteMany({ _id: sessionId });
    await ledger.deleteMany({ transactionId: `${transactionPrefix}stale-generation` });
    const wallets = db.collection(Collections.Wallets);
    await wallets.deleteMany({ _id: userId });
    await (await GetMongoClient()).close();
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
