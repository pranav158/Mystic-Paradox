/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

// The public build, and this test of it, run without the P2P module: its hostWrites hooks must refuse every write.
process.env.MYSTICPARADOX_P2P_MODULE = "off";

import type { HostWriteKind } from "../extensions/p2p";
import {
    ACTIVE_HUNTPASS_PROGRESSION_ID,
    APPROVED_XP_PROGRESSION_TRACK_IDS,
    CheckHostXpGrant,
    DescribeHostGrantRefusal,
    HOST_HUNT_PASS_XP_GRANT_CEILING,
    HOST_PLAYER_XP_GRANT_CEILING,
    HOST_PRESTIGE_GRANT_AMOUNT,
    HOST_WEAPON_XP_GRANT_CEILING,
    HostGrantLimitDenial,
    HostGrantLimitError,
    HostWriteHooks,
    HostXpGrantCeiling,
    HostLimitOnlyLogs,
    IsAuthoritativeServerFor,
    IsAuthorizedProgressionReporter,
    IsHostRuntimeAuth,
    MAX_PROGRESSION_GRANT_AMOUNT,
    RefuseUnauthorizedHostWrite,
    SavePlayerJourney,
    SummarizeObjectiveReport,
    TagHostWrite
} from "./progression";
import { BuildSlayersPathGraph, PlanHostPlayerJourney } from "./slayersPath";

// [2026-10-13 realms S3] The shared half of the player-hosted server's progression writes (routes/progression.ts): the
// hostWrites hook wrappers, the report summary used as a tag, and SavePlayerJourney's check hook.

const HOST = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "player-2", RuntimeRosterAccountIds: ["player-1", "player-2"] };

test("only a module-authenticated runtime counts as a host", () => {
    assert.equal(IsHostRuntimeAuth(HOST), true);
    assert.equal(IsHostRuntimeAuth({ IsGameserver: true }), false);
    assert.equal(IsHostRuntimeAuth({ userId: "player-1" }), false);
    assert.equal(IsHostRuntimeAuth({ IsPlayerHostRuntime: "true" }), false);
    assert.equal(IsHostRuntimeAuth(undefined), false);
    // The synchronous reporter check is unchanged: a host never passes it, the hostWrites hook decides instead.
    assert.equal(IsAuthorizedProgressionReporter(HOST, "player-2"), false);
});

test("without the P2P module every host write kind is refused and tagging does nothing", async () => {
    const Kinds: HostWriteKind[] = ["XP", "MASTERY", "OBJECTIVES", "SLAYERS_PATH", "REFORGE", "RANK_CONFIRM"];
    for (const Kind of Kinds) {
        const Denial = await RefuseUnauthorizedHostWrite({ AuthData: HOST }, Kind, "player-1");
        assert.equal(Denial?.status, 403, Kind);
        assert.equal((Denial?.body as any).code, "forbidden", Kind);
    }
    await TagHostWrite({ AuthData: HOST }, "XP", "player-1", { track: "ExperienceTrack_PlayerLevel" });   // resolves, throws nothing
});

test("the hook wrappers pass the request, kind and target through and hand back its answer", async () => {
    const Seen: any[] = [];
    const Allowing: HostWriteHooks = {
        authorize: async (Req, Kind, Target) => { Seen.push(["authorize", Req, Kind, Target]); return undefined; },
        record: async (Req, Write) => { Seen.push(["record", Req, Write]); }
    };
    const Refusing: HostWriteHooks = {
        authorize: async () => ({ status: 403, body: { code: "P2P_HOST_WRITE_DENIED" } }),
        record: async () => undefined
    };
    const Req = { marker: 1 };

    assert.equal(await RefuseUnauthorizedHostWrite(Req, "XP", "player-1", Allowing), undefined);
    await TagHostWrite(Req, "XP", "player-1", { track: "T", amount: 5, grantId: "g1" }, Allowing);
    assert.deepEqual(Seen, [
        ["authorize", Req, "XP", "player-1"],
        ["record", Req, { kind: "XP", targetUserId: "player-1", summary: { track: "T", amount: 5, grantId: "g1" } }]
    ]);
    assert.deepEqual(await RefuseUnauthorizedHostWrite(Req, "SLAYERS_PATH", "player-1", Refusing),
        { status: 403, body: { code: "P2P_HOST_WRITE_DENIED" } });
});

