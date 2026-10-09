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

import { Jid } from "./types";

/**
 * DEFERRED service contracts (plan §8.2, §10-§14).
 *
 * These interfaces document the target architecture but are intentionally NOT
 * implemented in the capture-first foundation: their exact behavior (SASL
 * mechanism, credential form, presence payload, roster IQ shape, MUC framing) is
 * unknown until the real client is captured (plan §2.4). Implement them per the
 * plan's execution order (§23) once redacted protocol fixtures exist. Keeping them
 * as types only guarantees no half-built, unverified protocol logic ships.
 */

export interface AuthResult {
    accountId: string;
    resource: string;
}

/** WP4 — SASL/JWT authentication + identity binding (plan §10). */
export interface AuthService {
    /**
     * Validate the credential presented over SASL and bind it to an account. MUST
     * verify the signed game JWT (RS256, issuer/audience "paradox-backend") and
     * require the JID localpart/authcid to resolve to that same account (plan §10.2).
     * Never widen the existing JWT validator or accept arbitrary JID localparts.
     */
    authenticate(
        mechanism: string,
        authcid: string,
        credential: string,
        requestedJid: Jid | undefined,
    ): Promise<AuthResult>;
}

/** WP5 — online/offline presence for accepted friends only (plan §11). */
export interface PresenceService {
    onResourceAvailable(accountId: string, resource: string): Promise<void>;
    onResourceUnavailable(accountId: string, resource: string): Promise<void>;
}

/** WP6 — roster compatibility; accepted friends only (plan §12). */
export interface RosterService {
    listAcceptedFriends(accountId: string): Promise<string[]>;
}

/** WP7 — direct friend chat; friendship-gated, non-persistent in the MVP (plan §13). */
export interface ChatService {
    routeDirectMessage(
        fromAccountId: string,
        toBareJid: string,
        stanzaId: string,
        body: string,
    ): Promise<void>;
}

/**
 * WP8 — read-only party authorization adapter (plan §14.2). The realtime module
 * asks these questions; it never mutates party maps directly.
 */
export interface PartyAuthAdapter {
    getPartyForPlayer(accountId: string): Promise<string | undefined>;
    isPartyMember(accountId: string, partyId: string): Promise<boolean>;
    listPartyMembers(partyId: string): Promise<string[]>;
}

/** WP8 — party/hunt room membership + group message fanout (plan §14.3). */
export interface RoomService {
    joinRoom(accountId: string, roomId: string, nickname: string): Promise<void>;
    leaveRoom(accountId: string, roomId: string): Promise<void>;
    routeGroupMessage(
        fromAccountId: string,
        roomId: string,
        stanzaId: string,
        body: string,
    ): Promise<void>;
}
