import assert from "node:assert/strict";
import test from "node:test";
import { RealmsCollections } from "../../realms/persistence/mongo/collections";
import { Collections } from "./collections";
import {
    ACCOUNT_RECORD_COLLECTION,
    AccountDeletionContext,
    CollectionsWithSteps,
    CORE_ACCOUNT_DELETION_EXEMPTIONS,
    CoreAccountDeletionSteps
} from "./accountDeletionPlan";

// [2026-10-14] The core part of the account erasure plan. Every collection of the core and realm lists is either a step of the plan or
// exempt with a reason, so a new collection cannot silently keep a player's data. The P2P and anti-cheat lists are checked by their own
// test in the modules (p2p/persistence/mongo/accountDeletionSteps.test.ts). Nothing here connects to a database.

const CONTEXT: AccountDeletionContext = {
    userId: "user-1",
    characterIds: ["character-1", "character-2"],
    ownedRealmIds: ["realm-1"],
    pseudonymousId: "pseudonym-1",
    now: "2026-10-14T12:00:00.000Z"
};

test("every core and realm collection is either in the plan or exempt, never both", () => {
    const Covered = new Set(CollectionsWithSteps(CoreAccountDeletionSteps()));
    const Exempt = new Set(CORE_ACCOUNT_DELETION_EXEMPTIONS.map((entry) => entry.collection));
    for (const Name of [...Object.values(Collections), ...Object.values(RealmsCollections)]) {
        if (Name === ACCOUNT_RECORD_COLLECTION) continue; // the account record itself is removed by the erasure, after the steps
        assert.ok(Covered.has(Name) || Exempt.has(Name), `${Name} is neither in the account deletion plan nor exempt`);
        assert.equal(Covered.has(Name) && Exempt.has(Name), false, `${Name} is both in the plan and exempt`);
    }
});

test("every exemption names a real collection and gives a reason", () => {
    const Known = new Set<string>([...Object.values(Collections), ...Object.values(RealmsCollections)]);
    for (const Entry of CORE_ACCOUNT_DELETION_EXEMPTIONS) {
        assert.ok(Known.has(Entry.collection), `unknown collection ${Entry.collection}`);
        assert.ok(Entry.reason.length > 0, Entry.collection);
    }
});

test("every step of the core plan names the account, so none can match another player's rows", () => {
    const Steps = CoreAccountDeletionSteps();
    assert.ok(Steps.length >= 30, `the core plan has ${Steps.length} steps`);
    for (const Step of Steps) {
        const Selector = JSON.stringify(Step.match(CONTEXT));
        assert.ok(Selector.includes("user-1") || Selector.includes("realm-1") || Selector.includes("character-1"),
            `${Step.collection}: ${Selector}`);
    }
});

test("live activity is checked before anything is deleted: the online realm guard comes first", () => {
    const Steps = CoreAccountDeletionSteps();
    assert.equal(Steps[0].kind, "guard");
    assert.equal(Steps[0].collection, RealmsCollections.Realms);
    assert.deepEqual(Steps[0].match({ ...CONTEXT, now: "2026-10-14T12:00:00.000Z" }), { hostAccountId: "user-1", onlineUntil: { $gt: "2026-10-14T12:00:00.000Z" } });
});

test("the character-owned collections match the account's characters as well as its id", () => {
    const Steps = CoreAccountDeletionSteps().filter((step) => ["inventories", "loadouts", "breadcrumbs", "encounteredContent", "inventoryTransactions"]
        .includes(step.collection));
    assert.equal(Steps.length, 5);
    for (const Step of Steps) {
        assert.deepEqual(Step.match(CONTEXT), {
            $or: [{ userId: "user-1" }, { characterId: { $in: ["character-1", "character-2"] } }, { _id: { $in: ["character-1", "character-2"] } }]
        }, Step.collection);
    }
});

test("the admin's audit trail: records about the account are removed and its own actions are pseudonymised", () => {
    const Audit = CoreAccountDeletionSteps().filter((step) => step.collection === Collections.AdminAudit);
    const Removed = Audit.find((step) => step.kind === "delete");
    const Pseudonymised = Audit.find((step) => step.kind === "update");
    assert.deepEqual(Removed?.match(CONTEXT), { targetUserId: "user-1" });
    assert.deepEqual(Pseudonymised?.match(CONTEXT), { actorUserId: "user-1" });
    assert.deepEqual((Pseudonymised as { update(c: AccountDeletionContext): unknown }).update(CONTEXT), { $set: { actorUserId: "pseudonym-1" } });
});

test("a party the account leads passes the lead to its first remaining member, and the party is bumped", () => {
    const Update = CoreAccountDeletionSteps().find((step) => step.collection === Collections.Parties && step.kind === "update");
    const Pipeline = (Update as { update(c: AccountDeletionContext): unknown }).update(CONTEXT) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(Pipeline));
    const Text = JSON.stringify(Pipeline);
    assert.match(Text, /\$arrayElemAt/);
    assert.match(Text, /\$revision/);
});
