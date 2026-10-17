import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import type * as Kit from "../realm/realmHubTestKit";
import type { HostWriteRow } from "../security/hostWrites";

/*
 * [2026-10-14 realms S4] The weapon reforge through the real progressionRouter, for a player-hosted runtime and for a dedicated
 * gameserver (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.4). The P2P module is the real one: its host-write
 * rules, its hub presence and its tags run against the realm hub test kit. Only the core persistence (progression tracks and
 * grants, in memory), the logger and the auth middleware (x-test-role picks the caller; a host presents its hub capability)
 * are replaced. A .gamedata test because routes/progression.ts and controllers/progression.ts read game data when they load.
 *
 * The p2p modules are required only inside the tests and hooks: the core persistence seam must be in place before anything
 * that imports it is loaded, and TypeScript imports would load them first.
 */

delete process.env.MYSTICPARADOX_P2P_MODULE;

const Quiet = () => undefined;
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}
// Keeps every other export of the real module; only the named ones are replaced (as progressionHostLimits.gamedata.test.ts does).
function Replace(modulePath: string, overrides: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    const Replacement = Object.create(require(modulePath));
    for (const [Name, Value] of Object.entries(overrides)) Object.defineProperty(Replacement, Name, { value: Value, enumerable: true });
    require.cache[Resolved]!.exports = Replacement;
}
Fake("../../logger",{ logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });

const Tracks = new Map<string, any>();
const Grants = new Map<string, any>();
const Key = (userId: string, progressionId: string) => `${userId}|${progressionId}`;

const TrackRepository = {
    get: async (userId: string, progressionId: string) => Tracks.get(Key(userId, progressionId)),
    increment: async (userId: string, progressionId: string, amount: number) => {
        const Current = Tracks.get(Key(userId, progressionId)) ?? { userId, progressionId, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updateVersion: 1 };
        const Next = { ...Current, progress: Current.progress + amount, updatedAt: "2026-10-14T00:00:00.000Z" };
        Tracks.set(Key(userId, progressionId), Next);
        return Next;
    },
    // Compare-and-set as the Mongo repository does it: the progress and version the reset read, and no open reforge.
    beginReforge: async (userId: string, progressionId: string, expectedProgress: number, expectedVersion: number, reforge: any) => {
        const Row = Tracks.get(Key(userId, progressionId));
        if (Row === undefined || Row.progress !== expectedProgress || Row.updateVersion !== expectedVersion || Row.reforge?.status === "open") return undefined;
        const Next = { ...Row, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0, reforge, updatedAt: reforge.openedAt, updateVersion: Row.updateVersion + 1 };
        Tracks.set(Key(userId, progressionId), Next);
        return Next;
    },
    updateReforge: async (userId: string, progressionId: string, reforgeId: string, expected: Record<string, unknown>, set: Record<string, unknown>) => {
        const Row = Tracks.get(Key(userId, progressionId));
        if (Row?.reforge?.reforgeId !== reforgeId) return false;
        for (const [Name, Value] of Object.entries(expected)) if (Row.reforge[Name] !== Value) return false;
        Tracks.set(Key(userId, progressionId), { ...Row, reforge: { ...Row.reforge, ...set } });
        return true;
    },
    // The store keeps the higher confirmed rank (a monotonic $max), as the Mongo repository does.
    setConfirmedFremiumRank: async (userId: string, progressionId: string, rank: number) => {
        const Current = Tracks.get(Key(userId, progressionId)) ?? { userId, progressionId, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0, updateVersion: 1 };
        const Next = { ...Current, confirmedFremiumRank: Math.max(Current.confirmedFremiumRank ?? 0, rank), updatedAt: "2026-10-14T00:00:00.000Z" };
        Tracks.set(Key(userId, progressionId), Next);
        return Next;
    },
    getAllForUser: async () => [],
    getObjectives: async () => [],
    mergeObjectives: async () => undefined,
    appendObjectiveEvent: async () => undefined,
};
const GrantRepository = {
    findByGrantId: async (GrantId: string) => Grants.get(GrantId),
    insertApplied: async (Record: any) => { Grants.set(Record.grantId, Record); },
};
const Repositories = { progressionTracks: TrackRepository, progressionGrants: GrantRepository };

