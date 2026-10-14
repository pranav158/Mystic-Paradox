/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

/*
 * [2026-10-15] The bounded mastery sync of a rank confirm (ConfirmPublicProgressionRank, controllers/progression.ts). The curves come
 * from game-data/progression_config.json (a .gamedata test). The track repository is in memory, installed through
 * UsePersistenceForTest; the logger records its lines, so the [MasteryMon] SYNC line is checked too.
 */

const Logged: { info: string[]; warn: string[] } = { info: [], warn: [] };
const Quiet = () => undefined;
const Recorder = (level: "info" | "warn") => (message: unknown) => { Logged[level].push(String(message)); };
const LoggerStub = {
    level: "silent", trace: Quiet, debug: Quiet, info: Recorder("info"), warn: Recorder("warn"), error: Quiet, fatal: Quiet,
    child: () => ({}),
};
require.cache[require.resolve("../logger")] = {
    id: require.resolve("../logger"), filename: require.resolve("../logger"), loaded: true,
    exports: { logger: LoggerStub, ApplyDiagnosticsLogProfile: Quiet }, children: [], paths: [],
} as unknown as NodeJS.Module;

type Row = { userId: string; progressionId: string; progress: number; confirmedFremiumRank: number; confirmedPremiumRank: number };
const Tracks = new Map<string, Row>();
const Key = (userId: string, progressionId: string) => `${userId}|${progressionId}`;
function Row(userId: string, progressionId: string): Row {
    const Existing = Tracks.get(Key(userId, progressionId));
    if (Existing !== undefined) return Existing;
    const Created: Row = { userId, progressionId, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0 };
    Tracks.set(Key(userId, progressionId), Created);
    return Created;
}

const Repos = {
    progressionTracks: {
        get: async (userId: string, progressionId: string) => Tracks.get(Key(userId, progressionId)),
        // Monotonic, as the Mongo repository's $max is.
        setProgressIfGreater: async (userId: string, progressionId: string, value: number) => {
            const Current = Row(userId, progressionId);
            Current.progress = Math.max(Current.progress, value);
            return Current;
        },
        setConfirmedFremiumRank: async (userId: string, progressionId: string, rank: number) => {
            const Current = Row(userId, progressionId);
            Current.confirmedFremiumRank = Math.max(Current.confirmedFremiumRank, rank);
            return Current;
        },
    },
};

let Progression: typeof import("./progression");
let Persistence: typeof import("../persistence");

before(() => {
    Progression = require("./progression");
    Persistence = require("../persistence");
    Persistence.UsePersistenceForTest({ repos: Repos as unknown as import("../persistence").RepositoryProvider, uow: {} as never });
});

after(() => {
    Persistence.UsePersistenceForTest(undefined);
});

const USER = "account-sync-1";
const SYNC_OPTIONS = { boundedMasterySync: true };

function Seed(progressionId: string, progress: number): void {
    Tracks.set(Key(USER, progressionId), { userId: USER, progressionId, progress, confirmedFremiumRank: 0, confirmedPremiumRank: 0 });
}

function Reset(): void {
    Tracks.clear();
    Logged.info.length = 0;
    Logged.warn.length = 0;
}

test("one objective's credit short, a host's mastery confirm is synced to the rank's requirement and goes through", async () => {
    Reset();
    Seed("MasteryTrack_Behemoth", 2);
    const Result = await Progression.ConfirmPublicProgressionRank(USER, "MasteryTrack_Behemoth", 1, SYNC_OPTIONS);
    assert.equal(Result.ok, true);
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.progress, 3, "raised to the 3 cumulative XP rank 1 needs");
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.confirmedFremiumRank, 1);
    assert.deepEqual(Logged.info.filter((line) => line.includes("[MasteryMon] SYNC")),
        [`[MasteryMon] SYNC user=${USER} track=MasteryTrack_Behemoth from=2 to=3`]);
});

test("the sync covers any mastery track, a weapon's too", async () => {
    Reset();
    Seed("MasteryTrack_Weapon_Sword", 1);
    const Result = await Progression.ConfirmPublicProgressionRank(USER, "MasteryTrack_Weapon_Sword", 1, SYNC_OPTIONS);
    assert.equal(Result.ok, true);
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Weapon_Sword"))?.progress, 2);
});

test("a gap of more than one objective's credit stays refused (insufficient_xp) and changes nothing", async () => {
    Reset();
    Seed("MasteryTrack_Behemoth", 1);
    const Result = await Progression.ConfirmPublicProgressionRank(USER, "MasteryTrack_Behemoth", 1, SYNC_OPTIONS);
    assert.deepEqual(Result, { ok: false, reason: "insufficient_xp" });
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.progress, 1);
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.confirmedFremiumRank, 0);
    assert.deepEqual(Logged.info.filter((line) => line.includes("[MasteryMon] SYNC")), []);
    assert.ok(Logged.warn.some((line) => line.includes("claims rank 1 (needs 3 cumulative XP) but only has 1 persisted")));
});

test("without the option (no host or gameserver caller) a mastery confirm one short is refused as before", async () => {
    Reset();
    Seed("MasteryTrack_Behemoth", 2);
    assert.deepEqual(await Progression.ConfirmPublicProgressionRank(USER, "MasteryTrack_Behemoth", 1),
        { ok: false, reason: "insufficient_xp" });
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.progress, 2);
});

test("a non-mastery track is never synced, even one point short", async () => {
    Reset();
    Seed("ExperienceTrack_Weapon_Sword", 349);
    assert.deepEqual(await Progression.ConfirmPublicProgressionRank(USER, "ExperienceTrack_Weapon_Sword", 2, SYNC_OPTIONS),
        { ok: false, reason: "insufficient_xp" });
    assert.equal(Tracks.get(Key(USER, "ExperienceTrack_Weapon_Sword"))?.progress, 349);
});

test("a confirm the stored progress already covers is unchanged: no sync line, no write", async () => {
    Reset();
    Seed("MasteryTrack_Behemoth", 3);
    const Result = await Progression.ConfirmPublicProgressionRank(USER, "MasteryTrack_Behemoth", 1, SYNC_OPTIONS);
    assert.equal(Result.ok, true);
    assert.equal(Tracks.get(Key(USER, "MasteryTrack_Behemoth"))?.progress, 3);
    assert.deepEqual(Logged.info.filter((line) => line.includes("[MasteryMon] SYNC")), []);
});

test("the mastery credit per objective is 1, the bound of the sync", () => {
    assert.equal(Progression.MASTERY_CREDIT_PER_OBJECTIVE, 1);
    assert.equal(Progression.IsMasteryProgressionTrack("MasteryTrack_Behemoth"), true);
    assert.equal(Progression.IsMasteryProgressionTrack("ExperienceTrack_Weapon_Sword"), false);
});
