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
import type { P2PRepositoryProvider } from "../persistence";
import type { TestRealm } from "../../persistence/sqlite/testSupport";

/*
 * [2026-10-14 realms S4] POST /inventory from a realm hub's host through the real route, the real P2P authorization and grant
 * policy (p2p module), and the real inventory transaction and wallet on a throwaway SQLite realm (persistence/sqlite/testSupport).
 * A weapon's prestige-gated reward (the Aetherheart, CURRENCY_PJM_PRESTIGE_FILLED) is paid only when banked prestige funds it in
 * the same transaction (wallet.ts SpendBankedPrestigeForReward); an unfunded one aborts the whole transaction. Every other Hunt
 * Pass item stays refused to a hub's host, and a Training hub refuses every grant. Only the auth middleware is replaced (x-test-role
 * picks the caller, a host presents its hub capability) and the logger. A .gamedata test: the inventory controller reads the
 * storage policy and the progression paths when it loads.
 *
 * The core persistence and the p2p modules are required only inside the hooks and tests (the seam must be in place before the
 * route is first loaded).
 */

const Quiet = () => undefined;
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}
// Keeps every other export of the real module; only the named ones are replaced (as the other route tests do).
function Replace(modulePath: string, overrides: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    const Replacement = Object.create(require(modulePath));
    for (const [Name, Value] of Object.entries(overrides)) Object.defineProperty(Replacement, Name, { value: Value, enumerable: true });
    require.cache[Resolved]!.exports = Replacement;
}
Fake("../../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });

// The core repositories and unit of work are the current SQLite realm (a fresh one per test; see WithRealm).
let Realm: TestRealm | undefined;
Replace("../../persistence", {
    GetRepositories: () => Realm!.repos,
    GetUnitOfWork: () => Realm!.uow,
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

const PRESTIGE_SWORD = "PrestigeTrack_Weapon_Sword";
const AETHERHEART = "CURRENCY_PJM_PRESTIGE_FILLED";
const NOTES = "CURRENCY_NOTES";
const CHARACTER = "character-member";

let Kit_: typeof Kit;
let P2PPersistence: { UseP2PPersistenceForTest: (provider: P2PRepositoryProvider | undefined) => void };
let RestoreEnvironment: () => void;
let Listening: Server;
let Port = 0;

before(async () => {
    Kit_ = require("../realm/realmHubTestKit");
    P2PPersistence = require("../persistence");
    RestoreEnvironment = Kit_.InstallHubTestEnvironment();
    const { progressionRouter } = require("../../routes/progression");
    const { inventoryRouter } = require("../../routes/inventory");
    const App = express();
    App.use(express.json());
    App.use(progressionRouter);
    App.use(inventoryRouter);
    Listening = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { Listening.once("listening", () => resolve()); Listening.once("error", reject); });
    Port = (Listening.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Listening.close(() => resolve()));
    RestoreEnvironment?.();
});

function Send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Payload = body === undefined ? undefined : JSON.stringify(body);
        const Req = http.request({ hostname: "127.0.0.1", port: Port, path, method,
            headers: Payload === undefined ? headers : { ...headers, "content-type": "application/json" } }, (res) => {
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

const HostHeaders = (hub: Kit.RunningHub): Record<string, string> => ({
    "x-test-role": "host", "x-test-capability": hub.capabilitySecret, "x-test-user": Kit_.MEMBER
});

async function Balance(catalogId: string): Promise<number> {
    return (await Realm!.repos.wallets.findByUserId(Kit_.MEMBER))?.balances[catalogId] ?? 0;
}

async function Claimed(): Promise<number> {
    return (await Realm!.repos.progressionTracks.get(Kit_.MEMBER, PRESTIGE_SWORD))?.prestigeClaimed ?? 0;
}

/**
 * A running hub of `hubKind` with its member admitted, and the member's character and Rams in a fresh SQLite realm. The P2P side
 * is the realm hub test kit's, with the character-ownership stub the authorization tests use (the kit's stub knows no characters).
 */
async function WithRealm(hubKind: "RAMSGATE" | "TRAINING", body: (scenario: { kit: Kit.HubKit; hub: Kit.RunningHub }) => Promise<void>): Promise<void> {
    const kit = Kit_.CreateHubKit();
    Realm = require("../../persistence/sqlite/testSupport").OpenTestRealm(`inventory-prestige-${hubKind.toLowerCase()}`);
    try {
        await Realm!.repos.characters.create({ characterId: CHARACTER, userId: Kit_.MEMBER, createdDate: "2026-10-14T00:00:00.000Z",
            lastModifiedDate: "2026-10-14T00:00:00.000Z", name: "Member", updateVersion: 1, data: "{}" });
        // The member starts with Rams, so a refused transaction's Rams credit would show in the balance.
        await Realm!.repos.wallets.createIfMissing({ userId: Kit_.MEMBER, balances: { [NOTES]: 5000 } });
        const hub = await Kit_.StartRunningHub(kit, { hubKind });
        const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: Kit_.REALM_ID, accountId: Kit_.MEMBER,
            peerId: require("../security/transportPeerIds").DeriveIcePeerId(Kit_.MEMBER), candidateId: "candidate-member", now: iso(), expiresAt: iso(90_000) });
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId: Kit_.MEMBER,
            admissionId: "admission-member", admittedAt: iso(), now: iso(), route: "relay" });
        require("../security/hostCapabilities").InvalidateHubPresence(hub.sessionId);
        P2PPersistence.UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: { findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
                characterId === CHARACTER && userId === Kit_.MEMBER ? { characterId, userId } : undefined },
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined }
        } as unknown as P2PRepositoryProvider);
        await body({ kit, hub });
    } finally {
        P2PPersistence.UseP2PPersistenceForTest(undefined);
        kit.dispose();
        await Realm!.cleanup();
        Realm = undefined;
    }
}

