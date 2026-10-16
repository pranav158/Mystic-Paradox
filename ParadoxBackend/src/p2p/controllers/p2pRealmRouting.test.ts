/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { HuntRouteContext } from "../../extensions/p2p";
import { P2PControlMessageRecord } from "../persistence";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, LOCAL_BRIDGE_PORT, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { ConsumeAdmissionTicket, MarkHostReady } from "./p2pAdmission";
import { P2PCandidateStatus, RestoreP2PCandidate, RouteP2PHunt } from "./p2pMatchmaking";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "./p2pLauncher";
import { EndRealmHub, HandleRealmEvent } from "./realmHubLifecycle";
import { HashHostCapabilitySecret } from "../security/hostCapabilities";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { roomService } from "../../realtime/RoomService";
import { WithEnvironment } from "../huntManifest/huntTablesTestKit";

// [2026-10-15] The dedicated route exists only with a DeployServer (DEPLOYSERVER_URL); the two official-route tests below need it.
const DEPLOYSERVER = "deployserver.invalid:8080";

/*
 * A realm member's matchmaking requests (RouteP2PHunt -> RouteRealmRequest) on the in-memory repositories: the Ramsgate and Training
 * hubs (placement, the host's own entry, membership, bans, offline, full, party filtering, the on-demand Training start), the realm
 * hunt's creation and refusals, and the candidate's status (SourceSessionId, the hub's own readiness).
 */

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

async function WithKit(body: (kit: HubKit) => Promise<void>, options: Parameters<typeof CreateHubKit>[0] = {}): Promise<void> {
    const kit = CreateHubKit(options);
    try { await body(kit); } finally { kit.dispose(); }
}

interface Harness {
    context: HuntRouteContext;
    candidates: Map<string, MatchmakingResult>;
    cancels: Array<{ huntId: string; accountIds: string[]; reason: string }>;
}

/** A route context for one request; the candidates it sets and the cancellations it makes are recorded. */
function Harness(playerId: string, overrides: Partial<HuntRouteContext> = {}): Harness {
    const candidates = new Map<string, MatchmakingResult>();
    const cancels: Harness["cancels"] = [];
    const context: HuntRouteContext = {
        gameMode: "CITY",
        huntId: "ShatteredIsles_ReturnToRamsgate",
        playerId,
        isHub: true,
        setCandidate: (accountId, result) => { candidates.set(accountId, result); },
        cancel: (huntId, accountIds, reason) => {
            cancels.push({ huntId, accountIds: [...accountIds], reason });
            return true;
        },
        ...overrides
    };
    return { context, candidates, cancels };
}

function Messages(kit: HubKit, accountId: string, messageType: string): P2PControlMessageRecord[] {
    return kit.hunts.controlMessages.filter((message) => message.accountId === accountId && message.messageType === messageType);
}

/** A member's whole entry into a running hub, as the member's launcher drives it (presence row, join ticket, the host's consume). */
async function Admit(kit: HubKit, hub: RunningHub, accountId: string) {
    kit.linkAccount(accountId);
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: crypto.randomUUID(), now: iso(), expiresAt: iso(90_000) });
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    await ConsumeAdmissionTicket({
        sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "handle-1", requestId: crypto.randomUUID(),
        capability: kit.hunts.capabilities.get(hub.capabilityId)!
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Ramsgate
// ---------------------------------------------------------------------------------------------------------------

test("Ramsgate: a member is placed in the running hub with a fresh entry, asked to join at once, and the host is told a peer is expected", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER);

        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        assert.deepEqual(h.cancels, []);
        const candidate = h.candidates.get(MEMBER)!;
        assert.equal(candidate.Source, "REALM_HUB");
        assert.equal(candidate.SourceSessionId, hub.sessionId);
        assert.equal(candidate.GameSessionId, kit.realms.hubRoomId(REALM_ID, "RAMSGATE"));
        assert.equal(candidate.HuntId, "ShatteredIsles_ReturnToRamsgate");
        assert.equal(candidate.Ready, false);

        const row = await kit.presence.findPresence(hub.sessionId, MEMBER);
        assert.equal(row?.state, "PENDING");
        assert.equal(row?.candidateId, candidate.CandidateId);
        const joins = Messages(kit, MEMBER, "JOIN_RENDEZVOUS");
        assert.equal(joins.length, 1);
        assert.equal(joins[0].payload.entryId, candidate.CandidateId);
        assert.equal(joins[0].payload.sessionKind, "REALM_HUB");
        assert.equal(joins[0].payload.hubKind, "RAMSGATE");
        assert.equal(Messages(kit, HOST, "REALM_PEER_EXPECTED").length, 1);
    });
});

