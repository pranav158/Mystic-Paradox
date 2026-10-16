import assert from "node:assert/strict";
import test from "node:test";
import {
    ApplyHeartbeat,
    BuildInvite,
    DecideJoin,
    DetectOwnershipChange,
    GenerateInviteCode,
    GetInviteState,
    HEARTBEAT_ONLINE_MS,
    INVITE_ALPHABET,
    INVITE_CODE_LENGTH,
    IsInviteUsable,
    IsRealmNameReleasable,
    IsRealmOnline,
    IsReservedRealmName,
    LAST_ONLINE_RELEASE_MS,
    NEVER_ONLINE_RELEASE_MS,
    NormalizeInviteCode,
    NormalizeRealmName,
    RESERVED_REALM_NAMES,
    RealmNameForUsername,
    RealmNameReleaseAt,
    SortJoinRequestsNewestFirst,
    ValidateRealmName
} from "./realmRules";

// [2026-10-16] A realm is named after its host's username.
test("a realm name from a username: lower case, other characters become one hyphen, nothing at either end", () => {
    assert.equal(RealmNameForUsername("MysticFox"), "mysticfox");
    assert.equal(RealmNameForUsername("  Pal42 "), "pal42");
    assert.equal(RealmNameForUsername("Old_Name.Two"), "old-name-two");
    assert.equal(RealmNameForUsername("__edge__"), "edge");
    // The username is the host's own, so a reserved word is not refused here (the username policy checked it).
    assert.equal(RealmNameForUsername("Mystic"), "mystic");
    // No username yet: the placeholder is the account id, too long for a realm name.
    assert.equal(RealmNameForUsername("00000000-0000-4000-8000-000000000000"), undefined);
    for (const bad of ["ab", "", "___", "x".repeat(25), undefined, null, 42, {}]) {
        assert.equal(RealmNameForUsername(bad), undefined, String(bad));
    }
});
import { RealmBan, RealmInviteRecord, RealmMember } from "./realmTypes";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ----- names -----

test("accepts 3-24 lower-case letters, digits and inner hyphens, and canonicalises case and spaces", () => {
    for (const name of ["abc", "ramsgate-friends", "a1b2c3", "x".repeat(24), "a-b", "a--b", "123"]) {
        assert.deepEqual(ValidateRealmName(name), { ok: true, name }, name);
    }
    assert.deepEqual(ValidateRealmName("  Friends-Realm  "), { ok: true, name: "friends-realm" });
    assert.equal(NormalizeRealmName(" AbC "), "abc");
});

test("rejects names of the wrong size, alphabet or hyphen placement", () => {
    for (const name of [
        "ab", "x".repeat(25), "", "   ", "-abc", "abc-", "-", "---", "my_realm", "my realm", "my.realm", "my/realm",
        "café", "рара", "a\nb", "ab\u0000c", "<script>", "%24ne"
    ]) {
        assert.deepEqual(ValidateRealmName(name), { ok: false, reason: "INVALID" }, JSON.stringify(name));
    }
    for (const value of [undefined, null, 5, true, {}, [], ["abc"], "a".repeat(5000)]) {
        assert.deepEqual(ValidateRealmName(value), { ok: false, reason: "INVALID" }, String(value));
    }
});

test("refuses reserved names in any case and with hyphens inside them", () => {
    for (const name of ["official", "OFFICIAL", "paradox", "mysticparadox", "mystic-paradox", "o-fficial", "ad-min", "support", "mod", "admin"]) {
        assert.deepEqual(ValidateRealmName(name), { ok: false, reason: "RESERVED" }, name);
    }
    assert.equal(IsReservedRealmName("my-official"), false);
    assert.deepEqual(ValidateRealmName("official-friends"), { ok: true, name: "official-friends" });
});

test("every reserved name is itself well-formed, so the list can never hide behind the format check", () => {
    for (const name of RESERVED_REALM_NAMES) {
        assert.ok(/^[a-z0-9]{3,24}$/.test(name), name);
    }
    for (const required of ["official", "paradox", "mysticparadox", "admin", "support", "mod"]) {
        assert.ok(RESERVED_REALM_NAMES.includes(required), required);
    }
});

