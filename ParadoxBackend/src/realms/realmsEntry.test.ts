import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizeGameSessionRealm, BindRealmPresenceAtLogin } from "./entry";
import { LauncherApiError } from "./realmErrors";
import { KEY_A, KEY_B, Rejects, SetupRealms, T0 } from "./realmsTestKit";

// Entry into a realm (2026-10-13 hub design section 2.1): RealmsService.authorizeEntry and the two functions the game-session and
// login routes call. All with the in-memory repositories.

const DAY = 24 * 3_600_000;

async function Prepare(extra: Record<string, unknown> = {}) {
    const kit = SetupRealms();
    const realm = await kit.create("host-1", "friends", extra);
    return { ...kit, realm };
}

// ----- authorizeEntry -----

test("a serving realm admits its host, its members and a valid invite holder, and says who is the host", async () => {
    const { service, serve, realm } = await Prepare();
    await serve("host-1", realm.realmId);
    assert.deepEqual(await service.authorizeEntry("host-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: true });

    const { invite } = await service.createInvite("host-1", { maxUses: 2, ttlHours: 24 });
    assert.deepEqual(
        await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code }),
        { ok: true, realmId: realm.realmId, isHost: false }
    );
    // Now a member: no invite needed, and nothing more is used.
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: false });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code }), { ok: true, realmId: realm.realmId, isHost: false });
    const view = (await service.getMine("host-1")).hosted!;
    assert.deepEqual(view.members.map((member) => member.accountId), ["host-1", "friend-1"]);
    assert.equal((await service.listInvites("host-1")).invites[0].uses, 1, "the invite was used once, by the join");
});

test("a PUBLIC serving realm admits a stranger and makes them a member", async () => {
    const kit = SetupRealms();
    const realm = await kit.create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await kit.serve("host-1", realm.realmId);
    assert.deepEqual(await kit.service.authorizeEntry("friend-1", { name: "open-house" }), { ok: true, realmId: realm.realmId, isHost: false });
    assert.equal((await kit.service.getByName("friend-1", "open-house")).realm.membership, "MEMBER");
});

test("an unknown realm, an unknown or foreign invite and a changed owner are each refused with their own code", async () => {
    const { service, serve, create, realm } = await Prepare();
    await serve("host-1", realm.realmId);
    const other = await create("host-2", "rivals");
    const { invite } = await service.createInvite("host-2", { maxUses: 2, ttlHours: 24 });

    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "no-such-realm" }), { ok: false, code: "REALM_NOT_FOUND" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", inviteCode: "ZZZZZZZZZZ" }), { ok: false, code: "REALM_INVITE_INVALID" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code }), { ok: false, code: "REALM_INVITE_INVALID" }, "an invite of another realm");
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", knownHostKey: KEY_B }), { ok: false, code: "REALM_OWNER_CHANGED" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", knownHostKey: KEY_A }), { ok: false, code: "REALM_JOIN_REQUESTED" });
    assert.equal(other.realmId, "realm-2");
    assert.equal((await service.getByName("host-1", "friends")).realm.memberCount, 1, "nothing was joined");
});

test("a stranger needs an invite for an invite-only realm; used up, expired and revoked invites are refused and used nothing", async () => {
    const { clock, repo, service, serve, realm } = await Prepare();
    await serve("host-1", realm.realmId);
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_JOIN_REQUESTED" });

    const spent = (await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 })).invite;
    assert.equal((await service.authorizeEntry("friend-1", { name: "friends", inviteCode: spent.code })).ok, true);
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends", inviteCode: spent.code }), { ok: false, code: "REALM_INVITE_EXPIRED" });

    const revoked = (await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 })).invite;
    await service.revokeInvite("host-1", revoked.code);
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends", inviteCode: revoked.code }), { ok: false, code: "REALM_INVITE_EXPIRED" });

    const short = (await service.createInvite("host-1", { maxUses: 5, ttlHours: 1 })).invite;
    clock.now = T0 + 3_600_000;
    await service.heartbeat("host-1", {}); // still online and serving at the new time
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends", inviteCode: short.code }), { ok: false, code: "REALM_INVITE_EXPIRED" });
    assert.equal(repo.invites.get(revoked.code)!.uses, 0);
    assert.equal(repo.invites.get(short.code)!.uses, 0);
});

test("a banned account is refused, even with a valid invite and in a PUBLIC realm, and the invite is not used", async () => {
    const { repo, service, serve, realm } = await Prepare();
    await serve("host-1", realm.realmId);
    const { invite } = await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    assert.equal((await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code })).ok, true);
    await service.ban("host-1", "friend-1", "griefing");
    assert.equal(repo.invites.get(invite.code)!.uses, 1);

    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code }), { ok: false, code: "REALM_BANNED" });
    await service.updateSettings("host-1", { joinPolicy: "PUBLIC" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_BANNED" });
    assert.equal(repo.invites.get(invite.code)!.uses, 1, "the refused entries used nothing");
    assert.equal((await service.authorizeEntry("friend-2", { name: "friends" })).ok, true, "others are still welcome");
});

