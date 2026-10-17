/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../logger";
import { CheckHostTrackTotal, GrantProgressionXp, HostGrantLimitError, HostTrackTotalCap, TrackCapXp } from "./progression";

// [2026-10-13 realms S3] A player-hosted server's XP grant runs the dedicated server's grant (same ledger, same grant id
// rules); only the log line names the sender. Needs the real progression config (track curves).

function FakeUnitOfWork(InitialProgress = 0) {
    const Ledger = new Map<string, any>();
    let Progress = InitialProgress;
    let Increments = 0;
    const Repos: any = {
        progressionGrants: {
            findByGrantId: async (GrantId: string) => Ledger.get(GrantId),
            insertApplied: async (Record: any) => { Ledger.set(Record.grantId, Record); },
        },
        progressionTracks: {
            get: async () => (Progress === 0 ? undefined : { progress: Progress }),
            increment: async (_UserId: string, _Track: string, Amount: number) => {
                Increments++;
                Progress += Amount;
                return { userId: "u", progressionId: "ExperienceTrack_PlayerLevel", progress: Progress, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updatedAt: "2026-10-13T00:00:00.000Z" };
            },
        },
    };
    return { UnitOfWork: { withTransaction: async (Action: any) => Action(Repos, {}) } as any, increments: () => Increments, ledger: () => Ledger.size, progress: () => Progress };
}

async function CaptureInfo(action: () => Promise<unknown>): Promise<string[]> {
    const Lines: string[] = [];
    const Original = logger.info;
    (logger as any).info = (Message: unknown) => { Lines.push(String(Message)); };
    try {
        await action();
    } finally {
        (logger as any).info = Original;
    }
    return Lines;
}

test("a host's XP grant is logged as a host's, a dedicated server's as before", async () => {
    const Host = FakeUnitOfWork();
    const HostLines = await CaptureInfo(() => GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "host-grant-1", Host.UnitOfWork, undefined, "host"));
    assert.ok(HostLines.some((Line) => Line.includes("grant=host-grant-1") && Line.includes("source=host applied=1")), HostLines.join("\n"));

    const Dedicated = FakeUnitOfWork();
    const DedicatedLines = await CaptureInfo(() => GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "gs-grant-1", Dedicated.UnitOfWork));
    assert.ok(DedicatedLines.some((Line) => Line.includes("grant=gs-grant-1") && Line.includes("source=gameserver applied=1")), DedicatedLines.join("\n"));
});

test("a host's retried grant id replays and never adds XP twice", async () => {
    const Fake = FakeUnitOfWork();
    const First = await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "host-grant-2", Fake.UnitOfWork, undefined, "host");
    const Retry = await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "host-grant-2", Fake.UnitOfWork, undefined, "host");
    assert.equal(First.replayed, false);
    assert.equal(Retry.replayed, true);                  // the route tags only a grant that was not a replay
    assert.equal(Fake.increments(), 1);
});

test("a host cannot reuse a grant id for a different request, nor skip the id, nor exceed the grant bounds", async () => {
    const Fake = FakeUnitOfWork();
    await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "host-grant-3", Fake.UnitOfWork, undefined, "host");
    await assert.rejects(GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 126, "host-grant-3", Fake.UnitOfWork, undefined, "host"),
        /already used with a different request/);
    await assert.rejects(GrantProgressionXp("player-2", "ExperienceTrack_PlayerLevel", 125, "host-grant-3", Fake.UnitOfWork, undefined, "host"),
        /already used with a different request/);
    await assert.rejects(GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 125, "not a valid id", Fake.UnitOfWork, undefined, "host"),
        /Invalid authoritative progression grant/);
    await assert.rejects(GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 100001, "host-grant-4", Fake.UnitOfWork, undefined, "host"),
        /Invalid authoritative progression grant/);
    assert.equal(Fake.increments(), 1);
});

// ---- [2026-10-13 realms S3 limits] a host's grant meets the ceilings and the full-track rule inside GrantProgressionXp -------

const REFUSED = (Reason: string) => (Error: unknown) => Error instanceof HostGrantLimitError && Error.refusal.reason === Reason;