const SWORD = "ExperienceTrack_Weapon_Sword";

// Core persistence: replaced before the router (and so the p2p module's own imports of it) is first loaded.
Replace("../../persistence", {
    GetRepositories: () => Repositories,
    GetUnitOfWork: () => ({ withTransaction: async (Action: any) => Action(Repositories, {}) }),
});

// The auth middleware: a dedicated gameserver, or a player-hosted runtime that presents its hub capability and the account it acts
// for (the bearer identity; the host's own when absent). An unknown caller is refused, as the real middleware does.
Fake("../../middleware/HasParadoxBackendAuth", {
    HasParadoxBackendAuth: (req: any, res: any, next: () => void) => {
        const Role = req.headers["x-test-role"];
        if (Role === "gs") {
            req.AuthData = { IsGameserver: true };
            next();
            return;
        }
        if (Role !== "host") {
            res.status(401).send();
            return;
        }
        const { ResolveActiveHostRuntimeContext, BuildPlayerHostRuntimeAuthData } = require("../security/hostCapabilities");
        const User = typeof req.headers["x-test-user"] === "string" ? req.headers["x-test-user"] : undefined;
        ResolveActiveHostRuntimeContext(req.headers["x-test-capability"])
            .then((Context: unknown) => {
                const AuthData = Context === undefined ? undefined : BuildPlayerHostRuntimeAuthData(Context, User === undefined ? undefined : { userId: User });
                if (AuthData === undefined) {
                    res.status(401).send();
                    return;
                }
                req.AuthData = AuthData;
                next();
            }, () => res.status(401).send());
    },
});

let Kit_: typeof Kit;
let HostWrites: typeof import("../security/hostWrites");
let RestoreEnvironment: () => void;
let Listening: Server;
let Port = 0;
let CAP = 0;

before(async () => {
    Kit_ = require("../realm/realmHubTestKit");
    HostWrites = require("../security/hostWrites");
    RestoreEnvironment = Kit_.InstallHubTestEnvironment();
    CAP = require("../../controllers/progression").TrackCapXp(SWORD);
    const { progressionRouter } = require("../../routes/progression");
    const App = express();
    App.use(express.json());
    App.use(progressionRouter);
    Listening = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { Listening.once("listening", () => resolve()); Listening.once("error", reject); });
    Port = (Listening.address() as AddressInfo).port;
});

after(async () => {
    RestoreEnvironment?.();
    await new Promise<void>((resolve) => Listening.close(() => resolve()));
});

function Send(method: string, path: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Req = http.request({ hostname: "127.0.0.1", port: Port, path, method, headers }, (res) => {
            let Text = "";
            res.setEncoding("utf8");
            res.on("data", (Chunk) => { Text += Chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: Text.length > 0 ? JSON.parse(Text) : undefined }));
        });
        Req.on("error", reject);
        Req.end();
    });
}

const HostHeaders = (hub: Kit.RunningHub, user?: string): Record<string, string> => ({
    "x-test-role": "host", "x-test-capability": hub.capabilitySecret, ...(user === undefined ? {} : { "x-test-user": user })
});
const GameserverHeaders = { "x-test-role": "gs" };

function Seed(userId: string, progressionId: string, progress: number): void {
    Tracks.set(Key(userId, progressionId), { userId, progressionId, progress, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
        updateVersion: 1, updatedAt: "2026-10-13T00:00:00.000Z" });
}

