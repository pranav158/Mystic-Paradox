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
import type { MatchmakingResult } from "../controllers/matchmaking";
import type { MetagameServiceRole } from "../config/serviceRole";
import { logger } from "../logger";

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

export interface HuntRouteContext {
    gameMode: string;
    huntId: string;
    playerId: string;
    partyId?: string;
    partyMembers?: string[];
    partyRevision?: number;
    /** Ramsgate, the city and the Training Dojo: persistent shared servers. */
    isHub: boolean;
    /** Publishes the travel candidate of one account. */
    setCandidate(accountId: string, result: MatchmakingResult): void;
    /** Ends the pending travel of these accounts with a reason code. */
    cancel(huntId: string, accountIds: readonly string[], reason: string): boolean;
}

/** `handled: false` continues with the dedicated DeployServer route. */
export type HuntRouteOutcome = { handled: false } | { handled: true; result: boolean };

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
         * handled the request (responded, or set req.AuthData and called next).
         */
        authenticate(req: Request, res: Response, next: NextFunction): Promise<boolean>;
    };
    inventory: {
        /**
         * Authorizes POST /inventory for a request this module authenticated (AuthData.IsPlayerHostRuntime).
         * Returns the transaction options, or the response that rejects it.
         */
        authorizeTransaction(req: Request, context: InventoryTransactionContext):
            Promise<ExtensionInventoryTransaction | ExtensionHttpResponse>;
    };
    matchmaking: {
        /** True when non-hub hunts must not start on DeployServer. */
        dedicatedHuntsDisabled(): boolean;
        /** Candidate of an account the in-memory map does not know (for example after a restart). */
        restoreCandidate(playerId: string): Promise<MatchmakingResult | undefined>;
        /** Status of a candidate the module owns; undefined for a dedicated candidate. */
        candidateStatus(playerId: string, current: MatchmakingResult): Promise<MatchmakingResult | undefined>;
        /** Shared candidate of a party whose hunt the module owns. */
        partyInstance(partyId: string): Promise<MatchmakingResult | undefined>;
        routeHunt(context: HuntRouteContext): Promise<HuntRouteOutcome>;
    };
    launcher: {
        /** Extra fields of GET /launcher/v1/policy. */
        policyFields(): Record<string, unknown>;
        /** Runtime files a launcher with this module installs and reports, all or none. */
        runtimeArtifacts: readonly string[];
        /** Extra Guard manifest artifact roles. */
        guardManifestRoles: readonly string[];
        /** Extra runtime files the update publisher accepts (lower case). */
        updateExtraFiles: readonly string[];
    };
    operations: {
        /** False when the module's fields of the operations policy document are malformed. */
        policyFieldsValid(record: unknown): boolean;
        overview(): Promise<OperationsOverviewExtension>;
    };
}

const DEDICATED_ONLY: P2PExtension = {
    loaded: false,
    server: {
        serviceRoles: [],
        runtimeSafetyIssues: () => [],
        startupSummary: () => undefined,
        ensureDatabase: async () => undefined,
        start: () => undefined,
        stop: async () => undefined
    },
    http: {
        mountEarlyRoutes: () => undefined,
        mountRoutes: () => undefined,
        mountErrorHandlers: () => undefined,
        metricClass: () => undefined,
        requestLogTags: () => "",
        authenticate: async () => false
    },
    inventory: {
        authorizeTransaction: async () => ({ status: 403,
            body: { code: "forbidden", message: "This runtime cannot mutate inventory.", payload: null } })
    },
    matchmaking: {
        dedicatedHuntsDisabled: () => false,
        restoreCandidate: async () => undefined,
        candidateStatus: async () => undefined,
        partyInstance: async () => undefined,
        routeHunt: async () => ({ handled: false })
    },
    launcher: {
        policyFields: () => ({}),
        runtimeArtifacts: [],
        guardManifestRoles: [],
        updateExtraFiles: []
    },
    operations: {
        policyFieldsValid: () => true,
        overview: async () => ({ policy: {}, sections: {} })
    }
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
