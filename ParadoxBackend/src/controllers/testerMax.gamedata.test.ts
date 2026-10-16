import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { Request, Response } from "express";
import { UsePersistenceForTest } from "../persistence";
import { gameDataDir } from "../gameData/loader";
import { OpenTestRealm } from "../persistence/sqlite/testSupport";
import { GrantProgressionXp } from "./progression";
import { ApplyCurrencyDeltas, InsufficientPrestigeProgressError, IsPrestigeGatedReward } from "./wallet";
import { FlushActivity } from "../activity/activityMonitor";
import { DefaultTesterMaxChecks, DefaultTesterMaxDeps, TesterMaxPlayer } from "./testerMax";
import { DeriveTesterMaxId, RunTesterMax, TesterMaxDeps, TesterMaxKit, ValidateTesterMaxKit } from "./testerMaxCore";

// [2026-10-14] Real game data (progression config, storage policy, Slayer's Path) with the SQLite provider. Skipped by npm test when
// the real data is missing (see scripts/run-tests.cjs). Every assertion reads a plain value.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => {
    UsePersistenceForTest(undefined);
    for (const Cleanup of Cleanups) await Cleanup();
});

const RUN = "gamedata-run-1";
const USER = "tester-max-user";

test("the committed example kit is valid against the real progression config and storage policy", () => {
    const Kit = JSON.parse(fs.readFileSync(path.join(gameDataDir(), "tester_max_kit.example.json"), "utf8").replace(/^﻿/, ""));
    assert.deepEqual(ValidateTesterMaxKit(Kit, DefaultTesterMaxChecks()), []);
});

test("XP through the real ledger: set-to-target in absolute blocks, OPERATOR_TEST, replay-safe, and not counted by the activity monitor", async () => {
    const Realm = OpenTestRealm("tester-max-xp");
    Cleanups.push(Realm.cleanup);
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    const Repos = Realm.repos;
    const Kit: TesterMaxKit = { progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 250_000 }] };

    // Only the XP ledgers are real here; the character and inventory ledgers are not part of this check.
    const Deps: TesterMaxDeps = {
        ...DefaultTesterMaxDeps(),
        findCharacterId: async () => "character-1",
        runInventory: async () => true
    };
    const Checks = DefaultTesterMaxChecks();
    const First = await RunTesterMax({ userId: USER, runId: RUN, kit: Kit, checks: Checks }, Deps);
    assert.equal(First.status, "done");
    assert.equal(First.progression[0].grants, 3);
    assert.equal((await Repos.progressionTracks.get(USER, "ExperienceTrack_PlayerLevel"))?.progress, 250_000);
    // [2026-10-16] The reached rank is confirmed through the game's own confirm (the top rank, 20, at 141,020 XP).
    assert.equal(First.progression[0].confirmedRank, 20);
    assert.equal((await Repos.progressionTracks.get(USER, "ExperienceTrack_PlayerLevel"))?.confirmedFremiumRank, 20);

    for (let Index = 0; Index < 3; Index++) {
        const Grant = await Repos.progressionGrants.findByGrantId(DeriveTesterMaxId(RUN, `xp:ExperienceTrack_PlayerLevel:${Index}`));
        assert.notEqual(Grant, undefined, `ledger row ${Index}`);
        assert.equal(Grant?.status, "applied");
        assert.equal(Grant?.amount, [100_000, 100_000, 50_000][Index]);
    }

    // The same run again, and a new run to the same target: nothing new is granted.
    const Replay = await RunTesterMax({ userId: USER, runId: RUN, kit: Kit, checks: Checks }, Deps);
    assert.equal(Replay.progression[0].grants, 0);
    const Other = await RunTesterMax({ userId: USER, runId: "gamedata-run-2", kit: Kit, checks: Checks }, Deps);
    assert.equal(Other.progression[0].grants, 0);
    assert.equal((await Repos.progressionTracks.get(USER, "ExperienceTrack_PlayerLevel"))?.progress, 250_000);

    // A new run to a higher target tops the track up by the difference only.
    const Top = await RunTesterMax({ userId: USER, runId: "gamedata-run-3", kit: { progression: [{ progressionId: "ExperienceTrack_PlayerLevel", targetProgress: 300_000 }] }, checks: Checks }, Deps);
    assert.equal(Top.progression[0].granted, 50_000);
    assert.equal((await Repos.progressionTracks.get(USER, "ExperienceTrack_PlayerLevel"))?.progress, 300_000);

    // The activity monitor ignores OPERATOR_TEST; an ordinary grant on another account is counted (the control). The monitor buffers
    // its writes and flushes on a timer, so the test flushes explicitly.
    await FlushActivity();
    const Rows = await Repos.activity.findDailyRows(USER, "2000-01-01", "2099-12-31", 10);
    assert.equal(Rows.length, 0);
    await GrantProgressionXp("control-user", "ExperienceTrack_PlayerLevel", 500, "control-grant-1", Realm.uow);
    await FlushActivity();
    const Control = await Repos.activity.findDailyRows("control-user", "2000-01-01", "2099-12-31", 10);
    assert.equal(Control.length >= 1, true);
});