/** A running hub of `hubKind` with its present member admitted; the host's tags are captured in `rows`. */
async function WithRealm(hubKind: "RAMSGATE" | "TRAINING", body: (scenario: { kit: Kit.HubKit; hub: Kit.RunningHub; rows: HostWriteRow[] }) => Promise<void>): Promise<void> {
    const kit = Kit_.CreateHubKit();
    const rows: HostWriteRow[] = [];
    HostWrites.UseHostWriteSinkForTest(async (row) => { rows.push(row); });
    Tracks.clear();
    Grants.clear();
    try {
        const hub = await Kit_.StartRunningHub(kit, { hubKind });
        const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: Kit_.REALM_ID, accountId: Kit_.MEMBER,
            peerId: require("../security/transportPeerIds").DeriveIcePeerId(Kit_.MEMBER), candidateId: "candidate-member", now: iso(), expiresAt: iso(90_000) });
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId: Kit_.MEMBER,
            admissionId: "admission-member", admittedAt: iso(), now: iso(), route: "relay" });
        require("../security/hostCapabilities").InvalidateHubPresence(hub.sessionId);
        await body({ kit, hub, rows });
    } finally {
        HostWrites.UseHostWriteSinkForTest(undefined);
        kit.dispose();
    }
}

/** The same session as a hunt: a roster of the host and the member, no hub kind. Its runtime is the same capability machinery. */
function TurnIntoHunt(kit: Kit.HubKit, hub: Kit.RunningHub): void {
    const Record = kit.hunts.hunts.get(hub.sessionId)!;
    const roster = [Kit_.HOST, Kit_.MEMBER].map((accountId, index) => ({
        accountId, steamId: require("../security/transportPeerIds").DeriveIcePeerId(accountId), candidateId: `candidate-${index}`,
        reconnectEpoch: 0, admissionState: "ADMITTED"
    }));
    kit.hunts.hunts.set(hub.sessionId, { ...Record, sessionKind: undefined, hubKind: undefined, realmId: undefined, roster } as any);
}

const RESET = (userId: string) => `/progression/${userId}/${SWORD}`;
const RESTORE = (userId: string, amount: number) => `/progression/purchase/${userId}/${SWORD}/${amount}`;

test("a Ramsgate hub's host resets a present member's weapon reforge: applied and tagged with the realm and the hub; a replay is not tagged", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const Reset = await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Reset.status, 200, JSON.stringify(Reset.json));
        const Track = Tracks.get(Key(Kit_.MEMBER, SWORD));
        assert.equal(Track.progress, 0);
        assert.equal(Track.reforge.status, "open");
        assert.equal(Track.reforge.banked, 500);
        assert.equal(rows.length, 1);
        const [Row] = rows;
        assert.equal(Row.kind, "REFORGE");
        assert.equal(Row.targetUserId, Kit_.MEMBER);
        assert.equal(Row.hostAccountId, Kit_.HOST);
        assert.equal(Row.sessionId, hub.sessionId);
        assert.equal(Row.generation, hub.generation);
        assert.equal(Row.realmId, Kit_.REALM_ID);
        assert.equal(Row.sessionKind, "REALM_HUB");
        assert.equal(Row.hubKind, "RAMSGATE");
        assert.equal(Row.summary.route, "delete");
        assert.equal(Row.summary.track, SWORD);
        assert.equal(Row.summary.priorProgress, CAP + 500);
        assert.equal(Row.summary.cap, CAP);
        assert.equal(Row.summary.banked, 500);
        assert.equal(Row.summary.reforgeId, Track.reforge.reforgeId);

        // The reset is open: a repeated DELETE replays and changes nothing, so it is not tagged again.
        const Again = await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Again.status, 200);
        assert.equal(rows.length, 1);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.reforgeId, Track.reforge.reforgeId);
    });
});

