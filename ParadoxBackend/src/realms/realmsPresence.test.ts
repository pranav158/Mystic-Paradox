import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRealmPresenceRepository } from "./persistence/InMemoryRealmsRepository";
import { RealmPresenceRepository } from "./persistence/RealmsRepository";
import { PRESENCE_CACHE_MS, PRESENCE_TTL_MS, PresenceTouchNeedsWrite } from "./realmRules";
import { Rejects, SetupRealms, T0 } from "./realmsTestKit";
import { RealmPresenceRecord } from "./realmTypes";

// Realm presence (2026-10-13 hub design section 2.2): bind, touch, leave, expiry, the 2 s cache, the player count and the
// launcher's presence calls. In-memory repositories; the injected clock moves time.

const iso = (ms: number) => new Date(ms).toISOString();

/** The in-memory presence repository counting its reads and writes (touches), and optionally holding one read until released. */
class SpyPresence extends InMemoryRealmPresenceRepository {
    reads = 0;
    touches = 0;
    hold: Promise<void> | undefined;
    async findActive(accountId: string, nowIso: string): Promise<RealmPresenceRecord | undefined> {
        this.reads += 1;
        const answer = await super.findActive(accountId, nowIso);
        if (this.hold !== undefined) await this.hold;
        return answer;
    }
    async touch(accountId: string, nowIso: string, expiresAtIso: string): Promise<RealmPresenceRecord | undefined> {
        this.touches += 1;
        return super.touch(accountId, nowIso, expiresAtIso);
    }
}

function SetupSpy() {
    const presence = new SpyPresence();
    const kit = SetupRealms({ presence });
    return { ...kit, presence };
}

// ----- bind, expiry, touch, leave -----

test("a bind records the realm with a 120 second life, and presenceOf answers exactly the section 2.4 shape", async () => {
    const { service } = SetupRealms();
    assert.equal(await service.presenceOf("friend-1"), undefined);
    await service.bindPresence("friend-1", "realm-1");
    assert.deepEqual(await service.presenceOf("friend-1"), {
        realmId: "realm-1", boundAt: iso(T0), lastSeenAt: iso(T0), expiresAt: iso(T0 + PRESENCE_TTL_MS)
    });
    assert.equal(PRESENCE_TTL_MS, 120_000);
});

