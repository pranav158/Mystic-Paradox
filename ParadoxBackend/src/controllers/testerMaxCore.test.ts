import assert from "node:assert/strict";
import test from "node:test";
import {
    DeriveTesterMaxId,
    IsValidTesterMaxRunId,
    PlanXpGrants,
    RunTesterMax,
    TesterMaxDeps,
    TesterMaxKit,
    TesterMaxKitChecks,
    TesterMaxRefusal,
    ValidateTesterMaxKit
} from "./testerMaxCore";

// [2026-10-14] Pure tests of the tester-max run: every ledger is a fake that records plain values. The kit checks are fakes too, so
// these tests need no game data. The real-ledger run is in testerMax.gamedata.test.ts.

const RUN = "run-2026-10-14-a";
const USER = "user-tester-1";
const CHARACTER = "char-1";
const MAX_GRANT = 100_000;

function Checks(overrides: Partial<TesterMaxKitChecks> = {}): TesterMaxKitChecks {
    return {
        isApprovedXpTrack: (Id) => Id.startsWith("ExperienceTrack_"),
        trackCapXp: (Id) => (Id === "ExperienceTrack_PrestigeLess" ? undefined : 27_775),
        rankForProgress: (_Id, Progress) => (Progress >= 27_775 ? 20 : Math.floor(Progress / 10_000)),
        isKnownCatalogId: (Id) => ["AC_HEAD_ARMSTRONG_00", "CURRENCY_NOTES", "CURRENCY_PLATINUM", "CURRENCY_PLATINUM_CS", "CURRENCY_SEASONAL_COIN", "R1", "R2", "R3"].includes(Id),
        isPlatinumAggregate: (Id) => Id === "CURRENCY_PLATINUM",
        maxXpGrant: MAX_GRANT,
        ...overrides
    };
}

interface Recorded {
    xp: Array<{ userId: string; progressionId: string; amount: number; grantId: string; economySource: string }>;
    inventory: Array<{ transactionId: string; stacked: Array<{ catalogId: string; quantity: number }>; economySource: string }>;
    confirms: Array<{ progressionId: string; rank: number }>;
}

function FakeDeps(options: {
    progress?: Record<string, number>;
    characterId?: string;
    failXpFor?: string;
    inventoryApplies?: boolean;
    failInventoryFor?: string;
} = {}): { deps: TesterMaxDeps; recorded: Recorded; progress: Record<string, number> } {
    const progress: Record<string, number> = { ...(options.progress ?? {}) };
    const recorded: Recorded = { xp: [], inventory: [], confirms: [] };
    const deps: TesterMaxDeps = {
        async findCharacterId() { return options.characterId ?? CHARACTER; },
        async readTrackProgress(_userId, progressionId) { return progress[progressionId] ?? 0; },
        async grantXp(userId, progressionId, amount, grantId, economySource) {
            if (options.failXpFor === progressionId) throw new Error("ledger unavailable");
            recorded.xp.push({ userId, progressionId, amount, grantId, economySource });
            progress[progressionId] = (progress[progressionId] ?? 0) + amount;
            return undefined;
        },
        async confirmRank(_userId, progressionId, rank) { recorded.confirms.push({ progressionId, rank }); },
        async runInventory(_userId, _characterId, transactionId, stacked, economySource) {
            if (options.failInventoryFor !== undefined && stacked.some((Item) => Item.catalogId === options.failInventoryFor)) {
                throw new Error("inventory refused");
            }
            recorded.inventory.push({ transactionId, stacked: stacked.map((Item) => ({ ...Item })), economySource });
            return options.inventoryApplies ?? true;
        }
    };
    return { deps, recorded, progress };
}

// ---- XP planning ----

test("a track from zero to 250000 takes three grants, one per absolute 100000 block, with the remainder last", () => {
    assert.deepEqual(PlanXpGrants(0, 250_000, MAX_GRANT), [
        { index: 0, amount: 100_000 },
        { index: 1, amount: 100_000 },
        { index: 2, amount: 50_000 }
    ]);
});

test("a plan resumed from the middle of a block plans the same ids as the first plan from that point", () => {
    const First = PlanXpGrants(0, 250_000, MAX_GRANT);
    const Resumed = PlanXpGrants(200_000, 250_000, MAX_GRANT);
    assert.deepEqual(Resumed, [{ index: 2, amount: 50_000 }]);
    assert.deepEqual(Resumed[0], First[2]);
});

