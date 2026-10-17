import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { HostWriteKind } from "../../extensions/p2p";
import { P2PHuntSessionRecord } from "../persistence";
import type { RealmHubKind } from "../realm/realmHubRules";
import { CreateHubKit, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER } from "../realm/realmHubTestKit";
import { BuildPlayerHostRuntimeAuthData, InvalidateHubPresence, ResolveActiveHostRuntimeContext } from "./hostCapabilities";
import {
    AuthorizeHostWrite, BuildHostWriteRow, HostWriteDenialReason, HostWritesEnabled, HostWriteRow, RecordHostWrite, UseHostWriteSinkForTest
} from "./hostWrites";
import { DeriveIcePeerId } from "./transportPeerIds";

const hunt = (overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord => ({
    sessionId: "s-1",
    generation: 2,
    state: "RUNNING",
    hostAccountId: "host",
    roster: [
        { accountId: "host", admissionState: "ADMITTED" },
        { accountId: "friend", admissionState: "ADMITTED" },
        { accountId: "late", admissionState: "RESERVED" }
    ],
    ...overrides
} as unknown as P2PHuntSessionRecord);

const auth = { IsPlayerHostRuntime: true as const, IsGameserver: false as const, p2pSessionId: "s-1", p2pGeneration: 2 };

test("a host may write for itself and its admitted members of a running hunt", () => {
    assert.equal(HostWriteDenialReason(auth, hunt(), "host"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "SUSPECT", preSuspectState: "RUNNING" } as any), "friend"), undefined);
});

test("a drained hunt keeps its members' saves while its server serves them; its stranger and its fenced hunt are still refused (2026-10-15)", () => {
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "DRAINING" } as any), "friend"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "DRAINING" } as any), "stranger"), "NOT_A_MEMBER");
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "FENCED" } as any), "friend"), "HUNT_NOT_RUNNING");
});

test("a host write is refused outside its running hunt and its admitted members", () => {
    assert.equal(HostWriteDenialReason(undefined, hunt(), "host"), "PLAYER_HOST_AUTH_REQUIRED");
    assert.equal(HostWriteDenialReason({ ...auth, IsGameserver: true as any }, hunt(), "host"), "PLAYER_HOST_AUTH_REQUIRED");
    assert.equal(HostWriteDenialReason(auth, undefined, "host"), "HUNT_NOT_FOUND");
    assert.equal(HostWriteDenialReason(auth, hunt({ generation: 3 }), "host"), "HUNT_NOT_FOUND");
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "ADMITTING" }), "host"), "HUNT_NOT_RUNNING");
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "COMPLETED" }), "host"), "HUNT_NOT_RUNNING");
    assert.equal(HostWriteDenialReason(auth, hunt(), "stranger"), "NOT_A_MEMBER");
    assert.equal(HostWriteDenialReason(auth, hunt(), "late"), "MEMBER_NOT_ADMITTED");
});

test("P2P_HOST_WRITES=off switches host writes off; anything else keeps them on", () => {
    assert.equal(HostWritesEnabled({}), true);
    assert.equal(HostWritesEnabled({ P2P_HOST_WRITES: "on" }), true);
    assert.equal(HostWritesEnabled({ P2P_HOST_WRITES: "off" }), false);
    assert.equal(HostWritesEnabled({ P2P_HOST_WRITES: "0" }), false);
});

// [2026-10-14 realms S4] Hub write rules (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.2). A hub has no frozen
// roster: its members are the ones present in it, and the host counts.

const ALL_WRITE_KINDS: readonly HostWriteKind[] = ["XP", "MASTERY", "OBJECTIVES", "ESCALATION", "COOLDOWN", "BOUNTY", "SLAYERS_PATH", "REFORGE", "RANK_CONFIRM",
    "LOADOUT_UNLOCK", "HUNT_PASS_XP"];
const RAMSGATE_WRITE_KINDS: readonly HostWriteKind[] = ["BOUNTY", "COOLDOWN", "SLAYERS_PATH", "ESCALATION", "OBJECTIVES", "MASTERY", "REFORGE", "RANK_CONFIRM",
    "LOADOUT_UNLOCK", "HUNT_PASS_XP"];
const PRESENT = { presentAccountIds: ["friend"] };