test("the banked restore of that reforge is accepted for the present member and tagged once; a replay is not", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        assert.equal((await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER))).status, 200);

        const Wrong = await Send("POST", RESTORE(Kit_.MEMBER, 499), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Wrong.status, 409, "only the banked amount restores");
        assert.equal(rows.length, 1, "a refused restore is not tagged");

        const Restore = await Send("POST", RESTORE(Kit_.MEMBER, 500), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Restore.status, 200, JSON.stringify(Restore.json));
        assert.equal(Restore.json.payload.replayed, false);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, 500);
        assert.equal(rows.length, 2);
        assert.equal(rows[1].kind, "REFORGE");
        assert.equal(rows[1].hubKind, "RAMSGATE");
        assert.equal(rows[1].summary.route, "purchase");
        assert.equal(rows[1].summary.amount, 500);

        const Replay = await Send("POST", RESTORE(Kit_.MEMBER, 500), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Replay.status, 200);
        assert.equal(Replay.json.payload.replayed, true);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, 500, "no second grant");
        assert.equal(rows.length, 2, "a replay is not tagged again");
    });
});

test("a host cannot reset or restore a reforge of a session that is a hunt: refused, nothing changes, nothing is tagged", async () => {
    await WithRealm("RAMSGATE", async ({ kit, hub, rows }) => {
        TurnIntoHunt(kit, hub);
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const Reset = await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Reset.status, 403);
        assert.equal(Reset.json.code, "P2P_HOST_WRITE_DENIED");
        const Restore = await Send("POST", RESTORE(Kit_.MEMBER, 500), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Restore.status, 403);
        assert.equal(Restore.json.code, "P2P_HOST_WRITE_DENIED");
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, CAP + 500);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge, undefined);
        assert.equal(rows.length, 0);
    });
});

test("a host cannot reset or restore a reforge in a Training hub: refused, nothing changes, nothing is tagged", async () => {
    await WithRealm("TRAINING", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const Reset = await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Reset.status, 403);
        assert.equal(Reset.json.code, "P2P_HOST_WRITE_DENIED");
        const Restore = await Send("POST", RESTORE(Kit_.MEMBER, 500), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Restore.status, 403);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, CAP + 500);
        assert.equal(rows.length, 0);
    });
});

test("a Ramsgate host cannot reset the reforge of an account that is not present in its hub", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.STRANGER, SWORD, CAP + 500);
        const Reset = await Send("DELETE", RESET(Kit_.STRANGER), HostHeaders(hub));
        assert.equal(Reset.status, 403);
        assert.equal(Reset.json.code, "P2P_HOST_WRITE_DENIED");
        assert.equal(Tracks.get(Key(Kit_.STRANGER, SWORD)).progress, CAP + 500);
        assert.equal(rows.length, 0);
    });
});

test("a refused reset (below the cap, or a track that is not a weapon reforge) is not tagged", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP - 1);
        assert.equal((await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER))).status, 409);
        Seed(Kit_.MEMBER, "ExperienceTrack_PlayerLevel", 500);
        assert.equal((await Send("DELETE", `/progression/${Kit_.MEMBER}/ExperienceTrack_PlayerLevel`, HostHeaders(hub, Kit_.MEMBER))).status, 409);
        assert.equal(rows.length, 0);
    });
});

test("a dedicated gameserver resets and restores a weapon reforge exactly as before, and nothing is tagged", async () => {
    await WithRealm("RAMSGATE", async ({ rows }) => {
        Seed("player-1", SWORD, CAP + 500);
        const Reset = await Send("DELETE", `/progression/player-1/${SWORD}`, GameserverHeaders);
        assert.equal(Reset.status, 200, JSON.stringify(Reset.json));
        assert.equal(Reset.json.message, "OK");
        const Restore = await Send("POST", `/progression/purchase/player-1/${SWORD}/500`, GameserverHeaders);
        assert.equal(Restore.status, 200, JSON.stringify(Restore.json));
        assert.equal(Restore.json.payload.replayed, false);
        assert.equal(Tracks.get(Key("player-1", SWORD)).progress, 500);
        assert.equal(rows.length, 0);
    });
});

// ---- [2026-10-14 realms S4] the reforge's prestige +1 (XP route) and the rank confirm, from a host ------------------------

const PRESTIGE_SWORD = "PrestigeTrack_Weapon_Sword";
const GrantPath = (userId: string, track: string, amount: number) => `/progression/${userId}/${track}/${amount}`;
const WithGrantId = (headers: Record<string, string>, grantId: string) => ({ ...headers, "x-mysticparadox-grant-id": grantId });
const ConfirmPath = (userId: string, track: string, rank: number) => `/progression/${userId}/${track}/${rank}/confirm/public`;

