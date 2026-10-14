/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { ExtensionHttpResponse, HostWriteKind, HostWriteRecordInput } from "../extensions/p2p";
import type { BountyStateRecord, CooldownStateRecord, EscalationProgressRecord } from "../persistence/mapping/domainTypes";
import { ParseEscalationTuning } from "../escalationProgress";
import type { EscalationTuningLoad } from "../escalationProgress";
import { ActiveSeasonWindow, ActiveSeasonWindowMs } from "../seasonWindow";

/*
 * [2026-10-13 realms S3] The host paths of POST /bounty/:userId, POST /escalation/:season/:userId and PUT
 * /cooldown/batch/:userId, through the real systemRouter. A .gamedata test because routes/system.ts reads
 * game-data/progression_config.json when it loads. Three seams are replaced before the router is first required, so no
 * MongoDB is needed: the auth middleware (x-test-role picks the caller), the repositories (in memory) and the P2P hooks
 * (a recorder; what the real hooks decide is tested next to them).
 */

const Bounties = new Map<string, BountyStateRecord>();
const Cooldowns = new Map<string, CooldownStateRecord>();
const Escalations = new Map<string, EscalationProgressRecord>();

function Save<T extends { updateVersion: number }>(rows: Map<string, T>, key: string, record: T, expected: number | undefined): T | undefined {
    const Current = rows.get(key);
    if (Current === undefined ? expected !== undefined : Current.updateVersion !== expected) return undefined;
    rows.set(key, record);
    return record;
}

const Repositories = {
    bountyStates: {
        get: async (userId: string) => Bounties.get(userId),
        saveIfVersion: async (record: BountyStateRecord, expected: number | undefined) => Save(Bounties, record.userId, record, expected),
    },
    cooldownStates: {
        get: async (userId: string) => Cooldowns.get(userId),
        saveIfVersion: async (record: CooldownStateRecord, expected: number | undefined) => Save(Cooldowns, record.userId, record, expected),
    },
    escalationProgress: {
        get: async (userId: string, seasonId: string) => Escalations.get(`${userId}|${seasonId}`),
        saveIfVersion: async (record: EscalationProgressRecord, expected: number | undefined) => Save(Escalations, `${record.userId}|${record.seasonId}`, record, expected),
    },
};

const Hooks = {
    authorized: [] as { kind: HostWriteKind; target: string }[],
    records: [] as HostWriteRecordInput[],
    denial: undefined as ExtensionHttpResponse | undefined,
};

// Replaces named exports of a module that is safe to load for real (its other exports stay).
function Replace(modulePath: string, overrides: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    const Replacement = Object.create(require(modulePath));
    for (const [Name, Value] of Object.entries(overrides)) Object.defineProperty(Replacement, Name, { value: Value, enumerable: true });
    require.cache[Resolved]!.exports = Replacement;
}

// Stands in for a module that must not be loaded at all (the real auth middleware reads its JWT secret at import).
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

