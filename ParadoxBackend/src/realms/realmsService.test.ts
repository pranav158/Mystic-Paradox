import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRealmPresenceRepository, InMemoryRealmsRepository } from "./persistence/InMemoryRealmsRepository";
import { LauncherApiError } from "./realmErrors";
import { CreateRealmsService, RealmsServiceDeps } from "./realmsService";
import { RealmEvent } from "./realmTypes";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const KEY_A = "KEY-A-0123456789abcdef";
const KEY_B = "KEY-B-0123456789abcdef";

const NAMES = new Map([["host-1", "Hosty"], ["friend-1", "Friendly"], ["friend-2", "Pal"]]);

function Setup(overrides: Partial<RealmsServiceDeps> = {}) {
    const clock = { now: T0 };
    const repo = new InMemoryRealmsRepository();
    const presence = new InMemoryRealmPresenceRepository();
    const events: RealmEvent[] = [];
    let realmCounter = 0;
    let codeCounter = 0;
    const service = CreateRealmsService({
        repository: repo,
        presence,
        events: async (event) => { events.push(event); },
        displayNames: async (ids) => new Map(ids.filter((id) => NAMES.has(id)).map((id) => [id, NAMES.get(id)!])),
        now: () => clock.now,
        isRateLimited: () => false,
        generateRealmId: () => `realm-${++realmCounter}`,
        // ABCDEFGHJK, ABCDEFGHJL, ... : valid codes that differ per call.
        generateInviteCode: () => `ABCDEFGH${"JKLMNPQRST"[Math.floor(codeCounter / 10) % 10]}${"KLMNPQRSTU"[codeCounter++ % 10]}`,
        ...overrides
    });
    const create = (accountId: string, name: string, extra: Record<string, unknown> = {}) =>
        service.createRealm(accountId, { name, hostPublicKey: KEY_A, joinPolicy: "INVITE_ONLY", listed: false, ...extra });
    return { clock, repo, presence, events, service, create };
}

async function Rejects(promise: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(promise, (error: unknown) => error instanceof LauncherApiError && error.code === code, `expected ${code}`);
}

// ----- claiming a name -----

test("a new realm is invite-only and unlisted by default, with its host as the first member, offline", async () => {
    const { service, create } = Setup();
    const { realm } = await create("host-1", "friends");
    assert.equal(realm.name, "friends");
    assert.equal(realm.joinPolicy, "INVITE_ONLY");
    assert.equal(realm.listed, false);
    assert.equal(realm.online, false);
    assert.equal(realm.memberCount, 1);
    assert.equal(realm.membership, "HOST");
    assert.equal(realm.host.displayName, "Hosty");
    assert.equal(realm.hostPublicKey, KEY_A);
    assert.deepEqual(realm.members, [{ accountId: "host-1", displayName: "Hosty", role: "HOST", joinedAt: "2026-10-13T12:00:00.000Z" }]);
    assert.equal(realm.nameReleaseAt, new Date(T0 + 3 * DAY).toISOString());
    const mine = await service.getMine("host-1");
    assert.equal(mine.hosted?.realmId, realm.realmId);
    assert.deepEqual(mine.memberOf, []);
});

test("a taken name and a second realm for the same host are refused", async () => {
    const { repo, create } = Setup();
    await create("host-1", "friends");
    await Rejects(create("host-2", "friends"), "REALM_NAME_TAKEN");
    await Rejects(create("host-1", "other-name"), "REALM_ALREADY_EXISTS");
    assert.equal(repo.realms.size, 1);
});

test("a name that was never online is released 3 days after the claim, and the new claim replaces the old realm", async () => {
    const { clock, repo, service, create } = Setup();
    const first = (await create("host-1", "friends")).realm;
    const invite = (await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 })).invite;
    await service.join("friend-1", { inviteCode: invite.code });

    clock.now = T0 + 3 * DAY - 1;
    await Rejects(create("host-2", "friends", { hostPublicKey: KEY_B }), "REALM_NAME_TAKEN");
    assert.equal(repo.realms.size, 1);

    clock.now = T0 + 3 * DAY;
    const second = (await create("host-2", "friends", { hostPublicKey: KEY_B })).realm;
    assert.notEqual(second.realmId, first.realmId);
    assert.equal(second.hostPublicKey, KEY_B);
    assert.equal(repo.realms.size, 1);
    assert.equal(repo.invites.size, 0, "the old realm's invites go with it");
    // The old host is free to claim again, and the old member is not in the new realm.
    assert.equal((await service.getMine("friend-1")).memberOf.length, 0);
    await create("host-1", "my-new-name");
});

test("a realm that was online keeps its name for 30 days after the last heartbeat", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "friends");
    clock.now = T0 + 2 * DAY;
    await service.heartbeat("host-1", {});

    clock.now = T0 + 2 * DAY + 29 * DAY;
    await Rejects(create("host-2", "friends"), "REALM_NAME_TAKEN");
    clock.now = T0 + 2 * DAY + 30 * DAY - 1;
    await Rejects(create("host-2", "friends"), "REALM_NAME_TAKEN");
    clock.now = T0 + 2 * DAY + 30 * DAY;
    await create("host-2", "friends");
});

