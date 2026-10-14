import assert from "node:assert/strict";
import test from "node:test";
import { ParseEntryRealm, ParseHeartbeatBody } from "./realmInput";
import {
    ApplyHostingPatch,
    HubRoomId,
    HubRoomIdsOf,
    IsRealmHubReady,
    IsRealmServing,
    NormalizeHosting,
    NormalizeHubRoomId,
    ValidateHostingPatch
} from "./realmRules";
import { RealmHosting } from "./realmTypes";

// The pure pieces of the 2026-10-13 hub design section 2: serving, hosting patches, hub room ids and the two new request parsers.

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==";

function Failure(result: { ok: boolean; code?: string }): string | undefined {
    return result.ok ? undefined : result.code;
}

const HOSTING_NOW: RealmHosting = {
    maxServers: 2, maxPlayers: 16, hubState: "RUNNING", trainingState: "NONE", activeServers: 1, updatedAt: iso(T0)
};

test("a realm is serving only while its host is online AND its hub is running", () => {
    const online = { onlineUntil: iso(T0 + 1000) };
    assert.equal(IsRealmServing({ ...online, hosting: HOSTING_NOW }, T0), true);
    assert.equal(IsRealmServing({ ...online, hosting: { ...HOSTING_NOW, hubState: "STARTING" } }, T0), false);
    assert.equal(IsRealmServing({ ...online, hosting: { ...HOSTING_NOW, hubState: "STOPPING" } }, T0), false);
    assert.equal(IsRealmServing({ ...online, hosting: { ...HOSTING_NOW, hubState: "NONE" } }, T0), false);
    assert.equal(IsRealmServing({ ...online }, T0), false, "no hosting record at all");
    assert.equal(IsRealmServing({ onlineUntil: iso(T0), hosting: HOSTING_NOW }, T0), false, "online state lapsed exactly now");
    assert.equal(IsRealmServing({ hosting: HOSTING_NOW }, T0), false, "never online");
    // The hub itself can be ready while the host's heartbeat has lapsed.
    assert.equal(IsRealmHubReady({ hosting: HOSTING_NOW }), true);
    assert.equal(IsRealmHubReady({}), false);
});

test("a hub room id is deterministic, UUID-shaped and different per realm and per hub kind", () => {
    const id = HubRoomId("realm-1", "RAMSGATE");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(HubRoomId("realm-1", "RAMSGATE"), id);
    assert.notEqual(HubRoomId("realm-1", "TRAINING"), id);
    assert.notEqual(HubRoomId("realm-2", "RAMSGATE"), id);
    assert.deepEqual(HubRoomIdsOf("realm-1"), [id, HubRoomId("realm-1", "TRAINING")]);
    assert.throws(() => HubRoomId("", "RAMSGATE"));
    assert.throws(() => HubRoomId("realm-1", "HUNT" as never));
});

test("a hub room id from a request is accepted only in its UUID form, lower-cased", () => {
    const id = HubRoomId("realm-1", "TRAINING");
    assert.equal(NormalizeHubRoomId(id.toUpperCase()), id);
    for (const bad of [undefined, null, 5, "", "not-a-uuid", `${id}0`, id.slice(1), id.replace(/-/g, ""), "g".repeat(8) + id.slice(8)]) {
        assert.equal(NormalizeHubRoomId(bad), undefined, String(bad));
    }
});

test("a hosting patch changes only what it names; null removes an optional field; defaults fill a realm that had none", () => {
    const fresh = ApplyHostingPatch(undefined, { hubState: "STARTING", hubSessionId: "sess-1" }, iso(T0));
    assert.deepEqual(fresh, {
        maxServers: 1, maxPlayers: 16, hubState: "STARTING", trainingState: "NONE", activeServers: 0, hubSessionId: "sess-1", updatedAt: iso(T0)
    });
    const withAfk = ApplyHostingPatch(fresh, { maxServers: 4, afkSeconds: 600 }, iso(T0 + 1));
    assert.equal(withAfk.maxServers, 4);
    assert.equal(withAfk.afkSeconds, 600);
    assert.equal(withAfk.hubState, "STARTING", "an unnamed field keeps its value");
    assert.equal(withAfk.updatedAt, iso(T0 + 1));
    const cleared = ApplyHostingPatch(withAfk, { afkSeconds: null, hubSessionId: null, hubState: "NONE", updatedAt: "ignored" }, iso(T0 + 2));
    assert.equal("afkSeconds" in cleared, false);
    assert.equal("hubSessionId" in cleared, false);
    assert.equal(cleared.hubState, "NONE");
    assert.equal(cleared.updatedAt, iso(T0 + 2), "the patch cannot set updatedAt");
    // Unknown keys never get in.
    assert.equal("isAdmin" in ApplyHostingPatch(fresh, { isAdmin: true } as never, iso(T0)), false);
    assert.equal(NormalizeHosting(undefined, iso(T0)), undefined);
    assert.equal(NormalizeHosting({ hubState: "RUNNING" }, iso(T0))?.maxPlayers, 16, "a half-written record is completed");
});