test("a tag that cannot be stored never fails the write it describes", async () => {
    const Throwing: HostWriteHooks = {
        authorize: async () => undefined,
        record: async () => { throw new Error("mongo down"); }
    };
    await TagHostWrite({}, "MASTERY", "player-1", {}, Throwing);
});

test("an authorize that throws is not swallowed: the route answers 500 and stores nothing", async () => {
    const Throwing: HostWriteHooks = {
        authorize: async () => { throw new Error("mongo down"); },
        record: async () => undefined
    };
    await assert.rejects(RefuseUnauthorizedHostWrite({}, "XP", "player-1", Throwing), /mongo down/);
});

test("the report summary keeps counts and the first 20 track increments, and tolerates garbage", () => {
    const Tracks = Array.from({ length: 25 }, (_, Index) => ({ progression_id: `MasteryTrack_${Index}`, progress: Index + 1 }));
    const Summary: any = SummarizeObjectiveReport({
        progress_tracks: Tracks,
        objectives: [
            { objective_id: "A", value: 1, completed_count: 1 },
            { objective_id: "B", value: 4, completed_count: 0 },
            { objective_id: "C", value: 9, completed_count: 3 }
        ]
    });
    assert.equal(Summary.progressTrackCount, 25);
    assert.equal(Summary.progressTracks.length, 20);
    assert.deepEqual(Summary.progressTracks[0], { id: "MasteryTrack_0", progress: 1 });
    assert.equal(Summary.objectiveCount, 3);
    assert.equal(Summary.completedObjectiveCount, 2);
    assert.ok(JSON.stringify(Summary).length < 2000);

    for (const Bad of [undefined, null, {}, { progress_tracks: "x", objectives: 4 }, []]) {
        const Empty: any = SummarizeObjectiveReport(Bad);
        assert.deepEqual([Empty.progressTrackCount, Empty.objectiveCount, Empty.completedObjectiveCount], [0, 0, 0]);
    }
});

// ---- SavePlayerJourney with the host check ---------------------------------------------------------------------------------

//   A (root) -> B, C      B -> D      C -> D      D -> E      X (root)
const Graph = BuildSlayersPathGraph({
    A: { childNodes: ["B", "C"] },
    B: { childNodes: ["D"] },
    C: { childNodes: ["D"] },
    D: { childNodes: ["E"] },
    X: {}
}, ["E"]);
const HostVet = (Stored: any, Merged: any) => PlanHostPlayerJourney(Stored, Merged, Graph).nodes;
const Entry = (Id: string, Status: number) => ({ node_id: Id, node_status: Status, objectives: [] });
const MapOf = (...Entries: [string, number][]) => Object.fromEntries(Entries.map(([Id, Status]) => [Id, Entry(Id, Status)]));

interface Row { userId: string; nodes: string; updateVersion: number; revision: number }

function FakeJourneys(Initial?: { nodes: any; version: number }, BeforeFirstUpdate?: (Current: Row) => Row) {
    let Current: Row | undefined = Initial === undefined ? undefined
        : { userId: "u", nodes: JSON.stringify(Initial.nodes), updateVersion: Initial.version, revision: 4 };
    let Updates = 0;
    return {
        repository: {
            findByUserId: async () => (Current === undefined ? undefined : { ...Current }),
            createIfAbsent: async (Record: Row) => {
                if (Current !== undefined) return false;
                Current = { ...Record };
                return true;
            },
            updateIfRevision: async (UserId: string, NodesJson: string, Version: number, Expected: number) => {
                Updates++;
                if (Updates === 1 && BeforeFirstUpdate !== undefined && Current !== undefined) Current = BeforeFirstUpdate(Current);   // a concurrent writer wins
                if (Current === undefined || Current.revision !== Expected) return false;
                Current = { userId: UserId, nodes: NodesJson, updateVersion: Version, revision: Expected + 1 };
                return true;
            }
        },
        stored: () => (Current === undefined ? undefined : JSON.parse(Current.nodes)),
        row: () => Current
    };
}

test("without a check a journey is stored as sent: the dedicated path is unchanged", async () => {
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 0]), version: 3 });
    const Saved = await SavePlayerJourney("u", MapOf(["A", 0], ["D", 2], ["E", 2]), 4, undefined, Journeys.repository);
    assert.deepEqual(Saved.newlyUnlocked.sort(), ["D", "E"]);                 // no parent unlocked, stored anyway
    assert.equal(Journeys.stored().D.node_status, 2);
    assert.equal(Saved.update_version, 4);
});