/** A weapon reforge already open on the member's sword (as the reset leaves it), for a session that cannot open one itself. */
function SeedOpenReforge(userId: string): void {
    Tracks.set(Key(userId, SWORD), { userId, progressionId: SWORD, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
        updateVersion: 2, updatedAt: "2026-10-14T00:00:00.000Z",
        reforge: { reforgeId: "reforge-seeded", status: "open", priorProgress: CAP + 500, cap: CAP, banked: 500, bankedRestored: 0,
            prestigeGranted: false, openedAt: new Date().toISOString() } });
}

test("a Ramsgate hub's host adds the +1 of a reforge it opened for a present member: accepted, marked once, tagged as the reforge's REFORGE write", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        assert.equal((await Send("DELETE", RESET(Kit_.MEMBER), HostHeaders(hub, Kit_.MEMBER))).status, 200);
        const ReforgeId = Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.reforgeId;

        const Plus = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-prestige-1"));
        assert.equal(Plus.status, 200, JSON.stringify(Plus.json));
        assert.equal(Plus.json.payload.progress, 1);
        assert.equal(Plus.json.payload.replayed, false);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)).progress, 1);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.prestigeGranted, true);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.status, "open", "the banked restore is still owed");
        assert.equal(rows.length, 2);
        assert.equal(rows[1].kind, "REFORGE");
        assert.equal(rows[1].targetUserId, Kit_.MEMBER);
        assert.equal(rows[1].hubKind, "RAMSGATE");
        assert.equal(rows[1].realmId, Kit_.REALM_ID);
        assert.deepEqual(rows[1].summary, { route: "xp", track: PRESTIGE_SWORD, amount: 1, grantId: "hub-prestige-1", reforgeId: ReforgeId });

        // The same grant id is a retry: it replays and is not tagged again; a second, different +1 for the same reforge is refused.
        const Retry = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-prestige-1"));
        assert.equal(Retry.status, 200);
        assert.equal(Retry.json.payload.replayed, true);
        const Second = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-prestige-2"));
        assert.equal(Second.status, 409);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)).progress, 1);
        assert.equal(rows.length, 2, "neither the replay nor the refused +1 is tagged");
    });
});

test("a hub's prestige +1 needs an open reforge: without one it is refused, nothing stored, nothing tagged", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        const Plus = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "no-reforge-1"));
        assert.equal(Plus.status, 409);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)), undefined);
        assert.equal(rows.length, 0);
    });
});

test("a hub's host takes no XP: a weapon or player XP grant is refused, and a prestige grant that is not +1 is refused by the limits", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, 100);
        const Xp = await Send("POST", GrantPath(Kit_.MEMBER, SWORD, 98), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-xp-1"));
        assert.equal(Xp.status, 403);
        assert.equal(Xp.json.code, "P2P_HOST_WRITE_DENIED");
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, 100);

        SeedOpenReforge(Kit_.MEMBER);
        const Two = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 2), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-prestige-2x"));
        assert.equal(Two.status, 403);
        assert.equal(Two.json.code, "HOST_WRITE_LIMIT");
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)), undefined);
        assert.equal(rows.length, 0);
    });
});