test("a realm's name is held while it is online, however old the claim", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "friends");
    for (let day = 0; day < 40; day += 10) {
        clock.now = T0 + day * DAY;
        await service.heartbeat("host-1", {});
    }
    clock.now = T0 + 41 * DAY;
    await Rejects(create("host-2", "friends"), "REALM_NAME_TAKEN");
});

test("a host who already has a realm cannot take a dormant name (and the dormant realm is left alone)", async () => {
    const { clock, repo, create } = Setup();
    await create("host-1", "friends");
    await create("host-3", "mine-already");
    clock.now = T0 + 10 * DAY;
    await Rejects(create("host-3", "friends"), "REALM_ALREADY_EXISTS");
    assert.equal(repo.realms.size, 2, "nothing was released for a claim that could not succeed");
});

test("if the dormant host comes back between the check and the release, the name stays taken", async () => {
    const { clock, repo, create } = Setup();
    await create("host-1", "friends");
    clock.now = T0 + 10 * DAY;
    repo.deleteRealmIfLastOnline = async () => false; // a heartbeat landed first
    await Rejects(create("host-2", "friends"), "REALM_NAME_TAKEN");
    assert.equal(repo.realms.size, 1);
});

// ----- directory lookups -----

test("anyone signed in can look a realm up by name and gets public information only", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends", { joinPolicy: "PUBLIC", listed: true, version: "0.2.128" });
    const { realm } = await service.getByName("stranger", "friends");
    assert.deepEqual(Object.keys(realm).sort(), [
        "host", "hostPublicKey", "hubReady", "invited", "joinPolicy", "listed", "memberCount", "membership", "name", "online", "playerCount",
        "realmId", "requested", "serving", "version"
    ]);
    assert.deepEqual(realm.host, { displayName: "Hosty" });
    assert.equal(realm.version, "0.2.128");
    assert.equal(realm.membership, null);
    assert.equal(realm.online, false);
    // No address of any kind can be in the response: no such field, and no IPv4 text in any value.
    assert.ok(!Object.keys(realm).some((key) => /^(ip|ipAddress|address|port|endpoint|candidates?)$/i.test(key)));
    assert.ok(!/\d{1,3}(\.\d{1,3}){3}/.test(JSON.stringify(realm)), JSON.stringify(realm));
    await Rejects(service.getByName("stranger", "nothing-here"), "REALM_NOT_FOUND");
});

test("the ownership notice: a launcher that sends the key it knew learns when the name has a new host", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "friends");
    assert.equal((await service.getByName("friend-1", "friends")).realm.ownershipChanged, undefined);
    assert.equal((await service.getByName("friend-1", "friends", KEY_A)).realm.ownershipChanged, false);
    assert.equal((await service.getByName("friend-1", "friends", KEY_B)).realm.ownershipChanged, true);

    clock.now = T0 + 3 * DAY;
    await create("host-2", "friends", { hostPublicKey: KEY_B });
    assert.equal((await service.getByName("friend-1", "friends", KEY_A)).realm.ownershipChanged, true);
    assert.equal((await service.getByName("friend-1", "friends", KEY_B)).realm.ownershipChanged, false);
});

test("only listed realms appear in the listing, online ones first", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "alpha", { listed: true });
    await create("host-2", "bravo", { listed: true });
    await create("host-3", "charlie", { listed: false });
    await create("host-4", "delta", { listed: true });
    clock.now = T0 + 1000;
    await service.heartbeat("host-4", {});
    const listing = await service.listListed("friend-1", { limit: 10, offset: 0 });
    assert.deepEqual(listing.realms.map((realm) => realm.name), ["delta", "alpha", "bravo"]);
    assert.equal(listing.realms[0].online, true);
    assert.deepEqual((await service.listListed("friend-1", { limit: 1, offset: 1 })).realms.map((realm) => realm.name), ["alpha"]);
});

test("a failing display-name lookup does not fail the directory", async () => {
    const { service, create } = Setup({ displayNames: async () => { throw new Error("accounts unavailable"); } });
    const { realm } = await create("host-1", "friends");
    assert.equal(realm.host.displayName, null);
    assert.equal((await service.getByName("friend-1", "friends")).realm.host.displayName, null);
});

// ----- joining -----

test("a PUBLIC realm admits anyone, once", async () => {
    const { service, create } = Setup();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    const first = await service.join("friend-1", { name: "open-house" });
    assert.equal(first.joined, true);
    assert.equal(first.realm.membership, "MEMBER");
    assert.equal(first.realm.memberCount, 2);
    const again = await service.join("friend-1", { name: "open-house" });
    assert.equal(again.joined, false);
    assert.equal(again.realm.memberCount, 2);
    const mine = await service.getMine("friend-1");
    assert.deepEqual(mine.memberOf.map((realm) => realm.name), ["open-house"]);
    assert.equal(mine.hosted, null);
});