// ----- name release -----

test("a realm that was never online frees its name 3 days after it was claimed", () => {
    const realm = { createdAt: iso(T0) };
    assert.equal(NEVER_ONLINE_RELEASE_MS, 3 * DAY);
    assert.equal(IsRealmNameReleasable(realm, T0), false);
    assert.equal(IsRealmNameReleasable(realm, T0 + 3 * DAY - 1), false);
    assert.equal(IsRealmNameReleasable(realm, T0 + 3 * DAY), true);
    assert.equal(RealmNameReleaseAt(realm), T0 + 3 * DAY);
});

test("a realm that was online keeps its name for 30 days after it was last online, whatever its age", () => {
    const realm = { createdAt: iso(T0 - 100 * DAY), lastOnlineAt: iso(T0) };
    assert.equal(LAST_ONLINE_RELEASE_MS, 30 * DAY);
    assert.equal(IsRealmNameReleasable(realm, T0 + 29 * DAY), false);
    assert.equal(IsRealmNameReleasable(realm, T0 + 30 * DAY - 1), false);
    assert.equal(IsRealmNameReleasable(realm, T0 + 30 * DAY), true);
    assert.equal(RealmNameReleaseAt(realm), T0 + 30 * DAY);
    // Going online resets the clock even for a realm older than 3 days.
    assert.equal(IsRealmNameReleasable({ createdAt: iso(T0 - 5 * DAY), lastOnlineAt: iso(T0 - DAY) }, T0), false);
});

test("a record with unreadable dates is never released automatically", () => {
    assert.equal(IsRealmNameReleasable({ createdAt: "garbage" }, T0 + 1000 * DAY), false);
    assert.equal(IsRealmNameReleasable({ createdAt: iso(T0), lastOnlineAt: "garbage" }, T0 + 1000 * DAY), false);
    assert.equal(RealmNameReleaseAt({ createdAt: "garbage" }), undefined);
});

// ----- ownership change -----

test("the same name under a different host key is an ownership change", () => {
    const known = { name: "friends", hostPublicKey: "KEY-ONE-0123456789" };
    assert.equal(DetectOwnershipChange(known, { name: "friends", hostPublicKey: "KEY-TWO-0123456789" }), true);
    assert.equal(DetectOwnershipChange(known, { name: "friends", hostPublicKey: "KEY-ONE-0123456789" }), false);
    assert.equal(DetectOwnershipChange(known, { name: "other", hostPublicKey: "KEY-TWO-0123456789" }), false);
    assert.equal(DetectOwnershipChange(known, { name: "FRIENDS", hostPublicKey: "KEY-TWO-0123456789" }), true);
});

// ----- invite codes -----

test("invite codes are 10 characters of an alphabet without look-alikes", () => {
    assert.equal(INVITE_CODE_LENGTH, 10);
    assert.equal(INVITE_ALPHABET.length, 32);
    for (const ambiguous of ["I", "O", "0", "1"]) assert.ok(!INVITE_ALPHABET.includes(ambiguous), ambiguous);
    assert.equal(new Set(INVITE_ALPHABET).size, 32);
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index++) {
        const code = GenerateInviteCode();
        assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
        seen.add(code);
    }
    assert.equal(seen.size, 2000, "2000 random codes must not collide");
});

test("invite code generation maps random bytes without bias and is deterministic for a given source", () => {
    assert.equal(GenerateInviteCode(() => Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), "ABCDEFGHJK");
    // Only the low 5 bits are used: 255 and 31 both pick the last symbol, 32 picks the first.
    assert.equal(GenerateInviteCode(() => Uint8Array.from([255, 31, 32, 63, 64, 0, 0, 0, 0, 0])), "99A9AAAAAA");
});