test("a second bind replaces the first (one realm per account), and a null bind deletes it", async () => {
    const { clock, presence, service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + 5000;
    await service.bindPresence("friend-1", "realm-2");
    assert.deepEqual(await service.presenceOf("friend-1"), {
        realmId: "realm-2", boundAt: iso(T0 + 5000), lastSeenAt: iso(T0 + 5000), expiresAt: iso(T0 + 5000 + PRESENCE_TTL_MS)
    });
    assert.equal(presence.rows.size, 1);
    await service.bindPresence("friend-1", null);
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.equal(presence.rows.size, 0);
    await service.bindPresence("never-bound", null); // nothing to delete: not an error
});

test("presence is active only while expiresAt is in the future, even if the database still holds the row", async () => {
    const { clock, presence, service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + PRESENCE_TTL_MS - 1;
    assert.equal((await service.presenceOf("friend-1"))?.realmId, "realm-1");
    clock.now = T0 + PRESENCE_TTL_MS;
    assert.equal(await service.presenceOf("friend-1"), undefined, "expired exactly at expiresAt");
    assert.equal(presence.rows.size, 1, "the TTL index has not cleaned it up yet: the read enforces expiry itself");
});

test("a lapsed row answers none even from the 2 second cache", async () => {
    const { clock, service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + PRESENCE_TTL_MS - 500;
    assert.ok(await service.presenceOf("friend-1"), "cached while 0.5 s from the end");
    clock.now = T0 + PRESENCE_TTL_MS + 500;
    assert.equal(await service.presenceOf("friend-1"), undefined);
});

test("a touch gives an active presence another 120 seconds; it never brings back an expired or absent one", async () => {
    const { clock, service } = SetupRealms();
    assert.equal(await service.touchPresence("friend-1"), undefined, "nothing to touch");
    await service.bindPresence("friend-1", "realm-1");

    clock.now = T0 + 60_000;
    const touched = await service.touchPresence("friend-1");
    assert.deepEqual(touched, { realmId: "realm-1", boundAt: iso(T0), lastSeenAt: iso(T0 + 60_000), expiresAt: iso(T0 + 60_000 + PRESENCE_TTL_MS) });
    clock.now = T0 + 150_000; // past the first expiry, inside the extended one
    assert.equal((await service.presenceOf("friend-1"))?.expiresAt, iso(T0 + 180_000));

    clock.now = T0 + 180_000;
    assert.equal(await service.touchPresence("friend-1"), undefined, "expired: not resurrected");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    clock.now = T0 + 181_000;
    assert.equal(await service.presenceOf("friend-1"), undefined, "and it stays gone");
});

test("leaving removes the presence at once", async () => {
    const { presence, service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-1");
    assert.ok(await service.presenceOf("friend-1"));
    await service.leavePresence("friend-1");
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.equal(presence.rows.size, 0);
    await service.leavePresence("friend-1"); // again: harmless
});

// ----- the cache -----

test("presenceOf is answered from a 2 second cache, none included, and a local write drops it", async () => {
    const { clock, presence, service } = SetupSpy();
    assert.equal(PRESENCE_CACHE_MS, 2000);
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.equal(presence.reads, 1, "a second ask within 2 s does not reach the database");

    await service.bindPresence("friend-1", "realm-1"); // a local write
    assert.equal((await service.presenceOf("friend-1"))?.realmId, "realm-1");
    assert.equal(presence.reads, 2, "the bind dropped the cached none");
    await service.presenceOf("friend-1");
    assert.equal(presence.reads, 2);

    clock.now = T0 + 1999;
    await service.presenceOf("friend-1");
    assert.equal(presence.reads, 2, "still fresh at 1.999 s");
    clock.now = T0 + 2000;
    await service.presenceOf("friend-1");
    assert.equal(presence.reads, 3, "stale at 2 s");
});

test("a change made by another process shows up when the 2 second cache lapses (and not before)", async () => {
    const { clock, presence, service } = SetupSpy();
    assert.equal(await service.presenceOf("friend-1"), undefined);
    await presence.bind({ accountId: "friend-1", realmId: "realm-9", boundAt: iso(T0), lastSeenAt: iso(T0), expiresAt: iso(T0 + PRESENCE_TTL_MS) });
    assert.equal(await service.presenceOf("friend-1"), undefined, "cached none");
    clock.now = T0 + 2000;
    assert.equal((await service.presenceOf("friend-1"))?.realmId, "realm-9");
});

test("leave and touch also keep the cache honest", async () => {
    const { clock, presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1");
    await service.presenceOf("friend-1");
    await service.leavePresence("friend-1");
    assert.equal(await service.presenceOf("friend-1"), undefined, "the cached row was dropped by the leave");

    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + 31_000;
    const readsBefore = presence.reads;
    await service.touchPresence("friend-1"); // lastSeenAt is 31 s old, so this one writes
    assert.equal((await service.presenceOf("friend-1"))?.lastSeenAt, iso(T0 + 31_000), "a written touch updates what presenceOf says");
    assert.equal(presence.reads, readsBefore + 1, "the touch read the row once; the written row is cached, so presenceOf costs nothing");
});

// ----- touch coalescing (realms wave 2): a touch writes only when the row needs it -----

test("the touch rule: write when lastSeenAt is more than 30 s old or less than 60 s of life is left, otherwise not", () => {
    const row = { lastSeenAt: iso(T0), expiresAt: iso(T0 + PRESENCE_TTL_MS) };
    assert.equal(PresenceTouchNeedsWrite(row, T0), false);
    assert.equal(PresenceTouchNeedsWrite(row, T0 + 30_000), false, "exactly 30 s is not older than 30 s");
    assert.equal(PresenceTouchNeedsWrite(row, T0 + 30_001), true);
    assert.equal(PresenceTouchNeedsWrite({ lastSeenAt: iso(T0), expiresAt: iso(T0 + 50_000) }, T0), true, "50 s left");
    assert.equal(PresenceTouchNeedsWrite({ lastSeenAt: iso(T0), expiresAt: iso(T0 + 60_000) }, T0), false, "exactly 60 s left");
    assert.equal(PresenceTouchNeedsWrite({ lastSeenAt: iso(T0), expiresAt: iso(T0 + 60_000) }, T0 + 1), true, "59.999 s left");
});

test("a touch inside the write window answers from the row and writes nothing", async () => {
    const { clock, presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + 5_000;
    const first = await service.touchPresence("friend-1");
    assert.deepEqual(first, { realmId: "realm-1", boundAt: iso(T0), lastSeenAt: iso(T0), expiresAt: iso(T0 + PRESENCE_TTL_MS) },
        "the row as last written, not the touch's time");
    assert.equal(presence.touches, 0, "no write for a 5 s old row");
    const readsAfterFirst = presence.reads;
    clock.now = T0 + 6_000;
    assert.equal((await service.touchPresence("friend-1"))?.realmId, "realm-1");
    assert.equal(presence.touches, 0);
    assert.equal(presence.reads, readsAfterFirst, "the second touch is decided from the fresh cache");
});

test("a row that is about to expire is written even when it was written recently", async () => {
    const { presence, service } = SetupSpy();
    await presence.bind({ accountId: "friend-1", realmId: "realm-1", boundAt: iso(T0), lastSeenAt: iso(T0), expiresAt: iso(T0 + 50_000) });
    const touched = await service.touchPresence("friend-1");
    assert.equal(touched?.expiresAt, iso(T0 + PRESENCE_TTL_MS), "less than 60 s left: extended");
    assert.equal(presence.touches, 1);
});

test("a touch every 10 seconds writes once per 40 seconds and the presence never lapses", async () => {
    const { clock, presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1");
    const touchesBefore = presence.touches;
    const readsBefore = presence.reads;
    let touches = 0;
    for (let offset = 10_000; offset <= 15 * 60_000; offset += 10_000) {
        clock.now = T0 + offset;
        touches += 1;
        assert.ok(await service.touchPresence("friend-1"), `still present at ${offset / 1000} s`);
    }
    // Writes at 40 s, 80 s, ...: lastSeenAt is 30 s old at the touch of 30 s (not older) and 40 s old at the touch of 40 s.
    assert.equal(presence.touches - touchesBefore, Math.floor((15 * 60_000) / 40_000));
    assert.equal(presence.reads - readsBefore, touches, "every touch reads the row once (the cache is 2 s, the touches 10 s apart)");
});

test("a touch every 60 seconds writes on every touch and the presence never lapses", async () => {
    const { clock, presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1");
    for (let offset = 60_000; offset <= 15 * 60_000; offset += 60_000) {
        clock.now = T0 + offset;
        assert.equal((await service.touchPresence("friend-1"))?.expiresAt, iso(T0 + offset + PRESENCE_TTL_MS));
    }
    assert.equal(presence.touches, 15);
});

test("touches at least every 60 seconds, with any spacing, never let the presence lapse", async () => {
    for (const seed of [1, 7, 42, 9001]) {
        const { clock, service } = SetupRealms();
        await service.bindPresence("friend-1", "realm-1");
        let state = seed;
        let at = T0;
        for (let touch = 0; touch < 300; touch++) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            at += 1_000 + (state % 60_000); // 1 s to 60 s between touches
            clock.now = at;
            assert.ok(await service.touchPresence("friend-1"), `seed ${seed}: lapsed before touch ${touch} (${at - T0} ms in)`);
        }
    }
});

test("an absent or lapsed row is never written back by a touch", async () => {
    const { clock, presence, service } = SetupSpy();
    assert.equal(await service.touchPresence("nobody"), undefined);
    await service.bindPresence("friend-1", "realm-1");
    clock.now = T0 + PRESENCE_TTL_MS;
    assert.equal(await service.touchPresence("friend-1"), undefined, "lapsed");
    assert.equal(presence.touches, 0, "decided from the read: nothing to write");
});

test("a read that was already in flight when a write happened cannot put its old answer back in the cache", async () => {
    const { presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1");
    let release!: () => void;
    presence.hold = new Promise<void>((resolve) => { release = resolve; });
    const stale = service.presenceOf("friend-1"); // reads realm-1, then waits
    await new Promise((resolve) => setImmediate(resolve));
    presence.hold = undefined;
    await service.bindPresence("friend-1", "realm-2"); // the write lands while that read is in flight
    release();
    assert.equal((await stale)?.realmId, "realm-1", "the in-flight caller gets the answer it asked for");
    assert.equal((await service.presenceOf("friend-1"))?.realmId, "realm-2", "but the next ask sees the write, not the old answer");
});

test("a read in flight while a touch lands cannot put the older, shorter-lived answer back in the cache", async () => {
    const { clock, presence, service } = SetupSpy();
    await service.bindPresence("friend-1", "realm-1"); // expires at T0 + 120 s
    clock.now = T0 + 119_500;
    let release!: () => void;
    presence.hold = new Promise<void>((resolve) => { release = resolve; });
    const stale = service.presenceOf("friend-1"); // sees the row with 0.5 s left, then waits
    await new Promise((resolve) => setImmediate(resolve));
    presence.hold = undefined;
    await service.touchPresence("friend-1"); // extends it to T0 + 239.5 s
    release();
    await stale;
    clock.now = T0 + 120_500; // past the old expiry, inside the new one, inside the 2 s cache window
    assert.equal((await service.presenceOf("friend-1"))?.expiresAt, iso(T0 + 119_500 + PRESENCE_TTL_MS));
});

test("a cache that grows without bound is pruned instead", async () => {
    const { service } = SetupRealms();
    for (let index = 0; index < 10_050; index++) await service.presenceOf(`account-${index}`);
    assert.equal(await service.presenceOf("account-10049"), undefined);
});

// ----- the launcher's presence calls -----

test("presence heartbeat: no presence answers null; an active one is kept alive and described, including serving and the host state", async () => {
    const { clock, service, create, serve } = SetupRealms();
    assert.deepEqual(await service.presenceHeartbeat("friend-1"), { realm: null, expiresAt: null });
    assert.deepEqual(await service.presenceStatus("friend-1"), { realm: null, expiresAt: null });

    const realm = await create("host-1", "friends");
    await service.bindPresence("friend-1", realm.realmId);
    assert.deepEqual(await service.presenceStatus("friend-1"), {
        realm: { name: "friends", serving: false, hubReady: false, hostOnline: false },
        expiresAt: iso(T0 + PRESENCE_TTL_MS)
    });

    await serve("host-1", realm.realmId);
    // 31 s, not 30: a touch writes only once the row is older than 30 s (coalescing), so a heartbeat at exactly 30 s answers the row as it is.
    clock.now = T0 + 31_000;
    assert.deepEqual(await service.presenceHeartbeat("friend-1"), {
        realm: { name: "friends", serving: true, hubReady: true, hostOnline: true },
        expiresAt: iso(T0 + 31_000 + PRESENCE_TTL_MS)
    });

    // The host stops reporting: the hub is still marked running (the p2p module has not ended it yet) but nothing serves.
    clock.now = T0 + 130_000;
    await service.presenceHeartbeat("friend-1");
    assert.deepEqual((await service.presenceStatus("friend-1")).realm, { name: "friends", serving: false, hubReady: true, hostOnline: false });

    // The launcher stopped for 3 minutes: the presence is gone and a heartbeat does not bring it back.
    clock.now = T0 + 400_000;
    assert.deepEqual(await service.presenceHeartbeat("friend-1"), { realm: null, expiresAt: null });
});

test("presence of a realm that no longer exists reads as none", async () => {
    const { service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-gone");
    assert.deepEqual(await service.presenceStatus("friend-1"), { realm: null, expiresAt: null });
});

test("presence leave from the launcher is idempotent and clears the context", async () => {
    const { service } = SetupRealms();
    await service.bindPresence("friend-1", "realm-1");
    assert.deepEqual(await service.presenceLeave("friend-1"), { left: true });
    assert.equal(await service.presenceOf("friend-1"), undefined);
    assert.deepEqual(await service.presenceLeave("friend-1"), { left: true });
});

test("the launcher's presence calls count against the heartbeat and read budgets", async () => {
    const keys: string[] = [];
    const { service } = SetupRealms({ isRateLimited: (key) => { keys.push(key); return key === "realms:heartbeat:friend-1"; } });
    await Rejects(service.presenceHeartbeat("friend-1"), "AUTH_RATE_LIMITED");
    await Rejects(service.presenceLeave("friend-1"), "AUTH_RATE_LIMITED");
    await service.presenceStatus("friend-1");
    assert.deepEqual(keys, ["realms:heartbeat:friend-1", "realms:heartbeat:friend-1", "realms:read:friend-1"]);
});

// ----- the player count -----

test("the realm listing and the host view count the members whose presence is active", async () => {
    const { clock, service, create } = SetupRealms();
    const alpha = await create("host-1", "alpha", { listed: true });
    const bravo = await create("host-2", "bravo", { listed: true });
    await service.bindPresence("friend-1", alpha.realmId);
    await service.bindPresence("friend-2", alpha.realmId);
    await service.bindPresence("host-2", bravo.realmId);

    const listing = (await service.listListed("someone", { limit: 10, offset: 0 })).realms;
    assert.deepEqual(listing.map((realm) => [realm.name, realm.playerCount]).sort(), [["alpha", 2], ["bravo", 1]]);
    assert.equal((await service.getMine("host-1")).hosted!.playerCount, 2);
    assert.equal((await service.getByName("someone", "bravo")).realm.playerCount, 1);

    clock.now = T0 + 60_000;
    await service.touchPresence("friend-1");
    clock.now = T0 + PRESENCE_TTL_MS; // friend-2 and host-2 lapsed, friend-1 was touched
    assert.equal((await service.getByName("someone", "alpha")).realm.playerCount, 1);
    assert.equal((await service.getByName("someone", "bravo")).realm.playerCount, 0);
});

test("a failing player-count lookup does not fail the directory", async () => {
    const presence = new InMemoryRealmPresenceRepository();
    presence.countActiveByRealm = async () => { throw new Error("presence store down"); };
    const { service, create } = SetupRealms({ presence: presence as RealmPresenceRepository });
    await create("host-1", "friends");
    assert.equal((await service.getByName("friend-1", "friends")).realm.playerCount, 0);
});