const hub = (overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord => ({
    sessionId: "s-1",
    generation: 2,
    state: "RUNNING",
    hostAccountId: "host",
    roster: [],
    sessionKind: "REALM_HUB",
    hubKind: "RAMSGATE",
    realmId: "realm-1",
    ...overrides
} as unknown as P2PHuntSessionRecord);

test("a Ramsgate hub takes its write kinds for a present member and for the host", () => {
    for (const kind of RAMSGATE_WRITE_KINDS) {
        assert.equal(HostWriteDenialReason(auth, hub(), "friend", kind, PRESENT), undefined, kind);
        assert.equal(HostWriteDenialReason(auth, hub(), "host", kind, PRESENT), undefined, `${kind} by the host`);
    }
});

// [2026-10-16] A Training hub writes what Ramsgate writes, except the reforge (the tutorial's quest step is a bounty write).
test("a Ramsgate hub refuses XP (no XP source in a hub, decision D4); a Training hub also refuses XP and the reforge", () => {
    assert.equal(HostWriteDenialReason(auth, hub(), "friend", "XP", PRESENT), "WRITE_KIND_NOT_ALLOWED_IN_HUB");
    for (const kind of ALL_WRITE_KINDS) {
        const refused = kind === "XP" || kind === "REFORGE" || HostWriteDenialReason(auth, hub(), "friend", kind, PRESENT) !== undefined;
        assert.equal(HostWriteDenialReason(auth, hub({ hubKind: "TRAINING" }), "friend", kind, PRESENT),
            refused ? "WRITE_KIND_NOT_ALLOWED_IN_HUB" : undefined, kind);
    }
});

test("a hub write needs a running hub of this generation and a target present in it", () => {
    assert.equal(HostWriteDenialReason(auth, hub({ state: "SUSPECT", preSuspectState: "RUNNING" } as any), "friend", "BOUNTY", PRESENT),
        undefined, "a missed lease keeps a running hub's writes");
    assert.equal(HostWriteDenialReason(auth, hub({ state: "SUSPECT", preSuspectState: "ADMITTING" } as any), "friend", "BOUNTY", PRESENT),
        "HUNT_NOT_RUNNING");
    assert.equal(HostWriteDenialReason(auth, hub({ state: "ADMITTING" }), "friend", "BOUNTY", PRESENT), "HUNT_NOT_RUNNING");
    assert.equal(HostWriteDenialReason(auth, hub({ generation: 3 }), "friend", "BOUNTY", PRESENT), "HUNT_NOT_FOUND");
    assert.equal(HostWriteDenialReason(auth, hub(), "stranger", "BOUNTY", PRESENT), "MEMBER_NOT_PRESENT");
    assert.equal(HostWriteDenialReason(auth, hub(), "friend", "BOUNTY", undefined), "MEMBER_NOT_PRESENT", "without a presence view a hub has only its host");
    assert.equal(HostWriteDenialReason(auth, hub(), "host", "BOUNTY", undefined), undefined);
});

test("a hunt refuses REFORGE (a hub action) and keeps every other kind on its roster", () => {
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend", "REFORGE"), "WRITE_KIND_NOT_ALLOWED");
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend", "XP"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend", "XP", PRESENT), undefined, "a presence view is read for hubs only");
    assert.equal(HostWriteDenialReason(auth, hunt(), "late", "BOUNTY"), "MEMBER_NOT_ADMITTED");
});

// [2026-10-14 realms S4] A rank confirm is a hunt's roster rule, as XP is: an admitted member, not a hunt-only refusal.
test("a rank confirm in a hunt needs an admitted roster member (the host counts), as XP does", () => {
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend", "RANK_CONFIRM"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "host", "RANK_CONFIRM"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "late", "RANK_CONFIRM"), "MEMBER_NOT_ADMITTED");
    assert.equal(HostWriteDenialReason(auth, hunt(), "stranger", "RANK_CONFIRM"), "NOT_A_MEMBER");
});

// [2026-10-15] A loadout unlock follows the rank confirm's membership rule: a hunt's admitted member (the host counts).
test("a loadout unlock in a hunt needs an admitted roster member (the host counts), as a rank confirm does", () => {
    assert.equal(HostWriteDenialReason(auth, hunt(), "friend", "LOADOUT_UNLOCK"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "host", "LOADOUT_UNLOCK"), undefined);
    assert.equal(HostWriteDenialReason(auth, hunt(), "late", "LOADOUT_UNLOCK"), "MEMBER_NOT_ADMITTED");
    assert.equal(HostWriteDenialReason(auth, hunt(), "stranger", "LOADOUT_UNLOCK"), "NOT_A_MEMBER");
    assert.equal(HostWriteDenialReason(auth, hunt({ state: "COMPLETED" as P2PHuntSessionRecord["state"] }), "friend", "LOADOUT_UNLOCK"), "HUNT_NOT_RUNNING");
});

