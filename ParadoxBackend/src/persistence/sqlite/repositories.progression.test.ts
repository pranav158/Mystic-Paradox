import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MongoServerError } from "mongodb";
import { BountyStateRecord, CooldownStateRecord, EscalationProgressRecord, ProgressionGrantRecord, WeaponReforgeState } from "../mapping/domainTypes";
import { NOW, OpenTestRealm } from "./testSupport";

// XP tracks and objectives, the weapon reforge, the exactly-once grant ledger and the three versioned per-account
// state documents (escalation, bounty, cooldowns).

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });
function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const IsDuplicate = (error: unknown) => error instanceof MongoServerError && error.code === 11000;
const TRACK = "ExperienceTrack_Weapon_Sword";

test("tracks: an increment creates the row, accumulates, counts versions and is atomic under concurrency", async () => {
    const { repos } = Realm("prog-increment");
    assert.equal(await repos.progressionTracks.get("u1", TRACK), undefined);
    const First = await repos.progressionTracks.increment("u1", TRACK, 250);
    assert.equal(First.progress, 250);
    assert.equal(First.updateVersion, 1);
    assert.equal(First.confirmedFremiumRank, 0);
    assert.equal(First.confirmedPremiumRank, 0);
    assert.equal(First.reforge, undefined);
    assert.equal(First.prestigeClaimed, undefined);
    assert.ok(First.createdAt && First.updatedAt);
    assert.equal((await repos.progressionTracks.increment("u1", TRACK, 50)).progress, 300);

    await Promise.all(Array.from({ length: 25 }, () => repos.progressionTracks.increment("u1", TRACK, 2)));
    const After = (await repos.progressionTracks.get("u1", TRACK))!;
    assert.equal(After.progress, 350, "two simultaneous kills of the same value both land");
    assert.equal(After.updateVersion, 27);
    assert.equal(After.createdAt, First.createdAt);

    await repos.progressionTracks.increment("u1", "Other", 1);
    await repos.progressionTracks.increment("u2", TRACK, 1);
    assert.deepEqual((await repos.progressionTracks.getAllForUser("u1")).map((Entry) => Entry.progressionId), [TRACK, "Other"]);
});

test("tracks: max-guards never regress a value, spend never goes negative", async () => {
    const { repos } = Realm("prog-guards");
    assert.equal((await repos.progressionTracks.setProgressIfGreater("u1", "Mastery_A", 5)).progress, 5, "creates the row");
    assert.equal((await repos.progressionTracks.setProgressIfGreater("u1", "Mastery_A", 3)).progress, 5, "a stale lower value is ignored");
    const Higher = await repos.progressionTracks.setProgressIfGreater("u1", "Mastery_A", 9);
    assert.equal(Higher.progress, 9);
    assert.equal(Higher.updateVersion, 3, "every call bumps the version, even an ignored one");

    const Ranked = await repos.progressionTracks.setConfirmedFremiumRank("u1", "Rank_B", 4);
    assert.equal(Ranked.confirmedFremiumRank, 4);
    assert.equal(Ranked.progress, 0, "a rank confirm before any grant creates the row at 0");
    assert.equal((await repos.progressionTracks.setConfirmedFremiumRank("u1", "Rank_B", 2)).confirmedFremiumRank, 4);

    await repos.progressionTracks.increment("u1", "Banked", 100);
    assert.equal((await repos.progressionTracks.spend("u1", "Banked", 60))?.progress, 40);
    assert.equal(await repos.progressionTracks.spend("u1", "Banked", 41), undefined, "cannot spend more than is banked");
    assert.equal((await repos.progressionTracks.get("u1", "Banked"))?.progress, 40);
    assert.equal(await repos.progressionTracks.spend("u1", "Nothing", 1), undefined);
    const Race = await Promise.all(Array.from({ length: 10 }, () => repos.progressionTracks.spend("u1", "Banked", 15)));
    assert.equal(Race.filter((Entry) => Entry !== undefined).length, 2, "40 covers exactly two debits of 15");
    assert.equal((await repos.progressionTracks.get("u1", "Banked"))?.progress, 10);
});