// The real logger starts a pino-pretty worker thread; with this file's short life that thread kept the process alive in
// about a third of the runs, so the log calls are swallowed here.
const Quiet = () => undefined;
Fake("../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });
Replace("../persistence", { GetRepositories: () => Repositories });
Replace("../extensions/p2p", {
    GetP2PExtension: () => ({
        hostWrites: {
            authorize: async (_req: unknown, kind: HostWriteKind, target: string) => { Hooks.authorized.push({ kind, target }); return Hooks.denial; },
            record: async (_req: unknown, write: HostWriteRecordInput) => { Hooks.records.push(write); },
        },
    }),
});
// [2026-10-13 realms S3 limits] The escalation tuning table is a fourth seam, so these tests do not depend on the real
// game-data/escalation_tuning.json: `EscalationLimits.load` is what GetEscalationTuning() answers. It starts as a small synthetic
// table of ESC_SEASON_6 (the escalation tests below set it to "missing" to run the never-lower fallback).
const EscalationTable = ParseEscalationTuning({
    seasons: {
        ESC_SEASON_6: {
            maxLevel: 25,
            xpToReachLevel: Array.from({ length: 25 }, (_, Index) => 100 * (Index + 1)),
            unlocks: { Reward_A: { level: 5 } },
            talents: {
                Talent_A: { pointsToUnlock: 0, pointCosts: [1, 1, 1, 1] },
                Talent_B: { pointsToUnlock: 0, pointCosts: [1] },
                Talent_C: { pointsToUnlock: 4, pointCosts: [1] },
            },
        },
    },
}).tuning;
assert.ok(EscalationTable !== undefined, "the synthetic escalation table must parse");
const WITH_TABLE: EscalationTuningLoad = { tuning: EscalationTable, status: "loaded" };
const WITHOUT_TABLE: EscalationTuningLoad = { tuning: undefined, status: "missing" };
const EscalationLimits = { load: WITH_TABLE };
Replace("../escalationProgress", { GetEscalationTuning: () => EscalationLimits.load });
Fake("../middleware/HasParadoxBackendAuth", {
    HasParadoxBackendAuth: (req: any, res: any, next: () => void) => {
        const Role = req.headers["x-test-role"];
        if (Role === "gs") req.AuthData = { IsGameserver: true };
        else if (Role === "player") req.AuthData = { userId: "player-1" };
        else if (Role === "host") req.AuthData = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "host-1", RuntimeRosterAccountIds: ["host-1", "player-1"] };
        else { res.status(401).send(); return; }
        next();
    },
});

let Listening: Server;
let Port = 0;

before(async () => {
    const { systemRouter } = require("./system");
    const App = express();
    App.use(express.json());
    App.use(systemRouter);
    Listening = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { Listening.once("listening", () => resolve()); Listening.once("error", reject); });
    Port = (Listening.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Listening.close(() => resolve()));
});

function Reset(): void {
    Bounties.clear();
    Cooldowns.clear();
    Escalations.clear();
    Hooks.authorized.length = 0;
    Hooks.records.length = 0;
    Hooks.denial = undefined;
}

function Send(method: string, path: string, role: string | undefined, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Headers: Record<string, string> = {};
        if (role !== undefined) Headers["x-test-role"] = role;
        const Payload = body === undefined ? undefined : JSON.stringify(body);
        if (Payload !== undefined) Headers["content-type"] = "application/json";
        const Req = http.request({ hostname: "127.0.0.1", port: Port, path, method, headers: Headers }, (res) => {
            let Text = "";
            res.setEncoding("utf8");
            res.on("data", (Chunk) => { Text += Chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: Text.length > 0 ? JSON.parse(Text) : undefined }));
        });
        Req.on("error", reject);
        if (Payload !== undefined) Req.write(Payload);
        Req.end();
    });
}

const DENIAL: ExtensionHttpResponse = { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };
const AXE = "43_5_5_Challenge_Season_BigHit_Axe-season43-4";
// [2026-10-13 realms S3 limits] A host's weekly challenge has to carry its schedule stamp (the start of the current pass window +
// 7 days x (week-1); AXE is week 5), and the route reads the real clock, so the stamp is computed from it here too.
const WEEK = new Date(ActiveSeasonWindowMs(Date.now()).startMs + 4 * 7 * 24 * 60 * 60 * 1000).toISOString();
const Draft = () => ({ current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 });
const Challenge = (id: string, progress: number, claimed: boolean, stamp: string = WEEK) => ({
    bounty_id: id, premium_bounty: false, slot_index: 0, objectives: [{ objective_id: "Hit", progress }],
    drafted_timestamp: stamp, update_version: 0, claimed,
});

// ---- bounty --------------------------------------------------------------------------------------------------------

