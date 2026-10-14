/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseRoomJid, RealmHubRoomAuthority, RoomService } from "./RoomService";
import type { RegisteredConnection } from "./SessionRegistry";

/** A realm directory in memory: which hub room ids belong to which realm, its members and its bans. */
class FakeRealmHubs implements RealmHubRoomAuthority {
    readonly rooms = new Map<string, string>(); // hub room uuid -> realm id
    readonly members = new Set<string>(); // `${realmId}:${accountId}`
    readonly bans = new Set<string>();
    failLookup = false;

    async realmOfHubRoom(hubRoomId: string): Promise<string | undefined> {
        if (this.failLookup) throw new Error("realms unavailable");
        return this.rooms.get(hubRoomId);
    }
    async isMember(realmId: string, accountId: string): Promise<boolean> { return this.members.has(`${realmId}:${accountId}`); }
    async isBanned(realmId: string, accountId: string): Promise<boolean> { return this.bans.has(`${realmId}:${accountId}`); }
    hubRoomIds(realmId: string): string[] {
        return [...this.rooms.entries()].filter(([, owner]) => owner === realmId).map(([id]) => id);
    }
}

class FakeConnection implements RegisteredConnection {
    readonly sent: string[] = [];
    constructor(
        readonly connId: string,
        readonly accountId: string,
        readonly resource: string,
    ) {}
    send(frame: string): void { this.sent.push(frame); }
    close(): void { /* no-op */ }
}

const CITY = "City-c069ba56-fe67-40b7-8e19-cb4a4813dc22";
const CITY_BARE = `${CITY}@muc.prod.ol.epicgames.com`;

test("room parser: accepts only the owned MUC domain and a nonempty nick", () => {
    assert.deepEqual(parseRoomJid(`${CITY_BARE}/MysticFox:alice:r1`), {
        roomBare: CITY_BARE,
        roomLocal: CITY,
        nick: "MysticFox:alice:r1",
    });
    assert.equal(parseRoomJid(`${CITY}@evil.example/MysticFox:alice:r1`), undefined);
    assert.deepEqual(parseRoomJid(CITY_BARE), { roomBare: CITY_BARE, roomLocal: CITY, nick: "" });
});

test("dev City MUC: join returns status 110 and groupchat fans out to occupants", async () => {
    const service = new RoomService(true);
    const alice = new FakeConnection("ca", "alice", "ra");
    const bob = new FakeConnection("cb", "bob", "rb");

    const aliceJoin = await service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(aliceJoin.length, 1);
    assert.match(aliceJoin[0], /status code="110"/);

    const bobJoin = await service.joinRoom(bob, `${CITY_BARE}/Bob:bob:rb`);
    assert.equal(bobJoin.length, 2); // Alice's occupant presence, then Bob self-presence.
    assert.match(bobJoin[1], /status code="110"/);
    assert.equal(alice.sent.length, 1); // newcomer presence

    service.groupMessage(alice, CITY_BARE, "g1", "hello <city>");
    assert.equal(alice.sent.length, 2);
    assert.equal(bob.sent.length, 1);
    assert.match(bob.sent[0], /type="groupchat"/);
    assert.match(bob.sent[0], /hello &lt;city&gt;/);
});

test("City MUC can be disabled outside development", async () => {
    const service = new RoomService(false);
    const alice = new FakeConnection("ca", "alice", "ra");
    const reply = await service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(reply.length, 1);
    assert.match(reply[0], /type="error"/);
    assert.match(reply[0], /<not-allowed /);
});

// [2026-10-14 realms S2, design section 7.5] A realm's hub room (City-<hubRoomId>) belongs to its realm.
const HUB = "5f1c0e7a-3d2b-4a6c-9e8f-0123456789ab";
const HUB_BARE = `City-${HUB}@muc.prod.ol.epicgames.com`;

test("a realm's hub room admits its members only, and never a banned one, even with the dev City rule on", async () => {
    const realms = new FakeRealmHubs();
    realms.rooms.set(HUB, "realm-1");
    realms.members.add("realm-1:alice");
    realms.members.add("realm-1:banned");
    realms.bans.add("realm-1:banned");
    const service = new RoomService(true, true, realms);
    const alice = new FakeConnection("ca", "alice", "ra");
    const stranger = new FakeConnection("cs", "stranger", "rs");
    const banned = new FakeConnection("cb", "banned", "rb");

    assert.match((await service.joinRoom(alice, `${HUB_BARE}/A:alice:ra`))[0], /status code="110"/);
    assert.match((await service.joinRoom(stranger, `${HUB_BARE}/S:stranger:rs`))[0], /<not-allowed /);
    assert.match((await service.joinRoom(banned, `${HUB_BARE}/B:banned:rb`))[0], /<not-allowed /);
});