test("an invite-only realm needs an invite; each join uses one; a used-up, expired or revoked invite is refused", async () => {
    const { clock, repo, service, create } = Setup();
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");

    const { invite } = await service.createInvite("host-1", { maxUses: 2, ttlHours: 24 });
    assert.equal(invite.uses, 0);
    assert.equal(invite.state, "USABLE");

    const joined = await service.join("friend-1", { inviteCode: invite.code });
    assert.equal(joined.joined, true);
    assert.equal(joined.realm.name, "friends");
    assert.equal(repo.invites.get(invite.code)!.uses, 1);

    // Joining again as a member uses nothing.
    assert.equal((await service.join("friend-1", { inviteCode: invite.code })).joined, false);
    assert.equal(repo.invites.get(invite.code)!.uses, 1);

    assert.equal((await service.join("friend-2", { name: "friends", inviteCode: invite.code })).joined, true);
    assert.equal(repo.invites.get(invite.code)!.uses, 2);
    await Rejects(service.join("friend-3", { inviteCode: invite.code }), "REALM_INVITE_EXPIRED");
    assert.equal((await service.getByName("host-1", "friends")).realm.memberCount, 3);

    const second = (await service.createInvite("host-1", { maxUses: 5, ttlHours: 1 })).invite;
    clock.now = T0 + 3_600_000;
    await Rejects(service.join("friend-3", { inviteCode: second.code }), "REALM_INVITE_EXPIRED");

    clock.now = T0;
    const third = (await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 })).invite;
    await service.revokeInvite("host-1", third.code);
    await Rejects(service.join("friend-3", { inviteCode: third.code }), "REALM_INVITE_EXPIRED");

    await Rejects(service.join("friend-3", { inviteCode: "ZZZZZZZZZZ" }), "REALM_INVITE_INVALID");
});

test("an invite cannot be used for another realm's name", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    await create("host-2", "rivals");
    const { invite } = await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    await Rejects(service.join("friend-1", { name: "rivals", inviteCode: invite.code }), "REALM_INVITE_INVALID");
    await Rejects(service.join("friend-1", { name: "no-such-realm" }), "REALM_NOT_FOUND");
});

test("a banned account is refused before any invite is used, in invite-only and PUBLIC realms alike", async () => {
    const { repo, service, create } = Setup();
    await create("host-1", "friends");
    const { invite } = await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    await service.join("friend-1", { inviteCode: invite.code });
    await service.ban("host-1", "friend-1", "griefing");

    await Rejects(service.join("friend-1", { inviteCode: invite.code }), "REALM_BANNED");
    await Rejects(service.previewInvite("friend-1", invite.code), "REALM_BANNED");
    assert.equal(repo.invites.get(invite.code)!.uses, 1, "the refused join used nothing");

    await service.updateSettings("host-1", { joinPolicy: "PUBLIC" });
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_BANNED");
    assert.equal((await service.join("friend-2", { name: "friends" })).joined, true);
});

test("a full realm refuses the join and gives the invite use back", async () => {
    const { repo, service, create } = Setup({ limits: { maxMembers: 2, maxBans: 5, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 50 } });
    await create("host-1", "friends");
    const { invite } = await service.createInvite("host-1", { maxUses: 5, ttlHours: 24 });
    await service.join("friend-1", { inviteCode: invite.code });
    await Rejects(service.join("friend-2", { inviteCode: invite.code }), "REALM_FULL");
    assert.equal(repo.invites.get(invite.code)!.uses, 1, "the failed join's use was refunded");
});

test("a launcher that remembers an old host key is told about a new owner instead of being joined", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    clock.now = T0 + 3 * DAY;
    await create("host-2", "open-house", { joinPolicy: "PUBLIC", hostPublicKey: KEY_B });
    await Rejects(service.join("friend-1", { name: "open-house", knownHostKey: KEY_A }), "REALM_OWNER_CHANGED");
    assert.equal((await service.join("friend-1", { name: "open-house", knownHostKey: KEY_B })).joined, true);
    assert.equal((await service.join("friend-2", { name: "open-house" })).joined, true);
});

test("an invite can be previewed without using it", async () => {
    const { repo, service, create } = Setup();
    await create("host-1", "friends", { version: "0.2.128" });
    const { invite } = await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 });
    const preview = await service.previewInvite("friend-1", invite.code);
    assert.equal(preview.realm.name, "friends");
    assert.equal(preview.realm.membership, null);
    assert.equal(repo.invites.get(invite.code)!.uses, 0);
    await Rejects(service.previewInvite("friend-1", "ZZZZZZZZZZ"), "REALM_INVITE_INVALID");
    await service.revokeInvite("host-1", invite.code);
    await Rejects(service.previewInvite("friend-1", invite.code), "REALM_INVITE_EXPIRED");
});

// ----- leaving, kicking, banning -----

test("a member can leave; the host cannot (they release the realm instead); a stranger is not a member", async () => {
    const { service, create } = Setup();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await Rejects(service.leave("friend-2", "open-house"), "REALM_NOT_MEMBER");
    await Rejects(service.leave("host-1", "open-house"), "REALM_HOST_CANNOT_LEAVE");
    await Rejects(service.leave("friend-1", "nothing-here"), "REALM_NOT_FOUND");
    assert.deepEqual(await service.leave("friend-1", "open-house"), { left: true });
    assert.equal((await service.getByName("host-1", "open-house")).realm.memberCount, 1);
    await Rejects(service.leave("friend-1", "open-house"), "REALM_NOT_MEMBER");
    // Leaving is not a ban: a PUBLIC realm takes them back.
    assert.equal((await service.join("friend-1", { name: "open-house" })).joined, true);
});