test("a host bounty save is authorized for BOUNTY and the target, stored like a gameserver save, and tagged with what was claimed", async () => {
    Reset();
    const Result = await Send("POST", "/bounty/player-1", "host", { bounties: [Challenge(AXE, 1, true)], draft_data_weekly: Draft() });
    assert.equal(Result.status, 200);
    assert.equal(Result.json.payload.bounties.length, 1);
    assert.equal(Result.json.payload.bounties[0].claimed, true);
    assert.deepEqual(Hooks.authorized, [{ kind: "BOUNTY", target: "player-1" }]);
    assert.equal(Hooks.records.length, 1);
    assert.equal(Hooks.records[0].kind, "BOUNTY");
    assert.equal(Hooks.records[0].targetUserId, "player-1");
    assert.deepEqual(Hooks.records[0].summary, {
        mode: "replace", group: "weekly", incoming: 1, removed: 0, newlyClaimedCount: 1, newlyClaimed: [AXE],
        keptClaimedWeekly: 0, ignoredWeekly: 0, clampedProgress: 0, version: 1,
    });
    assert.equal(Bounties.get("player-1")?.bounties[0].bounty.claimed, true);
    assert.ok(Bounties.get("player-1")?.bounties[0].claimedAt, "the claim is stamped, so it can fund a Cache Coins grant");

    // A later progress-only save is not a new claim, and the monotonic merge still applies to a host.
    const Again = await Send("POST", "/bounty/player-1", "host", { bounties: [Challenge(AXE, 0, false)] });
    assert.equal(Again.status, 200);
    assert.equal(Again.json.payload.bounties[0].claimed, true);
    assert.equal(Again.json.payload.bounties[0].objectives[0].progress, 1);
    assert.deepEqual(Hooks.records[1].summary, {
        mode: "upsert", incoming: 1, removed: 0, newlyClaimedCount: 0, newlyClaimed: [],
        keptClaimedWeekly: 0, ignoredWeekly: 0, clampedProgress: 0, version: 2,
    });
});

// [2026-10-13 realms S3 limits] The hostile saves of the limits, through the route: a host's claimed weekly instance cannot be
// re-stamped, an invented id is not stored, progress is clamped; the answer is still a 200 with the merged state, and the tag
// counts what was kept or ignored. A dedicated server's same saves are unchanged.
test("a host's re-stamp of a claimed weekly instance, an invented weekly id and huge progress are held to the schedule, with a 200 and a tag", async () => {
    Reset();
    await Send("POST", "/bounty/player-1", "host", { bounties: [Challenge(AXE, 1, true)], draft_data_weekly: Draft() });
    Hooks.records.length = 0;

    const NextWindowStamp = new Date(ActiveSeasonWindowMs(Date.now()).endMs + 4 * 7 * 24 * 60 * 60 * 1000).toISOString();
    const Hostile = await Send("POST", "/bounty/player-1", "host", {
        bounties: [
            Challenge(AXE, 0, false, NextWindowStamp),                                                       // re-stamp of the claimed instance
            Challenge("Challenge_Season_Invented", 1, true),                                                 // an id that is no weekly instance
            Challenge("43_2_1_Challenge_Season_Fine-season43-1", 1e12, false, new Date(ActiveSeasonWindowMs(Date.now()).startMs + 7 * 24 * 60 * 60 * 1000).toISOString()),
        ],
    });
    assert.equal(Hostile.status, 200);
    const Payload = Hostile.json.payload.bounties;
    assert.deepEqual(Payload.map((Entry: any) => Entry.bounty_id).sort(), [AXE, "43_2_1_Challenge_Season_Fine-season43-1"].sort());
    const Axe = Payload.find((Entry: any) => Entry.bounty_id === AXE);
    assert.equal(Axe.claimed, true);
    assert.equal(Axe.drafted_timestamp, WEEK);
    assert.equal(Payload.find((Entry: any) => Entry.bounty_id !== AXE).objectives[0].progress, 100000000);
    const Summary = Hooks.records[0].summary as any;
    assert.equal(Summary.keptClaimedWeekly, 1);
    assert.equal(Summary.ignoredWeekly, 1);
    assert.equal(Summary.clampedProgress, 1);
    assert.deepEqual(Summary.keptClaimedWeeklyIds, [AXE]);
    assert.deepEqual(Summary.ignoredWeeklyIds, ["Challenge_Season_Invented"]);
    assert.equal(Bounties.get("player-1")?.bounties.length, 2);

    // A dedicated server saving the same bodies is judged as before: the re-stamp replaces the claimed instance, the invented id is stored.
    Reset();
    await Send("POST", "/bounty/player-1", "gs", { bounties: [Challenge(AXE, 1, true)], draft_data_weekly: Draft() });
    const Gs = await Send("POST", "/bounty/player-1", "gs", { bounties: [Challenge(AXE, 0, false, NextWindowStamp), Challenge("Challenge_Season_Invented", 1, true)] });
    assert.equal(Gs.status, 200);
    assert.equal(Gs.json.payload.bounties.find((Entry: any) => Entry.bounty_id === AXE).claimed, false);
    assert.ok(Gs.json.payload.bounties.some((Entry: any) => Entry.bounty_id === "Challenge_Season_Invented"));
    assert.deepEqual(Hooks.records, []);
});

