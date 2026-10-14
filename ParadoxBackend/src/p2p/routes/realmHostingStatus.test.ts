/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { NextFunction, Request, Response } from "express";
import { LauncherApiError, SendLauncherError } from "../security/p2pErrors";
import { CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, StartRunningHub } from "../realm/realmHubTestKit";
import { ConsumeAdmissionTicket } from "../controllers/p2pAdmission";
import { CreateJoinBootstrap } from "../controllers/p2pLauncher";
import { RouteP2PHunt } from "../controllers/p2pMatchmaking";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { HuntRouteContext } from "../../extensions/p2p";
import { CreateRealmHostingRouter } from "./realmHosting";

// [2026-10-14 realms S3, design section 6.2] GET /launcher/v1/realm-hosting/status over HTTP, on the real router and controllers with
// in-memory repositories. The launcher sign-in needs MongoDB, so the router sits behind a stand-in that reads the account from the
// x-test-user header.

let restoreEnvironment: () => void;
let server: http.Server;
let port: number;

function FakeAuth(req: Request, res: Response, next: NextFunction) {
    const user = req.headers["x-test-user"];
    if (typeof user !== "string") {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }
    (req as any).LauncherAuthData = { userId: user };
    next();
}

before(async () => {
    restoreEnvironment = InstallHubTestEnvironment();
    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmHostingRouter({ auth: FakeAuth, guards: { hosting: (_req, _res, next) => next(), active: (_req, _res, next) => next() } }));
    app.use((_req, res) => { res.status(404).send(); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
    port = (server.address() as AddressInfo).port;
});

after(async () => {
    // Pooled keep-alive sockets would keep this process alive after the tests; close every connection before the close.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnvironment();
});

interface Reply { status: number; json: any }

function Get(user: string | undefined, path = "/launcher/v1/realm-hosting/status"): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (user !== undefined) headers["x-test-user"] = user;
        // One connection per request (no pooled keep-alive socket left open for the process to wait on).
        const request = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers, agent: false }, (res) => {
            let text = "";
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? JSON.parse(text) : undefined }));
        });
        request.on("error", reject);
        request.end();
    });
}

/** The member's launcher routed its hunt request, the host's hunt (a realm hunt) was created; nothing is started on it. */
async function RealmHuntRequested(kit: HubKit, partyId: string, members: string[]): Promise<void> {
    kit.addParty(partyId, members);
    for (const member of members) {
        kit.linkAccount(member);
        kit.realms.bindPresence(member, REALM_ID);
    }
    const context: HuntRouteContext = {
        gameMode: "ISLAND", huntId: "ShatteredIsles_IslandA", playerId: members[0], isHub: false, partyId,
        partyMembers: members, partyRevision: 1,
        setCandidate: () => undefined,
        cancel: () => true
    };
    await RouteP2PHunt(context);
}

/** A member admitted into the hub: its entry, its join ticket, the host's consume. */
async function Admit(kit: HubKit, hub: Awaited<ReturnType<typeof StartRunningHub>>, accountId: string): Promise<void> {
    kit.linkAccount(accountId);
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: crypto.randomUUID(), now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90_000).toISOString() });
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    await ConsumeAdmissionTicket({
        sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "handle-status", requestId: crypto.randomUUID(),
        capability: kit.hunts.capabilities.get(hub.capabilityId)!
    });
}

test("the realm's host reads its status: the hub, the realm hunts and the players with where they are", async () => {
    const kit = CreateHubKit();
    try {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await RealmHuntRequested(kit, "party-status", [FRIEND]);
        kit.realms.names.set(MEMBER, "Member One");
        kit.realms.names.set(HOST, "Host One");
        kit.realms.names.set(FRIEND, "Friend");

        const reply = await Get(HOST);
        assert.equal(reply.status, 200);
        const body = reply.json;
        assert.deepEqual(body.realm, { name: "friends", serving: true });
        assert.equal(body.hub.sessionId, hub.sessionId);
        assert.equal(body.hub.state, "RUNNING");
        assert.equal(typeof body.hub.startedAt, "string");
        assert.equal(body.hub.players, 2, "the host and the admitted member");
        assert.equal(body.training, null);
        assert.equal(body.hunts.length, 1);
        assert.equal(body.hunts[0].huntId, "ShatteredIsles_IslandA");
        assert.equal(body.hunts[0].state, "HOST_OFFERED");
        assert.equal(body.hunts[0].players, 0);

        const hubPlayers = body.players.filter((player: any) => player.where.kind === "HUB");
        assert.deepEqual(hubPlayers.map((player: any) => player.accountId).sort(), [HOST, MEMBER].sort());
        const member = hubPlayers.find((player: any) => player.accountId === MEMBER);
        assert.equal(member.displayName, "Member One");
        assert.deepEqual(member.where, { kind: "HUB", sessionId: hub.sessionId });
        assert.equal(typeof member.since, "string");
        assert.equal(member.route, undefined, "no route is reported until the member's transport says so");
    } finally {
        kit.dispose();
    }
});

test("only the realm's host reads the status: a member who hosts nothing gets REALM_NOT_FOUND", async () => {
    const kit = CreateHubKit();
    try {
        await StartRunningHub(kit);
        const reply = await Get(MEMBER);
        assert.equal(reply.status, 404);
        assert.equal(reply.json?.error?.code, "REALM_NOT_FOUND");
    } finally {
        kit.dispose();
    }
});

test("the status needs a launcher sign-in", async () => {
    const reply = await Get(undefined);
    assert.equal(reply.status, 401);
    assert.equal(reply.json?.error?.code, "AUTH_UNAUTHORIZED");
});