test("a first save with the check stores only the unlocks whose prerequisite holds", async () => {
    const Journeys = FakeJourneys();
    const Saved = await SavePlayerJourney("u", MapOf(["X", 2], ["D", 2], ["B", 2]), 1, HostVet, Journeys.repository);
    assert.deepEqual(Saved.newlyUnlocked, ["X"]);
    assert.deepEqual(Object.fromEntries(Object.entries(Saved.nodes).map(([Id, Node]: [string, any]) => [Id, Node.node_status])), { X: 2, D: 0, B: 0 });
    assert.deepEqual(Journeys.stored(), Saved.nodes);
});

test("a later save with the check accepts a purchase and its children and refuses the rest", async () => {
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 2], ["B", 0], ["C", 0], ["D", 0], ["E", 0], ["X", 0]), version: 7 });
    const Saved = await SavePlayerJourney("u", MapOf(["B", 2], ["D", 2], ["E", 2], ["X", 2]), 8, HostVet, Journeys.repository);
    assert.deepEqual([...Saved.newlyUnlocked].sort(), ["B", "D", "E", "X"]);

    const Refused = FakeJourneys({ nodes: MapOf(["A", 0], ["B", 0], ["D", 0], ["E", 0]), version: 7 });
    const Result = await SavePlayerJourney("u", MapOf(["B", 2], ["D", 2], ["E", 2]), 8, HostVet, Refused.repository);
    assert.deepEqual(Result.newlyUnlocked, []);
    assert.equal(Refused.stored().B.node_status, 0);
    assert.equal(Result.update_version, 8);                                   // the save itself still advances the version
});

test("a host cannot lock a node again through a newer save", async () => {
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 2]), version: 7 });
    await SavePlayerJourney("u", MapOf(["A", 0]), 8, HostVet, Journeys.repository);
    assert.equal(Journeys.stored().A.node_status, 2);

    const Dedicated = FakeJourneys({ nodes: MapOf(["A", 2]), version: 7 });
    await SavePlayerJourney("u", MapOf(["A", 0]), 8, undefined, Dedicated.repository);
    assert.equal(Dedicated.stored().A.node_status, 0);                        // trusted, as before
});

test("an older version cannot change a stored node, and a node the map lacked still goes through the check", async () => {
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 0], ["B", 0]), version: 9 });
    const Saved = await SavePlayerJourney("u", MapOf(["A", 2], ["B", 2], ["X", 2], ["E", 2]), 9, HostVet, Journeys.repository);
    assert.deepEqual(Saved.newlyUnlocked, ["X"]);                             // A and B: stored wins; E: no parent; X: root
    assert.equal(Journeys.stored().A.node_status, 0);
    assert.equal(Saved.update_version, 9);
});

test("the check runs again on a compare-and-swap retry, against the map the concurrent writer left", async () => {
    // Attempt 1 sees A locked and would strip B. A concurrent save unlocks A first and wins the swap; attempt 2 sees A unlocked.
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 0], ["B", 0]), version: 1 },
        (Current) => ({ ...Current, nodes: JSON.stringify(MapOf(["A", 2], ["B", 0])), revision: Current.revision + 1 }));
    let Vets = 0;
    const Saved = await SavePlayerJourney("u", MapOf(["B", 2]), 2, (Stored, Merged) => { Vets++; return HostVet(Stored, Merged); }, Journeys.repository);
    assert.equal(Vets, 2);
    assert.deepEqual(Saved.newlyUnlocked, ["B"]);
    assert.equal(Journeys.stored().A.node_status, 2);
    assert.equal(Journeys.stored().B.node_status, 2);

    // The same race without the check stores the unlock as sent (the dedicated path), so the check is what holds it back.
    const Unchecked = FakeJourneys({ nodes: MapOf(["A", 0], ["B", 0]), version: 1 });
    await SavePlayerJourney("u", MapOf(["B", 2]), 2, undefined, Unchecked.repository);
    assert.equal(Unchecked.stored().B.node_status, 2);
});

test("a refused unlock is refused on every retry: the stored map never holds it", async () => {
    // A concurrent writer changes only the version/revision; nothing unlocks A, so B stays locked after the retry too.
    const Journeys = FakeJourneys({ nodes: MapOf(["A", 0], ["B", 0]), version: 1 },
        (Current) => ({ ...Current, revision: Current.revision + 1 }));
    const Saved = await SavePlayerJourney("u", MapOf(["B", 2]), 2, HostVet, Journeys.repository);
    assert.deepEqual(Saved.newlyUnlocked, []);
    assert.equal(Journeys.stored().B.node_status, 0);
});

