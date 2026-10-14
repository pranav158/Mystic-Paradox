/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../../logger";
import { GetP2PRepositories, P2PHuntParticipantRecord, WithP2PTransaction } from "../persistence";
import { CANCELLABLE_FORMING_STATES, CancelFormingHunt } from "./p2pHostLifecycle";

// [2026-10-14] A party member who leaves the party (DELETE /party/member, or a kick) while his player-hosted or realm hunt is still
// forming must not be waited for. He is taken off the roster and his admission tickets are revoked. The expected players the host
// will use are re-resolved while the host has not been given them yet (HOST_SELECTING, HOST_OFFERED): the host receives them when it
// accepts its offer. From then on the host holds the list it was given; only the log says so (there is no control message that
// changes a roster). A hunt before RUNNING only; an admitted member is a normal disconnect; a host keeps its hunt.

export type PartyLeaveOutcome = "NO_HUNT" | "NOT_FORMING" | "HOST" | "ADMITTED" | "REMOVED" | "CANCELLED" | "MOVED_ON";

export interface PartyLeaveDependencies {
    /** Re-resolves the launch manifest for the players that are left (the resolver the hunt was created with). */
    resolveManifest(huntId: string, expectedPlayers: string[]): Promise<{ expectedPlayerString: string } | undefined>;
}

/** States in which the host has not yet been handed its expected players (the offer's acceptance hands them over). */
const EXPECTED_PLAYERS_OPEN_STATES = ["HOST_SELECTING", "HOST_OFFERED"];

function IsAdmitted(entry: P2PHuntParticipantRecord): boolean {
    return entry.admissionState === "ADMITTED" || entry.localBridgePort != undefined || entry.localBridgeReadyAt != undefined;
}

/**
 * Removes a member who left the party from his forming hunt, if the hunt is before RUNNING and he was not admitted. Returns what it did.
 * `now` is the transition's time. Errors from the store propagate; the caller logs them and the leave still succeeds.
 */
export async function RemoveLeaverFromFormingHunt(accountId: string, dependencies: PartyLeaveDependencies,
    now = new Date().toISOString()): Promise<PartyLeaveOutcome> {
    const repos = GetP2PRepositories();
    const hunt = await repos.p2pHunts.findActiveHuntForAccount(accountId);
    const leaver = hunt?.roster.find((entry) => entry.accountId === accountId);
    if (hunt == undefined || leaver == undefined) return "NO_HUNT";
    if (!CANCELLABLE_FORMING_STATES.includes(hunt.state)) {
        logger.info(`[PartyLeave] ${accountId} left the party during hunt ${hunt.sessionId} (state=${hunt.state}); the hunt is not changed (before RUNNING only)`);
        return "NOT_FORMING";
    }
    if (hunt.hostAccountId === accountId) {
        logger.warn(`[PartyLeave] ${accountId} left the party but hosts forming hunt ${hunt.sessionId} (state=${hunt.state}); the host keeps the hunt`);
        return "HOST";
    }
    if (IsAdmitted(leaver)) {
        logger.info(`[PartyLeave] ${accountId} left the party after being admitted to forming hunt ${hunt.sessionId}; normal disconnect handling`);
        return "ADMITTED";
    }
    const Remaining = hunt.roster.filter((entry) => entry.accountId !== accountId);
    if (Remaining.length === 0) {
        const Outcome = await CancelFormingHunt(hunt.sessionId, hunt.generation, accountId);
        logger.info(`[PartyLeave] removed ${accountId} from forming hunt ${hunt.sessionId}: no other player was left, so the hunt ended (${Outcome})`);
        return "CANCELLED";
    }

    let expectedPlayerString = hunt.expectedPlayerString;
    if (EXPECTED_PLAYERS_OPEN_STATES.includes(hunt.state)) {
        const Resolved = await dependencies.resolveManifest(hunt.huntDefinitionId, Remaining.map((entry) => entry.accountId))
            .catch((error: unknown) => {
                logger.warn(`[PartyLeave] manifest re-resolve failed for hunt ${hunt.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            });
        if (Resolved != undefined) expectedPlayerString = Resolved.expectedPlayerString;
        else logger.warn(`[PartyLeave] hunt ${hunt.sessionId} keeps expected players that still list ${accountId}`);
    } else {
        logger.warn(`[PartyLeave] host ${hunt.hostAccountId} of hunt ${hunt.sessionId} was given its expected players with the offer and still expects ${accountId}`);
    }

    const Written = await WithP2PTransaction(async (txRepos, mongoSession) => {
        const current = await txRepos.p2pHunts.findHunt(hunt.sessionId, mongoSession);
        const currentLeaver = current?.roster.find((entry) => entry.accountId === accountId);
        if (current == undefined || current.generation !== hunt.generation || currentLeaver == undefined || IsAdmitted(currentLeaver) ||
            !CANCELLABLE_FORMING_STATES.includes(current.state)) {
            return undefined;
        }
        const Next = await txRepos.p2pHunts.compareAndSetHunt({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            expectedStates: [current.state],
            expectedStateVersion: current.stateVersion,
            set: { roster: current.roster.filter((entry) => entry.accountId !== accountId), expectedPlayerString }
        }, mongoSession);
        if (Next == undefined) return undefined;
        await txRepos.p2pHunts.revokeAdmissionTicketsForAccount(hunt.sessionId, accountId, mongoSession);
        await txRepos.p2pHunts.appendHuntTransition({
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            fromState: current.state,
            toState: current.state,
            stateVersion: Next.stateVersion,
            reason: "PARTY_MEMBER_LEFT",
            actorType: "PARTICIPANT",
            actorAccountId: accountId,
            at: now
        }, mongoSession);
        return Next;
    });
    if (Written == undefined) {
        logger.info(`[PartyLeave] ${accountId} left the party; hunt ${hunt.sessionId} moved on before the removal, so it is not changed`);
        return "MOVED_ON";
    }
    logger.info(`[PartyLeave] removed ${accountId} from forming hunt ${hunt.sessionId} (state=${hunt.state}, ${Remaining.length} player(s) left)`);
    return "REMOVED";
}
