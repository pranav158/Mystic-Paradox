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

import { IsGameRecentlyActive, TouchGameSession } from "../activity/activityMonitor";
import { Router } from "express";
import crypto from "node:crypto";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { logger } from "../logger";
import { CancelMatchmakingForLeave, CheckAndUpdateQueueStatus, FetchLiveHubStatus, GetCandidateStatusPeriodMillis, HandlePlayerMatchmaking } from "../controllers/matchmaking";
import { CandidateStatusAnswerFor } from "../controllers/candidateStatus";
import { GetPartyForPlayer } from "../controllers/party";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { ResolveMatchmakingParty } from "../matchmakingParty";
import { EncryptionKeyStore, EncryptionKeyTokenFingerprint } from "../encryptionKeyStore";
import { GetP2PExtension } from "../extensions/p2p";
import { RuntimeRosterOf } from "../security/runtimeRoster";
import { GetRealmsService, IsRealmsModuleEnabled } from "../realms";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
// [2026-10-16] How recently a party member's game must have touched the backend to follow the leader into a hunt: 2.5 realm presence
// heartbeats (every 30 s). Shorter than the release gate's 2 minutes, so a member who just closed the game is not frozen into a roster.
const PARTY_MEMBER_ACTIVE_WINDOW_MS = 75_000;

/**
 * [2026-10-14 realms S2] A matchmaking request of a realm member keeps its realm presence alive (presence lapses 120 s after the
 * last touch). Only when the realms module is on; the touch never delays or fails the request.
 */
function TouchRealmPresence(accountId: string): void {
    if (!IsRealmsModuleEnabled()) return;
    try {
        GetRealmsService().touchPresence(accountId).catch((error: unknown) => {
            logger.warn(`[Realms] presence touch failed for ${accountId}: ${error}`);
        });
    } catch (error) {
        logger.warn(`[Realms] presence touch failed for ${accountId}: ${error}`);
    }
}

matchmakingRouter.post("/candidate/player/register", HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);

    res.status(200);
    res.json({});
});

// [1.12 heartbeat stub — 2026-07-10]
// Client fires this every ~5s while in matchmaking / in a game. Was logging as
// Unstubbed with WARN per request. No state needed — just acknowledge.
matchmakingRouter.post("/candidate/player/alive", HasParadoxBackendAuth, (req: any, res) => {
    TouchRealmPresence(req.AuthData.userId);
    // [2026-10-14] The matchmaking heartbeat of a running game extends the activity monitor's playtime (gap rule in activity/activityRules.ts).
    TouchGameSession(req.AuthData.userId);
    res.status(200);
    res.json({});
});

matchmakingRouter.get("/candidate/regions", HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`Querying regions for QoS`);

    res.status(200);
    res.json({
        code: 200,
        message: "success",
        payload: {
            maxPingingStepTime: 3,
            pingCount: 5,
            pingFrequency: 0.25,
            regionUrls: [
                QOS_TARGET_URL
            ]
        }
    });
});

// [1.14.7 FIX 2026-10-04] This was a bare 400 stub. The captured contract
// (DauntlessEndpointDocumentation/Matchmaking/Key/Generate.md) is:
//
//   URL: https://mm2-prod.steelyard.ca/key/generate   Method: GET   Auth: Yes
//   Request:  { "candidateId": "euw11$e90ae40b8b2d4020b4bda5450c56be82" }
//   Response: { "key": "<64 hex chars = 256-bit FEAESKey>",
//               "nonce": "<base64url fingerprint, 32 bytes>",
//               "token": "<JWT>" }
//
// with the capture's own note: "As soon as matchmaking is done they generate a key that is not used in any
// request. I assume this is what's used to encode UDP."
//
// Because the route 400'd, the client logged
//   LogPhoenixMatchmaking [Warning] Failed to generate an encryption key. Connecting without encryption
// and the UDP channel had no key while the hub may expect one. Serving the documented shape removes that
// mismatch; the values are freshly random per call and the token echoes the caller's bearer, as the
// game-session route already does.
// [1.14.7 FIX 2026-10-04] The hub's counterpart to /key/generate - the last blocker for Ramsgate arrival.
//
// Measured: the hub POSTs /key/consume and this service answered 404:
//     INFO: [RES] POST /__origin/mm2-prod.steelyard.ca/key/consume -> 404 (1ms)
// so the hub's encryption key stayed empty and the challenge it sends to a joining client failed:
//     UArchonGameInstance::ReceivedNetworkEncryptionToken::CompleteCallback - Failed on get_request with
//         Unexpected hex key length, key:                    <- empty
//     UWorld::SendChallengeControlMessage: encryption failure [Failure] Unexpected hex key length, key:
//     [client] BroadcastNetworkFailure: FailureType = PendingConnectionFailure
//     [client] Disconnect Error Message: A network connection could not be established.
// The client receives a key from /key/generate; NOTHING was giving the hub the matching one. /key/generate
// now records what it issued and /key/consume hands it back, so both ends share one 256-bit FEAESKey - which
// is exactly what the capture note in the docs describes ("they generate a key ... used to encode UDP").
//
// [2026-10-10 FIX] /key/consume must hand each joining player THEIR key. The game server never names a candidate
// (it sends { token, gameId }), so every consume fell back to the most recent key issued anywhere. Solo play hid
// it; in the first two-player party (19:41) the leader generated a key, the member generated one 170 ms later,
// and the leader's join got the member's key: "UWorld::SendChallengeControlMessage: encryption failure
// [SessionIdMismatch]" and the leader was dropped to the login screen. The token we issue is the caller's own
// bearer token, unique per player, and the server sends it back on consume - so keys are also kept per token
// (encryptionKeyStore.ts).
const EncryptionKeys = new EncryptionKeyStore();