// ---- [2026-10-13 realms S3 limits] what one host XP grant may add --------------------------------------------------------------

test("every approved XP track has a host decision, and the ceilings are the researched ones", () => {
    for (const Track of APPROVED_XP_PROGRESSION_TRACK_IDS) assert.notEqual(HostXpGrantCeiling(Track), undefined, `${Track} has no host ceiling decision`);
    assert.equal(HostXpGrantCeiling("ExperienceTrack_PlayerLevel"), 1000);
    assert.equal(HostXpGrantCeiling("ExperienceTrack_Weapon_Sword"), 1000);
    assert.equal(HostXpGrantCeiling("ExperienceTrack_Weapon_ChainBlades"), 1000);
    assert.equal(HostXpGrantCeiling(ACTIVE_HUNTPASS_PROGRESSION_ID), 200);
    assert.equal(HostXpGrantCeiling("PrestigeTrack_Weapon_Axe"), 1);
    assert.equal(HostXpGrantCeiling("MasteryTrack_PlayerLevel"), 0);
    assert.equal(HostXpGrantCeiling("MasteryTrack_Weapon_Hammer"), 0);
    assert.equal(HostXpGrantCeiling("Linked_Slayer_Slot_1"), undefined);           // no opinion: the general bound still applies
    assert.deepEqual([HOST_WEAPON_XP_GRANT_CEILING, HOST_PLAYER_XP_GRANT_CEILING, HOST_HUNT_PASS_XP_GRANT_CEILING, HOST_PRESTIGE_GRANT_AMOUNT], [1000, 1000, 200, 1]);
});

test("a host grant is refused only above the ceiling: every real value is accepted at the boundary and below", () => {
    // Real values (13 Oct research): weapon ~98 (largest 225), player level ~98 (225), Hunt Pass ~9 (15 applied, 25 requested).
    for (const [Track, Amounts] of [
        ["ExperienceTrack_Weapon_Sword", [1, 98, 225, 1000]],
        ["ExperienceTrack_PlayerLevel", [1, 98, 225, 1000]],
        [ACTIVE_HUNTPASS_PROGRESSION_ID, [1, 5, 9, 15, 25, 200]],
        ["PrestigeTrack_Weapon_Strikers", [1]],
    ] as [string, number[]][]) {
        for (const Amount of Amounts) assert.equal(CheckHostXpGrant(Track, Amount), undefined, `${Track} ${Amount}`);
    }
    assert.deepEqual(CheckHostXpGrant("ExperienceTrack_Weapon_Axe", 1001), { reason: "amount_over_ceiling", progressionId: "ExperienceTrack_Weapon_Axe", amount: 1001, limit: 1000 });
    assert.deepEqual(CheckHostXpGrant("ExperienceTrack_PlayerLevel", 26005), { reason: "amount_over_ceiling", progressionId: "ExperienceTrack_PlayerLevel", amount: 26005, limit: 1000 });
    assert.deepEqual(CheckHostXpGrant(ACTIVE_HUNTPASS_PROGRESSION_ID, 201), { reason: "amount_over_ceiling", progressionId: ACTIVE_HUNTPASS_PROGRESSION_ID, amount: 201, limit: 200 });
    assert.equal(CheckHostXpGrant("ExperienceTrack_Weapon_Axe", MAX_PROGRESSION_GRANT_AMOUNT)?.reason, "amount_over_ceiling");
});

test("a host's prestige grant is exactly +1, and a host never grants a mastery track", () => {
    for (const Amount of [0, 2, 3, 1000]) {
        assert.deepEqual(CheckHostXpGrant("PrestigeTrack_Weapon_Hammer", Amount), { reason: "amount_not_one", progressionId: "PrestigeTrack_Weapon_Hammer", amount: Amount, limit: 1 });
    }
    for (const Track of ["MasteryTrack_PlayerLevel", "MasteryTrack_Behemoth", "MasteryTrack_Weapon_Axe"]) {
        for (const Amount of [1, 5, 100000]) assert.deepEqual(CheckHostXpGrant(Track, Amount), { reason: "track_not_writable", progressionId: Track, amount: Amount, limit: 0 });
    }
    assert.equal(CheckHostXpGrant("Linked_Slayer_Slot_1", 5000), undefined);
});

