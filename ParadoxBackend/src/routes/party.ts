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

import { Router } from "express";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { logger } from "../logger";
import { GetUsernameForUserId } from "../controllers/login";
import {
    GetOrCreateParty,
    InviteToParty,
    GetInvitesForPlayer,
    AcceptInvite,
    LeaveParty,
    KickMember,
    PromoteMember
} from "../controllers/party";
import { GetPartyInstance, GetPlayerCandidate } from "../controllers/matchmaking";





export const partyRouter = Router();

const PLATFORM = "win";



partyRouter.post("/party", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const BuildId: string = req.body?.buildId ?? "";

    const Party = GetOrCreateParty(UserId, BuildId);
    const Instance = GetPartyInstance(Party.partyId);
    const InHunt = Instance != undefined;
    
    
    
    const Candidate = GetPlayerCandidate(UserId) ?? Instance;

    const PlayerStates = await Promise.all(Party.members.map(async (Member) => ({
        consoleSessionId: null,
        displayName: await GetUsernameForUserId(Member),
        isMemberOfCandidate: InHunt ? true : Member === Party.leaderPlayerId,
        platform: PLATFORM,
        playerId: Member
    })));

    res.status(200).json({
        candidateId: Candidate?.CandidateId ?? null,
        candidateState: Instance ? (Instance.Ready ? "IN_PROGRESS" : "MATCHING") : "QUEUED_FOR_START",
        gauntletLevel: null,
        leaderPlayerId: Party.leaderPlayerId,
        partyId: Party.partyId,
        playerHuntId: Instance?.HuntId ?? null,
        playerStates: PlayerStates
    });
});


partyRouter.put("/party/invite", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const RecipientId: unknown = req.body?.recipientPlayerId;
    const BuildId: string = req.body?.buildId ?? "";

    if (typeof RecipientId === "string" && RecipientId.length > 0) {
        const SenderName = await GetUsernameForUserId(UserId);
        InviteToParty(UserId, RecipientId, BuildId, SenderName, PLATFORM);
        logger.info(`${UserId} invited ${RecipientId} to their party`);
    }

    res.status(200).json({});
});


partyRouter.get("/party/invites", HasParadoxBackendAuth, (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const Invitations = GetInvitesForPlayer(UserId).map((Invite) => ({
        partyId: Invite.partyId,
        recipientPlayerId: UserId,
        sendingDisplayName: Invite.sendingDisplayName,
        sendingPlatform: Invite.sendingPlatform,
        sendingPlayerId: Invite.sendingPlayerId
    }));

    res.status(200).json({ invitations: Invitations });
});


partyRouter.put("/party/invite/accept/:inviterId", HasParadoxBackendAuth, (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const InviterId: string = req.params.inviterId;
    const BuildId: string = req.body?.buildId ?? "";

    AcceptInvite(UserId, InviterId, BuildId);
    logger.info(`${UserId} accepted party invite from ${InviterId}`);

    res.status(200).json({});
});


partyRouter.delete("/party/member", HasParadoxBackendAuth, (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    LeaveParty(UserId);
    logger.info(`${UserId} left their party`);
    res.status(200).json({});
});


partyRouter.delete("/party/member/:targetId", HasParadoxBackendAuth, (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    KickMember(UserId, req.params.targetId);
    logger.info(`${UserId} kicked ${req.params.targetId} from the party`);
    res.status(200).json({});
});


partyRouter.put("/party/member/promote/:targetId", HasParadoxBackendAuth, (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    PromoteMember(UserId, req.params.targetId);
    logger.info(`${UserId} promoted ${req.params.targetId} to party leader`);
    res.status(200).json({});
});
