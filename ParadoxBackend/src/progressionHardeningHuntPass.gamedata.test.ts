import assert from "node:assert/strict";
import test from "node:test";
import {
    ACTIVE_HUNTPASS_PROGRESSION_ID,
    DescribeUnapprovedXpTrack,
    IsApprovedXpProgressionTrack,
    IsHuntPassXpTrack,
    RankForProgress,
    ServedHuntPassProgressionId
} from "./controllers/progression";
import { MonitorHuntPassGrant, MonitorProgressionServed } from "./diagnostics/economyMonitor";
import { logger } from "./logger";

// [2026-10-10] Hunt pass grant observability and the served-pass allowlist (routes/progression.ts,
// controllers/progression.ts, diagnostics/economyMonitor.ts). Uses the real
// game-data/progression_config.json: season43 is 101 ranks (rank_id 0..100), 0 then 100 XP each.

function WithHuntPassOverride(value: string | undefined, action: () => void): void {
    const Previous = process.env.GAMESERVER_HUNTPASS_ID;
    if (value === undefined) delete process.env.GAMESERVER_HUNTPASS_ID;
    else process.env.GAMESERVER_HUNTPASS_ID = value;
    try {
        action();
    } finally {
        if (Previous === undefined) delete process.env.GAMESERVER_HUNTPASS_ID;
        else process.env.GAMESERVER_HUNTPASS_ID = Previous;
    }
}

function CaptureInfo(action: () => void): string[] {
    const Lines: string[] = [];
    const Original = logger.info;
    (logger as any).info = (Message: unknown) => { Lines.push(String(Message)); };
    try {
        action();
    } finally {
        (logger as any).info = Original;
    }
    return Lines;
}

test("the served hunt pass is approved for XP grants, and nothing else is widened", () => {
    WithHuntPassOverride(undefined, () => {
        assert.equal(ServedHuntPassProgressionId(), ACTIVE_HUNTPASS_PROGRESSION_ID);
        assert.equal(IsApprovedXpProgressionTrack("season43"), true);
        assert.equal(IsApprovedXpProgressionTrack("season19"), false);
        assert.equal(IsHuntPassXpTrack("season43"), true);
        assert.equal(IsHuntPassXpTrack("ExperienceTrack_PlayerLevel"), false);
    });
    WithHuntPassOverride("season19", () => {
        assert.equal(IsApprovedXpProgressionTrack("season19"), true);
        assert.equal(IsApprovedXpProgressionTrack("season43"), true);
        assert.equal(IsApprovedXpProgressionTrack("season27"), false);
        assert.equal(IsApprovedXpProgressionTrack("Linked_Slayer_Slot_1"), false);
        assert.equal(IsHuntPassXpTrack("season19"), true);
    });
    // An override naming a track without a rank curve stays refused.
    WithHuntPassOverride("season99", () => {
        assert.equal(IsApprovedXpProgressionTrack("season99"), false);
    });
    // An override can only open a hunt pass id, not a test or prestige track that has a curve.
    WithHuntPassOverride("test_minipass02", () => {
        assert.equal(IsApprovedXpProgressionTrack("test_minipass02"), false);
    });
});

test("refused tracks are named in the rejection line", () => {
    WithHuntPassOverride(undefined, () => {
        assert.match(DescribeUnapprovedXpTrack("Linked_Slayer_Slot_2"), /Slayer Link/);
        assert.match(DescribeUnapprovedXpTrack("season27"), /not served \(served=season43\)/);
        assert.match(DescribeUnapprovedXpTrack("NoSuchTrack"), /no rank curve/);
        assert.match(DescribeUnapprovedXpTrack("test_minipass01"), /not on the XP allowlist/);
    });
});

test("ranks follow the served cumulative requirements", () => {
    assert.equal(RankForProgress("season43", 0), 0);
    assert.equal(RankForProgress("season43", 99), 0);
    assert.equal(RankForProgress("season43", 100), 1);
    assert.equal(RankForProgress("season43", 687), 6);
    assert.equal(RankForProgress("season43", 1800), 18);
    assert.equal(RankForProgress("season43", 10_000), 100);
    assert.equal(RankForProgress("season43", 50_000), 100);
    assert.equal(RankForProgress("NoSuchTrack", 100), undefined);
});

test("[HuntPassMon] GRANT names progress and rank before and after", () => {
    const Lines = CaptureInfo(() => MonitorHuntPassGrant({
        userId: "user-1", progressionId: "season43", amount: 150, newProgress: 837,
        confirmedFremiumRank: 18, confirmedPremiumRank: 0, replayed: false, grantId: "gs-1"
    }, (Progress) => RankForProgress("season43", Progress)));
    assert.deepEqual(Lines, [
        "[HuntPassMon] GRANT user=user-1 track=season43 amount=150 progress=687->837 rank=6->8 confirmed=18/0 replayed=0 grant=gs-1"
    ]);
});

test("[PrestigeMon] SERVED always lists the served hunt pass, at progress 0 or absent", () => {
    const IsSource = (Id: string) => Id.startsWith("PrestigeTrack_") || Id === "season19" || Id === "season43";
    const Row = (Id: string, Progress: number, Fremium = 0) => ({
        progression_id: Id, progress: Progress, confirmed_fremium_rank: Fremium, confirmed_premium_rank: 0
    });

    const Zero = CaptureInfo(() => MonitorProgressionServed("user-1",
        [Row("PrestigeTrack_Weapon_Axe", 0), Row("PrestigeTrack_Weapon_Sword", 0), Row("season43", 0), Row("season19", 687, 18)],
        IsSource, ["season43"]));
    assert.deepEqual(Zero, [
        "[PrestigeMon] SERVED user=user-1 [PrestigeTrack_Weapon_Axe{progress=0 ranks=0/0} season43{progress=0 ranks=0/0} season19{progress=687 ranks=18/0}]"
    ]);

    const Absent = CaptureInfo(() => MonitorProgressionServed("user-1", [Row("PrestigeTrack_Weapon_Axe", 0)], IsSource, ["season19"]));
    assert.deepEqual(Absent, ["[PrestigeMon] SERVED user=user-1 [PrestigeTrack_Weapon_Axe{progress=0 ranks=0/0} season19{absent}]"]);

    // Without the parameter the old filter is unchanged.
    const Legacy = CaptureInfo(() => MonitorProgressionServed("user-1", [Row("PrestigeTrack_Weapon_Axe", 0), Row("season43", 0)], IsSource));
    assert.deepEqual(Legacy, ["[PrestigeMon] SERVED user=user-1 [PrestigeTrack_Weapon_Axe{progress=0 ranks=0/0}]"]);
});