test("a refused host grant is described without the account, sanitised, and answered with a 403 that is not the module's denial", () => {
    const Refusal = CheckHostXpGrant("ExperienceTrack_Weapon_Axe", 5000)!;
    assert.equal(DescribeHostGrantRefusal(Refusal), "reason=amount_over_ceiling track=ExperienceTrack_Weapon_Axe amount=5000 limit=1000");
    assert.equal(DescribeHostGrantRefusal({ reason: "track_full", progressionId: "ExperienceTrack_PlayerLevel", amount: 98, limit: 141020, stored: 141500 }),
        "reason=track_full track=ExperienceTrack_PlayerLevel amount=98 limit=141020 stored=141500");
    assert.ok(!DescribeHostGrantRefusal({ ...Refusal, progressionId: "Bad\nTrack with space" }).includes("\n"));
    const Denial = HostGrantLimitDenial();
    assert.equal(Denial.status, 403);
    assert.equal((Denial.body as any).code, "HOST_WRITE_LIMIT");
    assert.equal((Denial.body as any).payload, null);
    assert.match(new HostGrantLimitError(Refusal).message, /amount_over_ceiling/);
    assert.equal(new HostGrantLimitError(Refusal).refusal, Refusal);
});

// ---- [2026-10-17] dedicated parity ----------------------------------------------------------------------------------------------

test("dedicated parity: the authoritative server for a player is the gameserver key, or a realm server the module accepts with parity", async () => {
    const Calls: { kind: HostWriteKind; target: string; parity: boolean | undefined }[] = [];
    const Hooks = {
        authorize: async (_req: unknown, kind: HostWriteKind, target: string, options?: { parity?: boolean }) => {
            Calls.push({ kind, target, parity: options?.parity });
            return target === "member" ? undefined : { status: 403, body: {} };
        },
        record: async () => undefined
    } as unknown as HostWriteHooks;
    const Host = { AuthData: { IsPlayerHostRuntime: true, IsGameserver: false } };
    assert.equal(await IsAuthoritativeServerFor({ AuthData: { IsGameserver: true } }, "anyone", "REFORGE", Hooks), true);
    assert.equal(await IsAuthoritativeServerFor({ AuthData: { userId: "member" } }, "member", "REFORGE", Hooks), false, "a player's own token is no server");
    assert.equal(await IsAuthoritativeServerFor(Host, "member", "REFORGE", Hooks), true, "a realm server, for a player of its session");
    assert.equal(await IsAuthoritativeServerFor(Host, "stranger", "SLAYERS_PATH", Hooks), false, "never for anyone else");
    assert.deepEqual(Calls, [{ kind: "REFORGE", target: "member", parity: true }, { kind: "SLAYERS_PATH", target: "stranger", parity: true }]);
    // Without the module (this file runs with it off) a realm runtime is never authoritative.
    assert.equal(await IsAuthoritativeServerFor(Host, "member", "REFORGE"), false);
});

test("dedicated parity: only the ceiling and the full track can only-log, and only when the host policy does not refuse", () => {
    const Observe = { refuses: () => false, noteWouldRefuse: () => undefined };
    const Enforce = { refuses: () => true, noteWouldRefuse: () => undefined };
    const Over = CheckHostXpGrant("ExperienceTrack_Weapon_Axe", 1001)!;
    const Full = { reason: "track_full" as const, progressionId: "ExperienceTrack_PlayerLevel", amount: 98, limit: 141020, stored: 141020 };
    assert.equal(HostLimitOnlyLogs(Over, Observe), true);
    assert.equal(HostLimitOnlyLogs(Full, Observe), true);
    assert.equal(HostLimitOnlyLogs(Over, Enforce), false);
    assert.equal(HostLimitOnlyLogs(Full, Enforce), false);
    assert.equal(HostLimitOnlyLogs(CheckHostXpGrant("PrestigeTrack_Weapon_Axe", 2)!, Observe), false, "a prestige grant that is not +1 always refuses");
    assert.equal(HostLimitOnlyLogs(CheckHostXpGrant("MasteryTrack_PlayerLevel", 1)!, Observe), false, "a mastery grant always refuses");
    // Without the module the defaults are strict.
    assert.equal(HostLimitOnlyLogs(Over), false);
});
