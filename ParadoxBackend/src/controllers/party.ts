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

import crypto from "node:crypto";









export interface Party {
    partyId: string;
    leaderPlayerId: string;
    members: string[];
    buildId: string;
}

export interface PartyInvite {
    partyId: string;
    sendingPlayerId: string;
    sendingDisplayName: string;
    sendingPlatform: string;
}

const Parties = new Map<string, Party>();          
const PlayerParty = new Map<string, string>();      
const IncomingInvites = new Map<string, PartyInvite[]>(); 




function MakePartyId(buildId: string): string {
    return `${crypto.randomBytes(16).toString("hex")}_${Buffer.from(buildId ?? "").toString("base64")}`;
}

export function GetPartyForPlayer(playerId: string): Party | undefined {
    const Id = PlayerParty.get(playerId);
    return Id ? Parties.get(Id) : undefined;
}

export function GetOrCreateParty(playerId: string, buildId: string): Party {
    const Existing = GetPartyForPlayer(playerId);
    if (Existing) return Existing;

    const NewParty: Party = { partyId: MakePartyId(buildId), leaderPlayerId: playerId, members: [playerId], buildId };
    Parties.set(NewParty.partyId, NewParty);
    PlayerParty.set(playerId, NewParty.partyId);
    return NewParty;
}

export function InviteToParty(senderId: string, recipientId: string, buildId: string, senderDisplayName: string, senderPlatform: string): void {
    if (!recipientId || recipientId === senderId) return;

    const Party = GetOrCreateParty(senderId, buildId);
    const List = IncomingInvites.get(recipientId) ?? [];
    if (!List.some((i) => i.sendingPlayerId === senderId)) {
        List.push({ partyId: Party.partyId, sendingPlayerId: senderId, sendingDisplayName: senderDisplayName, sendingPlatform: senderPlatform });
    }
    IncomingInvites.set(recipientId, List);
}

export function GetInvitesForPlayer(recipientId: string): PartyInvite[] {
    return IncomingInvites.get(recipientId) ?? [];
}

export function LeaveParty(playerId: string): void {
    const Id = PlayerParty.get(playerId);
    PlayerParty.delete(playerId);
    if (!Id) return;

    const Party = Parties.get(Id);
    if (!Party) return;

    Party.members = Party.members.filter((m) => m !== playerId);
    if (Party.members.length === 0) {
        Parties.delete(Id);
        return;
    }
    if (Party.leaderPlayerId === playerId) {
        Party.leaderPlayerId = Party.members[0];
    }
}

export function AcceptInvite(recipientId: string, inviterId: string, buildId: string): Party | undefined {
    
    
    const Invites = IncomingInvites.get(recipientId) ?? [];
    if (!Invites.some((i) => i.sendingPlayerId === inviterId)) {
        return GetPartyForPlayer(recipientId); 
    }

    const InviterParty = GetOrCreateParty(inviterId, buildId);

    
    LeaveParty(recipientId);

    if (!InviterParty.members.includes(recipientId)) {
        InviterParty.members.push(recipientId);
    }
    PlayerParty.set(recipientId, InviterParty.partyId);

    
    IncomingInvites.set(recipientId, Invites.filter((i) => i.sendingPlayerId !== inviterId));
    return InviterParty;
}

export function KickMember(actorId: string, targetId: string): void {
    const Party = GetPartyForPlayer(actorId);
    
    if (Party && Party.leaderPlayerId === actorId && targetId !== actorId && Party.members.includes(targetId)) {
        LeaveParty(targetId);
    }
}

export function PromoteMember(actorId: string, targetId: string): void {
    const Party = GetPartyForPlayer(actorId);
    
    if (Party && Party.leaderPlayerId === actorId && Party.members.includes(targetId)) {
        Party.leaderPlayerId = targetId;
    }
}