test("a track already at or above the target plans nothing, and a start inside a block keeps its block index", () => {
    assert.deepEqual(PlanXpGrants(250_000, 250_000, MAX_GRANT), []);
    assert.deepEqual(PlanXpGrants(300_000, 250_000, MAX_GRANT), []);
    assert.deepEqual(PlanXpGrants(1_234, 100_000, MAX_GRANT), [{ index: 0, amount: 98_766 }]);
});

test("a plan refuses a grant size that is not a positive integer", () => {
    assert.throws(() => PlanXpGrants(0, 10, 0), /positive integer/);
    assert.throws(() => PlanXpGrants(0, 10, 1.5), /positive integer/);
});

// ---- ledger ids and run ids ----

test("derived ids are deterministic, valid progression grant ids, and differ by run and by part", () => {
    const A = DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:0");
    assert.equal(A, DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:0"));
    assert.match(A, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.notEqual(A, DeriveTesterMaxId("run-other-id", "xp:ExperienceTrack_PlayerLevel:0"));
    assert.notEqual(A, DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:1"));
    assert.equal(A.length, "tmax-".length + 40);
});

test("run ids: 8 to 64 characters of letters, digits, dot, underscore, hyphen; anything else is refused", () => {
    assert.equal(IsValidTesterMaxRunId("abcdefgh"), true);
    assert.equal(IsValidTesterMaxRunId("a".repeat(64)), true);
    assert.equal(IsValidTesterMaxRunId("abcdefg"), false);
    assert.equal(IsValidTesterMaxRunId("a".repeat(65)), false);
    assert.equal(IsValidTesterMaxRunId("has space here"), false);
    assert.equal(IsValidTesterMaxRunId("-leading-hyphen"), false);
    assert.equal(IsValidTesterMaxRunId(undefined), false);
    assert.equal(IsValidTesterMaxRunId(12345678), false);
});

// ---- kit validation ----

const GOOD_KIT: TesterMaxKit = {
    comment: "test kit",
    progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: "max" }, { progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: 5_000 }],
    inventory: [{ catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 1 }],
    currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 1_000_000 }, { catalogId: "CURRENCY_PLATINUM_CS", quantity: 500 }]
};

test("a well-formed kit has no problems", () => {
    assert.deepEqual(ValidateTesterMaxKit(GOOD_KIT, Checks()), []);
    assert.deepEqual(ValidateTesterMaxKit({}, Checks()), []);
});

test("the kit must be an object and may not carry unknown sections", () => {
    assert.deepEqual(ValidateTesterMaxKit([], Checks()), ["the kit must be a JSON object"]);
    assert.deepEqual(ValidateTesterMaxKit(null, Checks()), ["the kit must be a JSON object"]);
    assert.deepEqual(ValidateTesterMaxKit({ grants: [] }, Checks()), ['unknown section "grants"']);
});

test("progression: unapproved, duplicated, out-of-range and uncapped tracks are each reported", () => {
    const Problems = ValidateTesterMaxKit({
        progression: [
            { progressionId: "MasteryTrack_PlayerLevel", targetProgress: 10 },
            { progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: 10 },
            { progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: 20 },
            { progressionId: "ExperienceTrack_PrestigeLess", targetProgress: "max" },
            { progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 0 },
            { progressionId: "ExperienceTrack_Weapon_Axe", targetProgress: 10_000_001 }
        ]
    }, Checks());
    assert.equal(Problems.some((P) => P.includes('progression[0]: "MasteryTrack_PlayerLevel" is not an approved XP track')), true);
    assert.equal(Problems.some((P) => P.includes("progression[2]: ExperienceTrack_Weapon_Sword is listed twice")), true);
    assert.equal(Problems.some((P) => P.includes("progression[3]: ExperienceTrack_PrestigeLess has no top rank")), true);
    assert.equal(Problems.some((P) => P.startsWith("progression[4]: targetProgress must be")), true);
    assert.equal(Problems.some((P) => P.startsWith("progression[5]: targetProgress must be")), true);
    assert.equal(Problems.length, 5);
});