test("a realm's Ramsgate hub unlocks the loadout of a present member, and refuses a stranger or a member who left", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub, rows }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER);
        assert.equal(await AuthorizeHostWrite(req, "LOADOUT_UNLOCK", MEMBER), undefined);
        await RecordHostWrite(req, { kind: "LOADOUT_UNLOCK", targetUserId: MEMBER, summary: { gameserverDelta: 2 } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "LOADOUT_UNLOCK");
        assert.equal(rows[0].hubKind, "RAMSGATE");
        assert.equal((await AuthorizeHostWrite(req, "LOADOUT_UNLOCK", STRANGER))?.status, 403, "never entered the hub");
        await kit.presence.markLost({ sessionId: hub.sessionId, generation: hub.generation, accountId: MEMBER, lostAt: iso(), purgeAt: iso(604_800_000) });
        InvalidateHubPresence(hub.sessionId);
        assert.equal((await AuthorizeHostWrite(req, "LOADOUT_UNLOCK", MEMBER))?.status, 403, "its link was lost");
    });
});

test("an official hunt's tag keeps today's row shape: no realm fields", () => {
    const row = BuildHostWriteRow({ hostAccountId: "host", sessionId: "s-1", generation: 2 },
        { kind: "XP", targetUserId: "friend", summary: { amount: 5 } }, "2026-10-14T10:00:00.000Z");
    assert.deepEqual(row, { kind: "XP", targetUserId: "friend", hostAccountId: "host", sessionId: "s-1", generation: 2,
        summary: { amount: 5 }, at: "2026-10-14T10:00:00.000Z" });
    assert.deepEqual(Object.keys(row), ["kind", "targetUserId", "hostAccountId", "sessionId", "generation", "summary", "at"]);
});

test("a realm session's tag carries its realm, session kind and hub kind", () => {
    const row = BuildHostWriteRow({ hostAccountId: "host", sessionId: "s-1", generation: 2, realmId: "realm-1",
        sessionKind: "REALM_HUB", hubKind: "RAMSGATE" }, { kind: "BOUNTY", targetUserId: "friend", summary: {} }, "2026-10-14T10:00:00.000Z");
    assert.deepEqual(row, { kind: "BOUNTY", targetUserId: "friend", hostAccountId: "host", sessionId: "s-1", generation: 2,
        realmId: "realm-1", sessionKind: "REALM_HUB", hubKind: "RAMSGATE", summary: {}, at: "2026-10-14T10:00:00.000Z" });
});

// The same rules through the real checks: the hub's presence comes from the test kit's realm hub repository, the runtime
// request is built the way the auth layer builds it, and the tags go to a capture sink instead of MongoDB.

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

interface HubScenario { kit: HubKit; hub: RunningHub; rows: HostWriteRow[] }

/** A running hub of `hubKind` on the test kit; the tags it writes are captured in `rows`. */
async function WithHub(hubKind: RealmHubKind, body: (scenario: HubScenario) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    const rows: HostWriteRow[] = [];
    UseHostWriteSinkForTest(async (row) => { rows.push(row); });
    try {
        const hub = await StartRunningHub(kit, { hubKind });
        await body({ kit, hub, rows });
    } finally {
        UseHostWriteSinkForTest(undefined);
        kit.dispose();
    }
}

/** A member's entry as the presence repository records it: requested, then admitted over the relay. */
async function Admit(kit: HubKit, hub: RunningHub, accountId: string): Promise<void> {
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: `candidate-${accountId}`, now: iso(), expiresAt: iso(90_000) });
    await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId,
        admissionId: `admission-${accountId}`, admittedAt: iso(), now: iso(), route: "relay" });
    InvalidateHubPresence(hub.sessionId);
}

/** The request a hub's runtime makes for `userId` (the host's own when omitted), built as the auth layer builds it. */
async function RuntimeRequest(hub: RunningHub, userId?: string, overrides: Record<string, unknown> = {}): Promise<any> {
    const context = await ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = BuildPlayerHostRuntimeAuthData(context, userId === undefined ? undefined : { userId });
    assert.ok(AuthData, "the runtime may act for this account");
    return { AuthData: { ...AuthData, ...overrides } };
}

test("a Ramsgate hub's host write for a present member is accepted and tagged with the realm and the hub", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub, rows }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER);
        assert.equal(await AuthorizeHostWrite(req, "BOUNTY", MEMBER), undefined);
        await RecordHostWrite(req, { kind: "BOUNTY", targetUserId: MEMBER, summary: { bountyId: "b-1" } });
        assert.equal(rows.length, 1);
        assert.equal(typeof rows[0].at, "string");
        assert.deepEqual({ ...rows[0], at: "" }, { kind: "BOUNTY", targetUserId: MEMBER, hostAccountId: HOST, sessionId: hub.sessionId,
            generation: hub.generation, realmId: REALM_ID, sessionKind: "REALM_HUB", hubKind: "RAMSGATE", summary: { bountyId: "b-1" }, at: "" });
    });
});

test("the host itself is a write target in its Ramsgate hub, with no member entered", async () => {
    await WithHub("RAMSGATE", async ({ hub, rows }) => {
        const req = await RuntimeRequest(hub);
        assert.equal(await AuthorizeHostWrite(req, "MASTERY", HOST), undefined);
        await RecordHostWrite(req, { kind: "MASTERY", targetUserId: HOST, summary: {} });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].hubKind, "RAMSGATE");
    });
});