test("[2026-10-16] the Reward Cache coin: refused without banked prestige, credited by the tester tool's operator funding", async () => {
    const Realm = OpenTestRealm("tester-max-coin");
    Cleanups.push(Realm.cleanup);
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    const Coin = [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 500 }];
    assert.equal(IsPrestigeGatedReward("CURRENCY_SEASONAL_COIN"), true);
    await assert.rejects(ApplyCurrencyDeltas("coin-user", Coin, []), (Err: unknown) => Err instanceof InsufficientPrestigeProgressError);
    const Balances = await ApplyCurrencyDeltas("coin-user", Coin, [], undefined, "tmax-coin", false, undefined, true);
    assert.equal(Balances.CURRENCY_SEASONAL_COIN, 500);
});

// The route's refusals that come before any kit or ledger work. The repository stands in for the accounts and audit collections.
function FakeRepos(accounts: Record<string, { displayName: string; roles: string[] }>, audits: unknown[]) {
    return {
        launcherAccounts: {
            async findByUserId(UserId: string) {
                const Account = accounts[UserId];
                return Account === undefined ? undefined : { userId: UserId, ...Account };
            }
        },
        admin: {
            async appendAudit(Record: unknown) { audits.push(Record); }
        }
    } as any;
}

async function Post(userId: string, body: Record<string, unknown>) {
    const audits: unknown[] = [];
    UsePersistenceForTest({
        repos: FakeRepos({ "tester-1": { displayName: "Tester One", roles: ["tester"] }, "plain-1": { displayName: "Plain", roles: [] } }, audits),
        uow: undefined as any
    });
    const Req = { AdminAuth: { account: { userId: "manager:111111111111111111" } }, params: { userId }, body, ip: "127.0.0.1" } as unknown as Request;
    const Captured = { status: 200, body: undefined as any };
    const Res = {
        status(Code: number) { Captured.status = Code; return this; },
        json(Payload: unknown) { Captured.body = Payload; return this; }
    } as unknown as Response;
    await TesterMaxPlayer(Req, Res);
    return { status: Captured.status, body: Captured.body, audits };
}

test("the route refuses an unknown account, a non-tester, a wrong confirmation and a bad run id, with no audit for validation failures", async () => {
    const Unknown = await Post("nobody", { confirm: "MAX Nobody", runId: "run-abcdefgh" });
    assert.equal(Unknown.status, 404);
    assert.equal(Unknown.audits.length, 0);

    const NotTester = await Post("plain-1", { confirm: "MAX Plain", runId: "run-abcdefgh" });
    assert.equal(NotTester.status, 409);
    assert.equal(NotTester.body.error.code, "ADMIN_TESTER_REQUIRED");

    const WrongConfirm = await Post("tester-1", { confirm: "MAX tester one", runId: "run-abcdefgh" });
    assert.equal(WrongConfirm.status, 400);
    assert.equal(WrongConfirm.body.error.code, "ADMIN_TESTER_MAX_CONFIRMATION");

    const NoRunId = await Post("tester-1", { confirm: "MAX Tester One" });
    assert.equal(NoRunId.status, 400);
    assert.equal(NoRunId.body.error.code, "ADMIN_TESTER_MAX_RUN_ID");
    assert.equal(NoRunId.audits.length, 0);
});