// [2026-10-17] Dedicated parity: in the host policy's observe mode (the default) the ceilings and the full track only log
// (HostLimitOnlyLogs); the enforce-mode refusals are pinned below with MYSTICPARADOX_HOST_POLICY=enforce.
async function WithHostPolicy(mode: "observe" | "enforce", body: () => Promise<void>): Promise<void> {
    const Previous = process.env.MYSTICPARADOX_HOST_POLICY;
    process.env.MYSTICPARADOX_HOST_POLICY = mode;
    try {
        await body();
    } finally {
        if (Previous === undefined) delete process.env.MYSTICPARADOX_HOST_POLICY;
        else process.env.MYSTICPARADOX_HOST_POLICY = Previous;
    }
}

async function CaptureWarn(action: () => Promise<unknown>): Promise<string[]> {
    const Lines: string[] = [];
    const Original = logger.warn;
    (logger as any).warn = (Message: unknown) => { Lines.push(String(Message)); };
    try {
        await action();
    } finally {
        (logger as any).warn = Original;
    }
    return Lines;
}

test("observe: a host's over-ceiling grant and a grant to a full player level are applied and logged; the reforge rules still refuse", async () => {
    await WithHostPolicy("observe", async () => {
        for (const [Track, Amount, Initial] of [
            ["ExperienceTrack_PlayerLevel", 1001, 0],
            ["season43", 201, 0],
            ["ExperienceTrack_PlayerLevel", 98, 141_020],   // player level full
        ] as [string, number, number][]) {
            const Host = FakeUnitOfWork(Initial);
            let Result: any;
            const Lines = await CaptureWarn(async () => {
                Result = await GrantProgressionXp("player-1", Track, Amount, `host-observe-${Track}-${Initial}`, Host.UnitOfWork, undefined, "host");
            });
            assert.equal(Result.replayed, false, `${Track} ${Amount}`);
            assert.equal(Host.progress(), Initial + Amount, "applied as a dedicated server's grant");
            assert.ok(Lines.some((Line) => Line.startsWith("[HostPolicyObserve] would refuse xp")), Lines.join("\n"));
        }
        await assert.rejects(GrantProgressionXp("player-1", "PrestigeTrack_Weapon_Axe", 2, "host-observe-prestige", FakeUnitOfWork().UnitOfWork, undefined, "host"),
            REFUSED("amount_not_one"));
        await assert.rejects(GrantProgressionXp("player-1", "MasteryTrack_PlayerLevel", 1, "host-observe-mastery", FakeUnitOfWork().UnitOfWork, undefined, "host"),
            REFUSED("track_not_writable"));
    });
});

test("enforce: a host's grant above its ceiling is refused before anything is stored, a dedicated server's identical grant is not", () => WithHostPolicy("enforce", async () => {
    for (const [Track, Amount, Reason] of [
        ["ExperienceTrack_PlayerLevel", 1001, "amount_over_ceiling"],
        ["ExperienceTrack_Weapon_Sword", 26005, "amount_over_ceiling"],
        ["season43", 201, "amount_over_ceiling"],
        ["PrestigeTrack_Weapon_Axe", 2, "amount_not_one"],
        ["MasteryTrack_PlayerLevel", 1, "track_not_writable"],
    ] as [string, number, string][]) {
        const Host = FakeUnitOfWork();
        await assert.rejects(GrantProgressionXp("player-1", Track, Amount, `host-limit-${Track}`, Host.UnitOfWork, undefined, "host"), REFUSED(Reason), `${Track} ${Amount}`);
        assert.deepEqual([Host.increments(), Host.ledger(), Host.progress()], [0, 0, 0]);

        const Dedicated = FakeUnitOfWork();
        const Result = await GrantProgressionXp("player-1", Track, Amount, `gs-limit-${Track}`, Dedicated.UnitOfWork);
        assert.equal(Result.replayed, false, `${Track} ${Amount} on a dedicated server`);
        assert.equal(Dedicated.increments(), 1);
    }
}));