matchmakingRouter.post("/key/generate", HasParadoxBackendAuth, async (req: any, res) => {
    const Key = crypto.randomBytes(32).toString("hex");
    const Nonce = crypto.randomBytes(32).toString("base64url");
    const AuthHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const Token = AuthHeader.startsWith("bearer ") ? AuthHeader.slice("bearer ".length) : AuthHeader;
    const CandidateId = String(req.body && req.body.candidateId ? req.body.candidateId : "");
    // [2026-10-11] The issuing account lets a player-host's consume be limited to its hunt roster (B5).
    const AccountId = typeof req.AuthData?.userId === "string" && req.AuthData.userId.length > 0 ? req.AuthData.userId : undefined;

    EncryptionKeys.issue(CandidateId, { key: Key, nonce: Nonce, token: Token, at: Date.now(), accountId: AccountId });

    logger.info("key/generate served (256-bit key + nonce; candidateId="
        + (CandidateId || "none") + " token=" + EncryptionKeyTokenFingerprint(Token) + ")");

    res.status(200);
    res.json({
        key: Key,
        nonce: Nonce,
        token: Token
    });
});

// The hub's key fetch. Accepts the candidateId in the body or the query; falls back to the most recently
// issued key when the hub does not name one (a hub serves the candidate matchmaking just routed to it). The
// request shape is logged once per call so a wrong assumption is visible in the log rather than silent.
matchmakingRouter.post("/key/consume", HasParadoxBackendAuth, async (req: any, res) => {
    const Body = req.body ?? {};
    const CandidateId = String(Body.candidateId ?? req.query?.candidateId ?? "");
    const ConsumeToken = Body.token ?? req.query?.token;
    const TokenFp = EncryptionKeyTokenFingerprint(ConsumeToken);

    logger.info("key/consume request: candidateId=" + (CandidateId || "none")
        + " bodyKeys=" + Object.keys(Body).join(",") + " token=" + TokenFp);

    // [2026-10-11 P2P, plan 39_ §13.1 B5] A player-host runtime gets only keys issued to its own hunt roster, by
    // candidate or token, never the most-recent fallback (it could be any player's key). Dedicated servers unchanged.
    const Roster = RuntimeRosterOf(req.AuthData);
    const Lookup = EncryptionKeys.lookup(CandidateId, ConsumeToken, Date.now(), { rosterAccountIds: Roster });
    const Match = Lookup.issued;
    const MatchedBy = Lookup.matchedBy;
    if (Roster != undefined && Match === null) {
        logger.warn("key/consume: player-host runtime asked for a key outside its hunt roster or with no issued key"
            + " (rosterRejected=" + (Lookup.rosterRejected === true ? 1 : 0) + " token=" + TokenFp + "); no fallback for hosts");
        res.status(404);
        res.json({ error: "no issued key" });
        return;
    }
    if (Lookup.unknownToken && Match !== null) {
        // With several players generating keys the most recent key can be someone else's.
        logger.warn("key/consume: token " + TokenFp
            + " matches no issued key; falling back to the most recent key (may belong to another player)");
    }

    if (Match === null) {
        logger.warn("key/consume: no issued key is available yet (hub asked before any /key/generate)");
        res.status(404);
        res.json({ error: "no issued key" });
        return;
    }

    logger.info("key/consume served the issued key (matchedBy=" + MatchedBy + " candidateId=" + (CandidateId || "none")
        + " token=" + TokenFp + ")");
    res.status(200);
    res.json({
        key: Match.key,
        nonce: Match.nonce,
        token: Match.token
    });
});