// [2026-10-16] The one XP a hub takes: the active Hunt Pass track's, which the game awards in town.
// It is authorized as HUNT_PASS_XP; every other track stays refused.
test("a hub's host may grant Hunt Pass XP on the active season track, tagged HUNT_PASS_XP; a weapon track stays refused", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        const HuntPass = await Send("POST", GrantPath(Kit_.MEMBER, "season43", 5), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-hp-xp-1"));
        assert.equal(HuntPass.status, 200, JSON.stringify(HuntPass.json));
        assert.deepEqual(rows.map((Row) => Row.kind), ["HUNT_PASS_XP"]);
        Seed(Kit_.MEMBER, SWORD, 100);
        const Weapon = await Send("POST", GrantPath(Kit_.MEMBER, SWORD, 5), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hub-weapon-xp-1"));
        assert.equal(Weapon.status, 403);
        assert.equal(Weapon.json.code, "P2P_HOST_WRITE_DENIED");
    });
    await WithRealm("TRAINING", async ({ hub, rows }) => {
        const HuntPass = await Send("POST", GrantPath(Kit_.MEMBER, "season43", 5), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "dojo-hp-xp-1"));
        assert.equal(HuntPass.status, 200, JSON.stringify(HuntPass.json));
        assert.deepEqual(rows.map((Row) => Row.kind), ["HUNT_PASS_XP"]);
    });
});

// [2026-10-16] MYSTICPARADOX_HOST_POLICY observe (the live default; the hub test kit sets enforce): the XP route still tries
// its kinds quietly first, so the Hunt Pass grant keeps its HUNT_PASS_XP tag, and a weapon grant the hub does not take goes through as
// XP (logged by the module as [HostPolicyObserve]) instead of 403.
test("observe: a hub's weapon XP grant is accepted and tagged XP, and the Hunt Pass grant keeps its HUNT_PASS_XP tag", async () => {
    const Saved = process.env.MYSTICPARADOX_HOST_POLICY;
    delete process.env.MYSTICPARADOX_HOST_POLICY;
    try {
        await WithRealm("RAMSGATE", async ({ hub, rows }) => {
            const HuntPass = await Send("POST", GrantPath(Kit_.MEMBER, "season43", 5), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "observe-hp-xp-1"));
            assert.equal(HuntPass.status, 200, JSON.stringify(HuntPass.json));
            Seed(Kit_.MEMBER, SWORD, 100);
            const Weapon = await Send("POST", GrantPath(Kit_.MEMBER, SWORD, 5), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "observe-weapon-xp-1"));
            assert.equal(Weapon.status, 200, JSON.stringify(Weapon.json));
            assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).progress, 105);
            assert.deepEqual(rows.map((Row) => Row.kind), ["HUNT_PASS_XP", "XP"]);
        });
    } finally {
        if (Saved === undefined) delete process.env.MYSTICPARADOX_HOST_POLICY;
        else process.env.MYSTICPARADOX_HOST_POLICY = Saved;
    }
});

test("in a hunt the prestige +1 stays XP: accepted and tagged as XP, as before", async () => {
    await WithRealm("RAMSGATE", async ({ kit, hub, rows }) => {
        TurnIntoHunt(kit, hub);
        SeedOpenReforge(Kit_.MEMBER);
        const Plus = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "hunt-prestige-1"));
        assert.equal(Plus.status, 200, JSON.stringify(Plus.json));
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.prestigeGranted, true);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "XP");
        assert.deepEqual(rows[0].summary, { track: PRESTIGE_SWORD, amount: 1, grantId: "hunt-prestige-1" });
        assert.equal(rows[0].realmId, undefined, "a hunt's tag carries no realm");
    });
});

test("a Training hub refuses the prestige +1 as well: nothing stored, nothing tagged", async () => {
    await WithRealm("TRAINING", async ({ hub, rows }) => {
        SeedOpenReforge(Kit_.MEMBER);
        const Plus = await Send("POST", GrantPath(Kit_.MEMBER, PRESTIGE_SWORD, 1), WithGrantId(HostHeaders(hub, Kit_.MEMBER), "dojo-prestige-1"));
        assert.equal(Plus.status, 403);
        assert.equal(Plus.json.code, "P2P_HOST_WRITE_DENIED");
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)), undefined);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.prestigeGranted, false);
        assert.equal(rows.length, 0);
    });
});

