/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import type * as Kit from "../realm/realmHubTestKit";

// The reforge is read from the environment when controllers/reforge.ts loads, so this file (its own process under
// node --test) switches it off before anything loads it.
process.env.MYSTICPARADOX_REFORGE = "off";

/*
 * [2026-10-14 realms S4] With MYSTICPARADOX_REFORGE=off, ClassifyReforgeGrant returns "normal" for every grant. The prestige +1 a
 * realm hub's host sends (authorized as the reforge's REFORGE write, since a hub takes no XP) must then still be refused: the
 * route's own check is the only thing that stops an unreviewed +1. Tracks and grants are in memory; the P2P side is the realm hub
 * test kit's, as in progressionReforgeHost.gamedata.test.ts.
 */

const Quiet = () => undefined;
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}
function Replace(modulePath: string, overrides: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    const Replacement = Object.create(require(modulePath));
    for (const [Name, Value] of Object.entries(overrides)) Object.defineProperty(Replacement, Name, { value: Value, enumerable: true });
    require.cache[Resolved]!.exports = Replacement;
}
Fake("../../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });

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
    updateReforge: async (userId: string, progressionId: string, reforgeId: string, expected: Record<string, unknown>, set: Record<string, unknown>) => {
        const Row = Tracks.get(Key(userId, progressionId));
        if (Row?.reforge?.reforgeId !== reforgeId) return false;
        for (const [Name, Value] of Object.entries(expected)) if (Row.reforge[Name] !== Value) return false;
        Tracks.set(Key(userId, progressionId), { ...Row, reforge: { ...Row.reforge, ...set } });
        return true;
    },
    getAllForUser: async () => [],
};
const GrantRepository = {
    findByGrantId: async (GrantId: string) => Grants.get(GrantId),
    insertApplied: async (Record: any) => { Grants.set(Record.grantId, Record); },
};
const Repositories = { progressionTracks: TrackRepository, progressionGrants: GrantRepository };
Replace("../../persistence", {
    GetRepositories: () => Repositories,
    GetUnitOfWork: () => ({ withTransaction: async (Action: any) => Action(Repositories, {}) }),
});

Fake("../../middleware/HasParadoxBackendAuth", {
    HasParadoxBackendAuth: (req: any, res: any, next: () => void) => {
        if (req.headers["x-test-role"] !== "host") {
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

const SWORD = "ExperienceTrack_Weapon_Sword";
const PRESTIGE_SWORD = "PrestigeTrack_Weapon_Sword";

let Kit_: typeof Kit;
let RestoreEnvironment: () => void;
let Listening: Server;
let Port = 0;

before(async () => {
    Kit_ = require("../realm/realmHubTestKit");
    RestoreEnvironment = Kit_.InstallHubTestEnvironment();
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

/** A running Ramsgate hub with its member present; the host's own tags are captured in `rows`. */
async function WithRealm(body: (scenario: { hub: Kit.RunningHub; rows: any[] }) => Promise<void>): Promise<void> {
    const kit = Kit_.CreateHubKit();
    const rows: any[] = [];
    require("../security/hostWrites").UseHostWriteSinkForTest(async (row: unknown) => { rows.push(row); });
    Tracks.clear();
    Grants.clear();
    try {
        const hub = await Kit_.StartRunningHub(kit, { hubKind: "RAMSGATE" });
        const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: Kit_.REALM_ID, accountId: Kit_.MEMBER,
            peerId: require("../security/transportPeerIds").DeriveIcePeerId(Kit_.MEMBER), candidateId: "candidate-member", now: iso(), expiresAt: iso(90_000) });
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId: Kit_.MEMBER,
            admissionId: "admission-member", admittedAt: iso(), now: iso(), route: "relay" });
        require("../security/hostCapabilities").InvalidateHubPresence(hub.sessionId);
        await body({ hub, rows });
    } finally {
        require("../security/hostWrites").UseHostWriteSinkForTest(undefined);
        kit.dispose();
    }
}

test("with MYSTICPARADOX_REFORGE=off a hub host's prestige +1 is refused even with an open reforge: nothing stored, nothing tagged", async () => {
    await WithRealm(async ({ hub, rows }) => {
        Tracks.set(Key(Kit_.MEMBER, SWORD), { userId: Kit_.MEMBER, progressionId: SWORD, progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
            updateVersion: 2, updatedAt: "2026-10-14T00:00:00.000Z",
            reforge: { reforgeId: "reforge-off", status: "open", priorProgress: 28_000, cap: 27_775, banked: 225, bankedRestored: 0,
                prestigeGranted: false, openedAt: new Date().toISOString() } });
        const Plus = await Send("POST", `/progression/${Kit_.MEMBER}/${PRESTIGE_SWORD}/1`,
            { "x-test-role": "host", "x-test-capability": hub.capabilitySecret, "x-test-user": Kit_.MEMBER, "x-mysticparadox-grant-id": "off-prestige-1" });
        assert.equal(Plus.status, 409, JSON.stringify(Plus.json));
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)), undefined, "the +1 was not stored");
        assert.equal(Tracks.get(Key(Kit_.MEMBER, SWORD)).reforge.prestigeGranted, false);
        assert.equal(Grants.size, 0);
        assert.equal(rows.length, 0, "a refused +1 is not tagged");
    });
});

test("with MYSTICPARADOX_REFORGE=off a hunt host's prestige +1 is refused too: the game grants prestige only from a reforge", async () => {
    const kit = Kit_.CreateHubKit();
    const rows: any[] = [];
    require("../security/hostWrites").UseHostWriteSinkForTest(async (row: unknown) => { rows.push(row); });
    Tracks.clear();
    Grants.clear();
    try {
        const hub = await Kit_.StartRunningHub(kit, { hubKind: "RAMSGATE" });
        // The same session as a hunt (as progressionReforgeHost.gamedata.test.ts TurnIntoHunt): host and member on the roster.
        const Record = kit.hunts.hunts.get(hub.sessionId)!;
        const roster = [Kit_.HOST, Kit_.MEMBER].map((accountId, index) => ({
            accountId, steamId: require("../security/transportPeerIds").DeriveIcePeerId(accountId), candidateId: `candidate-${index}`,
            reconnectEpoch: 0, admissionState: "ADMITTED"
        }));
        kit.hunts.hunts.set(hub.sessionId, { ...Record, sessionKind: undefined, hubKind: undefined, realmId: undefined, roster } as any);
        const Plus = await Send("POST", `/progression/${Kit_.MEMBER}/${PRESTIGE_SWORD}/1`,
            { "x-test-role": "host", "x-test-capability": hub.capabilitySecret, "x-test-user": Kit_.MEMBER, "x-mysticparadox-grant-id": "off-hunt-prestige-1" });
        assert.equal(Plus.status, 409, JSON.stringify(Plus.json));
        assert.equal(Tracks.get(Key(Kit_.MEMBER, PRESTIGE_SWORD)), undefined, "the +1 was not stored");
        assert.equal(Grants.size, 0);
        assert.equal(rows.length, 0, "a refused +1 is not tagged");
    } finally {
        require("../security/hostWrites").UseHostWriteSinkForTest(undefined);
        kit.dispose();
    }
});
