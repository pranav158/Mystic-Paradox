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
import crypto from "node:crypto";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { logger } from "../logger";
import { CheckAndUpdateQueueStatus, FetchLiveHubStatus, GetCandidateStatusPeriodMillis, HandlePlayerMatchmaking } from "../controllers/matchmaking";
import { GetPartyForPlayer } from "../controllers/party";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { ResolveMatchmakingParty } from "../matchmakingParty";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
// The 1.14.7 client builds its matchmaking ID as "%d_%s_shipping";
// this version is tied to the checked target executable (CL 647472).
const TARGET_GAME_VERSION = "1.14.7";

matchmakingRouter.post("/candidate/player/register", HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);

    res.status(200);
    res.json({});
});

// [1.12 heartbeat stub — 2026-07-10]
// Client fires this every ~5s while in matchmaking / in a game. Was logging as
// Unstubbed with WARN per request. No state needed — just acknowledge.
matchmakingRouter.post("/candidate/player/alive", HasParadoxBackendAuth, (_req: any, res) => {
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
const PendingEncryptionKeys = new Map<string, { key: string; nonce: string; token: string; at: number }>();
const kPendingKeyTtlMs = 30 * 60 * 1000;
let MostRecentEncryptionKey: { candidateId: string; key: string; nonce: string; token: string; at: number } | null = null;

matchmakingRouter.post("/key/generate", HasParadoxBackendAuth, async (req: any, res) => {
    const Key = crypto.randomBytes(32).toString("hex");
    const Nonce = crypto.randomBytes(32).toString("base64url");
    const AuthHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const Token = AuthHeader.startsWith("bearer ") ? AuthHeader.slice("bearer ".length) : AuthHeader;
    const CandidateId = String(req.body && req.body.candidateId ? req.body.candidateId : "");

    const IssuedAt = Date.now();
    if (CandidateId.length > 0) {
        PendingEncryptionKeys.set(CandidateId, { key: Key, nonce: Nonce, token: Token, at: IssuedAt });
    }
    MostRecentEncryptionKey = { candidateId: CandidateId, key: Key, nonce: Nonce, token: Token, at: IssuedAt };

    logger.info("key/generate served (256-bit key + nonce; candidateId="
        + (CandidateId || "none") + ")");

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

    logger.info("key/consume request: candidateId=" + (CandidateId || "none")
        + " bodyKeys=" + Object.keys(Body).join(","));

    const Now = Date.now();
    for (const [IssuedId, Issued] of PendingEncryptionKeys) {
        if (Now - Issued.at > kPendingKeyTtlMs) {
            PendingEncryptionKeys.delete(IssuedId);
        }
    }

    let Match: { key: string; nonce: string; token: string } | null = null;
    if (CandidateId.length > 0 && PendingEncryptionKeys.has(CandidateId)) {
        const Issued = PendingEncryptionKeys.get(CandidateId)!;
        Match = { key: Issued.key, nonce: Issued.nonce, token: Issued.token };
    }
    else if (MostRecentEncryptionKey && Now - MostRecentEncryptionKey.at <= kPendingKeyTtlMs) {
        Match = {
            key: MostRecentEncryptionKey.key,
            nonce: MostRecentEncryptionKey.nonce,
            token: MostRecentEncryptionKey.token
        };
    }

    if (Match === null) {
        logger.warn("key/consume: no issued key is available yet (hub asked before any /key/generate)");
        res.status(404);
        res.json({ error: "no issued key" });
        return;
    }

    logger.info("key/consume served the issued key (candidateId=" + (CandidateId || "most-recent") + ")");
    res.status(200);
    res.json({
        key: Match.key,
        nonce: Match.nonce,
        token: Match.token
    });
});

matchmakingRouter.get("/candidate/status", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const MatchmakingResult = await CheckAndUpdateQueueStatus(UserId);

    // [1.14.7 FIX 2026-10-04] The documented /candidate/status contract
    // (DauntlessEndpointDocumentation/Matchmaking/Candidate/GetStatus.md) states the Ramsgate state as:
    //     { "gameMode": "CITY", "huntId": null, ... }
    // and its huntId table says plainly: "| null | Ramsgate |" - Ramsgate is expressed as a NULL huntId.
    // This route hardcoded gameMode "ISLAND" and echoed the internal hunt id
    // "ShatteredIsles_ReturnToRamsgate", so a client that asked for CITY (verified: /candidate/join with
    // gameMode CITY) was answered ISLAND plus a hunt id and took the wrong travel branch - it created a
    // pending net driver and timed out after 20s without ever dialling the hub (its own UE log never
    // mentions the address it was handed, and PHOENIX reports "Can't destroy a null online session").
    const IsRamsgateDestination = MatchmakingResult != undefined
        && MatchmakingResult.HuntId === "ShatteredIsles_ReturnToRamsgate";
    const ClientGameMode = IsRamsgateDestination ? "CITY" : "ISLAND";
    const ClientHuntId = IsRamsgateDestination ? null : MatchmakingResult?.HuntId;

    if(MatchmakingResult != undefined){
        if(MatchmakingResult.Canceled){
            logger.info(`Canceling matchmaking for user ${UserId}: ${MatchmakingResult.StatusReason ?? "HOST_ROUTE_FAILED"}`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: ClientGameMode,
                huntId: null,
                playerStates: {
                    [UserId]: {}
                },
                status: "CANCELED",
                statusDuration: 0.0,
                statusReason: MatchmakingResult.StatusReason ?? "HOST_ROUTE_FAILED"
            });
        }
        else if(MatchmakingResult.Ready){
            // [1.14.7 FIX 2026-10-04] The hub advertises this machine's PUBLIC address (the DeployServer logs
            // "ramsgate ready on <public-ip>:8790"). A client running on that same machine must then reach
            // its own public address, which needs NAT hairpin for the game's UDP port - and that is the
            // measured failure:
            //   [EnqueueDisconnectError] reason='The server network connection timed out. Please check your
            //                            network connection and try again later.'
            //   both hubs stayed at PostLogin=0
            // while matchmaking itself succeeded (valid session, hub bound and healthy on UDP 8790).
            //
            // The client's own HTTPS requests DO reach the public domain, so its source address equals the
            // advertised host exactly when it is behind the same public address - i.e. local. Answer loopback
            // in that case so it reaches the local hub directly; remote players keep the public host.
            const AdvertisedHost = MatchmakingResult.Host;
            const ClientAddress = typeof req.ip === "string" ? req.ip.replace(/^::ffff:/, "") : "";
            const IsLocalClient = ClientAddress.length > 0 && AdvertisedHost.length > 0
                && (ClientAddress === AdvertisedHost || ClientAddress === "127.0.0.1" || ClientAddress === "::1");
            const TravelHost = IsLocalClient ? "127.0.0.1" : AdvertisedHost;

            // [1.14.7 REVALIDATION 2026-10-04] Before answering with a hub address, confirm the hub is STILL
            // serving. A cached candidate is not proof: measured, Ramsgate left its map for AFK while the
            // cached entry stayed "ready", the client was told to travel to 127.0.0.1:8790, and the
            // replacement only reported "Networking::Listen returned OK" 17 seconds after the client had
            // already timed out. The root fix (bNoAFK) stops the hub leaving at all; this is the fence that
            // keeps a client from being sent to a dead port if it ever does.
            //
            // When the hub cannot be verified, answer with the SAME "still matching" shape the client already
            // polls on so it waits instead of travelling - the existing unavailable/waiting behaviour.
            let LivePort = MatchmakingResult.Port;
            if (IsRamsgateDestination) {
                const Live = await FetchLiveHubStatus();
                const LiveRamsgate = Live?.ramsgate;
                if (LiveRamsgate == undefined || !LiveRamsgate.ready) {
                    logger.warn(`Ramsgate candidate for ${UserId} is stale (hub not verified as serving) - holding the client in MATCHING`);
                    res.status(200);
                    res.json({
                        candidateId: MatchmakingResult.CandidateId,
                        candidateStatusPeriodMillis: 1000,
                        gameMode: "CITY",
                        huntId: null,
                        playerStates: {
                            [UserId]: {}
                        },
                        status: "MATCHING",
                        statusDuration: 0.0,
                        statusReason: null
                    });
                    return;
                }
                if (LiveRamsgate.port !== MatchmakingResult.Port) {
                    logger.warn(`Ramsgate port changed (${MatchmakingResult.Port} -> ${LiveRamsgate.port}); serving the live port`);
                }
                LivePort = LiveRamsgate.port;
            }

            logger.info(`Telling user ${UserId} to travel to ${TravelHost}:${LivePort} candidateId=${MatchmakingResult.CandidateId} local=${IsLocalClient ? 1 : 0} verified=1`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: ClientGameMode,
                huntId: ClientHuntId,
                playerStates: {
                    [UserId]: {}
                },
                serverInfo: {
                    buildId: `${TARGET_CHANGELIST}_${TARGET_GAME_VERSION}_shipping`,
                    gameSessionId: MatchmakingResult.GameSessionId,
                    host: TravelHost,
                    port: LivePort
                },
                status: "IN_PROGRESS",
                statusDuration: 0.0,
                statusReason: null
            });
        }
        else{
            logger.info(`MM not ready yet!`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: ClientGameMode,
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                    [UserId]: {}
                },
                status : "MATCHING",
                statusDuration : 0.0,
                statusReason : null
            })
        }
    }
    else{
        logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);

        res.status(404);
        res.send();
    }
});

matchmakingRouter.post("/candidate/join", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
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

    logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId}`);

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
    const Party = ResolveMatchmakingParty(
        GameMode, UserId, RequestedPartyId, PartyForPlayer, (Member) => sessionRegistry.isOnline(Member));

    if(Party.partyIdMismatch && PartyForPlayer != undefined && PartyForPlayer.members.length > 1){
        logger.warn(
            `UserId ${UserId} requested solo/stale-party ISLAND travel; ` +
            `client partyId=${RequestedPartyId ?? "<missing>"} does not match ` +
            `authoritative partyId=${PartyForPlayer.partyId}. Launching for this player only.`
        );
    }
    else if(!Party.partyIdMismatch && Party.excludedMembers.length > 0){
        logger.warn(
            `UserId ${UserId} ISLAND party contains ${Party.excludedMembers.length} offline member(s); ` +
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
        Party.partyRevision
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
        gameMode: GameMode,
        huntId: MatchmakingEntry!.HuntId,
        status: "MATCHING",
        statusReason: null
    });
});

matchmakingRouter.get("/QoS", (req, res) => {
    logger.info(`QoS Ping`);

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})
