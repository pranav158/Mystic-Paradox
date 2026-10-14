import assert from "node:assert/strict";
import test from "node:test";
import { SWEEP_LOOKBACK_MS } from "./realmsService";
import { HubRoomId } from "./realmRules";
import { SetupRealms, T0 } from "./realmsTestKit";

// Host hosting state, the sweeper, the event sink and hub room ids (2026-10-13 hub design sections 2.3-2.4).

const iso = (ms: number) => new Date(ms).toISOString();

// ----- the host's hosting block and the p2p module's hub state -----

test("the host heartbeat stores its limits; an omitted block leaves them alone; an omitted afkSeconds clears it", async () => {
    const { repo, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    assert.equal(repo.realms.get(realm.realmId)!.hosting, undefined, "no hosting record until someone reports one");

    await service.heartbeat("host-1", { hosting: { maxServers: 3, maxPlayers: 24, afkSeconds: 600 } });
    assert.deepEqual(repo.realms.get(realm.realmId)!.hosting, {
        maxServers: 3, maxPlayers: 24, afkSeconds: 600, hubState: "NONE", trainingState: "NONE", activeServers: 0, updatedAt: iso(T0)
    });
    await service.heartbeat("host-1", {});
    assert.equal(repo.realms.get(realm.realmId)!.hosting!.maxServers, 3, "a heartbeat without hosting changes nothing");
    await service.heartbeat("host-1", { hosting: { maxServers: 2, maxPlayers: 8 } });
    const hosting = repo.realms.get(realm.realmId)!.hosting!;
    assert.equal(hosting.maxServers, 2);
    assert.equal(hosting.maxPlayers, 8);
    assert.equal("afkSeconds" in hosting, false, "the block is the host's whole current choice");
});

test("a host heartbeat never writes the hub fields, and the p2p module's hub fields never undo the host's limits", async () => {
    const { repo, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    await service.heartbeat("host-1", { hosting: { maxServers: 4, maxPlayers: 32 } });
    await service.setHosting(realm.realmId, { hubState: "RUNNING", hubSessionId: "sess-1", activeServers: 1 });
    await service.heartbeat("host-1", { hosting: { maxServers: 5, maxPlayers: 33 } });
    assert.deepEqual(repo.realms.get(realm.realmId)!.hosting, {
        maxServers: 5, maxPlayers: 33, hubState: "RUNNING", trainingState: "NONE", activeServers: 1, hubSessionId: "sess-1", updatedAt: iso(T0)
    });
    await service.setHosting(realm.realmId, { trainingState: "STARTING" });
    assert.equal(repo.realms.get(realm.realmId)!.hosting!.maxServers, 5);
});

test("setHosting merges a patch, removes hubSessionId with null, validates, and says whether the realm exists", async () => {
    const { clock, repo, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    clock.now = T0 + 1000;
    assert.equal(await service.setHosting(realm.realmId, { hubState: "STARTING", hubSessionId: "sess-1" }), true);
    let hosting = repo.realms.get(realm.realmId)!.hosting!;
    assert.equal(hosting.maxServers, 1, "a realm that never reported gets the defaults");
    assert.equal(hosting.maxPlayers, 16);
    assert.equal(hosting.hubState, "STARTING");
    assert.equal(hosting.updatedAt, iso(T0 + 1000));

    await service.setHosting(realm.realmId, { hubState: "NONE", hubSessionId: null });
    hosting = repo.realms.get(realm.realmId)!.hosting!;
    assert.equal(hosting.hubState, "NONE");
    assert.equal("hubSessionId" in hosting, false);

    await assert.rejects(service.setHosting(realm.realmId, { hubState: "HALF" as never }), /hubState/);
    await assert.rejects(service.setHosting(realm.realmId, { maxPlayers: 65 }), /maxPlayers/);
    assert.equal(await service.setHosting("no-such-realm", { hubState: "RUNNING" }), false);
});

test("serving, hubReady and playerCount appear in the listing, the lookup and the host view", async () => {
    const { clock, service, create } = SetupRealms();
    const realm = await create("host-1", "friends", { listed: true });
    const View = async () => (await service.listListed("friend-1", { limit: 10, offset: 0 })).realms[0];
    let info = await View();
    assert.deepEqual([info.online, info.serving, info.hubReady, info.playerCount], [false, false, false, 0]);

    await service.heartbeat("host-1", {});
    info = await View();
    assert.deepEqual([info.online, info.serving, info.hubReady], [true, false, false], "online with no hub");

    await service.setHosting(realm.realmId, { hubState: "RUNNING" });
    await service.bindPresence("friend-1", realm.realmId);
    info = await View();
    assert.deepEqual([info.online, info.serving, info.hubReady, info.playerCount], [true, true, true, 1]);
    const hostView = (await service.getMine("host-1")).hosted!;
    assert.deepEqual([hostView.online, hostView.serving, hostView.hubReady, hostView.playerCount], [true, true, true, 1]);

    clock.now = T0 + 90_000;
    info = await View();
    assert.deepEqual([info.online, info.serving, info.hubReady], [false, false, true], "the heartbeat lapsed; the hub flag is the p2p module's to clear");
});

test("markOffline ends the online state now; it is false when nothing was online, and the sweeper does not announce it", async () => {
    const { clock, events, repo, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    assert.equal(await service.markOffline(realm.realmId), false, "never online");
    assert.equal(await service.markOffline("no-such-realm"), false);

    await service.heartbeat("host-1", {});
    clock.now = T0 + 10_000;
    assert.equal(await service.markOffline(realm.realmId), true);
    assert.equal(repo.realms.get(realm.realmId)!.onlineUntil, iso(T0 + 10_000));
    assert.equal(repo.realms.get(realm.realmId)!.lastOnlineAt, iso(T0), "the name stays held by the last real heartbeat");
    assert.equal((await service.getByName("friend-1", "friends")).realm.online, false);
    assert.equal(await service.markOffline(realm.realmId), false, "already offline");

    clock.now = T0 + 20_000;
    assert.equal(await service.sweepLapsedHosts(), 0);
    assert.deepEqual(events, [], "the p2p module called markOffline, so it is not told again");
});

// ----- the sweeper -----

test("the sweeper reports a host whose online state lapsed, once per lapse", async () => {
    const { clock, events, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    assert.equal(await service.sweepLapsedHosts(), 0, "never online: nothing to report");

    await service.heartbeat("host-1", {}); // online until T0 + 90 s
    clock.now = T0 + 89_999;
    assert.equal(await service.sweepLapsedHosts(), 0, "still online");
    clock.now = T0 + 90_000;
    assert.equal(await service.sweepLapsedHosts(), 1);
    assert.deepEqual(events, [{ type: "HOST_OFFLINE", realmId: realm.realmId, hostAccountId: "host-1" }]);
    clock.now = T0 + 105_000;
    assert.equal(await service.sweepLapsedHosts(), 0, "the same lapse is not reported twice");
    clock.now = T0 + 120_000;
    assert.equal(await service.sweepLapsedHosts(), 0);
    assert.equal(events.length, 1);

    // The host comes back and lapses again: a new lapse, a new report.
    clock.now = T0 + 200_000;
    await service.heartbeat("host-1", {});
    clock.now = T0 + 250_000;
    assert.equal(await service.sweepLapsedHosts(), 0);
    clock.now = T0 + 290_000;
    assert.equal(await service.sweepLapsedHosts(), 1);
    assert.equal(events.length, 2);
});

test("a host that closes its realm on purpose (online:false) is reported by the next sweep", async () => {
    const { clock, events, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    await service.heartbeat("host-1", {});
    clock.now = T0 + 5000;
    await service.heartbeat("host-1", { online: false });
    clock.now = T0 + 6000;
    assert.equal(await service.sweepLapsedHosts(), 1);
    assert.deepEqual(events, [{ type: "HOST_OFFLINE", realmId: realm.realmId, hostAccountId: "host-1" }]);
});

test("the sweeper only reports lapses of the last 10 minutes and several realms in one sweep", async () => {
    const { clock, events, service, create } = SetupRealms();
    const old = await create("host-1", "old-one");
    const fresh = await create("host-2", "fresh-one");
    await service.heartbeat("host-1", {});
    clock.now = T0 + 650_000;
    await service.heartbeat("host-2", {}); // online until T0 + 740 s
    clock.now = T0 + SWEEP_LOOKBACK_MS + 90_000; // the old one lapsed exactly 10 minutes ago; the fresh one is still online
    assert.equal(await service.sweepLapsedHosts(), 0, "a lapse from 10 minutes ago is history, not news");
    clock.now = T0 + 740_000;
    assert.equal(await service.sweepLapsedHosts(), 1);
    assert.deepEqual(events.map((event) => event.realmId), [fresh.realmId]);
    assert.notEqual(old.realmId, fresh.realmId);

    const second = SetupRealms();
    const a = await second.create("host-1", "alpha");
    const b = await second.create("host-2", "bravo");
    await second.service.heartbeat("host-1", {});
    await second.service.heartbeat("host-2", {});
    second.clock.now = T0 + 91_000;
    assert.equal(await second.service.sweepLapsedHosts(), 2);
    assert.deepEqual(second.events.map((event) => event.realmId).sort(), [a.realmId, b.realmId].sort());
});

test("a sink that fails does not fail the sweep, and the lapse is still counted as noticed", async () => {
    const { clock, service, create } = SetupRealms({ events: async () => { throw new Error("p2p module down"); } });
    await create("host-1", "friends");
    await service.heartbeat("host-1", {});
    clock.now = T0 + 91_000;
    assert.equal(await service.sweepLapsedHosts(), 1);
    assert.equal(await service.sweepLapsedHosts(), 0);
});

// ----- events from kick, ban, leave and release -----

test("a kick drops the member's presence in this realm only, and emits MEMBER_REMOVED / KICK", async () => {
    const { events, presence, service, create } = SetupRealms();
    const realm = await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    const other = await create("host-2", "other-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await service.join("friend-2", { name: "open-house" });
    await service.bindPresence("friend-1", realm.realmId);
    await service.bindPresence("friend-2", other.realmId); // a member of open-house, currently in another realm

    await service.kick("host-1", "friend-1");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.deepEqual(events, [{ type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: "friend-1", reason: "KICK" }]);

    await service.kick("host-1", "friend-2");
    assert.equal((await service.presenceOf("friend-2"))?.realmId, other.realmId, "the other realm's presence is not touched");
    assert.equal(presence.rows.size, 1);
    assert.equal(events.length, 2);
});

test("a refused kick, ban repeat or leave emits nothing", async () => {
    const { events, service, create } = SetupRealms();
    await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await assert.rejects(service.kick("host-1", "friend-2")); // not a member
    await assert.rejects(service.kick("host-1", "host-1"));
    await assert.rejects(service.leave("friend-2", "open-house"));
    await assert.rejects(service.leave("host-1", "open-house"));
    assert.deepEqual(events, []);

    await service.ban("host-1", "friend-1");
    assert.equal(events.length, 1);
    await service.ban("host-1", "friend-1"); // already banned: nothing changed
    assert.equal(events.length, 1);
});

test("a ban drops the presence and emits MEMBER_REMOVED / BAN, for a member and for a stranger alike", async () => {
    const { events, service, create } = SetupRealms();
    const realm = await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await service.bindPresence("friend-1", realm.realmId);
    await service.ban("host-1", "friend-1", "griefing");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    await service.ban("host-1", "friend-2");
    assert.deepEqual(events, [
        { type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: "friend-1", reason: "BAN" },
        { type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: "friend-2", reason: "BAN" }
    ]);
});

test("a member who leaves drops their presence and emits MEMBER_REMOVED / LEAVE", async () => {
    const { events, service, create } = SetupRealms();
    const realm = await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await service.bindPresence("friend-1", realm.realmId);
    await service.leave("friend-1", "open-house");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.deepEqual(events, [{ type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: "friend-1", reason: "LEAVE" }]);
});

test("releasing a realm removes every presence row of it and emits REALM_RELEASED with the host", async () => {
    const { events, presence, service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    const other = await create("host-2", "rivals");
    await service.bindPresence("friend-1", realm.realmId);
    await service.bindPresence("host-1", realm.realmId);
    await service.bindPresence("friend-2", other.realmId);
    await service.presenceOf("friend-1"); // cached

    await service.release("host-1");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.equal(await service.presenceOf("host-1"), undefined);
    assert.equal((await service.presenceOf("friend-2"))?.realmId, other.realmId);
    assert.deepEqual([...presence.rows.keys()], ["friend-2"]);
    assert.deepEqual(events, [{ type: "REALM_RELEASED", realmId: realm.realmId, hostAccountId: "host-1" }]);
});

test("a dormant realm replaced by a new claim loses its presence rows too (no event: nobody is hosting it)", async () => {
    const { clock, events, presence, service, create } = SetupRealms();
    const old = await create("host-1", "friends");
    await service.bindPresence("friend-1", old.realmId);
    clock.now = T0 + 3 * 24 * 3_600_000;
    await create("host-2", "friends");
    assert.equal(presence.rows.size, 0);
    assert.deepEqual(events, []);
});

test("a sink that throws, or none at all, never fails the request that caused the event", async () => {
    const failing = SetupRealms({ events: async () => { throw new Error("sink down"); } });
    await failing.create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await failing.service.join("friend-1", { name: "open-house" });
    assert.deepEqual(await failing.service.kick("host-1", "friend-1"), { accountId: "friend-1", status: "KICKED" });
    await failing.service.join("friend-1", { name: "open-house" });
    assert.equal((await failing.service.ban("host-1", "friend-1")).changed, true);
    assert.deepEqual(await failing.service.release("host-1"), { released: true });

    const silent = SetupRealms({ events: undefined });
    await silent.create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await silent.service.join("friend-1", { name: "open-house" });
    assert.deepEqual(await silent.service.kick("host-1", "friend-1"), { accountId: "friend-1", status: "KICKED" });
});

// ----- hub room ids, membership helpers -----

test("a hub room id finds its realm, for both hubs, in any letter case; anything else finds nothing", async () => {
    const { service, create } = SetupRealms();
    const realm = await create("host-1", "friends");
    const other = await create("host-2", "rivals");
    const ramsgate = HubRoomId(realm.realmId, "RAMSGATE");
    const training = HubRoomId(realm.realmId, "TRAINING");
    assert.equal((await service.findByHubRoomId(ramsgate))?.realmId, realm.realmId);
    assert.equal((await service.findByHubRoomId(training.toUpperCase()))?.realmId, realm.realmId);
    assert.equal((await service.findByHubRoomId(HubRoomId(other.realmId, "RAMSGATE")))?.realmId, other.realmId);
    assert.equal(await service.findByHubRoomId(HubRoomId("no-such-realm", "RAMSGATE")), undefined);
    assert.equal(await service.findByHubRoomId("not-a-uuid"), undefined);
    assert.equal(await service.findByHubRoomId(realm.realmId), undefined, "the realm id itself is not a room id");
    assert.equal(await service.findByHubRoomId(""), undefined);
});

test("isMember and isBanned answer for members, the host, strangers, banned accounts and unknown realms", async () => {
    const { service, create } = SetupRealms();
    const realm = await create("host-1", "open-house", { joinPolicy: "PUBLIC" });
    await service.join("friend-1", { name: "open-house" });
    await service.ban("host-1", "friend-2");
    assert.equal(await service.isMember(realm.realmId, "host-1"), true);
    assert.equal(await service.isMember(realm.realmId, "friend-1"), true);
    assert.equal(await service.isMember(realm.realmId, "friend-2"), false);
    assert.equal(await service.isMember("no-such-realm", "friend-1"), false);
    assert.equal(await service.isBanned(realm.realmId, "friend-2"), true);
    assert.equal(await service.isBanned(realm.realmId, "friend-1"), false);
    assert.equal(await service.isBanned("no-such-realm", "friend-2"), false);
    assert.equal((await service.getRealm(realm.realmId))?.name, "open-house");
    assert.equal((await service.getRealmByHost("host-1"))?.realmId, realm.realmId);
    assert.equal(await service.getRealmByHost("friend-1"), undefined);
});