matchmakingRouter.get("/candidate/status", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    TouchRealmPresence(UserId);

    const MatchmakingResult = await CheckAndUpdateQueueStatus(UserId);

    // The answer (the Ramsgate, Training and realm-hub cases) is built by controllers/candidateStatus.ts.
    const Answer = await CandidateStatusAnswerFor(UserId, MatchmakingResult, {
        clientIp: req.ip,
        fetchLiveHub: FetchLiveHubStatus
    });
    res.status(Answer.status);
    if (Answer.body === undefined) {
        res.send();
        return;
    }
    res.json(Answer.body);
});

matchmakingRouter.post("/candidate/join", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    TouchRealmPresence(UserId);
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;

    // [1.12 matchmaking pass-through — 2026-07-10]
    // Every account is force-normalized to "returning player" state in
    // NormalizeCharacterData (character.ts). So the client's LoginScreen always
    // takes the "post-onboarding" branch and posts GameMode=CITY,
    // HuntId=ShatteredIsles_ReturnToRamsgate — DeployServer returns the pre-spawned
    // Ramsgate on port 8790. No tutorial-route rewrite needed.
    //
    // Historical (removed) code path routed fresh accounts into the FTUE hunt
    // (CR19_PlayerHunt_FTUE_Pursuit_Beta_Beaver), which spawned a hunt server on
    // dia_moss_triforce_2 with beaver_beta. That worked as a network handshake test
    // but the FTUE requires content data (beginner-loadout items, tutorial cinematic
    // assets, intro dialog) that we haven't populated for 1.12, and the cinematic
    // triggers a Client-RPC-loops-locally recursion that eats the server stack.
    // Bypassing FTUE and dropping the player straight into the Ramsgate hub is the
    // achievable path — content-data population becomes a separate task.

    // [2026-10-14] The request shape that tells Start Hunt from Private Hunt (captured Candidate/Join: privateMatch, isPrivate, gameType,
    // partyId). Only the shape is logged: booleans and short strings, and whether a party id is present, never the id itself.
    const RequestShape = (value: unknown): string => typeof value === "string" ? JSON.stringify(value.slice(0, 40))
        : typeof value === "boolean" || typeof value === "number" ? String(value) : "absent";
    const PartyIdShape = typeof req.body?.partyId === "string" && req.body.partyId.trim().length > 0 ? "present" : "absent";
    logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId} `
        + `& gameType=${RequestShape(req.body?.gameType)} privateMatch=${RequestShape(req.body?.privateMatch)} `
        + `isPrivate=${RequestShape(req.body?.isPrivate)} partyId=${PartyIdShape}`);

    // TODO: We put a LOT of faith in our authenticated users not abusing the matchmaking system right now
    // A reasonable addition would be checks on frequency of MM/server spinup
    // Best scenario is 1-1 for server session<->player and a new server cooldown

    // Party-aware routing: ISLAND needs the active partyId and drops offline members; CITY keeps the
    // authoritative party (matchmakingParty.ts).
    const PartyForPlayer = await GetPartyForPlayer(UserId);
    const RequestedPartyId =
        typeof req.body.partyId === "string" && req.body.partyId.trim().length > 0
            ? req.body.partyId
            : undefined;
    // [2026-10-11] A Training request the P2P module may host also drops offline members (false without the module).
    const FilterOffline = GetP2PExtension().matchmaking.filtersOfflinePartyMembers(GameMode, HuntId);
    // [2026-10-16] A party member follows the leader as on a dedicated server: a member is online while their game holds an XMPP
    // socket OR touched the backend within PARTY_MEMBER_ACTIVE_WINDOW_MS (the realm presence heartbeat every 30 s, the matchmaking
    // heartbeat). No game holds an XMPP socket on this backend, so the socket alone left
    // every member but the leader out of an Escalation (ISLAND) launch: the realm's host stayed in Ramsgate and the hunt ran on that
    // host's PC without them. A member whose game closed stops touching and drops out
    // after the window.
    const Party = ResolveMatchmakingParty(GameMode, UserId, RequestedPartyId, PartyForPlayer,
        (Member) => sessionRegistry.isOnline(Member) || IsGameRecentlyActive(Member, PARTY_MEMBER_ACTIVE_WINDOW_MS), FilterOffline);

    if(Party.partyIdMismatch && PartyForPlayer != undefined && PartyForPlayer.members.length > 1){
        logger.warn(
            `UserId ${UserId} requested solo/stale-party ISLAND travel; ` +
            `client partyId=${RequestedPartyId ?? "<missing>"} does not match ` +
            `authoritative partyId=${PartyForPlayer.partyId}. Launching for this player only.`
        );
    }
    else if(!Party.partyIdMismatch && Party.excludedMembers.length > 0){
        logger.warn(
            `UserId ${UserId} ${GameMode} party contains ${Party.excludedMembers.length} offline member(s); ` +
            `launching with ${Party.partyMembers?.length ?? 0} active member(s). ` +
            `excluded=${Party.excludedMembers.join(",")}`
        );
    }

    const MatchmakingResult = await HandlePlayerMatchmaking(
        GameMode,
        GameArgs,
        HuntId,
        UserId,
        Party.partyId,
        Party.partyMembers,
        Party.partyRevision,
        typeof req.body?.buildId === "string" ? req.body.buildId : undefined
    );

    if(!MatchmakingResult){
        res.status(400);
        res.send();
        return;
    }

    const MatchmakingEntry = await CheckAndUpdateQueueStatus(UserId);

    res.status(200);
    res.json({
        candidateId: MatchmakingEntry!.CandidateId,
        // [2026-10-16] Without it the client waited its default 10 s before the first status poll.
        candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingEntry!),
        gameMode: GameMode,
        huntId: MatchmakingEntry!.HuntId,
        status: "MATCHING",
        statusReason: null
    });
});

/** [2026-10-14 cancel] The body key names of a leave, for the log (never the values): at most 12 names, cut to safe characters. */
function LoggedBodyKeys(body: unknown): string {
    if (body == undefined || typeof body !== "object" || Array.isArray(body)) return "";
    return Object.keys(body).slice(0, 12).map((Key) => Key.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40)).join(",");
}

/**
 * [2026-10-14 cancel] The client's Cancel of its search. From the 1.14.7 binary (Ghidra, confirmed by the coordinator):
 * FUN_140db6dd0 sends DELETE /candidate/leave with no request body, and only the party leader sends it - the party's
 * CancelMatchmaking (FUN_141c1e9d0) logs "CancelMatchmaking attempted by non-leader. Request rejected." and sends nothing for a
 * non-leader. The response the client expects is not known; 200 with {} is the safe answer (the same shape as the register and
 * alive stubs). The other shapes (POST and PUT on /candidate/leave, DELETE /candidate, DELETE /candidate/:candidateId) are aliases
 * kept until the log shows which the client sends; a shape none of them matches is answered 404 and shows as a [REQ] line in app.ts.
 * Each call logs one [CandidateLeave] line with the method, path, body key names (never values) and the outcome.
 */
export async function CandidateLeaveHandler(req: any, res: any): Promise<void> {
    const UserId: string = req.AuthData.userId;
    const BodyKeys = LoggedBodyKeys(req.body);
    try {
        const Answer = await CancelMatchmakingForLeave(UserId);
        logger.info(`[CandidateLeave] user=${UserId} method=${req.method} path=${req.path} bodyKeys=[${BodyKeys}] `
            + `candidate=${Answer.candidateId ?? "none"} state=${Answer.state} -> ${Answer.outcome}`);
        res.status(200);
        res.json({});
    } catch (error) {
        logger.error(`[CandidateLeave] user=${UserId} method=${req.method} path=${req.path} bodyKeys=[${BodyKeys}] `
            + `candidate=none state=error -> error: ${error}`);
        res.status(500);
        res.json({});
    }
}

matchmakingRouter.delete("/candidate/leave", HasParadoxBackendAuth, CandidateLeaveHandler);
matchmakingRouter.post("/candidate/leave", HasParadoxBackendAuth, CandidateLeaveHandler);
matchmakingRouter.put("/candidate/leave", HasParadoxBackendAuth, CandidateLeaveHandler);
matchmakingRouter.delete("/candidate", HasParadoxBackendAuth, CandidateLeaveHandler);
matchmakingRouter.delete("/candidate/:candidateId", HasParadoxBackendAuth, CandidateLeaveHandler);

matchmakingRouter.get("/QoS", (req, res) => {
    logger.info(`QoS Ping`);

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})