test("a typed or pasted invite code is normalised, and anything that cannot be a code is refused", () => {
    assert.equal(NormalizeInviteCode("abcde-fghjk"), "ABCDEFGHJK");
    assert.equal(NormalizeInviteCode("  ABCDE FGHJK "), "ABCDEFGHJK");
    assert.equal(NormalizeInviteCode("a-b-c-d-e-f-g-h-j-k"), "ABCDEFGHJK");
    for (const bad of ["ABCDEFGHJ", "ABCDEFGHJKL", "ABCDEFGHIK", "ABCDEFGHOK", "ABCDE0GHJK", "ABCDE1GHJK", "ABCDE_GHJK", "", "x".repeat(41)]) {
        assert.equal(NormalizeInviteCode(bad), undefined, bad);
    }
    for (const value of [undefined, null, 1234567890, {}, ["ABCDEFGHJK"]]) assert.equal(NormalizeInviteCode(value), undefined);
});

// ----- invite validity -----

function Invite(overrides: Partial<RealmInviteRecord> = {}): RealmInviteRecord {
    return BuildInvite({ code: "ABCDEFGHJK", realmId: "realm-1", createdBy: "host-1", nowMs: T0, maxUses: 2, ttlHours: 24, ...overrides });
}

test("a fresh invite is usable until it expires, is revoked or is used up", () => {
    const invite = Invite();
    assert.equal(invite.uses, 0);
    assert.equal(invite.createdAt, iso(T0));
    assert.equal(invite.expiresAt, iso(T0 + DAY));
    assert.equal(GetInviteState(invite, T0), "USABLE");
    assert.equal(GetInviteState(invite, T0 + DAY - 1), "USABLE");
    assert.equal(GetInviteState(invite, T0 + DAY), "EXPIRED");
    assert.equal(GetInviteState({ ...invite, uses: 1 }, T0), "USABLE");
    assert.equal(GetInviteState({ ...invite, uses: 2 }, T0), "EXHAUSTED");
    assert.equal(GetInviteState({ ...invite, uses: 3 }, T0), "EXHAUSTED");
    assert.equal(GetInviteState({ ...invite, revokedAt: iso(T0) }, T0), "REVOKED");
    // Revoked outranks every other reason.
    assert.equal(GetInviteState({ ...invite, revokedAt: iso(T0), uses: 2 }, T0 + 2 * DAY), "REVOKED");
    assert.equal(GetInviteState({ ...invite, expiresAt: "garbage" }, T0), "EXPIRED");
    assert.equal(IsInviteUsable(invite, T0), true);
    assert.equal(IsInviteUsable({ ...invite, uses: 2 }, T0), false);
});

// ----- the join decision -----

const HOST: RealmMember = { accountId: "host-1", role: "HOST", joinedAt: iso(T0) };
const FRIEND: RealmMember = { accountId: "friend-1", role: "MEMBER", joinedAt: iso(T0) };

function Realm(overrides: { joinPolicy?: "INVITE_ONLY" | "PUBLIC"; members?: RealmMember[]; bans?: RealmBan[] } = {}) {
    return { realmId: "realm-1", joinPolicy: "INVITE_ONLY" as const, members: [HOST], bans: [] as RealmBan[], ...overrides };
}

test("a banned account is refused whatever else is true", () => {
    const bans: RealmBan[] = [{ accountId: "bad-1", at: iso(T0) }];
    assert.deepEqual(DecideJoin(Realm({ bans }), "bad-1", undefined, T0), { allow: false, reason: "BANNED" });
    assert.deepEqual(DecideJoin(Realm({ bans, joinPolicy: "PUBLIC" }), "bad-1", undefined, T0), { allow: false, reason: "BANNED" });
    assert.deepEqual(DecideJoin(Realm({ bans }), "bad-1", Invite(), T0), { allow: false, reason: "BANNED" });
    // Even a leftover membership does not outrank the ban.
    assert.deepEqual(DecideJoin(Realm({ bans, members: [HOST, { ...FRIEND, accountId: "bad-1" }] }), "bad-1", undefined, T0), { allow: false, reason: "BANNED" });
});

