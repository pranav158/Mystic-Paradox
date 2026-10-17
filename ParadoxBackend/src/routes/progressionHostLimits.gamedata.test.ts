/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { ExtensionHttpResponse, HostWriteKind, HostWriteRecordInput } from "../extensions/p2p";
import { gameDataPath, tryLoadGameData } from "../gameData/loader";

// The limits and the module's refusals are separate; the module itself is replaced by a recorder below.
process.env.MYSTICPARADOX_P2P_MODULE = "off";

/*
 * [2026-10-13 realms S3 limits] POST /progression/:userId/:progressionId/:amount and POST /progression/:userId through the real
 * progressionRouter: what a player-hosted server's runtime may add in one XP grant and in one mastery report, and that a
 * dedicated server's identical request is unchanged. A .gamedata test because routes/progression.ts reads game-data when it
 * loads. Four seams are replaced before the router is first required, so no MongoDB is needed: the auth middleware
 * (x-test-role picks the caller), the repositories and unit of work (in memory), the P2P hooks (a recorder) and the logger.
 */

const Tracks = new Map<string, any>();
const Grants = new Map<string, any>();
const Objectives = new Map<string, { objectiveId: string; value: number; completedCount: number }>();
const Calls = { trackIncrements: [] as [string, number][] };

const TrackRepository = {
    get: async (userId: string, progressionId: string) => Tracks.get(`${userId}|${progressionId}`),
    increment: async (userId: string, progressionId: string, amount: number) => {
        const Current = Tracks.get(`${userId}|${progressionId}`);
        const Next = {
            userId, progressionId, progress: (Current?.progress ?? 0) + amount, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
            updatedAt: "2026-10-13T00:00:00.000Z",
        };
        Tracks.set(`${userId}|${progressionId}`, Next);
        Calls.trackIncrements.push([progressionId, amount]);
        return Next;
    },
    getAllForUser: async () => [],
    getObjectives: async (_UserId: string, Ids: string[]) => Ids.map((Id) => Objectives.get(Id)).filter((Row) => Row !== undefined),
    mergeObjectives: async (_UserId: string, Rows: { objectiveId: string; value: number; completedCount: number }[]) => {
        for (const Row of Rows) {
            const Before = Objectives.get(Row.objectiveId);
            Objectives.set(Row.objectiveId, { objectiveId: Row.objectiveId, value: Math.max(Before?.value ?? 0, Row.value), completedCount: Math.max(Before?.completedCount ?? 0, Row.completedCount) });
        }
    },
    appendObjectiveEvent: async () => undefined,
};
const GrantRepository = {
    findByGrantId: async (GrantId: string) => Grants.get(GrantId),
    insertApplied: async (Record: any) => { Grants.set(Record.grantId, Record); },
};
const Repositories = { progressionTracks: TrackRepository, progressionGrants: GrantRepository };

const Hooks = {
    authorized: [] as { kind: HostWriteKind; target: string }[],
    records: [] as HostWriteRecordInput[],
    denial: undefined as ExtensionHttpResponse | undefined,
    // [2026-10-17] The host policy: enforce (true) pins the limits as refusals; observe (false) only logs them (dedicated parity).
    policyRefuses: true,
    notes: [] as string[],
};

function Replace(modulePath: string, overrides: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    const Replacement = Object.create(require(modulePath));
    for (const [Name, Value] of Object.entries(overrides)) Object.defineProperty(Replacement, Name, { value: Value, enumerable: true });
    require.cache[Resolved]!.exports = Replacement;
}

function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

const Quiet = () => undefined;
Fake("../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });
Replace("../persistence", {
    GetRepositories: () => Repositories,
    GetUnitOfWork: () => ({ withTransaction: async (Action: any) => Action(Repositories, {}) }),
});
Replace("../extensions/p2p", {
    GetP2PExtension: () => ({
        hostWrites: {
            authorize: async (_req: unknown, kind: HostWriteKind, target: string) => { Hooks.authorized.push({ kind, target }); return Hooks.denial; },
            record: async (_req: unknown, write: HostWriteRecordInput) => { Hooks.records.push(write); },
        },
        hostPolicy: {
            refuses: () => Hooks.policyRefuses,
            noteWouldRefuse: (what: string, detail: string) => { Hooks.notes.push(`${what} ${detail}`); },
        },
    }),
});
Fake("../middleware/HasParadoxBackendAuth", {
    HasParadoxBackendAuth: (req: any, res: any, next: () => void) => {
        const Role = req.headers["x-test-role"];
        if (Role === "gs") req.AuthData = { IsGameserver: true };
        else if (Role === "host") req.AuthData = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "host-1", RuntimeRosterAccountIds: ["host-1", "player-1"] };
        else { res.status(401).send(); return; }
        next();
    },
});