test("a realm's hub room refuses a non-member when the dev City rule is off too; a member still joins", async () => {
    const realms = new FakeRealmHubs();
    realms.rooms.set(HUB, "realm-1");
    realms.members.add("realm-1:alice");
    const service = new RoomService(false, true, realms);
    const alice = new FakeConnection("ca", "alice", "ra");
    const stranger = new FakeConnection("cs", "stranger", "rs");
    assert.match((await service.joinRoom(alice, `${HUB_BARE}/A:alice:ra`))[0], /status code="110"/);
    assert.match((await service.joinRoom(stranger, `${HUB_BARE}/S:stranger:rs`))[0], /<not-allowed /);
});

test("other City rooms keep the dev rule: any user joins with it on, nobody with it off", async () => {
    const realms = new FakeRealmHubs();
    realms.rooms.set(HUB, "realm-1");
    const stranger = new FakeConnection("cs", "stranger", "rs");
    const open = new RoomService(true, true, realms);
    assert.match((await open.joinRoom(stranger, `${CITY_BARE}/S:stranger:rs`))[0], /status code="110"/);
    const closed = new RoomService(false, true, realms);
    assert.match((await closed.joinRoom(stranger, `${CITY_BARE}/S:stranger:rs`))[0], /<not-allowed /);
});

test("a failed realm lookup refuses a City room; it never falls back to the dev rule", async () => {
    const realms = new FakeRealmHubs();
    realms.failLookup = true;
    const service = new RoomService(true, true, realms);
    const stranger = new FakeConnection("cs", "stranger", "rs");
    assert.match((await service.joinRoom(stranger, `${HUB_BARE}/S:stranger:rs`))[0], /<not-allowed /);
});

test("evicting a realm member takes it out of the realm's hub room: the others see it leave, and it can no longer speak there", async () => {
    const realms = new FakeRealmHubs();
    realms.rooms.set(HUB, "realm-1");
    realms.members.add("realm-1:alice");
    realms.members.add("realm-1:bob");
    const service = new RoomService(false, true, realms);
    const alice = new FakeConnection("ca", "alice", "ra");
    const bob = new FakeConnection("cb", "bob", "rb");
    await service.joinRoom(alice, `${HUB_BARE}/A:alice:ra`);
    await service.joinRoom(bob, `${HUB_BARE}/B:bob:rb`);
    const aliceSent = alice.sent.length;

    service.evictRealmMember("realm-1", "bob");

    assert.equal(alice.sent.length, aliceSent + 1);
    assert.match(alice.sent[alice.sent.length - 1], /type="unavailable"/);
    assert.match(alice.sent[alice.sent.length - 1], /\/B:bob:rb"/);
    service.groupMessage(bob, HUB_BARE, "b1", "still here?");
    assert.equal(alice.sent.length, aliceSent + 1, "the evicted member's message is not delivered");
    // Its rejoin is refused by the membership rule.
    realms.members.delete("realm-1:bob");
    assert.match((await service.joinRoom(bob, `${HUB_BARE}/B:bob:rb`))[0], /<not-allowed /);
});

test("evicting a member of one realm leaves the other realm's rooms and members alone", async () => {
    const realms = new FakeRealmHubs();
    realms.rooms.set(HUB, "realm-1");
    realms.rooms.set("9a7b6c5d-4e3f-4a2b-8c1d-0f9e8d7c6b5a", "realm-2");
    const service = new RoomService(false, true, realms);
    const alice = new FakeConnection("ca", "alice", "ra");
    realms.members.add("realm-2:alice");
    await service.joinRoom(alice, `City-9a7b6c5d-4e3f-4a2b-8c1d-0f9e8d7c6b5a@muc.prod.ol.epicgames.com/A:alice:ra`);
    const before = alice.sent.length;
    service.evictRealmMember("realm-1", "alice");
    assert.equal(alice.sent.length, before);
});
