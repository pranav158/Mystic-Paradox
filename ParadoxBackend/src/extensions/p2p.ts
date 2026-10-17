/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Hook points for the optional player-hosted (P2P) hunt module.
//
// The server is complete without it: every hook below has a dedicated-only default (hunts route to
// DeployServer, no host-runtime credential, no extra routes, loops, indexes or policy fields). When a
// `p2p` folder is present next to this one, GetP2PExtension() loads it once and uses its hooks
// instead. MYSTICPARADOX_P2P_MODULE=off keeps the dedicated-only defaults even when the folder exists.
//
// Shared code never imports the module directly; it calls these hooks only.

import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import type { Db } from "mongodb";
import type { InventoryTransactionOptions } from "../controllers/inventory";
import type { AccountDeletionStep } from "../persistence/mongo/accountDeletionPlan";
import type { MatchmakingResult } from "../controllers/matchmaking";
import type { MetagameServiceRole } from "../config/serviceRole";
import { logger } from "../logger";
import type { ReleaseGate } from "../observability/releaseGates";

export interface ExtensionHttpResponse {
    status: number;
    body: unknown;
}

export interface InventoryTransactionContext {
    userId: string;
    characterId: string;
    transactionId: string;
}

/** An inventory transaction the module authorized for a request it authenticated. */
export interface ExtensionInventoryTransaction {
    /** Passed to RunInventoryTransaction (normally an onGrant fence). */
    options: InventoryTransactionOptions;
    /** Maps an error thrown by options.onGrant to a response; undefined uses the normal mapping. */
    errorResponse?(error: unknown): ExtensionHttpResponse | undefined;
    report?(phase: "applying" | "accepted" | "failed"): void;
}

/**
 * What a hosting runtime writes for a player, besides inventory (hostWrites hooks).
 * [2026-10-14 realms S4] REFORGE: the weapon reforge reset and its banked restore (DELETE /progression/:u/:track,
 * POST /progression/purchase/...). Only a realm's Ramsgate hub may make it; a hunt, a Training hub and the dedicated-only
 * build refuse it. The same kind also carries a weapon's prestige +1 (POST /progression/:u/PrestigeTrack_Weapon_X/1) in a
 * Ramsgate hub, where XP is refused; a hunt takes that +1 as XP as before.
 * [2026-10-14 realms S4] RANK_CONFIRM: a public rank confirm (POST /progression/:u/:track/:rank/confirm/public). Hunts: an
 * admitted roster member; the realm's Ramsgate: a present member; a Training hub refuses it.
 * [2026-10-15] LOADOUT_UNLOCK: a loadout slot unlock (POST /loadout/:u/:character/unlock/:n). The slot count is still derived from
 * the player's persisted Slayer's Path, so a host can only reach what the player has unlocked. The same membership rule as
 * RANK_CONFIRM: a hunt's admitted member; a realm's Ramsgate hub's present member; a Training hub refuses it.
 * [2026-10-16] HUNT_PASS_XP: XP on the active Hunt Pass track (ACTIVE_HUNTPASS_PROGRESSION_ID) from a realm hub, which takes
 * no other XP. The game awards Hunt Pass XP in town; the XP
 * route authorizes such a grant as this kind when XP is refused, and the per-track ceiling (CheckHostXpGrant) still applies.
 * [2026-10-16] A realm's Training hub writes what its Ramsgate writes, except the reforge (hubAuthorization.ts).
 */
export type HostWriteKind =
    | "XP" | "MASTERY" | "OBJECTIVES" | "ESCALATION" | "COOLDOWN" | "BOUNTY" | "SLAYERS_PATH" | "REFORGE" | "RANK_CONFIRM"
    | "LOADOUT_UNLOCK" | "HUNT_PASS_XP" | "ITEM_SAVE";