test("tracks inside a unit of work roll back with the currency debit that funds them", async () => {
    const { repos, uow } = Realm("prog-tx");
    await repos.wallets.create({ userId: "u1", balances: { PLAT: 100 } });
    await assert.rejects(uow.withTransaction(async (r, session) => {
        assert.ok(await r.wallets.incrementBalance("u1", "PLAT", -100, session));
        await r.progressionTracks.increment("u1", "SkuRankSkip", 5, session);
        throw new Error("crash");
    }), /crash/);
    assert.equal((await repos.wallets.findByUserId("u1"))?.balances.PLAT, 100);
    assert.equal(await repos.progressionTracks.get("u1", "SkuRankSkip"), undefined);

    await uow.withTransaction(async (r, session) => {
        await r.wallets.incrementBalance("u1", "PLAT", -100, session);
        await r.progressionTracks.increment("u1", "SkuRankSkip", 5, session);
        assert.equal((await r.progressionTracks.get("u1", "SkuRankSkip", session))?.progress, 5, "read your own write");
    });
    assert.equal((await repos.progressionTracks.get("u1", "SkuRankSkip"))?.progress, 5);
});

const Reforge = (overrides: Partial<WeaponReforgeState> = {}): WeaponReforgeState => ({
    reforgeId: "rf-1", status: "open", priorProgress: 5000, cap: 4000, banked: 1000, bankedRestored: 0, prestigeGranted: false,
    openedAt: "2026-10-13T12:00:00.000Z", ...overrides
});

test("weapon reforge: the reset needs the exact progress and version and no open reforge, the follow-ups apply once each", async () => {
    const { repos } = Realm("prog-reforge");
    const Before = await repos.progressionTracks.increment("u1", TRACK, 5000);
    await repos.progressionTracks.setConfirmedFremiumRank("u1", TRACK, 7);
    const Current = (await repos.progressionTracks.get("u1", TRACK))!;

    assert.equal(await repos.progressionTracks.beginReforge("u1", TRACK, 4999, Current.updateVersion, Reforge()), undefined, "wrong progress");
    assert.equal(await repos.progressionTracks.beginReforge("u1", TRACK, 5000, Before.updateVersion, Reforge()), undefined, "stale version");
    assert.equal(await repos.progressionTracks.beginReforge("u1", "Missing", 0, 0, Reforge()), undefined);
    const Reset = (await repos.progressionTracks.beginReforge("u1", TRACK, 5000, Current.updateVersion, Reforge()))!;
    assert.equal(Reset.progress, 0);
    assert.equal(Reset.confirmedFremiumRank, 0);
    assert.equal(Reset.updateVersion, Current.updateVersion + 1);
    assert.equal(Reset.updatedAt, "2026-10-13T12:00:00.000Z");
    assert.deepEqual(Reset.reforge, Reforge());
    assert.equal(await repos.progressionTracks.beginReforge("u1", TRACK, 0, Reset.updateVersion, Reforge({ reforgeId: "rf-2" })), undefined, "no second reforge while one is open");

    assert.equal(await repos.progressionTracks.updateReforge("u1", TRACK, "rf-1", { prestigeGranted: false }, { prestigeGranted: true }), true);
    assert.equal(await repos.progressionTracks.updateReforge("u1", TRACK, "rf-1", { prestigeGranted: false }, { prestigeGranted: true }), false, "the expected state no longer holds: once only");
    assert.equal(await repos.progressionTracks.updateReforge("u1", TRACK, "rf-1", {}, { prestigeGranted: true }), false, "a set that changes nothing is not a modification");
    assert.equal(await repos.progressionTracks.updateReforge("u1", TRACK, "other", {}, { bankedRestored: 1000 }), false, "wrong reforge id");
    assert.equal(await repos.progressionTracks.updateReforge("u1", "Missing", "rf-1", {}, { bankedRestored: 1 }), false);
    assert.equal(await repos.progressionTracks.updateReforge("u1", TRACK, "rf-1", { bankedRestored: 0 }, { bankedRestored: 1000, status: "closed", closedAt: NOW }), true);
    const Closed = (await repos.progressionTracks.get("u1", TRACK))!.reforge!;
    assert.equal(Closed.status, "closed");
    assert.equal(Closed.bankedRestored, 1000);
    assert.equal(Closed.closedAt, NOW);
    assert.equal(Closed.prestigeGranted, true);

    // A closed reforge no longer blocks the next one.
    const Next = (await repos.progressionTracks.get("u1", TRACK))!;
    assert.ok(await repos.progressionTracks.beginReforge("u1", TRACK, Next.progress, Next.updateVersion, Reforge({ reforgeId: "rf-2" })));
});