test("a hosting patch from the p2p module is checked: ranges, states and the session id", () => {
    assert.equal(ValidateHostingPatch({}), undefined);
    assert.equal(
        ValidateHostingPatch({ maxServers: 8, maxPlayers: 64, afkSeconds: 7200, activeServers: 8, hubState: "RUNNING", trainingState: "STOPPING", hubSessionId: "s" }),
        undefined
    );
    assert.equal(ValidateHostingPatch({ afkSeconds: null, hubSessionId: null }), undefined);
    assert.equal(ValidateHostingPatch({ maxServers: 0 }), "maxServers");
    assert.equal(ValidateHostingPatch({ maxServers: 9 }), "maxServers");
    assert.equal(ValidateHostingPatch({ maxPlayers: 65 }), "maxPlayers");
    assert.equal(ValidateHostingPatch({ maxPlayers: 1.5 }), "maxPlayers");
    assert.equal(ValidateHostingPatch({ afkSeconds: 7201 }), "afkSeconds");
    assert.equal(ValidateHostingPatch({ activeServers: -1 }), "activeServers");
    assert.equal(ValidateHostingPatch({ hubState: "HALF" as never }), "hubState");
    assert.equal(ValidateHostingPatch({ trainingState: "up" as never }), "trainingState");
    assert.equal(ValidateHostingPatch({ hubSessionId: "" }), "hubSessionId");
    assert.equal(ValidateHostingPatch({ hubSessionId: "x".repeat(129) }), "hubSessionId");
});

test("the host heartbeat hosting block: maxServers 1-8 and maxPlayers 1-64 are required, afkSeconds 0-7200 is optional", () => {
    assert.deepEqual(
        ParseHeartbeatBody({ hosting: { maxServers: 3, maxPlayers: 16 } }),
        { ok: true, value: { hosting: { maxServers: 3, maxPlayers: 16 } } }
    );
    assert.deepEqual(
        ParseHeartbeatBody({ online: true, hosting: { maxServers: 8, maxPlayers: 64, afkSeconds: 0, isAdmin: true } }),
        { ok: true, value: { online: true, hosting: { maxServers: 8, maxPlayers: 64, afkSeconds: 0 } } }
    );
    assert.deepEqual(ParseHeartbeatBody({ online: false }), { ok: true, value: { online: false } }, "hosting stays optional");
    for (const hosting of [
        "x", [], null, {}, { maxServers: 3 }, { maxPlayers: 16 }, { maxServers: 0, maxPlayers: 16 }, { maxServers: 9, maxPlayers: 16 },
        { maxServers: 3, maxPlayers: 0 }, { maxServers: 3, maxPlayers: 65 }, { maxServers: "3", maxPlayers: 16 }, { maxServers: 1.5, maxPlayers: 16 },
        { maxServers: 3, maxPlayers: 16, afkSeconds: 7201 }, { maxServers: 3, maxPlayers: 16, afkSeconds: -1 }, { maxServers: 3, maxPlayers: 16, afkSeconds: "60" }
    ]) {
        assert.equal(Failure(ParseHeartbeatBody({ hosting })), "REALM_VALIDATION_FAILED", JSON.stringify(hosting));
    }
});

test("the realm of a game session: a name is required, the invite code and host key are optional and strict", () => {
    assert.deepEqual(ParseEntryRealm({ name: " Friends " }), { ok: true, value: { name: "friends" } });
    assert.deepEqual(
        ParseEntryRealm({ name: "friends", inviteCode: "abcde-fghjk", knownHostKey: KEY, extra: 1 }),
        { ok: true, value: { name: "friends", inviteCode: "ABCDEFGHJK", knownHostKey: KEY } }
    );
    // A reserved name is well-formed: it simply finds no realm.
    assert.deepEqual(ParseEntryRealm({ name: "official" }), { ok: true, value: { name: "official" } });
    assert.equal(Failure(ParseEntryRealm({ name: "ab" })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseEntryRealm({ name: { $ne: "x" } })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseEntryRealm({})), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseEntryRealm({ name: "friends", inviteCode: "ABCDEFGHIK" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseEntryRealm({ name: "friends", inviteCode: { $ne: "x" } })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseEntryRealm({ name: "friends", knownHostKey: "short" })), "REALM_VALIDATION_FAILED");
    for (const bad of ["friends", 5, true, [], ["friends"]]) {
        assert.equal(Failure(ParseEntryRealm(bad)), "REALM_VALIDATION_FAILED", JSON.stringify(bad));
    }
});