// [2026-10-16] ITEM_SAVE: POST /inventory/instanceditem, one owned item's itemData (the cells slotted into gear from the armoury), as a
// dedicated server saves it. Every hub and hunt takes it (hubAuthorization.ts).

/** [2026-10-16] Options of hostWrites.authorize. */
export interface HostWriteAuthorizeOptions {
    /** A quiet check of one kind among several (see hostWrites.authorize): no log, and the write kind is always enforced. */
    probe?: boolean;
    /**
     * [2026-10-17] Dedicated parity: a dedicated server's own work for a
     * player of its session, such as finishing an interrupted reforge at the player's load or the Slayer's Path reward catch-up at
     * login. Only who may write is checked (the session runs and the player is in it), never the write kind, and quietly. Allowed only
     * in the host policy's observe mode (the default); enforce keeps these paths for dedicated servers.
     */
    parity?: boolean;
}

/** One accepted host write, as tagged for monitoring and reversal. `summary` holds what changed (no secrets). */
export interface HostWriteRecordInput {
    kind: HostWriteKind;
    targetUserId: string;
    summary: Record<string, unknown>;
}

export interface HuntRouteContext {
    gameMode: string;
    huntId: string;
    playerId: string;
    partyId?: string;
    partyMembers?: string[];
    partyRevision?: number;
    /** [2026-10-14] The client's build id from the join body; a solo party created for the request carries it, as POST /party does. */
    buildId?: string;
    /** Ramsgate, the city and the Training Dojo: persistent shared servers. */
    isHub: boolean;
    /** Publishes the travel candidate of one account. */
    setCandidate(accountId: string, result: MatchmakingResult): void;
    /** Ends the pending travel of these accounts with a reason code. */
    cancel(huntId: string, accountIds: readonly string[], reason: string): boolean;
}

/** `handled: false` continues with the dedicated DeployServer route. */
export type HuntRouteOutcome = { handled: false } | { handled: true; result: boolean };

/**
 * [2026-10-14 cancel] What the client's Cancel (DELETE /candidate/leave) did to a search the module owns.
 * canceled: the forming hunt was ended for its player (the party members in it get PARTY_MEMBER_CANCELED).
 * already-canceled / already-ended: nothing is left to cancel (a second press). too-late: the hunt is running, or a member
 * was already told to travel, so it is left alone. hub-not-cancelled: a realm hub entry is never cancelled.
 */
export type CandidateLeaveOutcome = "canceled" | "already-canceled" | "already-ended" | "too-late" | "hub-not-cancelled";
/** `handled: false` leaves the search to the shared (dedicated) cancel. */
export type CandidateLeaveResult = { handled: false } | { handled: true; outcome: CandidateLeaveOutcome; state: string };

export interface OperationsOverviewExtension {
    /** Merged into the overview's `policy` object. */
    policy: Record<string, unknown>;
    /** Merged into the overview response. */
    sections: Record<string, unknown>;
}