test("the host can kick a member (who may come back) but not themselves or a stranger", async () => {
    const { service, create } = Setup();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await Rejects(service.kick("host-1", "host-1"), "REALM_INVALID_TARGET");
    await Rejects(service.kick("host-1", "friend-2"), "REALM_NOT_MEMBER");
    await Rejects(service.kick("friend-1", "friend-2"), "REALM_NOT_FOUND");
    assert.deepEqual(await service.kick("host-1", "friend-1"), { accountId: "friend-1", status: "KICKED" });
    assert.equal((await service.getByName("host-1", "open-house")).realm.memberCount, 1);
    assert.equal((await service.join("friend-1", { name: "open-house" })).joined, true);
});

test("a ban removes the member, keeps the account out, lists with its reason, and can be lifted", async () => {
    const { service, create } = Setup();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });

    await Rejects(service.ban("host-1", "host-1"), "REALM_INVALID_TARGET");
    assert.deepEqual(await service.ban("host-1", "friend-1", "griefing"), { accountId: "friend-1", status: "BANNED", changed: true });
    assert.deepEqual(await service.ban("host-1", "friend-1"), { accountId: "friend-1", status: "BANNED", changed: false });
    // A stranger can be banned before they ever joined.
    assert.equal((await service.ban("host-1", "friend-2")).changed, true);

    const view = (await service.getMine("host-1")).hosted!;
    assert.equal(view.memberCount, 1);
    assert.deepEqual(view.bans.map((ban) => [ban.accountId, ban.displayName, ban.reason]), [["friend-1", "Friendly", "griefing"], ["friend-2", "Pal", null]]);
    await Rejects(service.join("friend-1", { name: "open-house" }), "REALM_BANNED");

    assert.deepEqual(await service.unban("host-1", "friend-1"), { accountId: "friend-1", status: "UNBANNED", changed: true });
    assert.equal((await service.unban("host-1", "friend-1")).changed, false);
    assert.equal((await service.join("friend-1", { name: "open-house" })).joined, true);
    await Rejects(service.join("friend-2", { name: "open-house" }), "REALM_BANNED");
});

test("host-only actions answer not-found to an account that hosts no realm", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    await Rejects(service.updateSettings("friend-1", { listed: true }), "REALM_NOT_FOUND");
    await Rejects(service.createInvite("friend-1", { maxUses: 1, ttlHours: 1 }), "REALM_NOT_FOUND");
    await Rejects(service.listInvites("friend-1"), "REALM_NOT_FOUND");
    await Rejects(service.revokeInvite("friend-1", "ABCDEFGHJK"), "REALM_NOT_FOUND");
    await Rejects(service.kick("friend-1", "host-1"), "REALM_NOT_FOUND");
    await Rejects(service.ban("friend-1", "host-1"), "REALM_NOT_FOUND");
    await Rejects(service.unban("friend-1", "host-1"), "REALM_NOT_FOUND");
    await Rejects(service.heartbeat("friend-1", {}), "REALM_NOT_FOUND");
    await Rejects(service.release("friend-1"), "REALM_NOT_FOUND");
});

test("the ban list has a ceiling", async () => {
    const { service, create } = Setup({ limits: { maxMembers: 10, maxBans: 2, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 50 } });
    await create("host-1", "friends");
    await service.ban("host-1", "a1");
    await service.ban("host-1", "a2");
    await Rejects(service.ban("host-1", "a3"), "REALM_FULL");
    assert.equal((await service.ban("host-1", "a2")).changed, false);
});

// ----- settings and invites -----

test("the host changes the join policy and listing", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    const { realm } = await service.updateSettings("host-1", { joinPolicy: "PUBLIC", listed: true });
    assert.equal(realm.joinPolicy, "PUBLIC");
    assert.equal(realm.listed, true);
    assert.equal((await service.updateSettings("host-1", { listed: false })).realm.joinPolicy, "PUBLIC");
});

test("invites: created with the requested use count and lifetime, listed, revoked once and again harmlessly", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    const { invite } = await service.createInvite("host-1", { maxUses: 3, ttlHours: 2 });
    assert.match(invite.code, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.equal(invite.maxUses, 3);
    assert.equal(invite.expiresAt, new Date(T0 + 2 * 3_600_000).toISOString());
    assert.equal(invite.revokedAt, null);
    assert.deepEqual((await service.listInvites("host-1")).invites.map((entry) => entry.code), [invite.code]);

    const revoked = (await service.revokeInvite("host-1", invite.code)).invite;
    assert.equal(revoked.state, "REVOKED");
    assert.equal(revoked.revokedAt, new Date(T0).toISOString());
    assert.equal((await service.revokeInvite("host-1", invite.code)).invite.revokedAt, revoked.revokedAt);
    await Rejects(service.revokeInvite("host-1", "ZZZZZZZZZZ"), "REALM_INVITE_INVALID");
});

test("another host cannot revoke an invite that is not theirs", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    await create("host-2", "rivals");
    const { invite } = await service.createInvite("host-1", { maxUses: 3, ttlHours: 2 });
    await Rejects(service.revokeInvite("host-2", invite.code), "REALM_INVITE_INVALID");
    assert.equal((await service.listInvites("host-1")).invites[0].state, "USABLE");
});

