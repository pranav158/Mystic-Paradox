import assert from "node:assert/strict";
import test from "node:test";
import { ApplyHeartbeat } from "./realmRules";
import { RealmInviteRecord, RealmRecord } from "./realmTypes";
import { RealmsRepository } from "./persistence/RealmsRepository";

// [2026-10-13 realms S2] The behaviour every RealmsRepository must have, written once and run against the in-memory double
// (realmsRepository.test.ts, always) and against MongoDB (realmsMongo.integration.test.ts, opt-in on an isolated
// database). The atomic cases matter most for MongoDB: racing requests must not both win a name, the last member slot or the
// last use of an invite.

const NOW = "2026-10-13T12:00:00.000Z";
const LATER = "2026-10-13T13:00:00.000Z";
const FAR = "2026-10-20T12:00:00.000Z";

export function MakeRealm(name: string, host: string, overrides: Partial<RealmRecord> = {}): RealmRecord {
    return {
        realmId: `id-${name}`,
        name,
        hostAccountId: host,
        hostPublicKey: "KEY-0123456789abcdef",
        joinPolicy: "INVITE_ONLY",
        listed: false,
        members: [{ accountId: host, role: "HOST", joinedAt: NOW }],
        bans: [],
        createdAt: NOW,
        ...overrides
    };
}

export function MakeInvite(code: string, realmId: string, overrides: Partial<RealmInviteRecord> = {}): RealmInviteRecord {
    return { code, realmId, createdBy: "host", createdAt: NOW, expiresAt: FAR, maxUses: 2, uses: 0, ...overrides };
}

export interface RepositoryHarness {
    repo: RealmsRepository;
    /** Empties both collections before each case. */
    reset(): Promise<void>;
}

