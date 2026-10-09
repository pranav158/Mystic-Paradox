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

import { XmppState } from "./types";

/**
 * XMPP connection state machine (plan §9.2). Pure + unit-tested (§20.1). Defines
 * which follow-on states are reachable from a given state, and which stanza kinds
 * are acceptable in a given state — presence/message/room-join must never be
 * accepted before authentication and resource binding (plan §9.2, §18).
 *
 * This is a first, conservative model. The exact sequence (e.g. whether the client
 * uses RFC 7395 <open> reopen after SASL, or requests a legacy session IQ) is
 * refined once the real client handshake is captured.
 */

export const ALLOWED_TRANSITIONS: Readonly<Record<XmppState, readonly XmppState[]>> = {
    [XmppState.Connected]: [XmppState.OpenReceived, XmppState.Closing, XmppState.Closed],
    [XmppState.OpenReceived]: [XmppState.AuthAdvertised, XmppState.Closing, XmppState.Closed],
    [XmppState.AuthAdvertised]: [XmppState.Authenticated, XmppState.Closing, XmppState.Closed],
    [XmppState.Authenticated]: [XmppState.ReopenReceived, XmppState.Closing, XmppState.Closed],
    [XmppState.ReopenReceived]: [XmppState.ResourceBound, XmppState.Closing, XmppState.Closed],
    [XmppState.ResourceBound]: [XmppState.SessionReady, XmppState.Closing, XmppState.Closed],
    [XmppState.SessionReady]: [XmppState.Closing, XmppState.Closed],
    [XmppState.Closing]: [XmppState.Closed],
    [XmppState.Closed]: [],
};

export function canTransition(from: XmppState, to: XmppState): boolean {
    if (from === to) return true; // idempotent re-entry
    return ALLOWED_TRANSITIONS[from].includes(to);
}

export type StanzaKind =
    | "open"
    | "auth"
    | "bind"
    | "session"
    | "iq"
    | "presence"
    | "message"
    | "roomJoin"
    | "ping"
    | "close";

/** Stanza kinds that require a fully authenticated + bound session. */
const REQUIRES_SESSION: ReadonlySet<StanzaKind> = new Set<StanzaKind>([
    "presence",
    "message",
    "roomJoin",
]);

export function canAcceptStanza(state: XmppState, kind: StanzaKind): boolean {
    if (kind === "close") return true;
    if (kind === "open") {
        // Initial stream open, or the post-SASL reopen.
        return state === XmppState.Connected || state === XmppState.Authenticated;
    }
    if (kind === "auth") {
        return state === XmppState.OpenReceived || state === XmppState.AuthAdvertised;
    }
    if (kind === "bind") {
        return state === XmppState.ReopenReceived || state === XmppState.Authenticated;
    }
    if (kind === "session") {
        return state === XmppState.ResourceBound || state === XmppState.ReopenReceived;
    }
    if (REQUIRES_SESSION.has(kind)) {
        return state === XmppState.SessionReady || state === XmppState.ResourceBound;
    }
    // Generic IQ / ping: allowed once the stream is open and not closed.
    return state !== XmppState.Connected && state !== XmppState.Closed;
}