test("[2026-10-16] a kit with a slayersPath section is refused, with the reason: the section was removed", () => {
    // Its unlockAll wrote Slayer's Path ids the 1.14.7 client lacks, and the player was sent back to the login screen after Ramsgate.
    assert.deepEqual(ValidateTesterMaxKit({ slayersPath: { unlockAll: true } }, Checks()),
        ["slayersPath was removed (16 Oct): a tester unlocks the Slayer's Path in game"]);
});

test("inventory: unknown catalog ids are refused (never invented), currencies are redirected, quantities bounded", () => {
    const Problems = ValidateTesterMaxKit({
        inventory: [
            { catalogId: "WP_MADE_UP_99", quantity: 1 },
            { catalogId: "CURRENCY_NOTES", quantity: 1 },
            { catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 0 },
            { catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 1001 }
        ]
    }, Checks());
    assert.equal(Problems[0], 'inventory[0]: "WP_MADE_UP_99" is not in the inventory storage policy (do not invent catalog ids)');
    assert.equal(Problems[1], "inventory[1]: CURRENCY_NOTES is a currency; list it under currencies");
    assert.equal(Problems[2], "inventory[2]: quantity must be an integer from 1 to 1000");
    assert.equal(Problems[3], "inventory[3]: quantity must be an integer from 1 to 1000");
    assert.equal(Problems.length, 4);
});

test("currencies: the Platinum aggregate is refused with the way to grant it; a prestige-gated reward coin is accepted", () => {
    const Problems = ValidateTesterMaxKit({
        currencies: [
            { catalogId: "CURRENCY_PLATINUM", quantity: 10 },
            { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 10 },
            { catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 1 },
            { catalogId: "CURRENCY_NOTES", quantity: 10_000_001 }
        ]
    }, Checks());
    assert.equal(Problems[0].includes("is the Platinum aggregate; grant a storefront bucket (CURRENCY_PLATINUM_*)"), true);
    assert.equal(Problems[1].includes('"AC_HEAD_ARMSTRONG_00" is not a known CURRENCY_* id'), true);
    assert.equal(Problems[2].includes("quantity must be an integer from 1 to 10000000"), true);
    assert.equal(Problems.length, 3, "CURRENCY_SEASONAL_COIN (the Reward Cache coin) is not a problem any more");
});

// ---- the run ----

test("a bad run id is refused before any ledger is touched", async () => {
    const Touched: string[] = [];
    const Throwing = new Proxy({}, { get: (_Target, Name) => { Touched.push(String(Name)); return () => { throw new Error("must not run"); }; } });
    await assert.rejects(
        RunTesterMax({ userId: USER, runId: "short", kit: GOOD_KIT, checks: Checks() }, Throwing as TesterMaxDeps),
        (Err: unknown) => Err instanceof TesterMaxRefusal && Err.code === "ADMIN_TESTER_MAX_RUN_ID"
    );
    assert.deepEqual(Touched, []);
});

test("a tester with no character is refused before any grant", async () => {
    const { deps, recorded } = FakeDeps({ characterId: undefined });
    deps.findCharacterId = async () => undefined;
    await assert.rejects(
        RunTesterMax({ userId: USER, runId: RUN, kit: GOOD_KIT, checks: Checks() }, deps),
        (Err: unknown) => Err instanceof TesterMaxRefusal && Err.code === "ADMIN_TESTER_MAX_NO_CHARACTER"
    );
    assert.equal(recorded.xp.length, 0);
    assert.equal(recorded.inventory.length, 0);
});

test("XP: each track is granted in its plan, every grant carries OPERATOR_TEST and a run-derived id", async () => {
    const { deps, recorded, progress } = FakeDeps({ progress: { ExperienceTrack_PlayerLevel: 0 } });
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: { progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 250_000 }] },
        checks: Checks()
    }, deps);
    assert.equal(Report.status, "done");
    assert.deepEqual(recorded.xp.map((G) => [G.amount, G.grantId, G.economySource]), [
        [100_000, DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:0"), "OPERATOR_TEST"],
        [100_000, DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:1"), "OPERATOR_TEST"],
        [50_000, DeriveTesterMaxId(RUN, "xp:ExperienceTrack_PlayerLevel:2"), "OPERATOR_TEST"]
    ]);
    assert.equal(progress.ExperienceTrack_PlayerLevel, 250_000);
    assert.deepEqual(Report.progression[0], {
        progressionId: "ExperienceTrack_PlayerLevel", target: 250_000, startProgress: 0, granted: 250_000, grants: 3, confirmedRank: 20,
        status: "done"
    });
});