test("ActiveSeasonWindow is still exported from routes/system, as the same function the host limits use", () => {
    const System = require("./system");
    assert.equal(typeof System.ActiveSeasonWindow, "function");
    assert.deepEqual(System.ActiveSeasonWindow(Date.now()), ActiveSeasonWindow(Date.now()));
});

test("a host bounty save the hooks refuse answers with the hook's body and stores and tags nothing", async () => {
    Reset();
    Hooks.denial = DENIAL;
    const Result = await Send("POST", "/bounty/stranger", "host", { bounties: [Challenge(AXE, 1, true)] });
    assert.equal(Result.status, 403);
    assert.deepEqual(Result.json, DENIAL.body);
    assert.deepEqual(Hooks.authorized, [{ kind: "BOUNTY", target: "stranger" }]);
    assert.deepEqual(Hooks.records, []);
    assert.equal(Bounties.size, 0);
});

test("a malformed host bounty save is a 400 and is not tagged", async () => {
    Reset();
    const Result = await Send("POST", "/bounty/player-1", "host", { bounties: {} });
    assert.equal(Result.status, 400);
    assert.deepEqual(Hooks.records, []);
    assert.equal(Bounties.size, 0);
});

test("the no-player sentinel is a no-op for a host and never reaches the hooks", async () => {
    Reset();
    const Result = await Send("POST", "/bounty/INVALID", "host", { bounties: [Challenge(AXE, 1, true)] });
    assert.equal(Result.status, 200);
    assert.deepEqual(Result.json.payload.bounties, []);
    assert.deepEqual(Hooks.authorized, []);
    assert.equal(Bounties.size, 0);
});

test("a dedicated server saves bounties without the hooks, and a player is still refused", async () => {
    Reset();
    const Gs = await Send("POST", "/bounty/player-1", "gs", { bounties: [Challenge(AXE, 1, true)], draft_data_weekly: Draft() });
    assert.equal(Gs.status, 200);
    assert.equal(Bounties.get("player-1")?.bounties.length, 1);
    const Player = await Send("POST", "/bounty/player-1", "player", { bounties: [Challenge(AXE, 9, true)] });
    assert.equal(Player.status, 403);
    assert.equal(Player.json, undefined);
    assert.equal((await Send("POST", "/bounty/player-1", undefined, {})).status, 401);
    assert.deepEqual(Hooks.authorized, []);
    assert.deepEqual(Hooks.records, []);
});

// ---- escalation ----------------------------------------------------------------------------------------------------

const SEASON = "ESC_SEASON_6";

// [2026-10-13 realms S3 limits] With a tuning table: the season must exist, a respec persists, an impossible part is refused.
const Level5 = { escalation_level: 5, next_level_xp: 100, talents_progress: [{ talent_id: "Talent_A", rank: 2 }], unlock_progress: [{ reward_id: "Reward_A", collected: true }] };