const Post = (hub: Kit.RunningHub, transactionId: string, stacked: Array<{ catalogId: string; quantity: number }>, extra: Record<string, unknown> = {}) =>
    Send("POST", "/inventory", HostHeaders(hub), { characterId: CHARACTER, transactionId, addStackedItems: stacked, ...extra });

test("a Ramsgate hub's host posts a prestige-gated reward that banked prestige funds: accepted, paid, and its level claimed", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 1);
        const Result = await Post(hub, "hub-aether-funded-1", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Result.status, 200, JSON.stringify(Result.json));
        assert.equal(await Balance(AETHERHEART), 1);
        assert.equal(await Claimed(), 1, "the banked level is claimed in the same transaction");
        assert.equal(await Balance(NOTES), 5000);
    });
});

test("the same reward without banked prestige is refused (409), and the transaction it sits in is aborted whole", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        const Refused = await Post(hub, "hub-aether-unfunded-1", [{ catalogId: NOTES, quantity: 100 }, { catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Refused.status, 409, JSON.stringify(Refused.json));
        assert.equal(Refused.json.message, "Insufficient banked prestige progress");
        assert.equal(await Balance(NOTES), 5000, "the Rams in the same transaction did not land");
        assert.equal(await Balance(AETHERHEART), 0);

        const Alone = await Post(hub, "hub-aether-unfunded-2", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Alone.status, 409);
        assert.equal(await Claimed(), 0, "the refusals claimed nothing");

        // The one banked level still funds the next grant, and it pays once.
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 1);
        const Funded = await Post(hub, "hub-aether-funded-2", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Funded.status, 200, JSON.stringify(Funded.json));
        assert.equal(await Balance(AETHERHEART), 1);
        const Again = await Post(hub, "hub-aether-funded-3", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Again.status, 409, "a banked level pays once");
        assert.equal(await Balance(AETHERHEART), 1);
    });
});

test("the rest of the Hunt Pass class, Platinum and cosmetics stay refused to a hub's host even with prestige banked", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 5);
        for (const [index, catalogId] of ["CURRENCY_REWARDCACHE", "TOKEN_HUNTPASS_PRESTIGE_S08A", "CURRENCY_PLATINUM"].entries()) {
            const Result = await Post(hub, `hub-denied-${index}`, [{ catalogId, quantity: 1 }]);
            assert.equal(Result.status, 403, catalogId);
            assert.equal(Result.json.code, "P2P_HOST_GRANT_DENIED", catalogId);
        }
        const Cosmetic = await Post(hub, "hub-denied-cosmetic", [], { addInstancedItems: [{ catalogId: "DYE_BABYBLUE_DURABLE", instanceId: "dye-1" }] });
        assert.equal(Cosmetic.status, 403);
        assert.equal(Cosmetic.json.code, "P2P_HOST_GRANT_DENIED");
        assert.equal(await Balance(AETHERHEART), 0);
        assert.equal(await Claimed(), 0);
    });
});

/** The same session as a hunt: a frozen roster and character for the member, a completing hunt (not a no-reward session). */
function TurnIntoHunt(kit: Kit.HubKit, hub: Kit.RunningHub): void {
    const Record = kit.hunts.hunts.get(hub.sessionId)!;
    const roster = [Kit_.HOST, Kit_.MEMBER].map((accountId, index) => ({
        accountId, steamId: require("../security/transportPeerIds").DeriveIcePeerId(accountId), candidateId: `candidate-${index}`,
        reconnectEpoch: 0, admissionState: "ADMITTED"
    }));
    kit.hunts.hunts.set(hub.sessionId, { ...Record, sessionKind: undefined, hubKind: undefined, realmId: undefined,
        guardCompletionMode: "END_OF_HUNT", roster, frozenLoadouts: [{ accountId: Kit_.MEMBER, characterId: CHARACTER }] } as any);
}

test("in a hunt the host's prestige-gated reward is paid the same way: the hunt's member, on her frozen character, with banked prestige", async () => {
    await WithRealm("RAMSGATE", async ({ kit, hub }) => {
        TurnIntoHunt(kit, hub);
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 1);
        const Result = await Post(hub, "hunt-aether-1", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Result.status, 200, JSON.stringify(Result.json));
        assert.equal(await Balance(AETHERHEART), 1);
        assert.equal(await Claimed(), 1);
        const Denied = await Post(hub, "hunt-denied-1", [{ catalogId: "CURRENCY_REWARDCACHE", quantity: 1 }]);
        assert.equal(Denied.status, 403);
        assert.equal(Denied.json.code, "P2P_HOST_GRANT_DENIED");
    });
});

