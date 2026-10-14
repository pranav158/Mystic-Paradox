/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { GetCandidateStatusPeriodMillis, LiveHubStatus, MatchmakingResult } from "./matchmaking";

// [2026-10-14 realms S2, design section 3.5] The body of GET /candidate/status, built from the candidate. The route keeps the
// authentication and the candidate lookup; everything the client reads is decided here so the realm branch can be tested. A
// candidate of a realm's hub (Source REALM_HUB) is not checked against the DeployServer's hub status (its address is the member's
// own loopback port), and a realm's Ramsgate answers as CITY with a null huntId, like the dedicated Ramsgate.

const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
// The 1.14.7 client builds its matchmaking ID as "%d_%s_shipping";
// this version is tied to the checked target executable (CL 647472).
const TARGET_GAME_VERSION = "1.14.7";
/** The retry hint of a realm cancelled for its host's capacity (the candidate's StatusReason is REALM_FULL). */
export const REALM_FULL_RETRY_AFTER_SECONDS = 30;

export interface CandidateStatusOptions {
    /** The request's address (`req.ip`). */
    clientIp: string | undefined;
    /** The DeployServer's live Ramsgate status (FetchLiveHubStatus); undefined when it cannot be reached. */
    fetchLiveHub: () => Promise<LiveHubStatus | undefined>;
}

/** The status answer: the HTTP status and the JSON body (no body for a missing candidate, which the route answers empty). */
export interface CandidateStatusAnswer {
    status: number;
    body?: Record<string, unknown>;
}

export async function CandidateStatusAnswerFor(
    UserId: string,
    MatchmakingResult: MatchmakingResult | undefined,
    options: CandidateStatusOptions
): Promise<CandidateStatusAnswer> {
    // [1.14.7 FIX 2026-10-04] The documented /candidate/status contract
    // (DauntlessEndpointDocumentation/Matchmaking/Candidate/GetStatus.md) states the Ramsgate state as:
    //     { "gameMode": "CITY", "huntId": null, ... }
    // and its huntId table says plainly: "| null | Ramsgate |" - Ramsgate is expressed as a NULL huntId.
    const IsRealmHubCandidate = MatchmakingResult?.Source === "REALM_HUB";
    const IsRamsgateDestination = MatchmakingResult != undefined
        && MatchmakingResult.HuntId === "ShatteredIsles_ReturnToRamsgate";
    // A realm's Training hub is asked for as SHARED with the Training hunt id (the same as the recovery destination).
    const IsRealmTraining = IsRealmHubCandidate && MatchmakingResult!.HuntId.includes("TrainingDojo");
    const ClientGameMode = IsRamsgateDestination ? "CITY" : IsRealmTraining ? "SHARED" : "ISLAND";
    const ClientHuntId = IsRamsgateDestination ? null : MatchmakingResult?.HuntId;

    if (MatchmakingResult == undefined) {
        logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);
        return { status: 404 };
    }
    if (MatchmakingResult.Canceled) {
        logger.info(`Canceling matchmaking for user ${UserId}: ${MatchmakingResult.StatusReason ?? "HOST_ROUTE_FAILED"}`);
        const RetryHint = MatchmakingResult.StatusReason === "REALM_FULL" ? { retryAfterSeconds: REALM_FULL_RETRY_AFTER_SECONDS } : {};
        return {
            status: 200,
            body: {
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: ClientGameMode,
                huntId: null,
                playerStates: {
                    [UserId]: {}
                },
                status: "CANCELED",
                statusDuration: 0.0,
                statusReason: MatchmakingResult.StatusReason ?? "HOST_ROUTE_FAILED",
                ...RetryHint
            }
        };
    }
    if (!MatchmakingResult.Ready) {
        logger.info(`MM not ready yet!`);
        return {
            status: 200,
            body: {
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: ClientGameMode,
                // A realm's Ramsgate is huntId null while it is pending too, as it is once it runs.
                huntId: IsRealmHubCandidate ? ClientHuntId : MatchmakingResult.HuntId,
                playerStates: {
                    [UserId]: {}
                },
                status: "MATCHING",
                statusDuration: 0.0,
                statusReason: null
            }
        };
    }

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
    const ClientAddress = typeof options.clientIp === "string" ? options.clientIp.replace(/^::ffff:/, "") : "";
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
    // [2026-10-14 realms S2] A realm hub candidate is the member's own loopback port (its launcher's join), not the hub's
    // address, so it is not checked against the DeployServer's hub status.
    let LivePort = MatchmakingResult.Port;
    if (IsRamsgateDestination && !IsRealmHubCandidate) {
        const Live = await options.fetchLiveHub();
        const LiveRamsgate = Live?.ramsgate;
        if (LiveRamsgate == undefined || !LiveRamsgate.ready) {
            logger.warn(`Ramsgate candidate for ${UserId} is stale (hub not verified as serving) - holding the client in MATCHING`);
            return {
                status: 200,
                body: {
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
                }
            };
        }
        if (LiveRamsgate.port !== MatchmakingResult.Port) {
            logger.warn(`Ramsgate port changed (${MatchmakingResult.Port} -> ${LiveRamsgate.port}); serving the live port`);
        }
        LivePort = LiveRamsgate.port;
    }

    logger.info(`Telling user ${UserId} to travel to ${TravelHost}:${LivePort} candidateId=${MatchmakingResult.CandidateId} local=${IsLocalClient ? 1 : 0} verified=${IsRealmHubCandidate ? "realm" : 1}`);

    return {
        status: 200,
        body: {
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
        }
    };
}