test("a host has a ceiling of open invites; expired and revoked ones do not count", async () => {
    const { clock, service, create } = Setup({ limits: { maxMembers: 10, maxBans: 10, maxActiveInvites: 2, maxJoinRequests: 50, maxPlayerInvites: 50 } });
    await create("host-1", "friends");
    const first = (await service.createInvite("host-1", { maxUses: 1, ttlHours: 1 })).invite;
    await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 });
    await Rejects(service.createInvite("host-1", { maxUses: 1, ttlHours: 24 }), "REALM_INVITE_LIMIT");
    await service.revokeInvite("host-1", first.code);
    await service.createInvite("host-1", { maxUses: 1, ttlHours: 1 });
    await Rejects(service.createInvite("host-1", { maxUses: 1, ttlHours: 24 }), "REALM_INVITE_LIMIT");
    clock.now = T0 + 2 * 3_600_000;
    await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 });
});

test("a clashing invite code is regenerated", async () => {
    const codes = ["ABCDEFGHJK", "ABCDEFGHJK", "ABCDEFGHJL"];
    const { service, create } = Setup({ generateInviteCode: () => codes.shift()! });
    await create("host-1", "friends");
    assert.equal((await service.createInvite("host-1", { maxUses: 1, ttlHours: 1 })).invite.code, "ABCDEFGHJK");
    assert.equal((await service.createInvite("host-1", { maxUses: 1, ttlHours: 1 })).invite.code, "ABCDEFGHJL");
});

// ----- heartbeat, release, limits -----

test("a heartbeat puts the realm online for 90 seconds and records the version; online:false closes it at once", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "friends");
    clock.now = T0 + 1000;
    const beat = await service.heartbeat("host-1", { version: "0.2.128" });
    assert.deepEqual(beat, {
        online: true,
        lastOnlineAt: new Date(T0 + 1000).toISOString(),
        onlineUntil: new Date(T0 + 91_000).toISOString(),
        ttlSeconds: 90,
        version: "0.2.128"
    });
    let info = (await service.getByName("friend-1", "friends")).realm;
    assert.equal(info.online, true);
    assert.equal(info.version, "0.2.128");

    clock.now = T0 + 91_000;
    assert.equal((await service.getByName("friend-1", "friends")).realm.online, false);

    clock.now = T0 + 100_000;
    await service.heartbeat("host-1", {});
    assert.equal((await service.getByName("friend-1", "friends")).realm.version, "0.2.128", "no version in the heartbeat keeps the last one");
    const closing = await service.heartbeat("host-1", { online: false });
    assert.equal(closing.online, false);
    info = (await service.getByName("friend-1", "friends")).realm;
    assert.equal(info.online, false);
    assert.equal((await service.getMine("host-1")).hosted!.lastOnlineAt, new Date(T0 + 100_000).toISOString());
});

test("releasing a realm frees its name at once and removes its members and invites", async () => {
    const { repo, service, create } = Setup();
    await create("host-1", "friends");
    const { invite } = await service.createInvite("host-1", { maxUses: 3, ttlHours: 24 });
    await service.join("friend-1", { inviteCode: invite.code });
    assert.deepEqual(await service.release("host-1"), { released: true });
    assert.equal(repo.realms.size, 0);
    assert.equal(repo.invites.size, 0);
    await Rejects(service.getByName("friend-1", "friends"), "REALM_NOT_FOUND");
    await Rejects(service.release("host-1"), "REALM_NOT_FOUND");
    await create("host-2", "friends");
});

test("every call counts against a per-account budget and is refused when it is spent", async () => {
    const calls: string[] = [];
    const { service, create } = Setup({ isRateLimited: (key) => { calls.push(key); return key.startsWith("realms:join:"); } });
    await create("host-1", "friends");
    await service.getByName("friend-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "AUTH_RATE_LIMITED");
    await Rejects(service.previewInvite("friend-1", "ABCDEFGHJK"), "AUTH_RATE_LIMITED");
    assert.deepEqual(calls, ["realms:create:host-1", "realms:read:friend-1", "realms:join:friend-1", "realms:join:friend-1"]);
});

test("the stored record never receives an address or any field the model does not name", async () => {
    const { repo, create, service } = Setup();
    await create("host-1", "friends", { ip: "203.0.113.9", address: "203.0.113.9:7777" });
    await service.createInvite("host-1", { maxUses: 1, ttlHours: 1 });
    await service.heartbeat("host-1", { version: "1" });
    const realm = [...repo.realms.values()][0];
    assert.deepEqual(Object.keys(realm).sort(), [
        "bans", "createdAt", "hostAccountId", "hostPublicKey", "hubRoomIds", "joinPolicy", "lastOnlineAt", "listed", "members", "name",
        "onlineUntil", "realmId", "version"
    ]);
    const invite = [...repo.invites.values()][0];
    assert.deepEqual(Object.keys(invite).sort(), ["code", "createdAt", "createdBy", "expiresAt", "maxUses", "realmId", "uses"]);
});

// ----- join requests [2026-10-15] -----

test("a join without an invite is refused as a request: recorded once, shown to the host newest first, counted on the host view", async () => {
    const { clock, service, create } = Setup();
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    clock.now = T0 + 60_000;
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    clock.now = T0 + 120_000;
    await Rejects(service.join("friend-2", { name: "friends" }), "REALM_JOIN_REQUESTED");

    assert.deepEqual((await service.listJoinRequests("host-1")).requests, [
        { accountId: "friend-2", displayName: "Pal", at: new Date(T0 + 120_000).toISOString() },
        { accountId: "friend-1", displayName: "Friendly", at: new Date(T0).toISOString() }
    ], "asking again keeps the first time");
    assert.equal((await service.getMine("host-1")).hosted?.joinRequestCount, 2);
    assert.deepEqual((await service.getMine("friend-1")).memberOf, [], "a waiting player is in nothing");
});

test("a banned account is refused as banned and leaves no request", async () => {
    const { repo, service, create } = Setup();
    await create("host-1", "friends");
    await service.ban("host-1", "friend-1", "griefing");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_BANNED");
    assert.equal((await repo.findById("realm-1"))!.joinRequests, undefined);
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, []);
});