test("a PUBLIC realm lets anyone in, an invite-only one needs a membership or a valid invite of that realm", () => {
    assert.deepEqual(DecideJoin(Realm({ joinPolicy: "PUBLIC" }), "stranger", undefined, T0), { allow: true, via: "PUBLIC" });

    assert.deepEqual(DecideJoin(Realm(), "stranger", undefined, T0), { allow: false, reason: "INVITE_REQUIRED" });
    assert.deepEqual(DecideJoin(Realm(), "stranger", Invite(), T0), { allow: true, via: "INVITE" });
    assert.deepEqual(DecideJoin(Realm(), "stranger", Invite({ realmId: "realm-2" }), T0), { allow: false, reason: "INVITE_INVALID" });
    assert.deepEqual(DecideJoin(Realm(), "stranger", { ...Invite(), revokedAt: iso(T0) }, T0), { allow: false, reason: "INVITE_EXPIRED" });
    assert.deepEqual(DecideJoin(Realm(), "stranger", { ...Invite(), uses: 2 }, T0), { allow: false, reason: "INVITE_EXPIRED" });
    assert.deepEqual(DecideJoin(Realm(), "stranger", Invite(), T0 + 2 * DAY), { allow: false, reason: "INVITE_EXPIRED" });
});

test("the host and members are already in, with no invite needed and none consumed", () => {
    const realm = Realm({ members: [HOST, FRIEND] });
    assert.deepEqual(DecideJoin(realm, "host-1", undefined, T0), { allow: true, via: "MEMBER" });
    assert.deepEqual(DecideJoin(realm, "friend-1", undefined, T0), { allow: true, via: "MEMBER" });
    assert.deepEqual(DecideJoin(realm, "friend-1", { ...Invite(), uses: 2 }, T0), { allow: true, via: "MEMBER" });
});

// ----- online state -----

test("a heartbeat keeps the realm online for 90 seconds", () => {
    assert.equal(HEARTBEAT_ONLINE_MS, 90_000);
    const update = ApplyHeartbeat(T0);
    assert.deepEqual(update, { lastOnlineAt: iso(T0), onlineUntil: iso(T0 + 90_000) });
    assert.equal(IsRealmOnline(update, T0), true);
    assert.equal(IsRealmOnline(update, T0 + 89_999), true);
    assert.equal(IsRealmOnline(update, T0 + 90_000), false);
});

test("a heartbeat records the version only when the host sent one, and online:false ends the online state now", () => {
    assert.equal("version" in ApplyHeartbeat(T0, {}), false);
    assert.equal(ApplyHeartbeat(T0, { version: "0.2.128" }).version, "0.2.128");
    const closing = ApplyHeartbeat(T0, { online: false, version: "0.2.128" });
    assert.equal(closing.onlineUntil, iso(T0));
    assert.equal(closing.lastOnlineAt, iso(T0), "closing on purpose still counts as online at least once");
    assert.equal(IsRealmOnline(closing, T0), false);
    assert.equal(ApplyHeartbeat(T0, { online: true }).onlineUntil, iso(T0 + 90_000));
});

test("a realm with no heartbeat, or a garbled one, is offline", () => {
    assert.equal(IsRealmOnline({}, T0), false);
    assert.equal(IsRealmOnline({ onlineUntil: "garbage" }, T0), false);
});

test("join requests are listed newest first; requests at the same time keep their stored order", () => {
    const requests = [
        { accountId: "a", at: iso(T0) },
        { accountId: "b", at: iso(T0 + 2_000) },
        { accountId: "c", at: iso(T0) },
        { accountId: "d", at: iso(T0 + 1_000) }
    ];
    assert.deepEqual(SortJoinRequestsNewestFirst(requests).map((request) => request.accountId), ["b", "d", "a", "c"]);
    assert.deepEqual(requests.map((request) => request.accountId), ["a", "b", "c", "d"], "the input is not reordered");
    assert.deepEqual(SortJoinRequestsNewestFirst([]), []);
});
