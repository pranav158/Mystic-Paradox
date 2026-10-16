import assert from "node:assert/strict";
import test from "node:test";
import {
    ParseAccountIdParam,
    ParseBanBody,
    ParseCreateRealmBody,
    ParseHeartbeatBody,
    ParseHostPublicKey,
    ParseInviteBody,
    ParseInviteCodeParam,
    ParseJoinBody,
    ParseKnownHostKeyQuery,
    ParseListQuery,
    ParseNameParam,
    ParseSettingsBody,
    ParseUsernameBody,
    ParseVersion
} from "./realmInput";
import { IsRealmsModuleEnabled, ReadRealmLimits } from "./realmsConfig";

const KEY = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==";

function Failure(result: { ok: boolean; code?: string }): string | undefined {
    return result.ok ? undefined : result.code;
}

test("creating a realm: defaults are invite-only and unlisted, the name is canonicalised, unknown keys are ignored", () => {
    const parsed = ParseCreateRealmBody({ name: " Friends-Realm ", hostPublicKey: KEY, isAdmin: true, __proto__: { x: 1 } });
    assert.deepEqual(parsed, { ok: true, value: { name: "friends-realm", hostPublicKey: KEY, joinPolicy: "INVITE_ONLY", listed: false } });
    const full = ParseCreateRealmBody({ name: "abc", hostPublicKey: KEY, joinPolicy: "PUBLIC", listed: true, version: "0.2.128" });
    assert.deepEqual(full, { ok: true, value: { name: "abc", hostPublicKey: KEY, joinPolicy: "PUBLIC", listed: true, version: "0.2.128" } });
});

test("creating a realm: each field is checked strictly, with a code that says what was wrong", () => {
    assert.equal(Failure(ParseCreateRealmBody({ name: "ab", hostPublicKey: KEY })), "REALM_NAME_INVALID");
    // [2026-10-16] No name: the realm takes the host's username (realmsService). A name that is sent but empty or wrong is still refused.
    const Unnamed = ParseCreateRealmBody({ hostPublicKey: KEY });
    assert.equal(Unnamed.ok, true);
    assert.equal(Unnamed.ok && Unnamed.value.name, undefined);
    assert.equal(Failure(ParseCreateRealmBody({ name: "", hostPublicKey: KEY })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseCreateRealmBody({ name: null, hostPublicKey: KEY })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseCreateRealmBody({ name: "Official", hostPublicKey: KEY })), "REALM_NAME_RESERVED");
    assert.equal(Failure(ParseCreateRealmBody({ name: "abc" })), "REALM_VALIDATION_FAILED");
    for (const hostPublicKey of ["short", "x".repeat(513), "has spaces in it 1234", "<script>alert(1)</script>", 12345678901234567890, null, {}, [KEY]]) {
        assert.equal(Failure(ParseCreateRealmBody({ name: "abc", hostPublicKey })), "REALM_VALIDATION_FAILED", String(hostPublicKey));
    }
    for (const joinPolicy of ["public", "OPEN", "", 1, true, null, {}]) {
        assert.equal(Failure(ParseCreateRealmBody({ name: "abc", hostPublicKey: KEY, joinPolicy })), "REALM_VALIDATION_FAILED", String(joinPolicy));
    }
    for (const listed of ["true", 1, 0, "yes", null, {}]) {
        assert.equal(Failure(ParseCreateRealmBody({ name: "abc", hostPublicKey: KEY, listed })), "REALM_VALIDATION_FAILED", String(listed));
    }
    for (const version of ["", "1 2", "x".repeat(65), 1, "<b>"]) {
        assert.equal(Failure(ParseCreateRealmBody({ name: "abc", hostPublicKey: KEY, version })), "REALM_VALIDATION_FAILED", String(version));
    }
    for (const body of [[], "abc", 5, true]) assert.equal(Failure(ParseCreateRealmBody(body)), "REALM_VALIDATION_FAILED");
});