test('"max" resolves to the top rank of the track', async () => {
    const { deps, progress } = FakeDeps({ progress: { ExperienceTrack_Weapon_Sword: 1_000 } });
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: { progression: [{ progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: "max" }] },
        checks: Checks()
    }, deps);
    assert.equal(progress.ExperienceTrack_Weapon_Sword, 27_775);
    assert.equal(Report.progression[0].target, 27_775);
    assert.equal(Report.progression[0].granted, 26_775);
});

test("replaying the same run grants nothing new: the XP is already at its target and the inventory id is the same", async () => {
    const { deps, recorded, progress } = FakeDeps({ progress: { ExperienceTrack_PlayerLevel: 0 } });
    const Kit: TesterMaxKit = {
        progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 250_000 }],
        currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 10 }]
    };
    await RunTesterMax({ userId: USER, runId: RUN, kit: Kit, checks: Checks() }, deps);
    const FirstXp = recorded.xp.length;
    const Second = await RunTesterMax({ userId: USER, runId: RUN, kit: Kit, checks: Checks() }, deps);
    assert.equal(recorded.xp.length, FirstXp);
    assert.equal(progress.ExperienceTrack_PlayerLevel, 250_000);
    assert.equal(recorded.inventory[0].transactionId, recorded.inventory[1].transactionId);
    assert.equal(Second.progression[0].grants, 0);
});

test("a new run id tops a track up to its target and grants nothing above it", async () => {
    const { deps, recorded, progress } = FakeDeps({ progress: { ExperienceTrack_PlayerLevel: 200_000 } });
    const Report = await RunTesterMax({
        userId: USER, runId: "second-run-2",
        kit: { progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 250_000 }] },
        checks: Checks()
    }, deps);
    assert.deepEqual(recorded.xp.map((G) => G.amount), [50_000]);
    assert.equal(recorded.xp[0].grantId, DeriveTesterMaxId("second-run-2", "xp:ExperienceTrack_PlayerLevel:2"));
    assert.equal(progress.ExperienceTrack_PlayerLevel, 250_000);
    const Lower = await RunTesterMax({
        userId: USER, runId: "third-run-3",
        kit: { progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 100_000 }] },
        checks: Checks()
    }, deps);
    assert.equal(Lower.progression[0].grants, 0);
    assert.equal(progress.ExperienceTrack_PlayerLevel, 250_000);
});

test("items and currencies go in one inventory transaction, stacks merged by catalog id, OPERATOR_TEST", async () => {
    const { deps, recorded } = FakeDeps();
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: {
            inventory: [{ catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 1 }, { catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 2 }],
            currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 1_000_000 }]
        },
        checks: Checks()
    }, deps);
    assert.equal(recorded.inventory.length, 1);
    assert.equal(recorded.inventory[0].transactionId, DeriveTesterMaxId(RUN, "items"));
    assert.equal(recorded.inventory[0].economySource, "OPERATOR_TEST");
    assert.deepEqual(recorded.inventory[0].stacked, [
        { catalogId: "AC_HEAD_ARMSTRONG_00", quantity: 3 },
        { catalogId: "CURRENCY_NOTES", quantity: 1_000_000 }
    ]);
    assert.deepEqual(Report.items, { status: "done", stacks: 2 });
});

test("[2026-10-16] our kit: the seven weapon tracks to level 20 and four currencies in one transaction, nothing else", async () => {
    const Weapons = ["Axe", "ChainBlades", "Hammer", "Repeaters", "Spear", "Strikers", "Sword"].map((Name) => `ExperienceTrack_Weapon_${Name}`);
    const { deps, recorded, progress } = FakeDeps();
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: {
            progression: Weapons.map((Id) => ({ progressionId: Id, targetProgress: "max" as const })),
            currencies: [
                { catalogId: "CURRENCY_NOTES", quantity: 8_000_000 },
                { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 50_000 }
            ]
        },
        checks: Checks()
    }, deps);
    assert.equal(Report.status, "done");
    assert.deepEqual(Weapons.map((Id) => progress[Id]), Weapons.map(() => 27_775));
    assert.equal(recorded.xp.some((G) => G.progressionId === "ExperienceTrack_PlayerLevel"), false);
    assert.equal(recorded.inventory.length, 1);
    assert.deepEqual(recorded.inventory[0].stacked, [
        { catalogId: "CURRENCY_NOTES", quantity: 8_000_000 },
        { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 50_000 }
    ]);
    assert.equal(Object.hasOwn(Report, "slayersPath"), false);
    // [2026-10-16] Each weapon's level 20 is confirmed, as the game does: XP at the cap with rank 0 confirmed kicked the player.
    assert.deepEqual(recorded.confirms, Weapons.map((Id) => ({ progressionId: Id, rank: 20 })));
    assert.deepEqual(Report.progression.map((Row) => Row.confirmedRank), Weapons.map(() => 20));
});