test("a Ramsgate hub refuses a target that is not present: a stranger, or a member whose link was lost", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub, rows }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub);
        assert.equal((await AuthorizeHostWrite(req, "BOUNTY", STRANGER))?.status, 403, "never entered");
        assert.equal(await AuthorizeHostWrite(req, "BOUNTY", MEMBER), undefined);
        await kit.presence.markLost({ sessionId: hub.sessionId, generation: hub.generation, accountId: MEMBER, lostAt: iso(), purgeAt: iso(604_800_000) });
        InvalidateHubPresence(hub.sessionId);
        const denial = await AuthorizeHostWrite(req, "BOUNTY", MEMBER);
        assert.equal(denial?.status, 403, "lost: no longer present");
        assert.equal((denial?.body as { code?: string }).code, "P2P_HOST_WRITE_DENIED");
        assert.equal(rows.length, 0);
    });
});

test("a Ramsgate hub's suspect state keeps writes only from RUNNING; the other states refuse them", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER);
        const record = kit.hunts.hunts.get(hub.sessionId)!;
        kit.hunts.hunts.set(hub.sessionId, { ...record, state: "SUSPECT", preSuspectState: "RUNNING" } as any);
        assert.equal(await AuthorizeHostWrite(req, "BOUNTY", MEMBER), undefined, "SUSPECT from RUNNING");
        kit.hunts.hunts.set(hub.sessionId, { ...record, state: "SUSPECT", preSuspectState: "ADMITTING" } as any);
        assert.equal((await AuthorizeHostWrite(req, "BOUNTY", MEMBER))?.status, 403, "SUSPECT from ADMITTING");
        kit.hunts.hunts.set(hub.sessionId, { ...record, state: "ABORTED" });
        assert.equal((await AuthorizeHostWrite(req, "BOUNTY", MEMBER))?.status, 403, "ABORTED");
    });
});

test("a write from a runtime of another generation of the hub is refused", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER, { p2pGeneration: hub.generation + 1 });
        assert.equal((await AuthorizeHostWrite(req, "BOUNTY", MEMBER))?.status, 403);
    });
});

test("XP is refused in a Ramsgate hub even for a present member", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub, rows }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER);
        assert.equal((await AuthorizeHostWrite(req, "XP", MEMBER))?.status, 403);
        assert.equal(rows.length, 0);
    });
});

test("a Training hub takes a present member's bounty write (the tutorial's quest step) and refuses XP and the reforge", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER);
        assert.equal(await AuthorizeHostWrite(req, "BOUNTY", MEMBER), undefined);
        assert.equal(await AuthorizeHostWrite(req, "SLAYERS_PATH", MEMBER), undefined);
        for (const kind of ["XP", "REFORGE"] as const) {
            const denial = await AuthorizeHostWrite(req, kind, MEMBER);
            assert.equal(denial?.status, 403, kind);
            assert.equal((denial?.body as { code?: string }).code, "P2P_HOST_WRITE_DENIED", kind);
        }
    });
});

// [2026-10-16] POST /inventory/instanceditem (the cells slotted into gear from the armoury) is a host write kind every hub takes, so a
// realm saves an item as a dedicated server does; the target must still be present (every such save was refused until now).
test("every hub takes a present member's item save (ITEM_SAVE), even under enforce, and refuses it for an absent player", async () => {
    for (const hubKind of ["RAMSGATE", "TRAINING"] as const) {
        await WithHub(hubKind, async ({ kit, hub }) => {
            await Admit(kit, hub, MEMBER);
            const req = await RuntimeRequest(hub, MEMBER);
            assert.equal(await AuthorizeHostWrite(req, "ITEM_SAVE", MEMBER), undefined, hubKind);
            assert.equal((await AuthorizeHostWrite(req, "ITEM_SAVE", STRANGER))?.status, 403, `${hubKind}: an absent player`);
        });
    }
});

test("P2P_HOST_WRITES=off refuses a Ramsgate hub's writes as well", async () => {
    const saved = process.env.P2P_HOST_WRITES;
    process.env.P2P_HOST_WRITES = "off";
    try {
        await WithHub("RAMSGATE", async ({ kit, hub }) => {
            await Admit(kit, hub, MEMBER);
            const req = await RuntimeRequest(hub, MEMBER);
            assert.equal((await AuthorizeHostWrite(req, "BOUNTY", MEMBER))?.status, 403);
        });
    } finally {
        if (saved === undefined) delete process.env.P2P_HOST_WRITES;
        else process.env.P2P_HOST_WRITES = saved;
    }
});