test("Ramsgate: the host's own request is ready at once on its loopback port, with no entry of its own", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(HOST, REALM_ID);
        const h = Harness(HOST);

        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        const candidate = h.candidates.get(HOST)!;
        assert.equal(candidate.Ready, true);
        assert.equal(candidate.Host, "127.0.0.1");
        assert.equal(candidate.Port, LOCAL_BRIDGE_PORT);
        assert.equal(candidate.Source, "REALM_HUB");
        // The host's presence row is still its admitted one: no entry was requested for it, and no peer is expected.
        assert.equal((await kit.presence.findPresence(hub.sessionId, HOST))?.state, "ADMITTED");
        assert.equal(Messages(kit, HOST, "REALM_PEER_EXPECTED").length, 0);
    });
});

test("Ramsgate: party members who are not in the realm are left alone (neither placed nor cancelled)", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.addParty("party-ramsgate", [MEMBER, FRIEND, STRANGER]);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.bindPresence(FRIEND, REALM_ID);
        const h = Harness(MEMBER, { partyId: "party-ramsgate", partyMembers: [MEMBER, FRIEND, STRANGER], partyRevision: 1 });

        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        assert.ok(h.candidates.has(MEMBER));
        assert.ok(h.candidates.has(FRIEND));
        assert.equal(h.candidates.has(STRANGER), false);
        assert.deepEqual(h.cancels, []);
    });
});

test("a member who is not in the realm is refused with REALM_NOT_MEMBER, the request cancelled for that account", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.realms.bindPresence(STRANGER, REALM_ID);
        const h = Harness(STRANGER);

        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        assert.deepEqual(h.cancels, [{ huntId: "ShatteredIsles_ReturnToRamsgate", accountIds: [STRANGER], reason: "REALM_NOT_MEMBER" }]);
        assert.equal(h.candidates.size, 0);
    });
});

test("[2026-10-16] a SOLO realm refuses a member's request with REALM_SOLO (no entry); the host's own request is still served", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.realms.realms.get(REALM_ID)!.joinPolicy = "SOLO";
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const member = Harness(MEMBER);
        assert.deepEqual(await RouteP2PHunt(member.context), { handled: true, result: true });
        assert.deepEqual(member.cancels.map((entry) => entry.reason), ["REALM_SOLO"]);
        assert.equal(member.candidates.size, 0);
        assert.equal(Messages(kit, HOST, "REALM_PEER_EXPECTED").length, 0, "the host is not told to expect anyone");

        kit.realms.bindPresence(HOST, REALM_ID);
        const host = Harness(HOST);
        assert.deepEqual(await RouteP2PHunt(host.context), { handled: true, result: true });
        assert.equal(host.candidates.get(HOST)?.Ready, true);
        assert.deepEqual(host.cancels, []);
    });
});

test("a banned member is refused with REALM_BANNED, even though its presence still names the realm", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.bans.add(`${REALM_ID}:${MEMBER}`);
        const h = Harness(MEMBER);

        await RouteP2PHunt(h.context);
        assert.deepEqual(h.cancels.map((entry) => entry.reason), ["REALM_BANNED"]);
        assert.equal(h.candidates.size, 0);
    });
});

test("a hub that is not serving (the realm offline or its Ramsgate not running) cancels with REALM_HOST_OFFLINE", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.setServing(REALM_ID, true, false);
        const h = Harness(MEMBER);

        await RouteP2PHunt(h.context);
        assert.deepEqual(h.cancels.map((entry) => entry.reason), ["REALM_HOST_OFFLINE"]);
    });
});