export function RunRealmsRepositoryContract(label: string, harness: () => Promise<RepositoryHarness>, options: { skip?: string | false } = {}): void {
    const Case = (name: string, body: (repo: RealmsRepository) => Promise<void>) =>
        test(`${label}: ${name}`, { skip: options.skip ?? false }, async () => {
            const { repo, reset } = await harness();
            await reset();
            await body(repo);
        });

    Case("a realm round-trips exactly, with its optional fields absent until they are written", async (repo) => {
        const realm = MakeRealm("friends", "host-1");
        assert.equal(await repo.insertRealm(realm), "INSERTED");
        assert.deepEqual(await repo.findById("id-friends"), realm);
        assert.deepEqual(await repo.findByName("friends"), realm);
        assert.deepEqual(await repo.findByHost("host-1"), realm);
        assert.equal(await repo.findById("nope"), undefined);
        assert.equal(await repo.findByName("nope"), undefined);
        assert.equal(await repo.findByHost("nobody"), undefined);
    });

    Case("a name and a host account are each unique", async (repo) => {
        assert.equal(await repo.insertRealm(MakeRealm("friends", "host-1")), "INSERTED");
        assert.equal(await repo.insertRealm(MakeRealm("friends", "host-2", { realmId: "other-id" })), "NAME_TAKEN");
        assert.equal(await repo.insertRealm(MakeRealm("second", "host-1", { realmId: "second-id" })), "HOST_HAS_REALM");
        assert.equal(await repo.findByName("second"), undefined);
        assert.equal(await repo.insertRealm(MakeRealm("second", "host-2", { realmId: "second-id" })), "INSERTED");
    });

    Case("racing claims for one name produce exactly one realm", async (repo) => {
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
            repo.insertRealm(MakeRealm("friends", `host-${index}`, { realmId: `race-${index}` }))));
        assert.equal(results.filter((result) => result === "INSERTED").length, 1);
        assert.equal(results.filter((result) => result === "NAME_TAKEN").length, 7);
    });

    Case("settings and heartbeats change only the host's own realm", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        assert.equal(await repo.setSettings("id-friends", "intruder", { listed: true }), false);
        assert.equal((await repo.findById("id-friends"))!.listed, false);
        assert.equal(await repo.setSettings("id-friends", "host-1", { joinPolicy: "PUBLIC", listed: true }), true);
        assert.equal(await repo.setSettings("missing", "host-1", { listed: true }), false);
        const afterSettings = (await repo.findById("id-friends"))!;
        assert.equal(afterSettings.joinPolicy, "PUBLIC");
        assert.equal(afterSettings.listed, true);

        assert.equal(await repo.recordHeartbeat("id-friends", "intruder", ApplyHeartbeat(Date.parse(NOW))), false);
        assert.equal((await repo.findById("id-friends"))!.lastOnlineAt, undefined);
        assert.equal(await repo.recordHeartbeat("id-friends", "host-1", ApplyHeartbeat(Date.parse(NOW), { version: "0.2.128" })), true);
        let realm = (await repo.findById("id-friends"))!;
        assert.equal(realm.lastOnlineAt, NOW);
        assert.equal(realm.onlineUntil, "2026-10-13T12:01:30.000Z");
        assert.equal(realm.version, "0.2.128");
        // A heartbeat without a version keeps the one on record.
        await repo.recordHeartbeat("id-friends", "host-1", ApplyHeartbeat(Date.parse(LATER)));
        realm = (await repo.findById("id-friends"))!;
        assert.equal(realm.lastOnlineAt, LATER);
        assert.equal(realm.version, "0.2.128");
    });

    Case("members: added once, never past the ceiling, never when banned", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        const member = (accountId: string) => ({ accountId, role: "MEMBER" as const, joinedAt: NOW });
        assert.equal(await repo.addMember("id-friends", member("a"), 3), "ADDED");
        assert.equal(await repo.addMember("id-friends", member("a"), 3), "ALREADY_MEMBER");
        assert.equal(await repo.addMember("id-friends", member("host-1"), 3), "ALREADY_MEMBER");
        assert.equal(await repo.addMember("id-friends", member("b"), 3), "ADDED");
        assert.equal(await repo.addMember("id-friends", member("c"), 3), "FULL");
        assert.equal(await repo.addMember("missing", member("c"), 3), "NOT_FOUND");
        assert.deepEqual((await repo.findById("id-friends"))!.members.map((entry) => entry.accountId), ["host-1", "a", "b"]);

        assert.equal(await repo.addBan("id-friends", { accountId: "banned", at: NOW }, 10), "BANNED");
        assert.equal(await repo.addMember("id-friends", member("banned"), 10), "BANNED");
    });

    Case("racing joins never fill a realm past its ceiling", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
            repo.addMember("id-friends", { accountId: `joiner-${index}`, role: "MEMBER", joinedAt: NOW }, 5)));
        assert.equal(results.filter((result) => result === "ADDED").length, 4);
        assert.equal(results.filter((result) => result === "FULL").length, 8);
        assert.equal((await repo.findById("id-friends"))!.members.length, 5);
    });

    Case("a double join by the same account adds it once", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        const results = await Promise.all(Array.from({ length: 6 }, () =>
            repo.addMember("id-friends", { accountId: "same", role: "MEMBER", joinedAt: NOW }, 50)));
        assert.equal(results.filter((result) => result === "ADDED").length, 1);
        assert.equal((await repo.findById("id-friends"))!.members.filter((entry) => entry.accountId === "same").length, 1);
    });

    Case("removing a member never removes the host", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.addMember("id-friends", { accountId: "a", role: "MEMBER", joinedAt: NOW }, 10);
        assert.equal(await repo.removeMember("id-friends", "host-1"), false);
        assert.equal(await repo.removeMember("id-friends", "stranger"), false);
        assert.equal(await repo.removeMember("missing", "a"), false);
        assert.equal(await repo.removeMember("id-friends", "a"), true);
        assert.equal(await repo.removeMember("id-friends", "a"), false);
        assert.deepEqual((await repo.findById("id-friends"))!.members.map((entry) => entry.accountId), ["host-1"]);
    });

    Case("a ban removes the member, is recorded once, has a ceiling, and can be lifted; the host cannot be removed by it", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.addMember("id-friends", { accountId: "a", role: "MEMBER", joinedAt: NOW }, 10);
        assert.equal(await repo.addBan("id-friends", { accountId: "a", reason: "griefing", at: NOW }, 2), "BANNED");
        assert.equal(await repo.addBan("id-friends", { accountId: "a", at: LATER }, 2), "ALREADY_BANNED");
        assert.equal(await repo.addBan("id-friends", { accountId: "b", at: NOW }, 2), "BANNED");
        assert.equal(await repo.addBan("id-friends", { accountId: "c", at: NOW }, 2), "FULL");
        assert.equal(await repo.addBan("missing", { accountId: "c", at: NOW }, 2), "NOT_FOUND");
        // Banning the host's own account id leaves the host entry in place (the service refuses it earlier; this is the backstop).
        assert.equal(await repo.addBan("id-friends", { accountId: "host-1", at: NOW }, 10), "BANNED");
        const realm = (await repo.findById("id-friends"))!;
        assert.deepEqual(realm.members.map((entry) => entry.accountId), ["host-1"]);
        assert.deepEqual(realm.bans[0], { accountId: "a", reason: "griefing", at: NOW });
        assert.equal("reason" in realm.bans[1], false);

        assert.equal(await repo.removeBan("id-friends", "a"), true);
        assert.equal(await repo.removeBan("id-friends", "a"), false);
        assert.equal(await repo.removeBan("missing", "a"), false);
        assert.equal(await repo.addMember("id-friends", { accountId: "a", role: "MEMBER", joinedAt: NOW }, 10), "ADDED");
    });

    Case("findByMember and the listing", async (repo) => {
        await repo.insertRealm(MakeRealm("alpha", "host-1", { listed: true }));
        await repo.insertRealm(MakeRealm("bravo", "host-2", { listed: true }));
        await repo.insertRealm(MakeRealm("charlie", "host-3", { listed: false }));
        await repo.insertRealm(MakeRealm("delta", "host-4", { listed: true }));
        await repo.recordHeartbeat("id-delta", "host-4", ApplyHeartbeat(Date.parse(NOW)));
        await repo.addMember("id-alpha", { accountId: "pal", role: "MEMBER", joinedAt: NOW }, 10);
        await repo.addMember("id-charlie", { accountId: "pal", role: "MEMBER", joinedAt: NOW }, 10);

        assert.deepEqual((await repo.findByMember("pal", 10)).map((realm) => realm.name), ["alpha", "charlie"]);
        assert.deepEqual((await repo.findByMember("host-2", 10)).map((realm) => realm.name), ["bravo"]);
        assert.deepEqual(await repo.findByMember("nobody", 10), []);
        assert.equal((await repo.findByMember("pal", 1)).length, 1);

        assert.deepEqual((await repo.listListed(10, 0)).map((realm) => realm.name), ["delta", "alpha", "bravo"]);
        assert.deepEqual((await repo.listListed(1, 1)).map((realm) => realm.name), ["alpha"]);
        assert.deepEqual(await repo.listListed(10, 3), []);
    });

    Case("name release deletes only a realm that has not been online since it was read, with its invites", async (repo) => {
        await repo.insertRealm(MakeRealm("never", "host-1"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-never"));
        await repo.insertRealm(MakeRealm("seen", "host-2", { lastOnlineAt: NOW }));

        // The realm came back online after the claim check read lastOnlineAt === undefined.
        await repo.recordHeartbeat("id-never", "host-1", ApplyHeartbeat(Date.parse(LATER)));
        assert.equal(await repo.deleteRealmIfLastOnline("id-never", undefined), false);
        assert.ok(await repo.findById("id-never"));
        assert.equal(await repo.deleteRealmIfLastOnline("id-seen", LATER), false);
        assert.equal(await repo.deleteRealmIfLastOnline("id-seen", NOW), true);
        assert.equal(await repo.findById("id-seen"), undefined);
        assert.equal(await repo.deleteRealmIfLastOnline("id-never", LATER), true);
        assert.equal(await repo.findInvite("ABCDEFGHJK"), undefined, "invites go with the realm");

        await repo.insertRealm(MakeRealm("fresh", "host-3"));
        assert.equal(await repo.deleteRealmIfLastOnline("id-fresh", undefined), true);
    });

    Case("the host releases its own realm, with its invites; nobody else can", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertRealm(MakeRealm("rivals", "host-2"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJL", "id-rivals"));
        assert.equal(await repo.deleteRealmOfHost("id-friends", "host-2"), false);
        assert.ok(await repo.findById("id-friends"));
        assert.equal(await repo.deleteRealmOfHost("id-friends", "host-1"), true);
        assert.equal(await repo.deleteRealmOfHost("id-friends", "host-1"), false);
        assert.equal(await repo.findInvite("ABCDEFGHJK"), undefined);
        assert.ok(await repo.findInvite("ABCDEFGHJL"), "another realm's invites stay");
    });

    Case("an invite round-trips, its code is unique, and the host's list is newest first", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        const first = MakeInvite("ABCDEFGHJK", "id-friends", { createdAt: NOW });
        const second = MakeInvite("ABCDEFGHJL", "id-friends", { createdAt: LATER });
        assert.equal(await repo.insertInvite(first), "INSERTED");
        assert.equal(await repo.insertInvite(second), "INSERTED");
        assert.equal(await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends")), "DUPLICATE");
        assert.deepEqual(await repo.findInvite("ABCDEFGHJK"), first);
        assert.equal(await repo.findInvite("ZZZZZZZZZZ"), undefined);
        assert.deepEqual((await repo.listInvites("id-friends", 10)).map((invite) => invite.code), ["ABCDEFGHJL", "ABCDEFGHJK"]);
        assert.deepEqual(await repo.listInvites("other", 10), []);
        assert.equal((await repo.listInvites("id-friends", 1)).length, 1);
    });

    Case("an invite is consumed until it is used up, expired or revoked", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends", { maxUses: 2, expiresAt: LATER }));
        assert.equal((await repo.consumeInvite("ABCDEFGHJK", NOW))!.uses, 1);
        assert.equal((await repo.consumeInvite("ABCDEFGHJK", NOW))!.uses, 2);
        assert.equal(await repo.consumeInvite("ABCDEFGHJK", NOW), undefined, "used up");
        await repo.refundInvite("ABCDEFGHJK");
        assert.equal((await repo.findInvite("ABCDEFGHJK"))!.uses, 1);
        assert.equal((await repo.consumeInvite("ABCDEFGHJK", NOW))!.uses, 2);
        await repo.refundInvite("ABCDEFGHJK");
        await repo.refundInvite("ABCDEFGHJK");
        await repo.refundInvite("ABCDEFGHJK");
        assert.equal((await repo.findInvite("ABCDEFGHJK"))!.uses, 0, "a refund never goes below zero");

        assert.equal(await repo.consumeInvite("ABCDEFGHJK", LATER), undefined, "expired exactly at expiresAt");
        assert.equal(await repo.consumeInvite("ZZZZZZZZZZ", NOW), undefined);

        await repo.revokeInvite("id-friends", "ABCDEFGHJK", NOW);
        assert.equal(await repo.consumeInvite("ABCDEFGHJK", NOW), undefined, "revoked");
    });

    Case("racing joins never use an invite more than its use count", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends", { maxUses: 3 }));
        const results = await Promise.all(Array.from({ length: 10 }, () => repo.consumeInvite("ABCDEFGHJK", NOW)));
        assert.equal(results.filter((result) => result !== undefined).length, 3);
        assert.equal((await repo.findInvite("ABCDEFGHJK"))!.uses, 3);
    });

    Case("revoking marks an invite once, keeps the first time, and only for its own realm", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends"));
        assert.equal(await repo.revokeInvite("other-realm", "ABCDEFGHJK", NOW), undefined);
        assert.equal((await repo.findInvite("ABCDEFGHJK"))!.revokedAt, undefined);
        assert.equal((await repo.revokeInvite("id-friends", "ABCDEFGHJK", NOW))!.revokedAt, NOW);
        assert.equal((await repo.revokeInvite("id-friends", "ABCDEFGHJK", LATER))!.revokedAt, NOW);
        assert.equal(await repo.revokeInvite("id-friends", "ZZZZZZZZZZ", NOW), undefined);
    });

    Case("open invites are counted at the given time: not revoked, not expired, not used up", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertInvite(MakeInvite("ABCDEFGHJK", "id-friends", { expiresAt: FAR }));
        await repo.insertInvite(MakeInvite("ABCDEFGHJL", "id-friends", { expiresAt: LATER }));
        await repo.insertInvite(MakeInvite("ABCDEFGHJM", "id-friends", { maxUses: 1, uses: 1 }));
        await repo.insertInvite(MakeInvite("ABCDEFGHJN", "id-friends", { revokedAt: NOW }));
        await repo.insertInvite(MakeInvite("ABCDEFGHJP", "other-realm"));
        assert.equal(await repo.countActiveInvites("id-friends", NOW), 2);
        assert.equal(await repo.countActiveInvites("id-friends", LATER), 1);
        assert.equal(await repo.countActiveInvites("nothing", NOW), 0);
    });

    // ----- [2026-10-13 hub design section 2] hosting, offline notices, hub room ids -----

    Case("patchHosting creates the record with defaults, merges what it names, removes with null, and leaves the rest", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        assert.equal(await repo.patchHosting("missing", { hubState: "RUNNING" }, NOW), false);
        assert.equal((await repo.findById("id-friends"))!.hosting, undefined, "no record until a patch");

        assert.equal(await repo.patchHosting("id-friends", { hubState: "STARTING", hubSessionId: "sess-1" }, NOW), true);
        assert.deepEqual((await repo.findById("id-friends"))!.hosting, {
            maxServers: 1, maxPlayers: 16, hubState: "STARTING", trainingState: "NONE", activeServers: 0, hubSessionId: "sess-1", updatedAt: NOW
        });
        // The host's own fields, written separately, never undo the hub fields (and the other way round).
        assert.equal(await repo.patchHosting("id-friends", { maxServers: 4, maxPlayers: 32, afkSeconds: 600 }, LATER), true);
        assert.equal(await repo.patchHosting("id-friends", { hubState: "RUNNING", activeServers: 2 }, LATER), true);
        assert.deepEqual((await repo.findById("id-friends"))!.hosting, {
            maxServers: 4, maxPlayers: 32, afkSeconds: 600, hubState: "RUNNING", trainingState: "NONE", activeServers: 2, hubSessionId: "sess-1", updatedAt: LATER
        });
        // null removes an optional field; an unknown key and undefined change nothing.
        assert.equal(await repo.patchHosting("id-friends", { afkSeconds: null, hubSessionId: null, trainingState: undefined, isAdmin: true } as never, FAR), true);
        const hosting = (await repo.findById("id-friends"))!.hosting!;
        assert.equal("afkSeconds" in hosting, false);
        assert.equal("hubSessionId" in hosting, false);
        assert.equal("isAdmin" in hosting, false);
        assert.equal(hosting.trainingState, "NONE");
        assert.equal(hosting.updatedAt, FAR);
    });

    Case("racing patches on disjoint hosting fields all land", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await Promise.all([
            repo.patchHosting("id-friends", { maxServers: 3 }, NOW),
            repo.patchHosting("id-friends", { maxPlayers: 20 }, NOW),
            repo.patchHosting("id-friends", { hubState: "RUNNING" }, NOW),
            repo.patchHosting("id-friends", { trainingState: "STARTING" }, NOW),
            repo.patchHosting("id-friends", { activeServers: 2 }, NOW)
        ]);
        const hosting = (await repo.findById("id-friends"))!.hosting!;
        assert.deepEqual([hosting.maxServers, hosting.maxPlayers, hosting.hubState, hosting.trainingState, hosting.activeServers], [3, 20, "RUNNING", "STARTING", 2]);
    });

    Case("markOffline ends a lasting online state at the given time, only once, and only for a realm that was online", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        assert.equal(await repo.markOffline("id-friends", NOW), false, "never online");
        assert.equal(await repo.markOffline("missing", NOW), false);
        await repo.recordHeartbeat("id-friends", "host-1", ApplyHeartbeat(Date.parse(NOW))); // online until 12:01:30
        assert.equal(await repo.markOffline("id-friends", "2026-10-13T12:00:10.000Z"), true);
        const realm = (await repo.findById("id-friends"))!;
        assert.equal(realm.onlineUntil, "2026-10-13T12:00:10.000Z");
        assert.equal(realm.lastOnlineAt, NOW, "lastOnlineAt is the last real heartbeat");
        assert.equal(await repo.markOffline("id-friends", "2026-10-13T12:00:20.000Z"), false, "already offline");
    });

    Case("claimLapsedHosts returns each recent lapse once, claimed atomically, and not older, still-online or never-online realms", async (repo) => {
        await repo.insertRealm(MakeRealm("never", "host-0"));
        await repo.insertRealm(MakeRealm("fresh", "host-1"));
        await repo.insertRealm(MakeRealm("stale", "host-2"));
        await repo.insertRealm(MakeRealm("live", "host-3"));
        await repo.recordHeartbeat("id-stale", "host-2", ApplyHeartbeat(Date.parse("2026-10-13T10:00:00.000Z"))); // lapsed 10:01:30
        await repo.recordHeartbeat("id-fresh", "host-1", ApplyHeartbeat(Date.parse("2026-10-13T11:58:00.000Z"))); // lapsed 11:59:30
        await repo.recordHeartbeat("id-live", "host-3", ApplyHeartbeat(Date.parse("2026-10-13T12:00:00.000Z"))); // online until 12:01:30

        const claim = () => repo.claimLapsedHosts("2026-10-13T12:00:00.000Z", "2026-10-13T11:50:00.000Z", 10);
        const first = await claim();
        assert.deepEqual(first.map((realm) => realm.name), ["fresh"]);
        assert.equal(first[0].offlineNotifiedFor, "2026-10-13T11:59:30.000Z");
        assert.deepEqual(await claim(), [], "a lapse is returned once");

        // The racing sweepers of two backends: each lapse goes to exactly one of them.
        await repo.recordHeartbeat("id-live", "host-3", ApplyHeartbeat(Date.parse("2026-10-13T11:00:00.000Z"))); // lapsed 11:01:30
        const racers = await Promise.all(Array.from({ length: 6 }, () => repo.claimLapsedHosts("2026-10-13T12:00:00.000Z", "2026-10-13T11:00:00.000Z", 10)));
        assert.equal(racers.flat().filter((realm) => realm.name === "live").length, 1);

        // A new heartbeat and a new lapse is a new notice.
        await repo.recordHeartbeat("id-fresh", "host-1", ApplyHeartbeat(Date.parse("2026-10-13T12:10:00.000Z")));
        assert.deepEqual(await repo.claimLapsedHosts("2026-10-13T12:11:00.000Z", "2026-10-13T12:01:00.000Z", 10), [], "online until 12:11:30");
        assert.deepEqual((await repo.claimLapsedHosts("2026-10-13T12:12:00.000Z", "2026-10-13T12:01:00.000Z", 10)).map((realm) => realm.name), ["fresh"]);
    });

    Case("claimLapsedHosts honours its limit and leaves the rest for the next sweep", async (repo) => {
        for (const index of [1, 2, 3]) {
            await repo.insertRealm(MakeRealm(`realm-${index}`, `host-${index}`));
            await repo.recordHeartbeat(`id-realm-${index}`, `host-${index}`, ApplyHeartbeat(Date.parse("2026-10-13T11:58:00.000Z")));
        }
        const args = ["2026-10-13T12:00:00.000Z", "2026-10-13T11:50:00.000Z"] as const;
        assert.equal((await repo.claimLapsedHosts(args[0], args[1], 2)).length, 2);
        assert.equal((await repo.claimLapsedHosts(args[0], args[1], 2)).length, 1);
        assert.equal((await repo.claimLapsedHosts(args[0], args[1], 2)).length, 0);
    });

    Case("a realm is found by either of its hub room ids, by exact match only", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1", { hubRoomIds: ["11111111-1111-5111-8111-111111111111", "22222222-2222-5222-8222-222222222222"] }));
        await repo.insertRealm(MakeRealm("rivals", "host-2", { hubRoomIds: ["33333333-3333-5333-8333-333333333333", "44444444-4444-5444-8444-444444444444"] }));
        await repo.insertRealm(MakeRealm("old", "host-3"));
        assert.equal((await repo.findByHubRoomId("11111111-1111-5111-8111-111111111111"))?.name, "friends");
        assert.equal((await repo.findByHubRoomId("22222222-2222-5222-8222-222222222222"))?.name, "friends");
        assert.equal((await repo.findByHubRoomId("44444444-4444-5444-8444-444444444444"))?.name, "rivals");
        assert.equal(await repo.findByHubRoomId("55555555-5555-5555-8555-555555555555"), undefined);
        assert.equal(await repo.findByHubRoomId(""), undefined);
        assert.deepEqual((await repo.findByHubRoomId("11111111-1111-5111-8111-111111111111"))!.hubRoomIds, ["11111111-1111-5111-8111-111111111111", "22222222-2222-5222-8222-222222222222"]);
    });

    // [2026-10-15] Join requests: the checks run in the order of AddJoinRequestResult, and a refused request changes nothing.
    Case("join requests: recorded once, refused for a member, a banned account and a full list, and withdrawn on request", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1", {
            members: [{ accountId: "host-1", role: "HOST", joinedAt: NOW }, { accountId: "friend", role: "MEMBER", joinedAt: NOW }],
            bans: [{ accountId: "banned", at: NOW }]
        }));
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "stranger-1", at: NOW }, 2), "ADDED");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "stranger-1", at: LATER }, 2), "ALREADY_REQUESTED");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "banned", at: NOW }, 2), "BANNED");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "friend", at: NOW }, 2), "ALREADY_MEMBER");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "host-1", at: NOW }, 2), "ALREADY_MEMBER");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "stranger-2", at: NOW }, 2), "ADDED");
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "stranger-3", at: NOW }, 2), "FULL");
        assert.equal(await repo.addJoinRequest("id-nope", { accountId: "stranger-3", at: NOW }, 2), "NOT_FOUND");
        assert.deepEqual((await repo.findById("id-friends"))!.joinRequests, [{ accountId: "stranger-1", at: NOW }, { accountId: "stranger-2", at: NOW }]);

        assert.equal(await repo.removeJoinRequest("id-friends", "stranger-1"), true);
        assert.equal(await repo.removeJoinRequest("id-friends", "stranger-1"), false);
        assert.deepEqual((await repo.findById("id-friends"))!.joinRequests, [{ accountId: "stranger-2", at: NOW }]);
        assert.equal(await repo.addJoinRequest("id-friends", { accountId: "stranger-3", at: NOW }, 2), "ADDED", "a withdrawn request frees its place");
    });

    Case("a ban withdraws the banned account's join request and leaves the others", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.addJoinRequest("id-friends", { accountId: "stranger", at: NOW }, 10);
        await repo.addJoinRequest("id-friends", { accountId: "other", at: NOW }, 10);
        assert.equal(await repo.addBan("id-friends", { accountId: "stranger", at: LATER }, 10), "BANNED");
        assert.deepEqual((await repo.findById("id-friends"))!.joinRequests, [{ accountId: "other", at: NOW }]);
        assert.equal(await repo.removeJoinRequest("id-friends", "stranger"), false);
    });

    Case("racing join requests never exceed the bound", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
            repo.addJoinRequest("id-friends", { accountId: `stranger-${index}`, at: NOW }, 3)));
        assert.equal(results.filter((result) => result === "ADDED").length, 3);
        assert.equal(results.filter((result) => result === "FULL").length, 3);
        assert.equal((await repo.findById("id-friends"))!.joinRequests?.length, 3);
    });

    // [2026-10-16] Player invites: the same checks and order as join requests; a membership or a ban answers the invite.
    Case("player invites: recorded once, refused for a member, a banned account and a full list, and withdrawn on request", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1", {
            members: [{ accountId: "host-1", role: "HOST", joinedAt: NOW }, { accountId: "friend", role: "MEMBER", joinedAt: NOW }],
            bans: [{ accountId: "banned", at: NOW }]
        }));
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "guest-1", at: NOW }, 2), "ADDED");
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "guest-1", at: LATER }, 2), "ALREADY_INVITED");
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "banned", at: NOW }, 2), "BANNED");
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "friend", at: NOW }, 2), "ALREADY_MEMBER");
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "guest-2", at: NOW }, 2), "ADDED");
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "guest-3", at: NOW }, 2), "FULL");
        assert.equal(await repo.addPlayerInvite("id-nope", { accountId: "guest-3", at: NOW }, 2), "NOT_FOUND");
        assert.deepEqual((await repo.findById("id-friends"))!.playerInvites, [{ accountId: "guest-1", at: NOW }, { accountId: "guest-2", at: NOW }]);

        assert.equal(await repo.removePlayerInvite("id-friends", "guest-1"), true);
        assert.equal(await repo.removePlayerInvite("id-friends", "guest-1"), false);
        assert.equal(await repo.addPlayerInvite("id-friends", { accountId: "guest-3", at: NOW }, 2), "ADDED", "a withdrawn invite frees its place");
    });

    Case("a membership and a ban each remove the account's player invite, and findByPlayerInvite finds the inviting realms", async (repo) => {
        await repo.insertRealm(MakeRealm("friends", "host-1"));
        await repo.insertRealm(MakeRealm("embers", "host-2"));
        await repo.addPlayerInvite("id-friends", { accountId: "guest", at: NOW }, 10);
        await repo.addPlayerInvite("id-embers", { accountId: "guest", at: NOW }, 10);
        await repo.addPlayerInvite("id-friends", { accountId: "other", at: NOW }, 10);
        assert.deepEqual((await repo.findByPlayerInvite("guest", 10)).map((realm) => realm.name), ["embers", "friends"]);

        assert.equal(await repo.addMember("id-friends", { accountId: "guest", role: "MEMBER", joinedAt: LATER }, 10), "ADDED");
        assert.deepEqual((await repo.findById("id-friends"))!.playerInvites, [{ accountId: "other", at: NOW }]);
        assert.equal(await repo.addBan("id-embers", { accountId: "guest", at: LATER }, 10), "BANNED");
        assert.deepEqual((await repo.findById("id-embers"))!.playerInvites, []);
        assert.deepEqual(await repo.findByPlayerInvite("guest", 10), []);
    });
}
