/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PortPool } from "./portPool";

function Pool(...ports: number[]) {
    const pool = new PortPool();
    for (const port of ports) pool.add(port);
    return pool;
}

test("a late release from an old owner cannot free the new owner's port", () => {
    const pool = Pool(8780);
    assert.equal(pool.take("A"), 8780);
    assert.equal(pool.release(8780, "A"), true);
    assert.equal(pool.take("B"), 8780);
    assert.equal(pool.release(8780, "A"), false);
    assert.equal(pool.take("C"), undefined);
    assert.equal(pool.ownerOf(8780), "B");
    assert.equal(pool.release(8780, "B"), true);
});

test("release is idempotent: exit event then readiness catch frees the port once", () => {
    const pool = Pool(8780, 8781, 8782);
    const port = pool.take("A")!;
    assert.equal(pool.release(port, "A"), true);
    assert.equal(pool.release(port, "A"), false);
    assert.equal(pool.freeCount, 3);
    const taken = [pool.take("x"), pool.take("y"), pool.take("z")];
    assert.equal(new Set(taken).size, 3);
    assert.equal(pool.take("w"), undefined);
});

test("add() ignores a port that is already free or held", () => {
    const pool = Pool(8780, 8781);
    pool.add(8780);
    assert.equal(pool.freeCount, 2);
    const port = pool.take("A")!;
    pool.add(port);
    assert.equal(pool.freeCount, 1);
    assert.equal(pool.heldCount, 1);
});

test("releasing a port that was never taken changes nothing", () => {
    const pool = Pool(8780);
    assert.equal(pool.release(8780, "A"), false);
    assert.equal(pool.release(9999, "A"), false);
    assert.equal(pool.freeCount, 1);
    assert.equal(pool.heldCount, 0);
});

test("FIFO: a just-released port is reused last", () => {
    const pool = Pool(8780, 8781, 8782);
    const first = pool.take("A")!;
    pool.release(first, "A");
    assert.notEqual(pool.take("B"), first);
});

test("readiness-timeout race: no port is ever held by two owners", () => {
    const pool = Pool(8780, 8781, 8782);
    const a = pool.take("A")!;                  // A times out; its child is still alive, the catch skips the release
    const b = pool.take("B")!;
    assert.notEqual(a, b);
    assert.equal(pool.release(a, "A"), true);   // A's exit event: A still owns its port
    const c = pool.take("C")!;
    const d = pool.take("D")!;
    const owners = [a, b, c, d].map((port) => pool.ownerOf(port));
    assert.equal(new Set([b, c, d]).size, 3);
    assert.ok(owners.every((owner) => owner !== "A"));
    assert.equal(pool.heldCount + pool.freeCount, 3);
});

test("a lease is reclaimed when its exit event is lost and its pid is gone", () => {
    const pool = Pool(8780, 8781);
    const port = pool.take("A")!;
    assert.equal(pool.attachPid(port, "A", 4242), true);
    assert.equal(pool.attachPid(port, "B", 1), false, "only the owner can attach a pid");
    assert.equal(pool.pidOf(port), 4242);
    let alive = true;
    const listed = new Set<string>();

    // Still being killed: unlisted owner, live pid -> stays held (the process may own the socket).
    assert.deepEqual(pool.reclaim((owner) => listed.has(owner), () => alive), []);
    assert.equal(pool.ownerOf(port), "A");

    // A listed owner is never reclaimed here, even with a dead pid (the watchdog's own sweep handles it).
    listed.add("A");
    alive = false;
    assert.deepEqual(pool.reclaim((owner) => listed.has(owner), () => alive), []);

    // Unlisted and gone, no exit event ever came: reclaimed.
    listed.delete("A");
    assert.deepEqual(pool.reclaim((owner) => listed.has(owner), () => alive), [{ port, owner: "A", pid: 4242 }]);
    assert.equal(pool.ownerOf(port), undefined);
    assert.equal(pool.freeCount, 2);

    // A late exit event after the reclaim (and after reuse) is refused.
    const reused = pool.take("B")!;
    const again = pool.take("C")!;
    assert.ok(reused === port || again === port);
    assert.equal(pool.release(port, "A"), false);
    assert.equal(pool.heldCount, 2);
});

test("a lease with no pid (spawn never produced one) is reclaimable once unlisted", () => {
    const pool = Pool(8780);
    const port = pool.take("A")!;
    assert.deepEqual(pool.reclaim(() => false, () => true), [{ port, owner: "A", pid: undefined }]);
    assert.equal(pool.freeCount, 1);
});
