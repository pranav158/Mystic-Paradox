/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { PresenceService } from "./PresenceService";
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
    private readonly byAccount = new Map<string, Map<string, FakeConnection>>();

    bind(conn: FakeConnection): void {
        let resources = this.byAccount.get(conn.accountId);
        if (!resources) {
            resources = new Map<string, FakeConnection>();
            this.byAccount.set(conn.accountId, resources);
        }
        resources.set(conn.resource, conn);
    }

    unbind(conn: FakeConnection): void {
        const resources = this.byAccount.get(conn.accountId);
        if (!resources || resources.get(conn.resource) !== conn) return;
        resources.delete(conn.resource);
        if (resources.size === 0) this.byAccount.delete(conn.accountId);
    }

    isOnline(accountId: string): boolean {
        return (this.byAccount.get(accountId)?.size ?? 0) > 0;
    }

    connectionsFor(accountId: string): RegisteredConnection[] {
        return [...(this.byAccount.get(accountId)?.values() ?? [])];
    }

    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined {
        return this.byAccount.get(accountId)?.get(resource);
    }
}

const friendLookup = async (accountId: string): Promise<string[]> => {
    if (accountId === "alice") return ["bob"];
    if (accountId === "bob") return ["alice"];
    return [];
};

test("additional resources do not replay online presence or snapshots to existing resources", async () => {
    const registry = new FakeRegistry();
    const service = new PresenceService(registry, friendLookup, 1_000);
    const bob = new FakeConnection("cb", "bob", "rb");
    const alice1 = new FakeConnection("ca1", "alice", "ra1");
    const alice2 = new FakeConnection("ca2", "alice", "ra2");
    registry.bind(bob);
    registry.bind(alice1);

    await service.onResourceAvailable("alice", "ra1");
    assert.equal(bob.sent.length, 1, "friend receives the first online transition");
    assert.equal(alice1.sent.length, 1, "new resource receives its friend snapshot");

    registry.bind(alice2);
    await service.onResourceAvailable("alice", "ra2");
    assert.equal(bob.sent.length, 1, "friend does not receive another online transition");
    assert.equal(alice1.sent.length, 1, "existing resource does not receive a repeated snapshot");
    assert.equal(alice2.sent.length, 1, "only the new resource receives the snapshot");
    service.close();
});

test("reconnect within grace preserves logical online state without another friend transition", async () => {
    const registry = new FakeRegistry();
    const service = new PresenceService(registry, friendLookup, 1_000);
    const bob = new FakeConnection("cb", "bob", "rb");
    const alice1 = new FakeConnection("ca1", "alice", "ra1");
    const alice2 = new FakeConnection("ca2", "alice", "ra2");
    registry.bind(bob);
    registry.bind(alice1);

    await service.onResourceAvailable("alice", "ra1");
    registry.unbind(alice1);
    await service.onResourceUnavailable("alice");

    registry.bind(alice2);
    await service.onResourceAvailable("alice", "ra2");
    assert.equal(bob.sent.length, 1, "grace reconnect does not replay Alice's online transition");
    assert.equal(alice2.sent.length, 1, "reconnected resource still receives Bob's snapshot");
    service.close();
});

test("completed offline transition permits exactly one later online transition", async () => {
    const registry = new FakeRegistry();
    const service = new PresenceService(registry, friendLookup, 5);
    const bob = new FakeConnection("cb", "bob", "rb");
    const alice1 = new FakeConnection("ca1", "alice", "ra1");
    const alice2 = new FakeConnection("ca2", "alice", "ra2");
    registry.bind(bob);
    registry.bind(alice1);

    await service.onResourceAvailable("alice", "ra1");
    registry.unbind(alice1);
    await service.onResourceUnavailable("alice");
    await delay(20);
    assert.match(bob.sent[1], /type="unavailable"/);

    registry.bind(alice2);
    await service.onResourceAvailable("alice", "ra2");
    assert.equal(bob.sent.length, 3);
    assert.doesNotMatch(bob.sent[2], /type="unavailable"/);
    service.close();
});