test("a host's grants at the ceiling are accepted, and a retry of an accepted one still replays", async () => {
    for (const [Track, Amount] of [["ExperienceTrack_PlayerLevel", 1000], ["ExperienceTrack_Weapon_Sword", 225], ["season43", 200], ["PrestigeTrack_Weapon_Axe", 1]] as [string, number][]) {
        const Fake = FakeUnitOfWork();
        const First = await GrantProgressionXp("player-1", Track, Amount, `host-ok-${Track}`, Fake.UnitOfWork, undefined, "host");
        const Retry = await GrantProgressionXp("player-1", Track, Amount, `host-ok-${Track}`, Fake.UnitOfWork, undefined, "host");
        assert.deepEqual([First.replayed, Retry.replayed, Fake.increments()], [false, true, 1], Track);
    }
});

test("the player level total is the config's 141,020 XP and no other track has a total cap", () => {
    assert.equal(HostTrackTotalCap("ExperienceTrack_PlayerLevel"), 141020);
    assert.equal(HostTrackTotalCap("ExperienceTrack_PlayerLevel"), TrackCapXp("ExperienceTrack_PlayerLevel"));
    for (const Track of ["ExperienceTrack_Weapon_Axe", "PrestigeTrack_Weapon_Axe", "season43", "MasteryTrack_PlayerLevel", "ExperienceTrack_Nothing"]) {
        assert.equal(HostTrackTotalCap(Track), undefined, Track);
        assert.equal(CheckHostTrackTotal(Track, 9_999_999, 100), undefined, Track);
    }
});

test("a host may not add to a full player level track, but the grant that crosses the total is accepted", () => {
    assert.equal(CheckHostTrackTotal("ExperienceTrack_PlayerLevel", 0, 98), undefined);
    assert.equal(CheckHostTrackTotal("ExperienceTrack_PlayerLevel", 140_000, 98), undefined);
    assert.equal(CheckHostTrackTotal("ExperienceTrack_PlayerLevel", 141_019, 98), undefined);                 // crosses: not refused, or a player 1 XP short could never finish
    assert.deepEqual(CheckHostTrackTotal("ExperienceTrack_PlayerLevel", 141_020, 98),
        { reason: "track_full", progressionId: "ExperienceTrack_PlayerLevel", amount: 98, limit: 141020, stored: 141020 });
    assert.equal(CheckHostTrackTotal("ExperienceTrack_PlayerLevel", 150_000, 1)?.reason, "track_full");
});

test("enforce: GrantProgressionXp refuses a host on a full player level track inside the transaction, stores nothing, and still replays the grant that filled it", () => WithHostPolicy("enforce", async () => {
    const Full = FakeUnitOfWork(141_020);
    await assert.rejects(GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 98, "host-full-1", Full.UnitOfWork, undefined, "host"), REFUSED("track_full"));
    assert.deepEqual([Full.increments(), Full.ledger(), Full.progress()], [0, 0, 141_020]);

    // A dedicated server's grant on the same track is unchanged by the rule.
    const Dedicated = FakeUnitOfWork(141_020);
    assert.equal((await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 98, "gs-full-1", Dedicated.UnitOfWork)).replayed, false);
    assert.equal(Dedicated.progress(), 141_118);

    // The grant that crosses the total is accepted; its retry replays (200 upstream) instead of being refused as "full".
    const Near = FakeUnitOfWork(141_000);
    const Crossing = await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 98, "host-cross-1", Near.UnitOfWork, undefined, "host");
    assert.equal(Crossing.replayed, false);
    assert.equal(Near.progress(), 141_098);
    const Retry = await GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 98, "host-cross-1", Near.UnitOfWork, undefined, "host");
    assert.equal(Retry.replayed, true);
    assert.equal(Near.progress(), 141_098);
    await assert.rejects(GrantProgressionXp("player-1", "ExperienceTrack_PlayerLevel", 98, "host-cross-2", Near.UnitOfWork, undefined, "host"), REFUSED("track_full"));
    assert.equal(Near.progress(), 141_098);
}));

test("a weapon track past its level 20 total is not capped for a host (prestige levels and banked XP keep earning)", async () => {
    const Past = FakeUnitOfWork(60_000);
    const Result = await GrantProgressionXp("player-1", "ExperienceTrack_Weapon_Sword", 98, "host-weapon-past", Past.UnitOfWork, undefined, "host");
    assert.equal(Result.replayed, false);
    assert.equal(Past.progress(), 60_098);
});