test("with the tuning table a host escalation save is authorized, judged against the season's limits, and a respec persists", async () => {
    Reset();
    EscalationLimits.load = WITH_TABLE;
    const First = await Send("POST", `/escalation/${SEASON}/player-1`, "host", Level5);
    assert.equal(First.status, 200);
    assert.deepEqual(First.json.payload, { ...Level5, update_version: 1 });
    assert.deepEqual(Hooks.authorized, [{ kind: "ESCALATION", target: "player-1" }]);
    assert.equal(Hooks.records[0].kind, "ESCALATION");
    assert.equal(Hooks.records[0].summary.season, SEASON);
    assert.deepEqual(Hooks.records[0].summary.talentPoints, { before: 0, after: 2 });

    // The game's next save after "Reset talents" (and a stale level / XP, and an un-collected unlock): talents are emptied,
    // the rest never goes down.
    const Reset1 = await Send("POST", `/escalation/${SEASON}/player-1`, "host", {
        escalation_level: 2, next_level_xp: 10, talents_progress: [], unlock_progress: [{ reward_id: "Reward_A", collected: false }],
    });
    assert.equal(Reset1.status, 200);
    assert.deepEqual(Reset1.json.payload, {
        escalation_level: 5, next_level_xp: 100, talents_progress: [], unlock_progress: [{ reward_id: "Reward_A", collected: true }], update_version: 2,
    });
    const Summary = Hooks.records[1].summary as any;
    assert.equal(Summary.levelXpRegressionIgnored, true);
    assert.equal(Summary.talentsReset, true);
    assert.deepEqual(Summary.talents, { before: 1, after: 0, ignored: 0 });
    assert.deepEqual(Summary.talentPoints, { before: 2, after: 0 });
    assert.deepEqual(Summary.unlocks, { before: 1, after: 1, ignored: 1 });
    assert.deepEqual(Escalations.get(`player-1|${SEASON}`)?.talentsProgress, []);

    // The re-spend replaces; the response carries the stored state.
    const Respent = await Send("POST", `/escalation/${SEASON}/player-1`, "host", { talents_progress: [{ talent_id: "Talent_B", rank: 1 }, { talent_id: "Talent_A", rank: 3 }] });
    assert.deepEqual(Respent.json.payload.talents_progress, [{ talent_id: "Talent_B", rank: 1 }, { talent_id: "Talent_A", rank: 3 }]);
    assert.equal((Hooks.records[2].summary as any).talentsReset, undefined);
    assert.equal(Hooks.records.length, 3);
});