let Listening: Server;
let Port = 0;

before(async () => {
    const { progressionRouter } = require("./progression");
    const App = express();
    App.use(express.json());
    App.use(progressionRouter);
    Listening = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { Listening.once("listening", () => resolve()); Listening.once("error", reject); });
    Port = (Listening.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Listening.close(() => resolve()));
});

function Reset(): void {
    Tracks.clear();
    Grants.clear();
    Objectives.clear();
    Calls.trackIncrements.length = 0;
    Hooks.authorized.length = 0;
    Hooks.records.length = 0;
    Hooks.denial = undefined;
    Hooks.policyRefuses = true;
    Hooks.notes.length = 0;
}

function Send(method: string, path: string, role: string | undefined, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Headers: Record<string, string> = { ...extraHeaders };
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

const Grant = (role: string, track: string, amount: number, grantId: string, user = "player-1") =>
    Send("POST", `/progression/${user}/${track}/${amount}`, role, undefined, { "x-mysticparadox-grant-id": grantId });

const LIMIT_CODE = "HOST_WRITE_LIMIT";
const DENIAL: ExtensionHttpResponse = { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };

// ---- XP grants -----------------------------------------------------------------------------------------------------------------

test("a host grant above its ceiling is a 403 with its own code: authorized first, never stored, never tagged", async () => {
    Reset();
    const Over = await Grant("host", "ExperienceTrack_Weapon_Axe", 1001, "limit-1");
    assert.equal(Over.status, 403);
    assert.equal(Over.json.code, LIMIT_CODE);
    assert.deepEqual(Hooks.authorized, [{ kind: "XP", target: "player-1" }]);
    assert.deepEqual(Hooks.records, []);
    assert.equal(Tracks.size, 0);
    assert.equal(Grants.size, 0);

    // Not clamped: nothing at all is recorded under the grant id, so the same id may still be used for a real grant.
    const Real = await Grant("host", "ExperienceTrack_Weapon_Axe", 98, "limit-1");
    assert.equal(Real.status, 200);
    assert.equal(Real.json.payload.progress, 98);
});

test("a host that may not write the player gets the module's denial, not the limit answer", async () => {
    Reset();
    Hooks.denial = DENIAL;
    const Result = await Grant("host", "ExperienceTrack_Weapon_Axe", 1001, "limit-2", "stranger");
    assert.equal(Result.status, 403);
    assert.deepEqual(Result.json, DENIAL.body);
});

test("a host's real-sized grants are stored and tagged: weapon, player level and Hunt Pass at their boundaries", async () => {
    Reset();
    for (const [Track, Amount] of [["ExperienceTrack_Weapon_Sword", 225], ["ExperienceTrack_PlayerLevel", 1000], ["season43", 200]] as [string, number][]) {
        const Result = await Grant("host", Track, Amount, `ok-${Track}`);
        assert.equal(Result.status, 200, `${Track} ${Amount}`);
        assert.equal(Result.json.payload.progress, Amount);
    }
    assert.deepEqual(Hooks.records.map((Write) => Write.summary), [
        { track: "ExperienceTrack_Weapon_Sword", amount: 225, grantId: "ok-ExperienceTrack_Weapon_Sword" },
        { track: "ExperienceTrack_PlayerLevel", amount: 1000, grantId: "ok-ExperienceTrack_PlayerLevel" },
        { track: "season43", amount: 200, grantId: "ok-season43" },
    ]);
    const Over = await Grant("host", "season43", 201, "ok-season43-over");
    assert.equal(Over.status, 403);
    assert.equal(Over.json.code, LIMIT_CODE);
    assert.equal(Tracks.get("player-1|season43").progress, 200);
});

test("a host's mastery grant and a prestige grant that is not +1 are refused", async () => {
    Reset();
    for (const [Track, Amount] of [["MasteryTrack_PlayerLevel", 1], ["MasteryTrack_Weapon_Axe", 5], ["PrestigeTrack_Weapon_Axe", 2]] as [string, number][]) {
        const Result = await Grant("host", Track, Amount, `refused-${Track}`);
        assert.equal(Result.status, 403, `${Track} ${Amount}`);
        assert.equal(Result.json.code, LIMIT_CODE);
    }
    assert.equal(Tracks.size, 0);
    assert.deepEqual(Hooks.records, []);
});

test("the amount bound is unchanged for a host: over 100000 is still a 400, ahead of the authorization", async () => {
    Reset();
    const Result = await Grant("host", "ExperienceTrack_Weapon_Axe", 100001, "bound-1");
    assert.equal(Result.status, 400);
    assert.deepEqual(Hooks.authorized, []);
});

test("a dedicated server's grants are not subject to the host limits: the same requests are applied as before", async () => {
    Reset();
    for (const [Track, Amount] of [["ExperienceTrack_Weapon_Axe", 1001], ["season43", 201], ["MasteryTrack_PlayerLevel", 3]] as [string, number][]) {
        const Result = await Grant("gs", Track, Amount, `gs-${Track}`);
        assert.equal(Result.status, 200, `${Track} ${Amount}`);
        assert.equal(Result.json.payload.progress, Amount);
    }
    assert.deepEqual(Hooks.authorized, []);                                                // no host hook, no tag
    assert.deepEqual(Hooks.records, []);
    assert.equal((await Grant("gs", "ExperienceTrack_PlayerLevel", 5000, "gs-player")).status, 200);
});

test("a host cannot push a full player level track further; the grant that crossed the total replays", async () => {
    Reset();
    Tracks.set("player-1|ExperienceTrack_PlayerLevel", { userId: "player-1", progressionId: "ExperienceTrack_PlayerLevel", progress: 141_000, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updatedAt: "2026-10-13T00:00:00.000Z" });
    const Crossing = await Grant("host", "ExperienceTrack_PlayerLevel", 98, "cross-1");
    assert.equal(Crossing.status, 200);
    assert.equal(Crossing.json.payload.progress, 141_098);

    const Retry = await Grant("host", "ExperienceTrack_PlayerLevel", 98, "cross-1");          // the response was lost: the retry still succeeds
    assert.equal(Retry.status, 200);
    assert.equal(Retry.json.payload.replayed, true);
    assert.equal(Hooks.records.length, 1);                                                     // and is not tagged twice

    const Next = await Grant("host", "ExperienceTrack_PlayerLevel", 98, "cross-2");
    assert.equal(Next.status, 403);
    assert.equal(Next.json.code, LIMIT_CODE);
    assert.equal(Tracks.get("player-1|ExperienceTrack_PlayerLevel").progress, 141_098);
    assert.equal(Hooks.records.length, 1);

    // A dedicated server's grant on the same full track still goes through.
    assert.equal((await Grant("gs", "ExperienceTrack_PlayerLevel", 98, "cross-gs")).status, 200);
});

// [2026-10-17] Dedicated parity (observe, the live default): the ceiling and the full player level only log; the grant is applied and
// tagged like any other host grant. The reforge rules (MasteryTrack_, a prestige grant that is not +1) still refuse.
test("observe: a host's over-ceiling grant and a grant to a full player level are applied, tagged and logged", async () => {
    Reset();
    Hooks.policyRefuses = false;
    const Over = await Grant("host", "season43", 260, "observe-over-1");
    assert.equal(Over.status, 200, JSON.stringify(Over.json));
    assert.equal(Over.json.payload.progress, 260);
    Tracks.set("player-1|ExperienceTrack_PlayerLevel", { userId: "player-1", progressionId: "ExperienceTrack_PlayerLevel", progress: 141_020, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updatedAt: "2026-10-13T00:00:00.000Z" });
    const Full = await Grant("host", "ExperienceTrack_PlayerLevel", 98, "observe-full-1");
    assert.equal(Full.status, 200, "no 403 for a max-level player");
    assert.equal(Full.json.payload.progress, 141_118);
    assert.deepEqual(Hooks.records.map((Write) => Write.summary.grantId), ["observe-over-1", "observe-full-1"]);
    assert.equal(Hooks.notes.length, 2, Hooks.notes.join("\n"));
    assert.ok(Hooks.notes[0].includes("reason=amount_over_ceiling") && Hooks.notes[1].includes("reason=track_full"), Hooks.notes.join("\n"));

    for (const [Track, Amount] of [["MasteryTrack_PlayerLevel", 1], ["PrestigeTrack_Weapon_Axe", 2]] as [string, number][]) {
        const Refused = await Grant("host", Track, Amount, `observe-refused-${Track}`);
        assert.equal(Refused.status, 403, `${Track} ${Amount}`);
        assert.equal(Refused.json.code, LIMIT_CODE);
    }
});

// ---- mastery reports -----------------------------------------------------------------------------------------------------------

// Real ids from the exported card table when it is present (the route then checks against it), else grammar-shaped ones.
const HAVE_FILE = fs.existsSync(gameDataPath("mastery_objectives.json"));
const AxeIds = (count: number): string[] => {
    const FromFile: string[] = HAVE_FILE
        ? (tryLoadGameData<any>("mastery_objectives.json").objectiveIds as string[]).filter((Id) => /^MasteryObjective_Weapon_Axe_/.test(Id)) : [];
    assert.ok(FromFile.length === 0 || FromFile.length >= count, "the real file has enough Axe ids");
    return FromFile.length > 0 ? FromFile.slice(0, count) : Array.from({ length: count }, (_, Index) => `MasteryObjective_Weapon_Axe_Generic_Kills${Index}`);
};
const Done = (Id: string, Value = 1, Count = 1) => ({ objective_id: Id, value: Value, completed_count: Count });
const Claim = (Track: string, Progress: number) => ({ progression_id: Track, progress: Progress });

test("a host's mastery report is applied under the limits and tagged with what they cut; a dedicated server's is not", async () => {
    Reset();
    const Ids = AxeIds(70);
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 70), Claim("MasteryTrack_Weapon_Axe", 70)],
        objectives: [...Ids.map((Id) => Done(Id, 5e8, 99)), Done("Objective_1"), Done("MasteryObjective_Cheater_Axe_Kill")],
    };
    const Host = await Send("POST", "/progression/player-1", "host", Body);
    assert.equal(Host.status, 200);
    assert.equal(Host.json.payload.objectives.length, 64);
    assert.ok(Host.json.payload.objectives.every((Row: any) => Row.progress === 100_000_000 && Row.completed_count === 10));
    assert.equal(Objectives.size, 64);
    assert.equal(Objectives.has("Objective_1"), false);
    assert.deepEqual(Calls.trackIncrements.sort(), [["MasteryTrack_PlayerLevel", 64], ["MasteryTrack_Weapon_Axe", 64]]);
    assert.deepEqual(Hooks.authorized.map((Entry) => Entry.kind), ["OBJECTIVES", "MASTERY"]);
    const Tag: any = Hooks.records.find((Write) => Write.kind === "MASTERY")?.summary;
    assert.equal(Tag.newlyCompletedCount, 64);
    assert.equal(Tag.overLimitCount, 6);
    assert.equal(Tag.ignoredCount, 2);
    assert.deepEqual(Tag.credits, { MasteryTrack_PlayerLevel: 64, MasteryTrack_Weapon_Axe: 64 });

    Reset();
    const Dedicated = await Send("POST", "/progression/player-1", "gs", Body);
    assert.equal(Dedicated.status, 200);
    assert.equal(Dedicated.json.payload.objectives.length, 72);                                // everything is stored, as before
    assert.ok(Dedicated.json.payload.objectives.some((Row: any) => Row.objective_id === "Objective_1" && Row.progress === 1));
    assert.ok(Dedicated.json.payload.objectives.some((Row: any) => Row.progress === 5e8 && Row.completed_count === 99));
    assert.deepEqual(Calls.trackIncrements.sort(), [["MasteryTrack_PlayerLevel", 70], ["MasteryTrack_Weapon_Axe", 70]]);
    assert.deepEqual(Hooks.authorized, []);
});

test("a host's mastery credit stops at the track's rank-sum total", async () => {
    Reset();
    Tracks.set("player-1|MasteryTrack_Weapon_Axe", { userId: "player-1", progressionId: "MasteryTrack_Weapon_Axe", progress: 114, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updatedAt: "2026-10-13T00:00:00.000Z" });
    const Ids = AxeIds(3);
    const Host = await Send("POST", "/progression/player-1", "host", {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 3), Claim("MasteryTrack_Weapon_Axe", 3)],
        objectives: Ids.map((Id) => Done(Id)),
    });
    assert.equal(Host.status, 200);
    assert.equal(Tracks.get("player-1|MasteryTrack_Weapon_Axe").progress, 115);               // room for 1 of the 3 (rank-sum 115)
    assert.equal(Tracks.get("player-1|MasteryTrack_PlayerLevel").progress, 3);
    const Tag: any = Hooks.records.find((Write) => Write.kind === "MASTERY")?.summary;
    assert.deepEqual(Tag.atCap, ["MasteryTrack_Weapon_Axe 3->1 (total 114, cap 115)"]);
});