test("prestige rewards are claimed once per level, only with enough progress", async () => {
    const { repos } = Realm("prog-prestige");
    await repos.progressionTracks.increment("u1", "PrestigeTrack_Weapon_Sword", 3);
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "PrestigeTrack_Weapon_Sword", 0, 2, 4), false, "not enough progress");
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "PrestigeTrack_Weapon_Sword", 0, 2, 2), true);
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "PrestigeTrack_Weapon_Sword", 0, 2, 2), false, "already claimed from 0");
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "PrestigeTrack_Weapon_Sword", 1, 1, 2), false, "wrong base");
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "PrestigeTrack_Weapon_Sword", 2, 1, 3), true);
    const Track = (await repos.progressionTracks.get("u1", "PrestigeTrack_Weapon_Sword"))!;
    assert.equal(Track.prestigeClaimed, 3);
    assert.equal(Track.progress, 3, "progress is never spent");
    assert.equal(await repos.progressionTracks.claimPrestigeLevels("u1", "Nope", 0, 1, 0), false);
});

test("objectives: max-guarded value and completed count, bulk merge, targeted read, raw event log", async () => {
    const { repos, uow } = Realm("prog-objectives");
    assert.deepEqual(await repos.progressionTracks.getObjectives("u1", []), []);
    const First = await repos.progressionTracks.setObjectiveIfGreater("u1", "MasteryObjective_Kills1", 1, 0);
    assert.deepEqual({ value: First.value, completedCount: First.completedCount }, { value: 1, completedCount: 0 });
    const Second = await repos.progressionTracks.setObjectiveIfGreater("u1", "MasteryObjective_Kills1", 2, 1);
    assert.deepEqual({ value: Second.value, completedCount: Second.completedCount }, { value: 2, completedCount: 1 });
    const Stale = await repos.progressionTracks.setObjectiveIfGreater("u1", "MasteryObjective_Kills1", 1, 0);
    assert.deepEqual({ value: Stale.value, completedCount: Stale.completedCount }, { value: 2, completedCount: 1 }, "an older report cannot lower it");
    const Mixed = await repos.progressionTracks.setObjectiveIfGreater("u1", "MasteryObjective_Kills1", 1, 5);
    assert.deepEqual({ value: Mixed.value, completedCount: Mixed.completedCount }, { value: 2, completedCount: 5 }, "each field has its own guard");

    await uow.withTransaction(async (r, session) => {
        await r.progressionTracks.mergeObjectives("u1", [
            { objectiveId: "A", value: 3, completedCount: 0 },
            { objectiveId: "B", value: 4, completedCount: 1 },
            { objectiveId: "MasteryObjective_Kills1", value: 1, completedCount: 1 },
            { objectiveId: "A", value: 2, completedCount: 2 }
        ], session);
        const Seen = await r.progressionTracks.getObjectives("u1", ["A", "MasteryObjective_Kills1", "Unknown"], session);
        assert.deepEqual(Seen.map((Entry) => [Entry.objectiveId, Entry.value, Entry.completedCount]).sort(),
            [["A", 3, 2], ["MasteryObjective_Kills1", 2, 5]]);
    });
    await repos.progressionTracks.mergeObjectives("u1", []);
    assert.equal((await repos.progressionTracks.getAllObjectivesForUser("u1")).length, 3);
    assert.equal((await repos.progressionTracks.getAllObjectivesForUser("u2")).length, 0);
    assert.deepEqual(await repos.progressionTracks.getObjectives("u2", ["A"]), [], "scoped to the account");

    await repos.progressionTracks.appendObjectiveEvent({ userId: "u1", rawBody: "{\"n\":1}", receivedAt: NOW });
    await repos.progressionTracks.appendObjectiveEvent({ userId: "u1", rawBody: "{\"n\":1}", receivedAt: NOW });
});

