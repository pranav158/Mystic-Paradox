/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

export type MatchmakingPartySnapshot = {
    partyId: string,
    members: string[]
};

export type MatchmakingPartyResolution = {
    partyId?: string,
    partyMembers?: string[],
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
    const PartyIdMismatch =
        IsIslandRequest && RequestedPartyId !== Party.partyId;

    if(PartyIdMismatch){
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
        excludedMembers: Party.members.filter((Member) => !PartyMembers.includes(Member)),
        partyIdMismatch: false
    };
}