// [2026-10-17] The Sparkforge's "forge Aetherhearts" (wallet.ts SparkforgeFundedHearts): one transaction that removes Aethersparks
// and adds Aether Hearts, 200 Sparks a Heart (the Heart's catalog price). It was refused as an unfunded reforge reward
// (source "convert_aethersparks_to_aetherhearts").
const AETHERSPARK = "CURRENCY_PJM_PRESTIGE_EMPTY";
const Convert = (hub: Kit.RunningHub, transactionId: string, hearts: number, sparks: number) =>
    Post(hub, transactionId, [{ catalogId: AETHERHEART, quantity: hearts }],
        { removeStackedItems: [{ catalogId: AETHERSPARK, quantity: sparks }], source: "convert_aethersparks_to_aetherhearts" });

test("the Sparkforge converts 800 Aethersparks into 4 Aether Hearts without banked prestige", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.wallets.incrementBalance(Kit_.MEMBER, AETHERSPARK, 1000);
        const Result = await Convert(hub, "forge-aether-1", 4, 800);
        assert.equal(Result.status, 200, JSON.stringify(Result.json));
        assert.equal(await Balance(AETHERHEART), 4);
        assert.equal(await Balance(AETHERSPARK), 200, "the Sparks are taken");
        assert.equal(await Claimed(), 0, "no reforge level is claimed");
    });
});

test("a conversion leaves banked reforge levels unclaimed, so the reforge's own Heart is still paid after it", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.wallets.incrementBalance(Kit_.MEMBER, AETHERSPARK, 400);
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 1);
        const Converted = await Convert(hub, "forge-aether-2", 2, 400);
        assert.equal(Converted.status, 200, JSON.stringify(Converted.json));
        assert.equal(await Claimed(), 0, "the conversion did not use the banked level");
        const Reward = await Post(hub, "reforge-reward-1", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Reward.status, 200, JSON.stringify(Reward.json));
        assert.equal(await Balance(AETHERHEART), 3);
        assert.equal(await Claimed(), 1);
    });
});

test("a conversion short of Sparks is refused whole: 600 Sparks pay 3 Hearts, the 4th needs prestige; too few owned is an overspend", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.wallets.incrementBalance(Kit_.MEMBER, AETHERSPARK, 700);
        const Short = await Convert(hub, "forge-aether-short", 4, 600);
        assert.equal(Short.status, 409, JSON.stringify(Short.json));
        assert.equal(Short.json.message, "Insufficient banked prestige progress");
        const Overspend = await Convert(hub, "forge-aether-overspend", 4, 800);
        assert.equal(Overspend.status, 409, JSON.stringify(Overspend.json));
        assert.equal(Overspend.json.message, "Insufficient balance");
        assert.equal(await Balance(AETHERHEART), 0, "neither refused transaction paid a Heart");
        assert.equal(await Balance(AETHERSPARK), 700, "nor took a Spark");
    });
});

test("Sparks removed alone (a reforge's cost, 100) fund nothing, and a Heart alone still needs banked prestige", async () => {
    await WithRealm("RAMSGATE", async ({ hub }) => {
        await Realm!.repos.wallets.incrementBalance(Kit_.MEMBER, AETHERSPARK, 300);
        const Cost = await Send("POST", "/inventory", HostHeaders(hub), { characterId: CHARACTER, transactionId: "reforge-cost-1",
            removeStackedItems: [{ catalogId: AETHERSPARK, quantity: 100 }], source: "UPlayerExperienceComponent::ServerPrestigeExperience_Implementation" });
        assert.equal(Cost.status, 200, JSON.stringify(Cost.json));
        assert.equal(await Balance(AETHERSPARK), 200);
        const Heart = await Post(hub, "reforge-reward-unbanked", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Heart.status, 409, "the earlier cost does not pay for a later Heart");
        assert.equal(await Balance(AETHERHEART), 0);
    });
});

// [2026-10-16] A realm's Training hub grants as its Ramsgate does (it was a no-reward session, which stalled the Training
// Grounds tutorial): the prestige-gated reward is paid there the same way, funded by banked prestige.
test("a Training hub pays the prestige-gated reward the way a Ramsgate hub does", async () => {
    await WithRealm("TRAINING", async ({ hub }) => {
        await Realm!.repos.progressionTracks.increment(Kit_.MEMBER, PRESTIGE_SWORD, 1);
        const Result = await Post(hub, "dojo-aether-1", [{ catalogId: AETHERHEART, quantity: 1 }]);
        assert.equal(Result.status, 200, JSON.stringify(Result.json));
        assert.equal(await Balance(AETHERHEART), 1);
        assert.equal(await Claimed(), 1);
    });
});