function Grant(id: string, amount: number): ProgressionGrantRecord {
    return {
        grantId: id, userId: "u1", progressionId: TRACK, amount, requestHash: `hash-${id}`, status: "applied", createdAt: NOW,
        result: {
            userId: "u1", progressionId: TRACK, progress: amount, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
            updateVersion: 1, createdAt: NOW, updatedAt: NOW
        }
    };
}

test("the grant ledger is exactly-once: a second insert of the same grant id is a duplicate-key error and nothing is granted twice", async () => {
    const { repos, uow } = Realm("prog-grants");
    assert.equal(await repos.progressionGrants.findByGrantId("g1"), undefined);

    const Apply = (id: string, amount: number) => uow.withTransaction(async (r, session) => {
        if (await r.progressionGrants.findByGrantId(id, session)) return "replayed";
        const Track = await r.progressionTracks.increment("u1", TRACK, amount, session);
        await r.progressionGrants.insertApplied({ ...Grant(id, amount), result: Track }, session);
        return "applied";
    });

    assert.equal(await Apply("g1", 100), "applied");
    assert.equal(await Apply("g1", 100), "replayed");
    assert.equal((await repos.progressionTracks.get("u1", TRACK))?.progress, 100);
    const Stored = (await repos.progressionGrants.findByGrantId("g1"))!;
    assert.equal(Stored.amount, 100);
    assert.equal(Stored.status, "applied");
    assert.equal(Stored.result.progress, 100);
    assert.equal("reforge" in Stored.result, false, "the stored result carries the plain track fields");

    // Two racers with the same grant id: the loser's unit of work fails on the insert and its increment is rolled back.
    const Racers = await Promise.allSettled([
        uow.withTransaction(async (r, session) => {
            await r.progressionTracks.increment("u1", TRACK, 7, session);
            await r.progressionGrants.insertApplied(Grant("g2", 7), session);
        }),
        uow.withTransaction(async (r, session) => {
            await r.progressionTracks.increment("u1", TRACK, 7, session);
            await r.progressionGrants.insertApplied(Grant("g2", 7), session);
        })
    ]);
    assert.equal(Racers.filter((Entry) => Entry.status === "fulfilled").length, 1);
    const Rejected = Racers.find((Entry) => Entry.status === "rejected") as PromiseRejectedResult;
    assert.ok(IsDuplicate(Rejected.reason));
    assert.equal((await repos.progressionTracks.get("u1", TRACK))?.progress, 107, "granted exactly once");
});

function EscalationRecord(version: number, level = 1): EscalationProgressRecord {
    return {
        userId: "u1", seasonId: "season-1", escalationLevel: level, nextLevelXp: 1000, talentsProgress: [{ id: "t", n: undefined }],
        unlockProgress: [], updateVersion: version, createdAt: NOW, updatedAt: NOW
    };
}