test("a full hub refuses a new member with REALM_HUB_FULL; a member already present is never refused", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit, { maxPlayers: 2 });
        await Admit(kit, hub, FRIEND);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.bindPresence(FRIEND, REALM_ID);

        const newcomer = Harness(MEMBER);
        await RouteP2PHunt(newcomer.context);
        assert.deepEqual(newcomer.cancels.map((entry) => entry.reason), ["REALM_HUB_FULL"]);

        const present = Harness(FRIEND);
        assert.deepEqual(await RouteP2PHunt(present.context), { handled: true, result: true });
        assert.deepEqual(present.cancels, []);
        assert.equal(present.candidates.get(FRIEND)?.Ready, false);
    });
});

test("two members racing for the last seat: exactly one is placed, the other is refused REALM_HUB_FULL and gets no entry", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit, { maxPlayers: 2 }); // the host holds one of the two seats
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.bindPresence(FRIEND, REALM_ID);
        const racers = [Harness(MEMBER), Harness(FRIEND)];

        await Promise.all(racers.map((racer) => RouteP2PHunt(racer.context)));

        const refused = racers.filter((racer) => racer.cancels.length > 0);
        const placed = racers.filter((racer) => racer.cancels.length === 0);
        assert.equal(placed.length, 1);
        assert.equal(refused.length, 1);
        assert.deepEqual(refused[0].cancels.map((entry) => entry.reason), ["REALM_HUB_FULL"]);
        assert.equal(refused[0].candidates.size, 0, "a refused member is given no candidate");
        const winner = [MEMBER, FRIEND].find((accountId) => placed[0].candidates.has(accountId))!;
        const loser = winner === MEMBER ? FRIEND : MEMBER;
        assert.equal((await kit.presence.findPresence(hub.sessionId, winner))?.state, "PENDING");
        assert.equal(await kit.presence.findPresence(hub.sessionId, loser), undefined, "no row for the refused member");
        assert.equal(await kit.presence.countByState(hub.sessionId, hub.generation, ["PENDING", "TICKETED", "ADMITTED"]), 2);
    });
});

test("Ramsgate with hosting off: a realm member is routed as before (no realm branch, no presence read)", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const saved = process.env.MYSTICPARADOX_REALMS_HOSTING;
        process.env.MYSTICPARADOX_REALMS_HOSTING = "off";
        try {
            const h = Harness(MEMBER);
            // The dedicated route (no hunt in the way): RouteP2PHunt answers handled=false for a request it does not own.
            assert.deepEqual(await RouteP2PHunt(h.context), { handled: false });
            assert.equal(h.candidates.size, 0);
            assert.deepEqual(h.cancels, []);
        } finally {
            if (saved === undefined) delete process.env.MYSTICPARADOX_REALMS_HOSTING;
            else process.env.MYSTICPARADOX_REALMS_HOSTING = saved;
        }
    });
});

