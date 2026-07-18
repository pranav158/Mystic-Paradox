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



export interface AuthResult {
    accountId: string;
    resource: string;
}


export interface AuthService {
    
    authenticate(
        mechanism: string,
        authcid: string,
        credential: string,
        requestedJid: Jid | undefined,
    ): Promise<AuthResult>;
}


export interface PresenceService {
    onResourceAvailable(accountId: string, resource: string): Promise<void>;
    onResourceUnavailable(accountId: string, resource: string): Promise<void>;
}


export interface RosterService {
    listAcceptedFriends(accountId: string): Promise<string[]>;
}


export interface ChatService {
    routeDirectMessage(
        fromAccountId: string,
        toBareJid: string,
        stanzaId: string,
        body: string,
    ): Promise<void>;
}


export interface PartyAuthAdapter {
    getPartyForPlayer(accountId: string): string | undefined;
    isPartyMember(accountId: string, partyId: string): boolean;
    listPartyMembers(partyId: string): string[];
}


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