test("Play without an invite records the request; the host's approval lets the next Play in as a member", async () => {
    const { service, create } = Setup();
    const realm = (await create("host-1", "friends")).realm;
    await service.heartbeat("host-1", {});
    await service.setHosting(realm.realmId, { hubState: "RUNNING" });

    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_JOIN_REQUESTED" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_JOIN_REQUESTED" }, "the same answer again");
    assert.equal((await service.listJoinRequests("host-1")).requests.length, 1);

    assert.deepEqual(await service.approveJoinRequest("host-1", "friend-1"), { accountId: "friend-1", status: "APPROVED" });
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, [], "approval removes the request");
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: false });
    const joined = await service.join("friend-1", { name: "friends" });
    assert.equal(joined.joined, false, "already a member: nothing is added twice");
    assert.equal(joined.realm.membership, "MEMBER");
});

test("deny removes the request and the player may ask again; a player with no request is not found", async () => {
    const { service, create } = Setup();
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    assert.deepEqual(await service.denyJoinRequest("host-1", "friend-1"), { accountId: "friend-1", status: "DENIED" });
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, []);
    await Rejects(service.denyJoinRequest("host-1", "friend-1"), "REALM_REQUEST_NOT_FOUND");
    await Rejects(service.approveJoinRequest("host-1", "friend-2"), "REALM_REQUEST_NOT_FOUND");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    assert.equal((await service.listJoinRequests("host-1")).requests.length, 1);
});

test("a full request list refuses a new player and keeps the requests it has", async () => {
    const { service, create } = Setup({ limits: { maxMembers: 10, maxBans: 10, maxActiveInvites: 25, maxJoinRequests: 1, maxPlayerInvites: 50 } });
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    await Rejects(service.join("friend-2", { name: "friends" }), "REALM_REQUESTS_FULL");
    assert.deepEqual((await service.listJoinRequests("host-1")).requests.map((request) => request.accountId), ["friend-1"]);
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends" }), { ok: false, code: "REALM_REQUESTS_FULL" });
});

test("approving into a full realm is refused and the request stays", async () => {
    const { service, create } = Setup({ limits: { maxMembers: 2, maxBans: 10, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 50 } });
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    const { invite } = await service.createInvite("host-1", { maxUses: 1, ttlHours: 24 });
    await service.join("friend-2", { inviteCode: invite.code });
    await Rejects(service.approveJoinRequest("host-1", "friend-1"), "REALM_FULL");
    assert.deepEqual((await service.listJoinRequests("host-1")).requests.map((request) => request.accountId), ["friend-1"]);
});

test("the host adds a player by username: at once, without an invite, and a pending request goes with it", async () => {
    const usernames = new Map([["pal", "friend-2"], ["friendly", "friend-1"]]);
    const { service, create } = Setup({ resolveUsername: async (name) => usernames.get(name.toLowerCase()) });
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");

    assert.deepEqual(await service.addMemberByUsername("host-1", "  Friendly "), { accountId: "friend-1", displayName: "Friendly", added: true });
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, []);
    assert.equal((await service.join("friend-1", { name: "friends" })).joined, false, "in the realm now");
    assert.deepEqual(await service.addMemberByUsername("host-1", "FRIENDLY"), { accountId: "friend-1", displayName: "Friendly", added: false });

    assert.deepEqual(await service.addMemberByUsername("host-1", "PAL"), { accountId: "friend-2", displayName: "Pal", added: true });
    assert.equal((await service.getByName("host-1", "friends")).realm.memberCount, 3);
});

test("adding by username: an unknown name is not found (also when no resolver is set); a banned account is refused", async () => {
    const plain = Setup();
    await plain.create("host-1", "friends");
    await Rejects(plain.service.addMemberByUsername("host-1", "nobody"), "REALM_PLAYER_NOT_FOUND");

    const { service, create } = Setup({ resolveUsername: async (name) => (name === "pal" ? "friend-2" : undefined) });
    await create("host-1", "friends");
    await service.ban("host-1", "friend-2");
    await Rejects(service.addMemberByUsername("host-1", "pal"), "REALM_BANNED");
    await Rejects(service.addMemberByUsername("host-1", "nobody"), "REALM_PLAYER_NOT_FOUND");
    assert.equal((await service.getByName("host-1", "friends")).realm.memberCount, 1, "nothing was added");
});