test("without a realm presence a request is routed as before (the realm branch does not apply)", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        const h = Harness(MEMBER);
        assert.deepEqual(await RouteP2PHunt(h.context), { handled: false });
        assert.equal(h.candidates.size, 0);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Training: on demand
// ---------------------------------------------------------------------------------------------------------------

test("Training: with no Training hub the host is asked to start one; the member waits, and joins once the hub runs", async () => {
    await WithKit(async (kit) => {
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER, { gameMode: "SHARED", huntId: "ShatteredIsles_TrainingDojo" });

        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        const candidate = h.candidates.get(MEMBER)!;
        assert.equal(candidate.Ready, false);
        assert.equal(candidate.HuntId, "ShatteredIsles_TrainingDojo");
        const training = [...kit.hunts.hunts.values()].find((hunt) => hunt.hubKind === "TRAINING")!;
        assert.equal(training.state, "HOST_OFFERED");
        assert.equal(candidate.GameSessionId, kit.realms.hubRoomId(REALM_ID, "TRAINING"));
        assert.equal(candidate.SourceSessionId, training.sessionId);
        assert.equal(Messages(kit, HOST, "HUNT_BOOTSTRAP").length, 1);
        assert.equal(Messages(kit, MEMBER, "JOIN_RENDEZVOUS").length, 0, "no join before the hub runs");

        // The host's launcher brings the hub up: bootstrap, ready, the route-ready. The waiting member is asked to join now.
        const bootstrap = await CreateHostBootstrap(HOST, training.sessionId);
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        await MarkHostReady({ sessionId: training.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MarkLocalRouteReady(HOST, training.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId,
            localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
        assert.equal(kit.hunts.hunts.get(training.sessionId)?.state, "RUNNING");
        const joins = Messages(kit, MEMBER, "JOIN_RENDEZVOUS");
        assert.equal(joins.length, 1);
        assert.equal(joins[0].payload.entryId, candidate.CandidateId);
        assert.equal(joins[0].payload.hubKind, "TRAINING");

        // Still waiting for its own join: not ready, not cancelled.
        const status = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(status?.Canceled, undefined);
        assert.equal(status?.Ready, false);
    });
});

test("Training: a hub that did not start within 90 s cancels the waiting member with REALM_HUB_START_TIMEOUT", async () => {
    await WithKit(async (kit) => {
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER, { gameMode: "SHARED", huntId: "ShatteredIsles_TrainingDojo" });
        await RouteP2PHunt(h.context);
        const candidate = h.candidates.get(MEMBER)!;
        const training = [...kit.hunts.hunts.values()].find((hunt) => hunt.hubKind === "TRAINING")!;
        kit.hunts.hunts.get(training.sessionId)!.createdAt = iso(-100_000);

        const status = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(status?.Canceled, true);
        assert.equal(status?.StatusReason, "REALM_HUB_START_TIMEOUT");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Hunts
// ---------------------------------------------------------------------------------------------------------------

/** A realm hunt of the party (the requester first); the host is the realm's host and is not in the party. */
async function RealmHunt(kit: HubKit, partyId: string, members: string[], huntId = "ShatteredIsles_IslandA") {
    kit.addParty(partyId, members);
    for (const member of members) {
        kit.linkAccount(member);
        kit.realms.bindPresence(member, REALM_ID);
    }
    const h = Harness(members[0], { gameMode: "ISLAND", huntId, isHub: false, partyId, partyMembers: members, partyRevision: 1 });
    const outcome = await RouteP2PHunt(h.context);
    const hunt = [...kit.hunts.hunts.values()].find((entry) => entry.realmId === REALM_ID && entry.partyId === partyId);
    return { outcome, harness: h, hunt };
}

test("a realm hunt is created with the realm's host (a non-playing host) and offered to it; the members are on the frozen roster", async () => {
    await WithKit(async (kit) => {
        const { outcome, harness, hunt } = await RealmHunt(kit, "party-hunt", [MEMBER, FRIEND]);
        assert.deepEqual(outcome, { handled: true, result: true });
        assert.deepEqual(harness.cancels, []);
        assert.ok(hunt, "a realm hunt exists");
        assert.equal(hunt!.state, "HOST_OFFERED");
        assert.equal(hunt!.hostAccountId, HOST);
        assert.equal(hunt!.hostSteamId, DeriveIcePeerId(HOST));
        assert.equal(hunt!.hostParticipates, false);
        assert.deepEqual(hunt!.roster.map((entry) => entry.accountId), [MEMBER, FRIEND]);
        assert.equal(Messages(kit, HOST, "HOST_OFFERED").length, 1);
        for (const member of [MEMBER, FRIEND]) {
            const candidate = harness.candidates.get(member)!;
            assert.equal(candidate.GameSessionId, hunt!.sessionId);
            assert.equal(candidate.Source, undefined, "a hunt candidate is not a hub candidate");
        }
    });
});

test("a realm hunt needs its realm's Ramsgate serving (REALM_HOST_OFFLINE otherwise), and no hunt is created", async () => {
    await WithKit(async (kit) => {
        kit.realms.setServing(REALM_ID, true, false);
        const { harness, hunt } = await RealmHunt(kit, "party-offline", [MEMBER, FRIEND]);
        assert.deepEqual(harness.cancels.map((entry) => entry.reason), ["REALM_HOST_OFFLINE"]);
        assert.equal(hunt, undefined);
    });
});

test("every hunt class routes as a realm hunt (Trials, arena, leaderboard, race, competitive, escalation, heroic, patrol); FTUE stays refused", async () => {
    // The race, competitive and leaderboard ids are labelled stand-ins: the 1.14.7 hunt tables have no such hunt ids. One kit per
    // class, because a realm's hunts share its host's capacity and this test is about the routing decision.
    const classes: Array<[string, string]> = [
        ["trials", "Trials_Island_01"],
        ["arena", "CR19_PlayerHunt_Arena_Elite"],
        ["leaderboard", "CR19_PlayerHunt_Leaderboard_Synthetic"],
        ["race", "CR19_PlayerHunt_Race_Synthetic"],
        ["competitive", "CR19_PlayerHunt_Competitive_Synthetic"],
        ["escalation", "CR19_MatchmakerHunt_Escalation_Thunderbird"],
        ["heroic", "CR19_MatchmakerHunt_Beaver_Heroic"],
        ["patrol", "AdventurePatrol_Blaze"]
    ];
    for (const [name, huntId] of classes) {
        await WithKit(async (kit) => {
            const { harness, hunt } = await RealmHunt(kit, `party-${name}`, [MEMBER], huntId);
            assert.deepEqual(harness.cancels, [], `${name} (${huntId}) is not refused`);
            assert.equal(hunt?.realmId, REALM_ID, `${name} (${huntId}) is a realm hunt`);
            assert.equal(hunt?.huntDefinitionId, huntId);
        });
    }
    await WithKit(async (kit) => {
        const ftue = await RealmHunt(kit, "party-ftue", [MEMBER], "CR19_PlayerHunt_FTUE_Pursuit_Beta_Beaver");
        assert.deepEqual(ftue.harness.cancels.map((entry) => entry.reason), ["REALM_HUNT_RUNTIME_INCOMPATIBLE"]);
        assert.equal(ftue.hunt, undefined);
    });
});

test("Gauntlet is refused for realm members with MYSTICPARADOX_GAUNTLET off (GAUNTLET_DISABLED, no hunt) and is a realm hunt with it on", async () => {
    const saved = process.env.MYSTICPARADOX_GAUNTLET;
    try {
        for (const huntId of ["CR19_PlayerHunt_Gauntlet", "CR19_MatchmakerHunt_Gauntlet"]) {
            await WithKit(async (kit) => {
                delete process.env.MYSTICPARADOX_GAUNTLET;
                const refused = await RealmHunt(kit, "party-gauntlet-off", [MEMBER], huntId);
                assert.deepEqual(refused.harness.cancels, [{ huntId, accountIds: [MEMBER], reason: "GAUNTLET_DISABLED" }]);
                assert.equal(refused.hunt, undefined, `${huntId} creates no hunt while it is disabled`);

                process.env.MYSTICPARADOX_GAUNTLET = "on";
                const allowed = await RealmHunt(kit, "party-gauntlet-on", [MEMBER], huntId);
                assert.deepEqual(allowed.harness.cancels, []);
                assert.equal(allowed.hunt?.realmId, REALM_ID, `${huntId} is a realm hunt with the switch on`);
            });
        }
    } finally {
        if (saved === undefined) delete process.env.MYSTICPARADOX_GAUNTLET;
        else process.env.MYSTICPARADOX_GAUNTLET = saved;
    }
});

test("Gauntlet is refused on the player-hosted route for a player with no realm (GAUNTLET_DISABLED); with the switch on it stays on the dedicated route", async () => {
    const saved = process.env.MYSTICPARADOX_GAUNTLET;
    try {
        await WithEnvironment({ DEPLOYSERVER_URL: DEPLOYSERVER }, () => WithKit(async (kit) => {
            kit.addParty("party-p2p-gauntlet", [STRANGER]);
            kit.linkAccount(STRANGER);
            const request = () => Harness(STRANGER, { gameMode: "ISLAND", huntId: "CR19_PlayerHunt_Gauntlet", isHub: false,
                partyId: "party-p2p-gauntlet", partyMembers: [STRANGER], partyRevision: 1 });

            delete process.env.MYSTICPARADOX_GAUNTLET;
            const refused = request();
            assert.deepEqual(await RouteP2PHunt(refused.context), { handled: true, result: true });
            assert.deepEqual(refused.cancels.map((entry) => entry.reason), ["GAUNTLET_DISABLED"]);

            // With the switch on, the account is not on the player-hosted allowlist, so the request is the dedicated route's, as before.
            process.env.MYSTICPARADOX_GAUNTLET = "on";
            const allowed = request();
            assert.deepEqual(await RouteP2PHunt(allowed.context), { handled: false });
            assert.deepEqual(allowed.cancels, []);
        }));
    } finally {
        if (saved === undefined) delete process.env.MYSTICPARADOX_GAUNTLET;
        else process.env.MYSTICPARADOX_GAUNTLET = saved;
    }
});

test("official routing is unchanged for a player with no realm: a solo request and a Trials request stay on the dedicated route", async () => {
    await WithEnvironment({ DEPLOYSERVER_URL: DEPLOYSERVER }, () => WithKit(async (kit) => {
        kit.linkAccount(STRANGER);
        const solo = Harness(STRANGER, { gameMode: "ISLAND", huntId: "ShatteredIsles_IslandA", isHub: false });
        assert.deepEqual(await RouteP2PHunt(solo.context), { handled: false });
        assert.deepEqual(solo.cancels, []);

        kit.addParty("party-official-trial", [STRANGER]);
        const trial = Harness(STRANGER, { gameMode: "ISLAND", huntId: "Trials_Island_01", isHub: false,
            partyId: "party-official-trial", partyMembers: [STRANGER], partyRevision: 1 });
        assert.deepEqual(await RouteP2PHunt(trial.context), { handled: false });
        assert.deepEqual(trial.cancels, []);
    }));
});

test("a realm member's request with no party state becomes a realm hunt with a one-member roster, on its own solo party", async () => {
    await WithKit(async (kit) => {
        kit.linkAccount(MEMBER);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER, { gameMode: "ISLAND", huntId: "ShatteredIsles_IslandA", isHub: false, buildId: "647472_rel-1.14.7_shipping" });
        assert.deepEqual(await RouteP2PHunt(h.context), { handled: true, result: true });
        assert.deepEqual(h.cancels, []);

        const hunt = [...kit.hunts.hunts.values()].find((entry) => entry.realmId === REALM_ID);
        assert.ok(hunt, "a realm hunt exists");
        assert.equal(hunt!.state, "HOST_OFFERED");
        assert.equal(hunt!.hostAccountId, HOST);
        assert.equal(hunt!.hostParticipates, false);
        assert.equal(hunt!.partyId, `solo-${MEMBER}`);
        assert.deepEqual(hunt!.roster.map((entry) => entry.accountId), [MEMBER]);
        assert.equal(h.candidates.get(MEMBER)?.GameSessionId, hunt!.sessionId);
        assert.equal(h.candidates.get(MEMBER)?.Source, undefined, "a hunt candidate is not a hub candidate");
    });
});

test("a realm host whose server cap is reached refuses the hunt with REALM_FULL at once, and the member's status says so", async () => {
    await WithKit(async (kit) => {
        const realm = kit.realms.realms.get(REALM_ID)!;
        kit.realms.realms.set(REALM_ID, { ...realm, hosting: { maxServers: 1, maxPlayers: 16 } });
        const first = await RealmHunt(kit, "party-one", [MEMBER]);
        assert.ok(first.hunt);
        assert.equal(first.hunt!.state, "HOST_OFFERED");

        const second = await RealmHunt(kit, "party-two", [FRIEND]);
        assert.equal(second.hunt?.state, "ABORTED");
        assert.equal(second.hunt?.failureReason, "REALM_FULL");
        const status = await P2PCandidateStatus(FRIEND, second.harness.candidates.get(FRIEND)!);
        assert.equal(status?.Canceled, true);
        assert.equal(status?.StatusReason, "REALM_FULL");
    });
});

test("a realm member's hunt is started only with its realm's party state and never with a stale revision", async () => {
    await WithKit(async (kit) => {
        kit.addParty("party-stale", [MEMBER], 5);
        kit.linkAccount(MEMBER);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER, { gameMode: "ISLAND", huntId: "ShatteredIsles_IslandA", isHub: false, partyId: "party-stale",
            partyMembers: [MEMBER], partyRevision: 1 });
        await RouteP2PHunt(h.context);
        assert.deepEqual(h.cancels.map((entry) => entry.reason), ["PARTY_REVISION_CONFLICT"]);
    });
});

test("the candidate is released once the member is admitted with its route published, and is restored from the live entry after a restart", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER);
        await RouteP2PHunt(h.context);
        const candidate = h.candidates.get(MEMBER)!;

        // The entry is pending: no route yet, not ready, not cancelled.
        const pending = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(pending?.Ready, false);
        assert.equal(pending?.Canceled, undefined);

        // The member's launcher publishes its loopback route, then the host admits it (its ticket is consumed).
        await kit.presence.markRouteReady({ sessionId: hub.sessionId, generation: hub.generation, accountId: MEMBER,
            localBridgePort: 56000, readyAt: iso(), now: iso() });
        assert.equal(((await kit.presence.findPresence(hub.sessionId, MEMBER))?.state), "PENDING");
        await Admit(kit, hub, MEMBER);
        assert.equal(((await kit.presence.findPresence(hub.sessionId, MEMBER))?.state), "ADMITTED");
        assert.equal(((await kit.presence.findPresence(hub.sessionId, MEMBER))?.candidateId), candidate.CandidateId);

        const released = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(released?.Ready, true);
        assert.equal(released?.Host, "127.0.0.1");
        assert.equal(released?.Port, 56000);

        // After a restart the candidate is restored from the member's live entry, with the hub as its source.
        h.candidates.clear();
        const restored = await RestoreP2PCandidate(MEMBER);
        assert.equal(restored?.Source, "REALM_HUB");
        assert.equal(restored?.SourceSessionId, hub.sessionId);
        assert.equal(restored?.GameSessionId, kit.realms.hubRoomId(REALM_ID, "RAMSGATE"));
        assert.equal(restored?.CandidateId, candidate.CandidateId);
        assert.equal(await RestoreP2PCandidate(STRANGER), undefined);
    });
});