export interface P2PExtension {
    readonly loaded: boolean;
    server: {
        /** Extra MYSTICPARADOX_SERVICE_ROLE values that have their own entry point. */
        serviceRoles: readonly string[];
        /**
         * Runs before persistence starts. Throws for a rule that applies in every environment and
         * returns the settings that make a production configuration unsafe.
         */
        runtimeSafetyIssues(environment: NodeJS.ProcessEnv): string[];
        /** Logged once at startup. */
        startupSummary(role: MetagameServiceRole): Record<string, unknown> | undefined;
        /** Collections, indexes and data the module needs. Runs before the schema marker is written. */
        ensureDatabase(db: Db): Promise<void>;
        /** [2026-10-14] The module's steps of the account deletion plan (persistence/mongo/accountDeletionPlan.ts). */
        accountDeletionSteps(): AccountDeletionStep[];
        start(role: MetagameServiceRole): void;
        stop(): Promise<void>;
    };
    http: {
        /** Routes that need their own body parser; mounted before the shared JSON parser. */
        mountEarlyRoutes(app: Express): void;
        mountRoutes(app: Express): void;
        mountErrorHandlers(app: Express): void;
        /** Metric class of a request path, or undefined for the shared classes. */
        metricClass(requestPath: string): string | undefined;
        /** Extra ` key=value` tags for the request log line. */
        requestLogTags(req: Request): string;
        /**
         * Authenticates a request that carries the module's own credential. Returns true when it
         * handled the request (responded, or set req.AuthData and called next). A runtime it authenticates
         * (AuthData.IsPlayerHostRuntime) carries the accounts it may act for in AuthData.RuntimeRosterAccountIds
         * (security/runtimeRoster.ts).
         */
        authenticate(req: Request, res: Response, next: NextFunction): Promise<boolean>;
        /**
         * Request-budget bucket of a request carrying the module's own credential (security/rateLimit.ts), or
         * undefined to keep the per-address bucket. Only a credential the module validated may get a bucket.
         */
        rateLimitBucket(req: Request): Promise<string | undefined>;
    };
    inventory: {
        /**
         * Authorizes POST /inventory for a request this module authenticated (AuthData.IsPlayerHostRuntime).
         * Returns the transaction options, or the response that rejects it.
         */
        authorizeTransaction(req: Request, context: InventoryTransactionContext):
            Promise<ExtensionInventoryTransaction | ExtensionHttpResponse>;
    };
    /**
     * [2026-10-13 realms S3] Writes a module-authenticated runtime (AuthData.IsPlayerHostRuntime) makes for the players it
     * hosts, beyond inventory: in a Paradox-account realm a host does what a dedicated server does, granted instantly and
     * tagged for monitoring and reversal (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md §4).
     */
    hostWrites: {
        /**
         * Undefined when the write may proceed; otherwise the response that refuses it. [2026-10-16] `probe`: a route trying several
         * kinds for one write (the XP route: XP, then REFORGE, then HUNT_PASS_XP) asks quietly first; a probe never logs and always
         * refuses a kind the session does not take, whatever the host policy mode. The route's last, plain call decides and logs.
         */
        authorize(req: Request, kind: HostWriteKind, targetUserId: string, options?: HostWriteAuthorizeOptions): Promise<ExtensionHttpResponse | undefined>;
        /** Tags an accepted write (who hosted, which session, what changed). Never throws. */
        record(req: Request, write: HostWriteRecordInput): Promise<void>;
    };
    /**
     * [2026-10-17] The host policy (MYSTICPARADOX_HOST_POLICY, the module's security/hostPolicyMode.ts) for limits the core applies to
     * a host's writes, such as the per-grant XP ceilings and the full player-level track (controllers/progression.ts): `refuses` is
     * true only in enforce mode; in observe mode the core logs the would-be refusal through `noteWouldRefuse` and lets it through.
     */
    hostPolicy: {
        refuses(): boolean;
        noteWouldRefuse(what: string, detail: string): void;
    };
    matchmaking: {
        /** True when non-hub hunts must not start on DeployServer. */
        dedicatedHuntsDisabled(): boolean;
        /**
         * True when a request of this mode and hunt takes only the party members with a live session, as ISLAND
         * requests always do (matchmakingParty.ts). False keeps the authoritative party.
         */
        filtersOfflinePartyMembers(gameMode: string, huntId: string | undefined): boolean;
        /** Candidate of an account the in-memory map does not know (for example after a restart). */
        restoreCandidate(playerId: string): Promise<MatchmakingResult | undefined>;
        /** Status of a candidate the module owns; undefined for a dedicated candidate. */
        candidateStatus(playerId: string, current: MatchmakingResult): Promise<MatchmakingResult | undefined>;
        /** Shared candidate of a party whose hunt the module owns. */
        partyInstance(partyId: string): Promise<MatchmakingResult | undefined>;
        routeHunt(context: HuntRouteContext): Promise<HuntRouteOutcome>;
        /** [2026-10-14 cancel] The client's Cancel of a search the module owns (a player-hosted or realm hunt, or a realm hub entry). */
        cancelCandidate(playerId: string, current: MatchmakingResult): Promise<CandidateLeaveResult>;
        /** [2026-10-14] A member left the party or was kicked (DELETE /party/member): a forming hunt of his stops waiting for him. */
        partyMemberLeft(accountId: string): Promise<void>;
    };
    launcher: {
        /** Extra fields of GET /launcher/v1/policy. */
        policyFields(): Record<string, unknown>;
        /** Extra Guard manifest artifact roles. */
        guardManifestRoles: readonly string[];
    };
    operations: {
        /** False when the module's fields of the operations policy document are malformed. */
        policyFieldsValid(record: unknown): boolean;
        overview(): Promise<OperationsOverviewExtension>;
    };
    /**
     * [2026-10-14] The module's gates for the manager preflight (GET /health/release-gates, observability/releaseGates.ts): the P2P env
     * policy, the durable emergency stop and the Tier 1 grants. Optional; absent contributes none (the dedicated-only build).
     */
    releaseGates?(): Promise<ReleaseGate[]>;
}

