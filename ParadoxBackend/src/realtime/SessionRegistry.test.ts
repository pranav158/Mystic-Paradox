/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RegisteredConnection, SessionRegistry } from "./SessionRegistry";

function connection(connId: string): RegisteredConnection {
    return {
        connId,
        send: () => undefined,
        close: () => undefined
    };
}

test("online account snapshot deduplicates multiple live resources", () => {
    const registry = new SessionRegistry();
    const phone = connection("phone");
    const game = connection("game");
    const other = connection("other");

    registry.bind("account-a", "phone", phone);
    registry.bind("account-a", "game", game);
    registry.bind("account-b", "game", other);

    assert.equal(registry.onlineAccountCount(), 2);
    assert.deepEqual(new Set(registry.onlineAccountIds()), new Set(["account-a", "account-b"]));

    registry.unbind("account-a", "phone", phone);
    assert.equal(registry.isOnline("account-a"), true);
    registry.unbind("account-a", "game", game);
    assert.equal(registry.isOnline("account-a"), false);
    assert.deepEqual(registry.onlineAccountIds(), ["account-b"]);
});

test("displaced resource teardown cannot remove its replacement", () => {
    const registry = new SessionRegistry();
    const oldConnection = connection("old");
    const newConnection = connection("new");

    assert.equal(registry.bind("account-a", "game", oldConnection), undefined);
    assert.equal(registry.bind("account-a", "game", newConnection), oldConnection);

    registry.unbind("account-a", "game", oldConnection);
    assert.equal(registry.isOnline("account-a"), true);
    registry.unbind("account-a", "game", newConnection);
    assert.equal(registry.isOnline("account-a"), false);
});