test("a Ramsgate hub's host confirms a present member's rank: accepted and tagged once, when the rank rises", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const First = await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(First.status, 200, JSON.stringify(First.json));
        assert.equal(First.json.payload.confirmed_fremium_rank, 5);
        assert.equal(First.json.payload.progress, CAP + 500, "the XP total is preserved");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "RANK_CONFIRM");
        assert.equal(rows[0].hubKind, "RAMSGATE");
        assert.deepEqual(rows[0].summary, { track: SWORD, rank: 5, previousRank: 0, confirmedRank: 5 });

        // Confirming the same rank again, or a lower one, changes nothing and is not tagged.
        assert.equal((await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER))).status, 200);
        assert.equal((await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 3), HostHeaders(hub, Kit_.MEMBER))).status, 200);
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).confirmedFremiumRank, 5);
        assert.equal(rows.length, 1);
    });
});

test("the Ramsgate host confirms its own rank, a stranger is refused, and a Training hub's member is confirmed too", async () => {
    await WithRealm("RAMSGATE", async ({ hub, rows }) => {
        Seed(Kit_.HOST, SWORD, CAP + 500);
        assert.equal((await Send("POST", ConfirmPath(Kit_.HOST, SWORD, 5), HostHeaders(hub))).status, 200);
        Seed(Kit_.STRANGER, SWORD, CAP + 500);
        const Stranger = await Send("POST", ConfirmPath(Kit_.STRANGER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Stranger.status, 403);
        assert.equal(Stranger.json.code, "P2P_HOST_WRITE_DENIED");
        assert.equal(Tracks.get(Key(Kit_.STRANGER, SWORD)).confirmedFremiumRank, 0);
        assert.deepEqual(rows.map((Row) => [Row.kind, Row.targetUserId]), [["RANK_CONFIRM", Kit_.HOST]]);
    });
    // [2026-10-16] A Training hub writes what Ramsgate writes, the rank confirm included (only the reforge stays Ramsgate's).
    await WithRealm("TRAINING", async ({ hub, rows }) => {
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const Confirmed = await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Confirmed.status, 200, JSON.stringify(Confirmed.json));
        assert.deepEqual(rows.map((Row) => [Row.kind, Row.targetUserId]), [["RANK_CONFIRM", Kit_.MEMBER]]);
    });
});

test("a hunt's host confirms an admitted member's rank and is refused for a non-member; the XP rule still answers 409", async () => {
    await WithRealm("RAMSGATE", async ({ kit, hub, rows }) => {
        TurnIntoHunt(kit, hub);
        Seed(Kit_.MEMBER, SWORD, CAP + 500);
        const Member = await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Member.status, 200, JSON.stringify(Member.json));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "RANK_CONFIRM");
        assert.equal(rows[0].hubKind, undefined, "a hunt's tag has no hub kind");

        Seed(Kit_.STRANGER, SWORD, CAP + 500);
        assert.equal((await Send("POST", ConfirmPath(Kit_.STRANGER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER))).status, 403);

        // A rank the stored XP does not qualify for is still refused by ConfirmPublicProgressionRank, untagged.
        Seed(Kit_.MEMBER, SWORD, 0);
        const Short = await Send("POST", ConfirmPath(Kit_.MEMBER, SWORD, 5), HostHeaders(hub, Kit_.MEMBER));
        assert.equal(Short.status, 409);
        assert.equal(rows.length, 1);
    });
});

test("a dedicated gameserver confirms exactly as before: a qualified rank is stored, an unqualified one is 409, and nothing is tagged", async () => {
    await WithRealm("RAMSGATE", async ({ rows }) => {
        Seed("player-1", SWORD, CAP + 500);
        const Ok = await Send("POST", ConfirmPath("player-1", SWORD, 5), GameserverHeaders);
        assert.equal(Ok.status, 200, JSON.stringify(Ok.json));
        assert.equal(Ok.json.payload.confirmed_fremium_rank, 5);
        Seed("player-2", SWORD, 0);
        assert.equal((await Send("POST", ConfirmPath("player-2", SWORD, 5), GameserverHeaders)).status, 409);
        assert.equal((await Send("POST", ConfirmPath("player-1", SWORD, 0), { "x-test-role": "none" })).status, 401);
        assert.equal(rows.length, 0);
    });
});
