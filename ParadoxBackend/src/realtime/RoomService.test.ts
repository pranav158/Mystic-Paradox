/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseRoomJid, RoomService } from "./RoomService";
import type { RegisteredConnection } from "./SessionRegistry";

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
    assert.deepEqual(parseRoomJid(`${CITY_BARE}/ExampleSlayer:alice:r1`), {
        roomBare: CITY_BARE,
        roomLocal: CITY,
        nick: "ExampleSlayer:alice:r1",
    });
    assert.equal(parseRoomJid(`${CITY}@evil.example/ExampleSlayer:alice:r1`), undefined);
    assert.deepEqual(parseRoomJid(CITY_BARE), { roomBare: CITY_BARE, roomLocal: CITY, nick: "" });
});

test("dev City MUC: join returns status 110 and groupchat fans out to occupants", () => {
    const service = new RoomService(true);
    const alice = new FakeConnection("ca", "alice", "ra");
    const bob = new FakeConnection("cb", "bob", "rb");

    const aliceJoin = service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(aliceJoin.length, 1);
    assert.match(aliceJoin[0], /status code="110"/);

    const bobJoin = service.joinRoom(bob, `${CITY_BARE}/Bob:bob:rb`);
    assert.equal(bobJoin.length, 2); 
    assert.match(bobJoin[1], /status code="110"/);
    assert.equal(alice.sent.length, 1); 

    service.groupMessage(alice, CITY_BARE, "g1", "hello <city>");
    assert.equal(alice.sent.length, 2);
    assert.equal(bob.sent.length, 1);
    assert.match(bob.sent[0], /type="groupchat"/);
    assert.match(bob.sent[0], /hello &lt;city&gt;/);
});

test("City MUC can be disabled outside development", () => {
    const service = new RoomService(false);
    const alice = new FakeConnection("ca", "alice", "ra");
    const reply = service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(reply.length, 1);
    assert.match(reply[0], /type="error"/);
    assert.match(reply[0], /<not-allowed /);
});