test("a candidate whose hub ended is cancelled with the hub's reason; a lost entry is cancelled with REALM_ENTRY_LOST", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        kit.realms.bindPresence(FRIEND, REALM_ID);
        const h = Harness(MEMBER);
        await RouteP2PHunt(h.context);
        const candidate = h.candidates.get(MEMBER)!;

        // A member's entry lost (its link closed before it was admitted): cancelled as lost.
        await kit.presence.endSession({ sessionId: hub.sessionId, generation: hub.generation, at: iso(), purgeAt: iso(1_000_000) });
        const lost = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(lost?.Canceled, true);
        assert.equal(lost?.StatusReason, "REALM_ENTRY_LOST");
    });

    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER);
        await RouteP2PHunt(h.context);
        const candidate = h.candidates.get(MEMBER)!;

        // The hub itself ended (the host stopped it): the candidate is cancelled with the hub's reason.
        await EndRealmHub(hub.sessionId, hub.generation, "HOST_STOPPED", "COMPLETED", { actorType: "HOST", actorAccountId: HOST });
        const ended = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(ended?.Canceled, true);
        assert.equal(ended?.StatusReason, "HOST_STOPPED");
    });
});

test("a waiting entry that expired is cancelled with REALM_ENTRY_EXPIRED", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.realms.bindPresence(MEMBER, REALM_ID);
        const h = Harness(MEMBER);
        await RouteP2PHunt(h.context);
        const candidate = h.candidates.get(MEMBER)!;
        // The stored row's wait lapses (findPresence answers copies, so the stored row is changed directly).
        for (const row of kit.presence.rows.values()) if (row.accountId === MEMBER && row.sessionId === hub.sessionId) row.expiresAt = iso(-1_000);
        const status = await P2PCandidateStatus(MEMBER, candidate);
        assert.equal(status?.StatusReason, "REALM_ENTRY_EXPIRED");
    });
});

test("a kick, a ban or a leave of a realm member reaches the chat: the realm event sink evicts it from the realm's hub rooms", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        const evicted: string[] = [];
        const original = roomService.evictRealmMember;
        roomService.evictRealmMember = (realmId: string, accountId: string) => { evicted.push(`${realmId}:${accountId}`); };
        try {
            await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: MEMBER, reason: "KICK" });
            await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: FRIEND, reason: "BAN" });
            await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: STRANGER, reason: "LEAVE" });
            await HandleRealmEvent({ type: "HOST_OFFLINE", realmId: REALM_ID, hostAccountId: HOST });
        } finally {
            roomService.evictRealmMember = original;
        }
        assert.deepEqual(evicted, [`${REALM_ID}:${MEMBER}`, `${REALM_ID}:${FRIEND}`, `${REALM_ID}:${STRANGER}`]);
    });
});