test("only the host manages requests and adds players: anyone else is told they host no realm", async () => {
    const { service, create } = Setup({ resolveUsername: async (name) => (name.toLowerCase() === "pal" ? "friend-2" : undefined) });
    await create("host-1", "friends");
    await Rejects(service.listJoinRequests("friend-1"), "REALM_NOT_FOUND");
    await Rejects(service.approveJoinRequest("friend-1", "friend-2"), "REALM_NOT_FOUND");
    await Rejects(service.denyJoinRequest("friend-1", "friend-2"), "REALM_NOT_FOUND");
    await Rejects(service.addMemberByUsername("friend-1", "pal"), "REALM_NOT_FOUND");
});

// ----- [2026-10-16] a realm is named after its host's username -----

test("a claim without a name takes the host's username; no username, no realm", async () => {
    const { service } = Setup();
    const Claim = (accountId: string, name?: string) =>
        service.createRealm(accountId, { ...(name === undefined ? {} : { name }), hostPublicKey: KEY_A, joinPolicy: "INVITE_ONLY", listed: false });
    const { realm } = await Claim("host-1");
    assert.equal(realm.name, "hosty");
    assert.equal(realm.host.displayName, "Hosty");
    assert.equal((await service.getByName("friend-1", "hosty")).realm.name, "hosty");
    // An account with no username yet (no display name) cannot claim one.
    await Rejects(Claim("nobody-yet"), "REALM_USERNAME_REQUIRED");
});

test("a reserved word is the host's own realm name when it is their username", async () => {
    const { service } = Setup({ displayNames: async (ids) => new Map(ids.map((id) => [id, "Mystic"])) });
    const { realm } = await service.createRealm("host-1", { hostPublicKey: KEY_A, joinPolicy: "INVITE_ONLY", listed: false });
    assert.equal(realm.name, "mystic");
});

test("a name that is another player's username is refused; the host's own is fine", async () => {
    const usernames = new Map([["pal", "friend-2"], ["hosty", "host-1"]]);
    const { service } = Setup({ resolveUsername: async (name) => usernames.get(name.toLowerCase()) });
    const Claim = (accountId: string, name: string) =>
        service.createRealm(accountId, { name, hostPublicKey: KEY_A, joinPolicy: "INVITE_ONLY", listed: false });
    await Rejects(Claim("host-1", "pal"), "REALM_NAME_IS_USERNAME");
    assert.equal((await Claim("host-1", "hosty")).realm.name, "hosty");
    // A name nobody has as a username stays possible through the API.
    assert.equal((await Claim("friend-1", "ember-hold")).realm.name, "ember-hold");
});

// ----- player invites [2026-10-16]: the host invites by username, the player accepts or declines -----

function InviteSetup(limits?: RealmsServiceDeps["limits"]) {
    const usernames = new Map([["pal", "friend-2"], ["friendly", "friend-1"], ["hosty", "host-1"]]);
    return Setup({ resolveUsername: async (name) => usernames.get(name.toLowerCase()), ...(limits ? { limits } : {}) });
}

test("an invited player is not a member until they accept; both sides see the invite", async () => {
    const { service, create } = InviteSetup();
    await create("host-1", "friends");
    assert.deepEqual(await service.invitePlayerByUsername("host-1", "  Friendly "), { accountId: "friend-1", displayName: "Friendly", status: "INVITED" });

    const hosted = (await service.getMine("host-1")).hosted!;
    assert.deepEqual(hosted.playerInvites, [{ accountId: "friend-1", displayName: "Friendly", at: new Date(T0).toISOString() }]);
    assert.equal(hosted.memberCount, 1, "an invite is not a membership");
    const seen = (await service.getByName("friend-1", "friends")).realm;
    assert.equal(seen.invited, true);
    assert.equal(seen.membership, null);
    assert.deepEqual((await service.getMine("friend-1")).memberOf, []);

    const mine = await service.listMyPlayerInvites("friend-1");
    assert.deepEqual(mine.invites.map((invite) => [invite.realm.name, invite.realm.invited, invite.at]), [["friends", true, new Date(T0).toISOString()]]);
    assert.deepEqual((await service.listMyPlayerInvites("friend-2")).invites, []);

    const accepted = await service.acceptPlayerInvite("friend-1", "friends");
    assert.equal(accepted.joined, true);
    assert.equal(accepted.realm.membership, "MEMBER");
    assert.equal(accepted.realm.invited, false);
    assert.deepEqual((await service.listMyPlayerInvites("friend-1")).invites, []);
    assert.deepEqual((await service.getMine("host-1")).hosted!.playerInvites, []);
    assert.deepEqual((await service.getMine("friend-1")).memberOf.map((realm) => realm.name), ["friends"]);
    await Rejects(service.acceptPlayerInvite("friend-1", "friends"), "REALM_PLAYER_INVITE_NOT_FOUND");
});