const DEDICATED_ONLY: P2PExtension = {
    loaded: false,
    server: {
        serviceRoles: [],
        runtimeSafetyIssues: () => [],
        startupSummary: () => undefined,
        ensureDatabase: async () => undefined,
        accountDeletionSteps: () => [],
        start: () => undefined,
        stop: async () => undefined
    },
    http: {
        mountEarlyRoutes: () => undefined,
        mountRoutes: () => undefined,
        mountErrorHandlers: () => undefined,
        metricClass: () => undefined,
        requestLogTags: () => "",
        authenticate: async () => false,
        rateLimitBucket: async () => undefined
    },
    inventory: {
        authorizeTransaction: async () => ({ status: 403,
            body: { code: "forbidden", message: "This runtime cannot mutate inventory.", payload: null } })
    },
    hostWrites: {
        authorize: async () => ({ status: 403,
            body: { code: "forbidden", message: "This runtime cannot write player state.", payload: null } }),
        record: async () => undefined
    },
    // Without the module no host writes exist; strict answers keep it that way.
    hostPolicy: {
        refuses: () => true,
        noteWouldRefuse: () => undefined
    },
    matchmaking: {
        dedicatedHuntsDisabled: () => false,
        filtersOfflinePartyMembers: () => false,
        restoreCandidate: async () => undefined,
        candidateStatus: async () => undefined,
        partyInstance: async () => undefined,
        routeHunt: async () => ({ handled: false }),
        cancelCandidate: async () => ({ handled: false }),
        partyMemberLeft: async () => undefined
    },
    launcher: {
        policyFields: () => ({}),
        guardManifestRoles: []
    },
    operations: {
        policyFieldsValid: () => true,
        overview: async () => ({ policy: {}, sections: {} })
    },
    releaseGates: async () => []
};

let Extension: P2PExtension | undefined;

function LoadP2PExtension(): P2PExtension {
    if (/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_P2P_MODULE?.trim() ?? "")) {
        logger.info("[P2P] module disabled by MYSTICPARADOX_P2P_MODULE; dedicated hunts only");
        return DEDICATED_ONLY;
    }
    const modulePath = path.join(__dirname, "..", "p2p");
    if (!fs.existsSync(modulePath)) return DEDICATED_ONLY;
    const module = require(modulePath) as { CreateP2PExtension?: () => P2PExtension };
    if (typeof module.CreateP2PExtension !== "function") {
        throw new Error(`${modulePath} does not export CreateP2PExtension().`);
    }
    logger.info("[P2P] player-hosted hunt module loaded");
    return module.CreateP2PExtension();
}

export function GetP2PExtension(): P2PExtension {
    Extension ??= LoadP2PExtension();
    return Extension;
}