test("escalation progress: insert-only when no version is expected, otherwise replace only at that version", async () => {
    const { repos } = Realm("prog-escalation");
    assert.equal(await repos.escalationProgress.get("u1", "season-1"), undefined);
    const Inserted = await repos.escalationProgress.saveIfVersion(EscalationRecord(1), undefined);
    assert.equal(Inserted?.escalationLevel, 1);
    assert.equal(await repos.escalationProgress.saveIfVersion(EscalationRecord(1, 9), undefined), undefined, "a row exists: insert-only loses");
    assert.equal(await repos.escalationProgress.saveIfVersion(EscalationRecord(2, 2), 5), undefined, "stale expected version");
    const Replaced = await repos.escalationProgress.saveIfVersion(EscalationRecord(2, 2), 1);
    assert.equal(Replaced?.escalationLevel, 2);
    assert.equal(Replaced?.updateVersion, 2);
    assert.equal((await repos.escalationProgress.get("u1", "season-1"))?.escalationLevel, 2);
    assert.equal(await repos.escalationProgress.saveIfVersion(EscalationRecord(3), 1), undefined, "the version moved on");
    assert.equal(await repos.escalationProgress.saveIfVersion({ ...EscalationRecord(1), seasonId: "season-9" }, 1), undefined, "no row to replace");
    assert.equal(await repos.escalationProgress.get("u1", "season-9"), undefined);

    const Racers = await Promise.all([
        repos.escalationProgress.saveIfVersion(EscalationRecord(3, 30), 2),
        repos.escalationProgress.saveIfVersion(EscalationRecord(3, 31), 2)
    ]);
    assert.equal(Racers.filter((Entry) => Entry !== undefined).length, 1, "one of two saves at the same version wins");
});

function Bounty(version: number, bounties = 1): BountyStateRecord {
    return {
        userId: "u1",
        bounties: Array.from({ length: bounties }, (_, Index) => ({ group: "daily" as const, bounty: { id: `b${Index}` } })),
        draftData: { daily: { token: "x" } }, updateVersion: version, createdAt: NOW, updatedAt: NOW
    };
}

test("bounty state: the same versioned save, and a save can join the unit of work of the reward it funds", async () => {
    const { repos, uow } = Realm("prog-bounty");
    assert.equal(await repos.bountyStates.get("u1"), undefined);
    assert.equal((await repos.bountyStates.saveIfVersion(Bounty(1), undefined))?.bounties.length, 1);
    assert.equal(await repos.bountyStates.saveIfVersion(Bounty(1), undefined), undefined);
    assert.equal(await repos.bountyStates.saveIfVersion(Bounty(2, 3), 7), undefined);
    assert.equal((await repos.bountyStates.saveIfVersion(Bounty(2, 3), 1))?.bounties.length, 3);
    assert.deepEqual((await repos.bountyStates.get("u1"))?.draftData, { daily: { token: "x" } });

    await assert.rejects(uow.withTransaction(async (r, session) => {
        assert.ok(await r.bountyStates.saveIfVersion(Bounty(3, 9), 2, session));
        assert.equal((await r.bountyStates.get("u1", session))?.bounties.length, 9);
        throw new Error("grant failed");
    }), /grant failed/);
    assert.equal((await repos.bountyStates.get("u1"))?.bounties.length, 3, "the claim mark rolled back with the failed grant");
    assert.equal((await repos.bountyStates.get("u1"))?.updateVersion, 2);
});

function Cooldowns(version: number, ids: string[]): CooldownStateRecord {
    return {
        userId: "u1", entries: ids.map((id) => ({ id, startedDate: NOW, updatedAt: NOW })), updateVersion: version, createdAt: NOW, updatedAt: NOW
    };
}

test("cooldowns: ids with dots or a leading dollar are plain array entries, saved under the same version rule", async () => {
    const { repos } = Realm("prog-cooldowns");
    assert.equal(await repos.cooldownStates.get("u1"), undefined);
    assert.ok(await repos.cooldownStates.saveIfVersion(Cooldowns(1, ["daily.fountain", "$weird"]), undefined));
    assert.equal(await repos.cooldownStates.saveIfVersion(Cooldowns(1, []), undefined), undefined);
    assert.deepEqual((await repos.cooldownStates.get("u1"))?.entries.map((Entry) => Entry.id), ["daily.fountain", "$weird"]);
    assert.equal(await repos.cooldownStates.saveIfVersion(Cooldowns(2, ["x"]), 9), undefined);
    const Next = await repos.cooldownStates.saveIfVersion(Cooldowns(2, ["x", "y"]), 1);
    assert.deepEqual(Next?.entries.map((Entry) => Entry.id), ["x", "y"]);
    assert.equal((await repos.cooldownStates.get("u1"))?.updateVersion, 2);
});
