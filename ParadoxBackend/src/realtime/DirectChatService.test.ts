/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { FriendEdgeRecord } from "../persistence/contracts/FriendshipRepository";
import { DirectChatService } from "./DirectChatService";
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

class FakeRegistry {
    readonly conns = new Map<string, Map<string, FakeConnection>>();
    add(conn: FakeConnection): void {
        let resources = this.conns.get(conn.accountId);
        if (!resources) {
            resources = new Map();
            this.conns.set(conn.accountId, resources);
        }
        resources.set(conn.resource, conn);
    }
    connectionsFor(accountId: string): FakeConnection[] {
        return [...(this.conns.get(accountId)?.values() ?? [])];
    }
    connectionFor(accountId: string, resource: string): FakeConnection | undefined {
        return this.conns.get(accountId)?.get(resource);
    }
}

function edge(ownerId: string, otherId: string, status: FriendEdgeRecord["status"]): FriendEdgeRecord {
    return { ownerId, otherId, status, created: new Date(0).toISOString() };
}

function setup(statusAB: FriendEdgeRecord["status"] = "ACCEPTED", statusBA: FriendEdgeRecord["status"] = "ACCEPTED") {
    const edges = new Map<string, FriendEdgeRecord>([
        ["alice:bob", edge("alice", "bob", statusAB)],
        ["bob:alice", edge("bob", "alice", statusBA)],
    ]);
    const registry = new FakeRegistry();
    const sender = new FakeConnection("ca", "alice", "ra");
    const bob1 = new FakeConnection("cb1", "bob", "rb1");
    const bob2 = new FakeConnection("cb2", "bob", "rb2");
    registry.add(sender);
    registry.add(bob1);
    registry.add(bob2);
    const service = new DirectChatService(
        () => ({ find: async (ownerId, otherId) => edges.get(`${ownerId}:${otherId}`) }),
        registry,
        () => 1_000,
    );
    return { service, sender, bob1, bob2 };
}

test("direct chat: accepted friendship delivers escaped text to all recipient resources", async () => {
    const { service, sender, bob1, bob2 } = setup();
    const errors = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com", "m1", "hi <bob> & all");
    assert.deepEqual(errors, []);
    assert.equal(bob1.sent.length, 1);
    assert.equal(bob2.sent.length, 1);
    assert.match(bob1.sent[0], /type="chat"/);
    assert.match(bob1.sent[0], /from="alice@prod\.ol\.epicgames\.com\/ra"/);
    assert.match(bob1.sent[0], /to="bob@prod\.ol\.epicgames\.com\/rb1"/);
    assert.match(bob1.sent[0], /id="m1"/);
    assert.match(bob1.sent[0], /hi &lt;bob&gt; &amp; all/);
});

test("direct chat: full JID targets only the requested live resource", async () => {
    const { service, sender, bob1, bob2 } = setup();
    const errors = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com/rb2", "m2", "private resource");
    assert.deepEqual(errors, []);
    assert.equal(bob1.sent.length, 0);
    assert.equal(bob2.sent.length, 1);
});

test("direct chat: both friendship directions must be accepted", async () => {
    const { service, sender, bob1 } = setup("ACCEPTED", "PENDING");
    const errors = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com", "m3", "denied");
    assert.equal(bob1.sent.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /type="error"/);
    assert.match(errors[0], /<forbidden /);
});

test("direct chat: offline friend returns service-unavailable without throwing", async () => {
    const { service, sender, bob1, bob2 } = setup();
    
    const errors = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com/missing", "m4", "hello?");
    assert.equal(bob1.sent.length + bob2.sent.length, 0);
    assert.match(errors[0], /<service-unavailable /);
});

test("direct chat: rejects foreign domains and empty messages", async () => {
    const { service, sender } = setup();
    const badJid = await service.routeDirectMessage(sender, "bob@example.com", "m5", "hello");
    assert.match(badJid[0], /<jid-malformed /);
    const empty = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com", "m6", "   ");
    assert.match(empty[0], /<not-acceptable /);
});

test("direct chat: per-connection burst is rate limited", async () => {
    const { service, sender } = setup();
    for (let i = 0; i < 12; i++) {
        assert.deepEqual(await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com", `r${i}`, "hello"), []);
    }
    const limited = await service.routeDirectMessage(sender, "bob@prod.ol.epicgames.com", "r13", "hello");
    assert.match(limited[0], /<resource-constraint /);
});