test("a realm that is not serving is offline to everyone but its host: no hub, hub starting, hub stopped, or a lapsed heartbeat", async () => {
    const { clock, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    await service.updateSettings("host-1", { joinPolicy: "PUBLIC" });

    // Never online.
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
    // Online, but no hub (the host's launcher is up, the hub is not).
    await service.heartbeat("host-1", {});
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
    await service.setHosting(realm.realmId, { hubState: "STARTING" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
    // Running: in.
    await service.setHosting(realm.realmId, { hubState: "RUNNING" });
    assert.equal((await service.authorizeEntry("friend-1", { name: "friends" })).ok, true);
    // Hub stopping: out again.
    await service.setHosting(realm.realmId, { hubState: "STOPPING" });
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
    await service.setHosting(realm.realmId, { hubState: "RUNNING" });
    assert.equal((await service.authorizeEntry("friend-2", { name: "friends" })).ok, true);
    // The host's heartbeat lapses (90 s): offline for members too.
    clock.now = T0 + 90_000;
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends" }), { ok: false, code: "REALM_OFFLINE" });
});

test("the host enters its own realm even when nothing is serving (that is how it starts it)", async () => {
    const { service, realm } = await Prepare();
    assert.deepEqual(await service.authorizeEntry("host-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: true });
});

test("an offline refusal costs nothing: the invite is not used and the stranger is not made a member", async () => {
    const { repo, service, realm } = await Prepare();
    const { invite } = await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code }), { ok: false, code: "REALM_OFFLINE" });
    assert.equal(repo.invites.get(invite.code)!.uses, 0);
    assert.equal(repo.realms.get(realm.realmId)!.members.length, 1);
    // Once the realm serves, the same invite still works.
    await service.heartbeat("host-1", {});
    await service.setHosting(realm.realmId, { hubState: "RUNNING" });
    assert.equal((await service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code })).ok, true);
    assert.equal(repo.invites.get(invite.code)!.uses, 1);
});

test("a full realm refuses the entry and gives the invite use back", async () => {
    const kit = SetupRealms({ limits: { maxMembers: 2, maxBans: 5, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 50 } });
    const realm = await kit.create("host-1", "friends");
    await kit.serve("host-1", realm.realmId);
    const { invite } = await kit.service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    assert.equal((await kit.service.authorizeEntry("friend-1", { name: "friends", inviteCode: invite.code })).ok, true);
    assert.deepEqual(await kit.service.authorizeEntry("friend-2", { name: "friends", inviteCode: invite.code }), { ok: false, code: "REALM_FULL" });
    assert.equal(kit.repo.invites.get(invite.code)!.uses, 1, "the failed entry's use was refunded");
});

test("a realm that changed hands is refused for the old host key before anything else", async () => {
    const { clock, service, create } = SetupRealms();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    clock.now = T0 + 3 * DAY;
    const next = await create("host-2", "open-house", { joinPolicy: "PUBLIC", hostPublicKey: KEY_B });
    await service.heartbeat("host-2", {});
    await service.setHosting(next.realmId, { hubState: "RUNNING" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "open-house", knownHostKey: KEY_A }), { ok: false, code: "REALM_OWNER_CHANGED" });
    assert.equal((await service.authorizeEntry("friend-1", { name: "open-house", knownHostKey: KEY_B })).ok, true);
});

test("entries share a per-account budget and a spent one throws the rate-limit error", async () => {
    const keys: string[] = [];
    const { service, realm } = await (async () => {
        const kit = SetupRealms({ isRateLimited: (key) => { keys.push(key); return key.startsWith("realms:entry:"); } });
        const created = await kit.create("host-1", "friends");
        return { ...kit, realm: created };
    })();
    void realm;
    await Rejects(service.authorizeEntry("friend-1", { name: "friends" }), "AUTH_RATE_LIMITED");
    assert.ok(keys.includes("realms:entry:friend-1"));
});

// ----- AuthorizeGameSessionRealm (what POST /launcher/v1/game-sessions does with `realm`) -----

test("a game session without a realm is untouched: nothing is checked, nothing is asked of the service", async () => {
    const service = () => { throw new Error("the service must not be used"); };
    const enabled = () => { throw new Error("the switch must not be read"); };
    assert.equal(await AuthorizeGameSessionRealm("friend-1", undefined, { service, enabled }), undefined);
    assert.equal(await AuthorizeGameSessionRealm("friend-1", null, { service, enabled }), undefined);
});