test("with the tuning table a host's impossible parts are refused and tagged, the rest of the save is applied", async () => {
    Reset();
    EscalationLimits.load = WITH_TABLE;
    await Send("POST", `/escalation/${SEASON}/player-1`, "host", { escalation_level: 9, next_level_xp: 0, talents_progress: [{ talent_id: "Talent_A", rank: 4 }, { talent_id: "Talent_B", rank: 1 }] });

    // Level 40 does not exist, Talent_Z is not a talent of the season, Reward_A is already collected: the stored level, XP and talents
    // stay, and the save still counts as a write (version 2).
    const Cheat = await Send("POST", `/escalation/${SEASON}/player-1`, "host", {
        escalation_level: 40, next_level_xp: 0, talents_progress: [{ talent_id: "Talent_A", rank: 4 }, { talent_id: "Talent_Z", rank: 1 }], unlock_progress: [{ reward_id: "Reward_A", collected: true }],
    });
    assert.equal(Cheat.status, 200);
    assert.deepEqual(Cheat.json.payload, {
        escalation_level: 9, next_level_xp: 0, talents_progress: [{ talent_id: "Talent_A", rank: 4 }, { talent_id: "Talent_B", rank: 1 }],
        unlock_progress: [{ reward_id: "Reward_A", collected: true }], update_version: 2,
    });
    const Summary = Hooks.records[1].summary as any;
    assert.match(Summary.levelXpRejected, /level 40 is above the season maximum 25/);
    assert.match(Summary.talentsRejected, /"Talent_Z" is not in this season's table/);
    assert.equal(Summary.talentsReset, undefined);
    assert.equal(Summary.levelAfter, 9);
    assert.equal(Escalations.get(`player-1|${SEASON}`)?.updateVersion, 2);
});

test("with the tuning table a host cannot write a season the table does not have: 403, nothing stored or tagged", async () => {
    Reset();
    EscalationLimits.load = WITH_TABLE;
    const Result = await Send("POST", "/escalation/ESC_SEASON_9/player-1", "host", { escalation_level: 3 });
    assert.equal(Result.status, 403);
    assert.deepEqual(Result.json, { code: "ESCALATION_SEASON_UNKNOWN", message: "This escalation season is not known.", payload: null });
    assert.deepEqual(Hooks.authorized, [{ kind: "ESCALATION", target: "player-1" }], "the hooks judge the account first");
    assert.deepEqual(Hooks.records, []);
    assert.equal(Escalations.size, 0);

    // A host the hooks refuse gets the hooks' answer, not a hint about seasons.
    Hooks.denial = DENIAL;
    const Denied = await Send("POST", "/escalation/ESC_SEASON_9/stranger", "host", { escalation_level: 3 });
    assert.equal(Denied.status, 403);
    assert.deepEqual(Denied.json, DENIAL.body);

    // The refusal is for hosts only: a dedicated server, and a player saving their own season, are not judged by the table.
    Hooks.denial = undefined;
    const Gs = await Send("POST", "/escalation/ESC_SEASON_9/player-1", "gs", { escalation_level: 40, next_level_xp: 999999, talents_progress: [{ talent_id: "Nope", rank: 99 }] });
    assert.equal(Gs.status, 200);
    assert.deepEqual(Gs.json.payload, { escalation_level: 40, next_level_xp: 999999, talents_progress: [{ talent_id: "Nope", rank: 99 }], unlock_progress: [], update_version: 1 });
    assert.equal((await Send("POST", `/escalation/${SEASON}/player-1`, "player", { escalation_level: 40 })).status, 200);
});

test("without the tuning file a host escalation save is authorized for ESCALATION, never lowers stored progress, and is tagged with what it ignored", async () => {
    Reset();
    EscalationLimits.load = WITHOUT_TABLE;
    const First = await Send("POST", `/escalation/${SEASON}/player-1`, "host", {
        escalation_level: 5, next_level_xp: 100, talents_progress: [{ talent_id: "Talent_A", rank: 2 }], unlock_progress: [{ reward_id: "Reward_A", collected: true }],
    });
    assert.equal(First.status, 200);
    assert.equal(First.json.payload.escalation_level, 5);
    assert.deepEqual(Hooks.authorized, [{ kind: "ESCALATION", target: "player-1" }]);
    assert.equal(Hooks.records[0].kind, "ESCALATION");
    assert.equal(Hooks.records[0].summary.season, SEASON);
    assert.equal(Hooks.records[0].summary.levelAfter, 5);

    // A stale or hostile save: lower level, lower XP, lower rank, un-collected unlock, empty arrays.
    const Stale = await Send("POST", `/escalation/${SEASON}/player-1`, "host", {
        escalation_level: 2, next_level_xp: 10, talents_progress: [], unlock_progress: [{ reward_id: "Reward_A", collected: false }],
    });
    assert.equal(Stale.status, 200);
    assert.deepEqual(Stale.json.payload, {
        escalation_level: 5, next_level_xp: 100,
        talents_progress: [{ talent_id: "Talent_A", rank: 2 }], unlock_progress: [{ reward_id: "Reward_A", collected: true }],
        update_version: 2,
    });
    const Summary = Hooks.records[1].summary as any;
    assert.equal(Summary.levelXpRegressionIgnored, true);
    assert.deepEqual(Summary.talents, { before: 1, after: 1, ignored: 1 });
    assert.deepEqual(Summary.unlocks, { before: 1, after: 1, ignored: 1 });
    assert.deepEqual(Escalations.get(`player-1|${SEASON}`)?.talentsProgress, [{ talent_id: "Talent_A", rank: 2 }]);

    // No table, no season check and no ceiling: today's behaviour for hosts.
    const Other = await Send("POST", "/escalation/ESC_SEASON_9/player-1", "host", { escalation_level: 40 });
    assert.equal(Other.status, 200);
    assert.equal(Other.json.payload.escalation_level, 40);
    assert.equal((Hooks.records[2].summary as any).talentPoints, undefined);
});

test("a host escalation save the hooks refuse stores and tags nothing", async () => {
    Reset();
    Hooks.denial = DENIAL;
    const Result = await Send("POST", `/escalation/${SEASON}/stranger`, "host", { escalation_level: 9 });
    assert.equal(Result.status, 403);
    assert.deepEqual(Result.json, DENIAL.body);
    assert.deepEqual(Hooks.records, []);
    assert.equal(Escalations.size, 0);
});

test("dedicated and player escalation saves are untouched: the dedicated merge still replaces XP and talents, no hooks", async () => {
    Reset();
    await Send("POST", `/escalation/${SEASON}/player-1`, "gs", { escalation_level: 5, next_level_xp: 100, talents_progress: [{ talent_id: "Talent_A", rank: 2 }] });
    const Stale = await Send("POST", `/escalation/${SEASON}/player-1`, "gs", { escalation_level: 2, next_level_xp: 10, talents_progress: [] });
    assert.equal(Stale.status, 200);
    assert.equal(Stale.json.payload.escalation_level, 5, "the level is monotonic for the dedicated merge too");
    assert.equal(Stale.json.payload.next_level_xp, 10, "the dedicated merge still takes the server's XP");
    assert.deepEqual(Stale.json.payload.talents_progress, [], "and the in-game talent RESET");

    assert.equal((await Send("POST", `/escalation/${SEASON}/player-1`, "player", { escalation_level: 7 })).status, 200, "a player saving their own season");
    assert.equal((await Send("POST", `/escalation/${SEASON}/player-2`, "player", { escalation_level: 7 })).status, 403, "but not another account's");
    assert.deepEqual(Hooks.authorized, []);
    assert.deepEqual(Hooks.records, []);
});

// ---- cooldown batch ------------------------------------------------------------------------------------------------

test("a host cooldown batch is authorized for COOLDOWN, only moves cooldowns later, and is tagged with what changed", async () => {
    Reset();
    const First = await Send("PUT", "/cooldown/batch/player-1", "host", {
        cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T17:00:00.000Z" }, { cooldown_id: "GRANT_X", cooldown_started_date: "2026-10-13T00:00:00.000Z" }],
    });
    assert.equal(First.status, 200);
    assert.deepEqual(Hooks.authorized, [{ kind: "COOLDOWN", target: "player-1" }]);
    assert.equal(Hooks.records[0].summary.route, "batch");
    assert.equal(Hooks.records[0].summary.addedCount, 2);

    // A reset attempt for one gate, a legitimate move for the other.
    const Second = await Send("PUT", "/cooldown/batch/player-1", "host", {
        cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-01T00:00:00.000Z" }, { cooldown_id: "GRANT_X", cooldown_started_date: "2026-10-13T06:00:00.000Z" }],
    });
    assert.equal(Second.status, 200);
    assert.deepEqual(Second.json.payload, { bounty_daily: "2026-10-13T17:00:00.000Z", GRANT_X: "2026-10-13T06:00:00.000Z" });
    const Summary = Hooks.records[1].summary as any;
    assert.equal(Summary.keptLaterCount, 1);
    assert.equal(Summary.raisedCount, 1);
    assert.deepEqual(Summary.raised, [{ id: "GRANT_X", from: "2026-10-13T00:00:00.000Z", to: "2026-10-13T06:00:00.000Z" }]);
    assert.equal(Summary.version, 2);
});

// [2026-10-13 realms S3 limits] A host may not lock a friend's gate with a far-future date; the route reads the real clock.
test("a host cooldown batch refuses a date more than 48 hours ahead (the season id may reach the window end), and tags the refusal", async () => {
    Reset();
    const Now = Date.now();
    const Window = ActiveSeasonWindowMs(Now);
    const Far = new Date(Now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const Near = new Date(Now + 60 * 60 * 1000).toISOString();
    const Result = await Send("PUT", "/cooldown/batch/player-1", "host", {
        cooldowns: [
            { cooldown_id: "bounty_daily", cooldown_started_date: Far },
            { cooldown_id: "GRANT_NEAR", cooldown_started_date: Near },
            { cooldown_id: "season43", cooldown_started_date: new Date(Window.endMs).toISOString() },
            { cooldown_id: "season44", cooldown_started_date: new Date(Window.endMs + 1).toISOString() },
        ],
    });
    assert.equal(Result.status, 200);
    assert.deepEqual(Result.json.payload, { GRANT_NEAR: Near, season43: new Date(Window.endMs).toISOString() });
    const Summary = Hooks.records[0].summary as any;
    assert.equal(Summary.refusedFutureCount, 2);
    assert.deepEqual(Summary.refusedFuture.map((Entry: any) => Entry.id), ["bounty_daily", "season44"]);
    assert.equal(Summary.addedCount, 2);

    // A dedicated server's batch has no such limit.
    const Gs = await Send("PUT", "/cooldown/batch/player-2", "gs", { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: Far }] });
    assert.deepEqual(Gs.json.payload, { bounty_daily: Far });
});