test("settings need at least one valid setting", () => {
    assert.deepEqual(ParseSettingsBody({ joinPolicy: "PUBLIC" }), { ok: true, value: { joinPolicy: "PUBLIC" } });
    assert.deepEqual(ParseSettingsBody({ listed: false }), { ok: true, value: { listed: false } });
    assert.deepEqual(ParseSettingsBody({ joinPolicy: "INVITE_ONLY", listed: true, hostPublicKey: "ignored" }), { ok: true, value: { joinPolicy: "INVITE_ONLY", listed: true } });
    assert.equal(Failure(ParseSettingsBody({})), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseSettingsBody(undefined)), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseSettingsBody({ name: "other" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseSettingsBody({ joinPolicy: "NOPE" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseSettingsBody({ listed: "yes" })), "REALM_VALIDATION_FAILED");
});

test("invite options: defaults of 10 uses and 7 days, whole numbers within range only", () => {
    assert.deepEqual(ParseInviteBody(undefined), { ok: true, value: { maxUses: 10, ttlHours: 168 } });
    assert.deepEqual(ParseInviteBody({}), { ok: true, value: { maxUses: 10, ttlHours: 168 } });
    assert.deepEqual(ParseInviteBody({ maxUses: 1, expiresInHours: 1 }), { ok: true, value: { maxUses: 1, ttlHours: 1 } });
    assert.deepEqual(ParseInviteBody({ maxUses: 100, expiresInHours: 720 }), { ok: true, value: { maxUses: 100, ttlHours: 720 } });
    for (const maxUses of [0, 101, -1, 1.5, "5", NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 2]) {
        assert.equal(Failure(ParseInviteBody({ maxUses })), "REALM_VALIDATION_FAILED", String(maxUses));
    }
    for (const expiresInHours of [0, 721, -5, 0.5, "24", NaN, null]) {
        assert.equal(Failure(ParseInviteBody({ expiresInHours })), "REALM_VALIDATION_FAILED", String(expiresInHours));
    }
});

test("joining takes a name and/or an invite code, normalised, plus an optional known host key", () => {
    assert.deepEqual(ParseJoinBody({ name: "Friends" }), { ok: true, value: { name: "friends" } });
    assert.deepEqual(ParseJoinBody({ inviteCode: "abcde-fghjk" }), { ok: true, value: { inviteCode: "ABCDEFGHJK" } });
    assert.deepEqual(ParseJoinBody({ name: "friends", inviteCode: "ABCDEFGHJK", knownHostKey: KEY }), { ok: true, value: { name: "friends", inviteCode: "ABCDEFGHJK", knownHostKey: KEY } });
    assert.equal(Failure(ParseJoinBody({})), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseJoinBody({ knownHostKey: KEY })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseJoinBody({ name: "-bad-" })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseJoinBody({ inviteCode: "ABCDEFGHIK" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseJoinBody({ name: "friends", knownHostKey: "bad key" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseJoinBody({ name: { $ne: "x" } })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseJoinBody({ inviteCode: { $ne: "x" } })), "REALM_VALIDATION_FAILED");
    // [2026-10-16] A join names an existing realm: a well-formed reserved name passes (the owner's realm is "mysticfox"), while a
    // malformed one is still refused. Creating a realm under a reserved name is still refused (ParseCreateRealmBody).
    assert.deepEqual(ParseJoinBody({ name: "MysticFox " }), { ok: true, value: { name: "mysticfox" } });
    assert.deepEqual(ParseJoinBody({ name: "mysticfox", knownHostKey: KEY }), { ok: true, value: { name: "mysticfox", knownHostKey: KEY } });
    assert.equal(Failure(ParseJoinBody({ name: "-mysticfox" })), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseCreateRealmBody({ name: "mysticfox" })), "REALM_NAME_RESERVED");
});

test("heartbeat: optional online flag and version", () => {
    assert.deepEqual(ParseHeartbeatBody(undefined), { ok: true, value: {} });
    assert.deepEqual(ParseHeartbeatBody({ online: false, version: "0.2.128" }), { ok: true, value: { online: false, version: "0.2.128" } });
    assert.equal(Failure(ParseHeartbeatBody({ online: "false" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseHeartbeatBody({ version: "bad version" })), "REALM_VALIDATION_FAILED");
});

test("ban reason: optional, trimmed, 200 characters at most, no control characters", () => {
    assert.deepEqual(ParseBanBody(undefined), { ok: true, value: {} });
    assert.deepEqual(ParseBanBody({ reason: "  griefing  " }), { ok: true, value: { reason: "griefing" } });
    assert.deepEqual(ParseBanBody({ reason: "   " }), { ok: true, value: {} });
    assert.deepEqual(ParseBanBody({ reason: "x".repeat(200) }), { ok: true, value: { reason: "x".repeat(200) } });
    assert.equal(Failure(ParseBanBody({ reason: "x".repeat(201) })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseBanBody({ reason: "line\nbreak" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseBanBody({ reason: "nul\u0000byte" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseBanBody({ reason: 5 })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseBanBody([])), "REALM_VALIDATION_FAILED");
});

test("listing query: digits only, limit 1-50, offset 0-10000", () => {
    assert.deepEqual(ParseListQuery({}), { ok: true, value: { limit: 25, offset: 0 } });
    assert.deepEqual(ParseListQuery({ limit: "50", offset: "10000" }), { ok: true, value: { limit: 50, offset: 10000 } });
    for (const limit of ["0", "51", "-1", "1.5", "abc", "", " 5", ["5"], "1e1", "0x10"]) {
        assert.equal(Failure(ParseListQuery({ limit })), "REALM_VALIDATION_FAILED", String(limit));
    }
    for (const offset of ["10001", "-1", "x", "", ["1"], { $gt: "0" }]) {
        assert.equal(Failure(ParseListQuery({ offset })), "REALM_VALIDATION_FAILED", JSON.stringify(offset));
    }
});

test("path and query values: names, invite codes, account ids and host keys", () => {
    assert.deepEqual(ParseNameParam("Friends"), { ok: true, value: "friends" });
    // A reserved name is well-formed: looking it up is "not found", not "invalid".
    assert.deepEqual(ParseNameParam("official"), { ok: true, value: "official" });
    assert.equal(Failure(ParseNameParam("a b")), "REALM_NAME_INVALID");
    assert.equal(Failure(ParseNameParam(undefined)), "REALM_NAME_INVALID");

    assert.deepEqual(ParseInviteCodeParam("abcde-fghjk"), { ok: true, value: "ABCDEFGHJK" });
    assert.equal(Failure(ParseInviteCodeParam("nope")), "REALM_VALIDATION_FAILED");

    assert.equal(ParseAccountIdParam("0d0f7e2c-5f3a-4a55-9f3e-6b1d2c3a4b5c"), "0d0f7e2c-5f3a-4a55-9f3e-6b1d2c3a4b5c");
    assert.equal(ParseAccountIdParam("dev:user_1.a"), "dev:user_1.a");
    for (const bad of ["", "$ne", "a b", "a/b", "x".repeat(129), "a%00b", undefined, 5, ["a"], "../etc"]) {
        assert.equal(ParseAccountIdParam(bad as any), undefined, String(bad));
    }

    assert.equal(ParseHostPublicKey(KEY), KEY);
    assert.equal(ParseHostPublicKey(`  ${KEY}  `), KEY);
    assert.equal(ParseHostPublicKey("tooshort"), undefined);
    assert.equal(ParseVersion("0.2.128+rc1"), "0.2.128+rc1");
    assert.equal(ParseVersion("0.2 128"), undefined);

    assert.deepEqual(ParseKnownHostKeyQuery({}), { ok: true, value: undefined });
    assert.deepEqual(ParseKnownHostKeyQuery({ knownHostKey: KEY }), { ok: true, value: KEY });
    assert.equal(Failure(ParseKnownHostKeyQuery({ knownHostKey: "bad key" })), "REALM_VALIDATION_FAILED");
    assert.equal(Failure(ParseKnownHostKeyQuery({ knownHostKey: [KEY] })), "REALM_VALIDATION_FAILED");
});

test("the module switch: only on, true or 1 (any case) turns it on; the default is off", () => {
    for (const value of ["on", "ON", "true", "True", "1", " on "]) assert.equal(IsRealmsModuleEnabled({ MYSTICPARADOX_REALMS_MODULE: value }), true, value);
    for (const value of [undefined, "", "off", "false", "0", "yes", "enabled", "2", "onn"]) {
        assert.equal(IsRealmsModuleEnabled({ MYSTICPARADOX_REALMS_MODULE: value }), false, String(value));
    }
    assert.equal(IsRealmsModuleEnabled({}), false);
});

test("adding a player: a username is required, trimmed, 1-64 plain characters; nothing else is read", () => {
    assert.deepEqual(ParseUsernameBody({ username: "  Friendly " }), { ok: true, value: { username: "Friendly" } });
    assert.deepEqual(ParseUsernameBody({ username: "x", accountId: "someone-else" }), { ok: true, value: { username: "x" } });
    assert.deepEqual(ParseUsernameBody({ username: "x".repeat(64) }), { ok: true, value: { username: "x".repeat(64) } });
    for (const body of [undefined, null, {}, { username: 7 }, { username: ["a"] }, { username: "" }, { username: "   " },
        { username: "x".repeat(65) }, { username: "a\tb" }, { username: "a\u007fb" }]) {
        const parsed = ParseUsernameBody(body);
        assert.equal(parsed.ok, false, JSON.stringify(body));
        if (!parsed.ok) assert.equal(parsed.code, "REALM_VALIDATION_FAILED");
    }
    assert.equal(ParseUsernameBody([]).ok, false);
});

test("realm limits: defaults, bounded overrides, garbage ignored", () => {
    assert.deepEqual(ReadRealmLimits({}), { maxMembers: 1000, maxBans: 1000, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 50 });
    assert.equal(ReadRealmLimits({ MYSTICPARADOX_REALMS_MAX_MEMBERS: "50" }).maxMembers, 50);
    assert.equal(ReadRealmLimits({ MYSTICPARADOX_REALMS_MAX_MEMBERS: "1" }).maxMembers, 1000);
    assert.equal(ReadRealmLimits({ MYSTICPARADOX_REALMS_MAX_MEMBERS: "99999" }).maxMembers, 1000);
    assert.equal(ReadRealmLimits({ MYSTICPARADOX_REALMS_MAX_BANS: "abc" }).maxBans, 1000);
});
