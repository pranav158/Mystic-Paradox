/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Party-aware routing for POST /matchmaking (routes/matchmaking.ts) has two contracts:
// - ISLAND requests carry the partyId of the party the client is actively travelling with. It must match the
//   authoritative party, and only members with a live XMPP session go along. A stale server-side party (for
//   example after the other client disconnected) can then never turn "Private Hunt / solo" into a two-player
//   server whose airship waits forever.
// - CITY/ReturnToRamsgate requests omit partyId in the captured 1.12 protocol, so the authoritative party is
//   kept and returning members still fan out to the shared Ramsgate.

export type MatchmakingPartySnapshot = {
    partyId: string,
    members: string[],
    revision?: number
};

export type MatchmakingPartyResolution = {
    partyId?: string,
    partyMembers?: string[],
    partyRevision?: number,
    excludedMembers: string[],
    partyIdMismatch: boolean
};

export function ResolveMatchmakingParty(
    GameMode: string,
    UserId: string,
    RequestedPartyId: string | undefined,
    Party: MatchmakingPartySnapshot | undefined,
    IsOnline: (AccountId: string) => boolean
): MatchmakingPartyResolution {
    if(Party == undefined){
        return { excludedMembers: [], partyIdMismatch: false };
    }

    const IsIslandRequest = GameMode === "ISLAND";
    if(IsIslandRequest && RequestedPartyId !== Party.partyId){
        return {
            excludedMembers: Party.members.filter((Member) => Member !== UserId),
            partyIdMismatch: true
        };
    }

    const PartyMembers = Party.members.filter((Member) =>
        Member === UserId || !IsIslandRequest || IsOnline(Member)
    );

    return {
        partyId: Party.partyId,
        partyMembers: PartyMembers,
        partyRevision: Party.revision,
        excludedMembers: Party.members.filter((Member) => !PartyMembers.includes(Member)),
        partyIdMismatch: false
    };
}