test("a host cooldown batch the hooks refuse, or a malformed one, stores and tags nothing", async () => {
    Reset();
    Hooks.denial = DENIAL;
    const Denied = await Send("PUT", "/cooldown/batch/stranger", "host", { cooldowns: [{ cooldown_id: "X", cooldown_started_date: "2026-10-13T00:00:00.000Z" }] });
    assert.equal(Denied.status, 403);
    assert.deepEqual(Denied.json, DENIAL.body);
    Hooks.denial = undefined;
    const Bad = await Send("PUT", "/cooldown/batch/player-1", "host", { cooldowns: [{ cooldown_id: "X", cooldown_started_date: "not a date" }] });
    assert.equal(Bad.status, 400);
    assert.deepEqual(Hooks.records, []);
    assert.equal(Cooldowns.size, 0);
});

test("a dedicated server's cooldown batch is unchanged (it may move a cooldown earlier), and a player is still refused", async () => {
    Reset();
    await Send("PUT", "/cooldown/batch/player-1", "gs", { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T17:00:00.000Z" }] });
    const Earlier = await Send("PUT", "/cooldown/batch/player-1", "gs", { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-01T00:00:00.000Z" }] });
    assert.equal(Earlier.status, 200);
    assert.deepEqual(Earlier.json.payload, { bounty_daily: "2026-10-01T00:00:00.000Z" });
    assert.equal((await Send("PUT", "/cooldown/batch/player-1", "player", { cooldowns: [] })).status, 403);
    assert.deepEqual(Hooks.authorized, []);
    assert.deepEqual(Hooks.records, []);
});

// ---- [2026-10-15] MOTD trigger and the bounty reset (the routes the realm test showed as unstubbed) -------------------------

test("GET /motd/trigger answers a quiet 404 (a 200 opened an empty MOTD popup in the client); nothing is stored or passed to the hooks", async () => {
    Reset();
    const Result = await Send("GET", "/motd/trigger?event_name=test", "player");
    assert.equal(Result.status, 404);
    assert.equal((await Send("GET", "/motd/trigger?event_name=test", "gs")).status, 404);
    assert.equal((await Send("GET", "/motd/trigger?event_name=test", undefined)).status, 401);
    assert.deepEqual(Hooks.authorized, []);
    assert.equal(Bounties.size, 0);
});

test("POST /bounty/delete/:id (the game's bounty reset) changes nothing: a gameserver and an authorized host get 200, a player 403", async () => {
    Reset();
    const Seed = await Send("POST", "/bounty/player-1", "gs", { bounties: [Challenge(AXE, 1, true)], draft_data_weekly: Draft() });
    assert.equal(Seed.status, 200);
    const Before = structuredClone(Bounties.get("player-1"));
    const Gs = await Send("POST", "/bounty/delete/player-1", "gs");
    assert.equal(Gs.status, 200);
    assert.deepEqual(Gs.json, { code: null, message: "OK", payload: {} });
    assert.deepEqual(Bounties.get("player-1"), Before, "the stored bounty state, claims included, is untouched");
    const Host = await Send("POST", "/bounty/delete/player-1", "host");
    assert.equal(Host.status, 200);
    assert.deepEqual(Hooks.authorized, [{ kind: "BOUNTY", target: "player-1" }]);
    assert.deepEqual(Bounties.get("player-1"), Before);
    assert.equal((await Send("POST", "/bounty/delete/player-1", "player")).status, 403);
    assert.equal((await Send("POST", "/bounty/delete/player-1", undefined)).status, 401);
    Hooks.denial = DENIAL;
    const Refused = await Send("POST", "/bounty/delete/player-1", "host");
    assert.equal(Refused.status, 403);
    assert.deepEqual(Refused.json, DENIAL.body);
    Hooks.denial = undefined;
    assert.deepEqual(Hooks.records, [], "a reset that changes nothing is not tagged");
});
