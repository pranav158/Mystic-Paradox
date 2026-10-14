/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_SERVER_PORT_SPAN, PickHostServerUdpPort } from "./p2pLauncher";

// [2026-10-14 repro] A realm host runs its Ramsgate and its hunts on one PC: every game server needs its own UDP port. With one
// fixed port the realm's Ramsgate and a realm hunt both listened on 8791, the hunt never received its client and the next
// hunt ended in a fatal error.

test("the first live session gets the base port, later ones the next free port", () => {
    assert.equal(PickHostServerUdpPort(8791, []), 8791);
    assert.equal(PickHostServerUdpPort(8791, [{ serverUdpPort: 8791 }]), 8792);
    assert.equal(PickHostServerUdpPort(8791, [{ serverUdpPort: 8791 }, { serverUdpPort: 8792 }]), 8793);
});

test("a port freed by an ended session is used again (only live sessions are passed)", () => {
    assert.equal(PickHostServerUdpPort(8791, [{ serverUdpPort: 8792 }]), 8791);
});

test("a live session from before the rule (no stored port) holds the base port, the old fixed one", () => {
    assert.equal(PickHostServerUdpPort(8791, [{}]), 8792);
    assert.equal(PickHostServerUdpPort(8791, [{}, { serverUdpPort: 8792 }]), 8793);
});

test("a host that already uses every port of its range is refused", () => {
    const all = Array.from({ length: HOST_SERVER_PORT_SPAN }, (_, index) => ({ serverUdpPort: 8791 + index }));
    assert.throws(() => PickHostServerUdpPort(8791, all), (error: any) => error?.code === "P2P_HOST_PORTS_EXHAUSTED");
});