test("[2026-10-16] the reached rank is confirmed on a replay too (the confirm never lowers), and rank 0 is not confirmed", async () => {
    const { deps, recorded } = FakeDeps({ progress: { ExperienceTrack_Weapon_Sword: 27_775 } });
    const Kit: TesterMaxKit = { progression: [{ progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: "max" }] };
    const Replay = await RunTesterMax({ userId: USER, runId: RUN, kit: Kit, checks: Checks() }, deps);
    assert.equal(Replay.progression[0].grants, 0);
    assert.deepEqual(recorded.confirms, [{ progressionId: "ExperienceTrack_Weapon_Sword", rank: 20 }]);
    const Low = FakeDeps();
    await RunTesterMax({
        userId: USER, runId: RUN, kit: { progression: [{ progressionId: "ExperienceTrack_Weapon_Axe", targetProgress: 500 }] }, checks: Checks()
    }, Low.deps);
    assert.deepEqual(Low.recorded.confirms, []);
});

test("[2026-10-16] a refused rank confirm marks that track as an error; the other tracks and the currencies still run", async () => {
    const { deps, recorded } = FakeDeps();
    deps.confirmRank = async (_userId, progressionId) => {
        if (progressionId === "ExperienceTrack_Weapon_Axe") throw new Error("rank 20 confirm refused: insufficient_xp");
        recorded.confirms.push({ progressionId, rank: 20 });
    };
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: {
            progression: [
                { progressionId: "ExperienceTrack_Weapon_Axe", targetProgress: "max" },
                { progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: "max" }
            ],
            currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 5 }]
        },
        checks: Checks()
    }, deps);
    assert.equal(Report.status, "partial");
    assert.equal(Report.progression[0].status, "error");
    assert.match(Report.progression[0].error ?? "", /insufficient_xp/);
    assert.equal(Report.progression[1].confirmedRank, 20);
    assert.equal(Report.items?.status, "done");
});

test("one failing track does not stop the others: the report is partial and names what failed", async () => {
    const { deps, recorded } = FakeDeps({
        failXpFor: "ExperienceTrack_Weapon_Sword",
        progress: {}
    });
    const Report = await RunTesterMax({
        userId: USER, runId: RUN,
        kit: {
            progression: [
                { progressionId: "ExperienceTrack_Weapon_Sword", targetProgress: 5_000 },
                { progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 5_000 }
            ],
            currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 5 }]
        },
        checks: Checks()
    }, deps);
    assert.equal(Report.status, "partial");
    assert.equal(Report.progression[0].status, "error");
    assert.equal(Report.progression[0].error, "ledger unavailable");
    assert.equal(Report.progression[1].status, "done");
    assert.equal(recorded.xp.some((G) => G.progressionId === "ExperienceTrack_PlayerLevel"), true);
    assert.equal(Report.items?.status, "done");
    assert.equal(recorded.inventory.some((I) => I.transactionId === DeriveTesterMaxId(RUN, "items")), true);
});

test("an inventory transaction that does not apply is reported as an error, not as done", async () => {
    const { deps } = FakeDeps({ inventoryApplies: false });
    const Report = await RunTesterMax({
        userId: USER, runId: RUN, kit: { currencies: [{ catalogId: "CURRENCY_NOTES", quantity: 5 }] }, checks: Checks()
    }, deps);
    assert.equal(Report.status, "partial");
    assert.equal(Report.items?.status, "error");
    assert.equal(Report.items?.error, "the inventory transaction did not apply");
});