test("a game session that names a realm while the module is off is refused, never played as official", async () => {
    const service = () => { throw new Error("the service must not be used"); };
    await Rejects(AuthorizeGameSessionRealm("friend-1", { name: "friends" }, { enabled: () => false, service }), "REALMS_DISABLED");
    // Even a malformed realm is a refusal, not a silent official Play.
    await Rejects(AuthorizeGameSessionRealm("friend-1", "friends", { enabled: () => false, service }), "REALMS_DISABLED");
    await Rejects(AuthorizeGameSessionRealm("friend-1", false, { enabled: () => false, service }), "REALMS_DISABLED");
});

test("a malformed realm is refused with the validation code before the service is asked", async () => {
    const service = () => { throw new Error("the service must not be used"); };
    const deps = { enabled: () => true, service };
    await Rejects(AuthorizeGameSessionRealm("friend-1", {}, deps), "REALM_VALIDATION_FAILED");
    await Rejects(AuthorizeGameSessionRealm("friend-1", "friends", deps), "REALM_VALIDATION_FAILED");
    await Rejects(AuthorizeGameSessionRealm("friend-1", { name: "a" }, deps), "REALM_NAME_INVALID");
    await Rejects(AuthorizeGameSessionRealm("friend-1", { name: "friends", inviteCode: "nope" }, deps), "REALM_VALIDATION_FAILED");
});

test("an authorized game session names its realm; every refusal of the service surfaces as that launcher error", async () => {
    const kit = SetupRealms();
    const realm = await kit.create("host-1", "friends");
    const deps = { enabled: () => true, service: () => kit.service };

    // Offline first.
    await Rejects(AuthorizeGameSessionRealm("friend-1", { name: "friends" }, deps), "REALM_JOIN_REQUESTED");
    assert.deepEqual(await AuthorizeGameSessionRealm("host-1", { name: "friends" }, deps), { realmId: realm.realmId, isHost: true });

    await kit.serve("host-1", realm.realmId);
    const { invite } = await kit.service.createInvite("host-1", { maxUses: 3, ttlHours: 24 });
    assert.deepEqual(
        await AuthorizeGameSessionRealm("friend-1", { name: "friends", inviteCode: invite.code }, deps),
        { realmId: realm.realmId, isHost: false }
    );
    await Rejects(AuthorizeGameSessionRealm("friend-2", { name: "friends", knownHostKey: KEY_B }, deps), "REALM_OWNER_CHANGED");
    await Rejects(AuthorizeGameSessionRealm("friend-2", { name: "missing-realm" }, deps), "REALM_NOT_FOUND");

    await kit.service.ban("host-1", "friend-1");
    await Rejects(AuthorizeGameSessionRealm("friend-1", { name: "friends" }, deps), "REALM_BANNED");
    kit.clock.now = T0 + 120_000; // the host stopped reporting
    await Rejects(AuthorizeGameSessionRealm("friend-2", { name: "friends", inviteCode: invite.code }, deps), "REALM_OFFLINE");

    // The error carries a readable message.
    await assert.rejects(
        AuthorizeGameSessionRealm("friend-2", { name: "friends", inviteCode: invite.code }, deps),
        (error: unknown) => error instanceof LauncherApiError && error.message.length > 10
    );
});

// ----- BindRealmPresenceAtLogin (what the game login does with the consumed code) -----

test("the login bind does nothing while the module is off", async () => {
    const service = () => { throw new Error("the service must not be used"); };
    await BindRealmPresenceAtLogin("friend-1", "realm-1", { enabled: () => false, service });
    await BindRealmPresenceAtLogin("friend-1", null, { enabled: () => false, service });
    await BindRealmPresenceAtLogin("friend-1", undefined, { enabled: () => false, service });
});

test("every login resets the realm context: a code with a realm binds it, a code without one clears it", async () => {
    const kit = SetupRealms();
    const deps = { enabled: () => true, service: () => kit.service };
    await BindRealmPresenceAtLogin("friend-1", "realm-1", deps);
    assert.equal((await kit.service.presenceOf("friend-1"))?.realmId, "realm-1");
    await BindRealmPresenceAtLogin("friend-1", "realm-2", deps);
    assert.equal((await kit.service.presenceOf("friend-1"))?.realmId, "realm-2", "a new realm replaces the old one");
    await BindRealmPresenceAtLogin("friend-1", undefined, deps);
    assert.equal(await kit.service.presenceOf("friend-1"), undefined, "an official Play keeps no realm");
    await BindRealmPresenceAtLogin("friend-1", "realm-1", deps);
    await BindRealmPresenceAtLogin("friend-1", null, deps);
    assert.equal(await kit.service.presenceOf("friend-1"), undefined);
});

test("a failed reset never blocks a login, a failed realm bind does (it must not continue as official play)", async () => {
    const failing = { enabled: () => true, service: () => ({ bindPresence: async () => { throw new Error("database down"); } }) };
    await BindRealmPresenceAtLogin("friend-1", null, failing);
    await BindRealmPresenceAtLogin("friend-1", undefined, failing);
    await assert.rejects(BindRealmPresenceAtLogin("friend-1", "realm-1", failing), /database down/);
});