test("declining removes the invite and the host may invite again; the host can cancel; a missing invite is not found", async () => {
    const { service, create } = InviteSetup();
    await create("host-1", "friends");
    await service.invitePlayerByUsername("host-1", "friendly");
    assert.deepEqual(await service.declinePlayerInvite("friend-1", "friends"), { declined: true });
    assert.deepEqual((await service.getMine("host-1")).hosted!.playerInvites, []);
    await Rejects(service.declinePlayerInvite("friend-1", "friends"), "REALM_PLAYER_INVITE_NOT_FOUND");

    await service.invitePlayerByUsername("host-1", "friendly");
    assert.deepEqual(await service.invitePlayerByUsername("host-1", "FRIENDLY"), { accountId: "friend-1", displayName: "Friendly", status: "INVITED" }, "inviting again changes nothing");
    assert.equal((await service.getMine("host-1")).hosted!.playerInvites.length, 1);
    assert.deepEqual(await service.cancelPlayerInvite("host-1", "friend-1"), { accountId: "friend-1", status: "CANCELLED" });
    await Rejects(service.cancelPlayerInvite("host-1", "friend-1"), "REALM_PLAYER_INVITE_NOT_FOUND");
    await Rejects(service.acceptPlayerInvite("friend-1", "friends"), "REALM_PLAYER_INVITE_NOT_FOUND");
    await Rejects(service.acceptPlayerInvite("friend-1", "nothing-here"), "REALM_NOT_FOUND");
});

test("joining or pressing Play with a pending invite accepts it instead of asking again", async () => {
    const { service, create } = InviteSetup();
    const realm = (await create("host-1", "friends")).realm;
    await service.heartbeat("host-1", {});
    await service.setHosting(realm.realmId, { hubState: "RUNNING" });

    await service.invitePlayerByUsername("host-1", "friendly");
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: false });
    assert.equal((await service.getByName("friend-1", "friends")).realm.membership, "MEMBER");
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, [], "no request was recorded");

    await service.invitePlayerByUsername("host-1", "pal");
    const joined = await service.join("friend-2", { name: "friends" });
    assert.equal(joined.joined, true);
    assert.equal(joined.realm.membership, "MEMBER");
    assert.deepEqual((await service.getMine("host-1")).hosted!.playerInvites, []);
});

test("inviting a player who asked to join lets them in at once; a member is answered MEMBER; the host cannot invite themselves", async () => {
    const { service, create } = InviteSetup();
    await create("host-1", "friends");
    await Rejects(service.join("friend-1", { name: "friends" }), "REALM_JOIN_REQUESTED");
    assert.equal((await service.getByName("friend-1", "friends")).realm.requested, true, "the player sees their request waiting");

    assert.deepEqual(await service.invitePlayerByUsername("host-1", "friendly"), { accountId: "friend-1", displayName: "Friendly", status: "MEMBER" });
    assert.deepEqual((await service.listJoinRequests("host-1")).requests, []);
    const seen = (await service.getByName("friend-1", "friends")).realm;
    assert.equal(seen.membership, "MEMBER");
    assert.equal(seen.requested, false);
    assert.deepEqual(await service.invitePlayerByUsername("host-1", "friendly"), { accountId: "friend-1", displayName: "Friendly", status: "MEMBER" });
    await Rejects(service.invitePlayerByUsername("host-1", "hosty"), "REALM_INVALID_TARGET");
    await Rejects(service.invitePlayerByUsername("host-1", "nobody"), "REALM_PLAYER_NOT_FOUND");
});

test("a ban withdraws the invite and refuses a new one; accepting after a ban is refused", async () => {
    const { repo, service, create } = InviteSetup();
    await create("host-1", "friends");
    await service.invitePlayerByUsername("host-1", "pal");
    await service.ban("host-1", "friend-2", "griefing");
    assert.deepEqual((await repo.findById("realm-1"))!.playerInvites, []);
    await Rejects(service.invitePlayerByUsername("host-1", "pal"), "REALM_BANNED");
    await Rejects(service.acceptPlayerInvite("friend-2", "friends"), "REALM_PLAYER_INVITE_NOT_FOUND");
    assert.deepEqual((await service.listMyPlayerInvites("friend-2")).invites, []);
});

test("the unanswered invite list has a ceiling", async () => {
    const { service, create } = InviteSetup({ maxMembers: 10, maxBans: 10, maxActiveInvites: 25, maxJoinRequests: 50, maxPlayerInvites: 1 });
    await create("host-1", "friends");
    await service.invitePlayerByUsername("host-1", "friendly");
    await Rejects(service.invitePlayerByUsername("host-1", "pal"), "REALM_PLAYER_INVITES_FULL");
    await service.declinePlayerInvite("friend-1", "friends");
    assert.equal((await service.invitePlayerByUsername("host-1", "pal")).status, "INVITED", "a freed slot takes the next invite");
});

test("only the host invites and cancels: anyone else is told they host no realm", async () => {
    const { service, create } = InviteSetup();
    await create("host-1", "friends");
    await Rejects(service.invitePlayerByUsername("friend-1", "pal"), "REALM_NOT_FOUND");
    await Rejects(service.cancelPlayerInvite("friend-1", "friend-2"), "REALM_NOT_FOUND");
});
