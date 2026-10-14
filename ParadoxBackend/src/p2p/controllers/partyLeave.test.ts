/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";
import type { HuntRouteContext } from "../../extensions/p2p";
import { logger } from "../../logger";
import { P2PHuntParticipantRecord, P2PHuntSessionRecord } from "../persistence";
import { CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, STRANGER } from "../realm/realmHubTestKit";
import { RouteP2PHunt } from "./p2pMatchmaking";
import { RemoveLeaverFromFormingHunt, PartyLeaveDependencies } from "./partyLeave";

// [2026-10-14] A party member who leaves the party while his realm hunt is forming (RemoveLeaverFromFormingHunt), on the in-memory
// repositories of the hub test kit. The hunt is a realm hunt of the party, routed the way p2pCandidateLeave.test.ts routes it.

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

async function WithKit(body: (kit: HubKit) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    try { await body(kit); } finally {
        mock.restoreAll();
        kit.dispose();
    }
}

/** A realm hunt of the party, the requester first. Its members are bound to the realm. */
async function RealmHunt(kit: HubKit, partyId: string, members: string[]): Promise<P2PHuntSessionRecord> {
    kit.addParty(partyId, members);
    for (const member of members) {
        kit.linkAccount(member);
        kit.realms.bindPresence(member, REALM_ID);
    }
    const context: HuntRouteContext = {
        gameMode: "ISLAND",
        huntId: "ShatteredIsles_IslandA",
        playerId: members[0]!,
        isHub: false,
        setCandidate: () => undefined,
        cancel: () => true,
        partyId,
        partyMembers: members,
        partyRevision: 1
    };
    await RouteP2PHunt(context);
    const hunt = [...kit.hunts.hunts.values()].find((entry) => entry.realmId === REALM_ID && entry.partyId === partyId);
    assert.ok(hunt, "the realm hunt was created");
    return hunt!;
}

/** A compare-and-set on the hunt as it is now (the test's way of putting it in a given state). */
async function SetHunt(kit: HubKit, sessionId: string, set: Partial<P2PHuntSessionRecord>): Promise<P2PHuntSessionRecord> {
    const current = (await kit.hunts.findHunt(sessionId))!;
    const next = await kit.hunts.compareAndSetHunt({
        sessionId, generation: current.generation, expectedStates: [current.state], expectedStateVersion: current.stateVersion, set
    });
    assert.ok(next, "the compare-and-set applied");
    return next!;
}

function Entry(accountId: string, overrides: Partial<P2PHuntParticipantRecord> = {}): P2PHuntParticipantRecord {
    return { accountId, steamId: `steam-${accountId}`, candidateId: `candidate-${accountId}`, reconnectEpoch: 0, admissionState: "PENDING", ...overrides };
}

function Resolver(calls: Array<{ huntId: string; players: string[] }> = []): PartyLeaveDependencies {
    return {
        resolveManifest: async (huntId, players) => {
            calls.push({ huntId, players });
            return { expectedPlayerString: `EXPECT-${players.join("+")}` };
        }
    };
}

function Capture(method: "info" | "warn"): string[] {
    const lines: string[] = [];
    mock.method(logger, method, (message: string) => { lines.push(message); });
    return lines;
}

test("a member who left a forming realm hunt is removed: roster, re-resolved expected players, transition and log", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-removed", [FRIEND, MEMBER]);
        assert.equal(Hunt.state, "HOST_OFFERED", "the host has not been given its players yet");
        const Lines = Capture("info");
        const Calls: Array<{ huntId: string; players: string[] }> = [];
        // The in-memory store hands out the live record, so the version is read before the removal.
        const VersionBefore = Hunt.stateVersion;

        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Resolver(Calls)), "REMOVED");

        const After = (await kit.hunts.findHunt(Hunt.sessionId))!;
        assert.deepEqual(After.roster.map((entry) => entry.accountId), [FRIEND]);
        assert.equal(After.expectedPlayerString, `EXPECT-${FRIEND}`, "the expected players are re-resolved for the players left");
        assert.deepEqual(Calls, [{ huntId: Hunt.huntDefinitionId, players: [FRIEND] }]);
        assert.equal(After.stateVersion, VersionBefore + 1, "one compare-and-set");
        assert.equal(After.state, "HOST_OFFERED");
        const Transition = kit.hunts.transitions.find((entry) => entry.reason === "PARTY_MEMBER_LEFT");
        assert.ok(Transition, "the removal is in the hunt's transitions");
        assert.equal(Transition!.actorAccountId, MEMBER);
        assert.equal(Transition!.sessionId, Hunt.sessionId);
        assert.ok(Lines.includes(`[PartyLeave] removed ${MEMBER} from forming hunt ${Hunt.sessionId} (state=HOST_OFFERED, 1 player(s) left)`),
            `the log names the removal; got ${JSON.stringify(Lines)}`);
    });
});

