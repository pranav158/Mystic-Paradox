/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canAcceptStanza, canTransition } from "./stateMachine";
import { XmppState } from "./types";

test("canTransition: valid forward transitions", () => {
    assert.equal(canTransition(XmppState.Connected, XmppState.OpenReceived), true);
    assert.equal(canTransition(XmppState.OpenReceived, XmppState.AuthAdvertised), true);
    assert.equal(canTransition(XmppState.AuthAdvertised, XmppState.Authenticated), true);
    assert.equal(canTransition(XmppState.ResourceBound, XmppState.SessionReady), true);
});

test("canTransition: invalid skips are rejected", () => {
    assert.equal(canTransition(XmppState.Connected, XmppState.SessionReady), false);
    assert.equal(canTransition(XmppState.Connected, XmppState.Authenticated), false);
    assert.equal(canTransition(XmppState.Closed, XmppState.OpenReceived), false);
});

test("canTransition: same-state re-entry is allowed; any state can close", () => {
    assert.equal(canTransition(XmppState.SessionReady, XmppState.SessionReady), true);
    assert.equal(canTransition(XmppState.AuthAdvertised, XmppState.Closed), true);
    assert.equal(canTransition(XmppState.SessionReady, XmppState.Closing), true);
});

test("canAcceptStanza: presence/message/roomJoin require a bound session", () => {
    for (const kind of ["presence", "message", "roomJoin"] as const) {
        assert.equal(canAcceptStanza(XmppState.Connected, kind), false, `${kind} must be rejected pre-auth`);
        assert.equal(canAcceptStanza(XmppState.Authenticated, kind), false, `${kind} must be rejected pre-bind`);
        assert.equal(canAcceptStanza(XmppState.SessionReady, kind), true, `${kind} allowed once session-ready`);
    }
});

test("canAcceptStanza: handshake stanzas gated by state", () => {
    assert.equal(canAcceptStanza(XmppState.Connected, "open"), true);
    assert.equal(canAcceptStanza(XmppState.OpenReceived, "auth"), true);
    assert.equal(canAcceptStanza(XmppState.Connected, "auth"), false);
    assert.equal(canAcceptStanza(XmppState.ReopenReceived, "bind"), true);
    
    assert.equal(canAcceptStanza(XmppState.Connected, "close"), true);
    assert.equal(canAcceptStanza(XmppState.Closed, "close"), true);
});