test("a hunt that is already RUNNING is left alone", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-running", [FRIEND, MEMBER]);
        await SetHunt(kit, Hunt.sessionId, { state: "RUNNING" });
        const Calls: Array<{ huntId: string; players: string[] }> = [];

        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Resolver(Calls)), "NOT_FORMING");

        assert.deepEqual((await kit.hunts.findHunt(Hunt.sessionId))!.roster.map((entry) => entry.accountId), [FRIEND, MEMBER]);
        assert.equal(Calls.length, 0, "no manifest is resolved");
    });
});

test("a member who was already admitted is a normal disconnect: the hunt keeps him", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-admitted", [FRIEND, MEMBER]);
        await SetHunt(kit, Hunt.sessionId, { state: "ADMITTING", roster: [Entry(FRIEND), Entry(MEMBER, { admissionState: "ADMITTED" })] });

        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Resolver()), "ADMITTED");

        assert.deepEqual((await kit.hunts.findHunt(Hunt.sessionId))!.roster.map((entry) => entry.accountId), [FRIEND, MEMBER]);
    });
});

test("the host of a forming hunt keeps the hunt: it is not removed and the log says so", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-host", [FRIEND, MEMBER]);
        await SetHunt(kit, Hunt.sessionId, { hostAccountId: HOST, roster: [Entry(FRIEND), Entry(MEMBER), Entry(HOST)] });
        const Lines = Capture("warn");

        assert.equal(await RemoveLeaverFromFormingHunt(HOST, Resolver()), "HOST");

        assert.equal((await kit.hunts.findHunt(Hunt.sessionId))!.roster.length, 3);
        assert.ok(Lines.some((line) => line.includes(`${HOST} left the party but hosts forming hunt ${Hunt.sessionId}`)));
    });
});

test("once the host was handed its players (STARTING), the list is kept and the host is logged as still expecting the member", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-starting", [FRIEND, MEMBER]);
        const Started = await SetHunt(kit, Hunt.sessionId, { state: "STARTING", hostAccountId: HOST });
        const Lines = Capture("warn");
        const Calls: Array<{ huntId: string; players: string[] }> = [];

        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Resolver(Calls)), "REMOVED");

        const After = (await kit.hunts.findHunt(Hunt.sessionId))!;
        assert.deepEqual(After.roster.map((entry) => entry.accountId), [FRIEND]);
        assert.equal(After.expectedPlayerString, Started.expectedPlayerString, "the handed-over list is not rewritten");
        assert.equal(Calls.length, 0, "no re-resolve once the host holds its list");
        assert.ok(Lines.some((line) => line.includes(`host ${HOST} of hunt ${Hunt.sessionId} was given its expected players with the offer and still expects ${MEMBER}`)));
    });
});

test("a failing manifest re-resolve keeps the list and says so; the member is still removed", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-resolver-fails", [FRIEND, MEMBER]);
        const Lines = Capture("warn");
        const Failing: PartyLeaveDependencies = { resolveManifest: async () => { throw new Error("resolver down"); } };

        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Failing), "REMOVED");

        const After = (await kit.hunts.findHunt(Hunt.sessionId))!;
        assert.deepEqual(After.roster.map((entry) => entry.accountId), [FRIEND]);
        assert.equal(After.expectedPlayerString, Hunt.expectedPlayerString);
        assert.ok(Lines.some((line) => line.includes("manifest re-resolve failed") && line.includes("resolver down")));
        assert.ok(Lines.some((line) => line.includes(`keeps expected players that still list ${MEMBER}`)));
    });
});

test("the last player leaving a forming hunt ends it, cancelled for him", async () => {
    await WithKit(async (kit) => {
        const Hunt = await RealmHunt(kit, "party-leave-last", [FRIEND, MEMBER]);
        assert.equal(await RemoveLeaverFromFormingHunt(MEMBER, Resolver()), "REMOVED");

        assert.equal(await RemoveLeaverFromFormingHunt(FRIEND, Resolver()), "CANCELLED");

        const Ended = (await kit.hunts.findHunt(Hunt.sessionId))!;
        assert.equal(Ended.failureReason, "PLAYER_CANCELED");
        assert.equal(Ended.cancelledByAccountId, FRIEND);
    });
});

test("a player with no forming hunt: nothing happens", async () => {
    await WithKit(async (kit) => {
        await RealmHunt(kit, "party-leave-none", [FRIEND, MEMBER]);
        assert.equal(await RemoveLeaverFromFormingHunt(STRANGER, Resolver()), "NO_HUNT");
    });
});
