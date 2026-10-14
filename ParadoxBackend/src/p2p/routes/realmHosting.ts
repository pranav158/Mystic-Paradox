/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Request, RequestHandler, Response, Router } from "express";
import { logger } from "../../logger";
import { HasLauncherAuth } from "../../middleware/HasLauncherAuth";
import { RequireActiveAccount } from "../../middleware/RequireActiveAccount";
import { GetRequestId } from "../../observability/requestContext";
import { IncrementMetric } from "../../observability/metrics";
import { ListHubPeers } from "../controllers/realmHubAdmission";
import { GetRealmHostingStatus } from "../controllers/realmHostingStatus";
import { CreateRealmHubSession, StopRealmHubSession } from "../controllers/realmHubLifecycle";
import { LauncherApiError, SendDetailedLauncherError } from "../security/p2pErrors";

// [2026-10-13 realms S1] The realm host's launcher API (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 4):
//
//   POST /launcher/v1/realm-hosting/hubs/start   { hubKind, maxPlayers? }  -> { sessionId, generation, hubKind, state }
//   POST /launcher/v1/realm-hosting/hubs/stop    { hubKind }               -> { stopped, hubKind, sessionId?, state? }
//   POST /launcher/v1/p2p/hunts/:sessionId/peers { generation }            -> { generation, peers: [...] }
//
// Every route needs a launcher sign-in. The hub routes sit under /launcher/v1/realm-hosting (not /launcher/v1/realms, whose
// router ends in a catch-all NOT_FOUND). Failures are the launcher error envelope {error:{code,message,requestId}}, with
// `reason` next to them for REALM_HOST_INELIGIBLE.

export interface RealmHostingRouterDeps {
    /** Launcher authentication; tests substitute a stand-in. It must set req.LauncherAuthData.userId. */
    auth?: RequestHandler;
    /**
     * [2026-10-14] Account guards (middleware/RequireActiveAccount.ts). `hosting` refuses a hub start (a deactivated account, or one
     * without the current consent when MYSTICPARADOX_CONSENT_ENFORCE is on); `active` refuses a deactivated account's peer list.
     * Stopping a hub and reading the status stay open: a host can always end what runs on its PC. Tests substitute pass-throughs.
     */
    guards?: { hosting?: RequestHandler; active?: RequestHandler };
}

function AccountIdOf(req: Request): string {
    const userId = (req as any).LauncherAuthData?.userId;
    if (typeof userId !== "string" || userId.length === 0) throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
    return userId;
}

async function Handle(res: Response, operation: string, action: () => Promise<unknown>): Promise<void> {
    IncrementMetric("mysticparadox_p2p_requests_total", 1, { operation });
    try {
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(await action());
    } catch (error) {
        if (error instanceof LauncherApiError) {
            IncrementMetric("mysticparadox_p2p_errors_total", 1, { code: error.code });
            SendDetailedLauncherError(res, error);
            return;
        }
        IncrementMetric("mysticparadox_p2p_errors_total", 1, { code: "INTERNAL" });
        logger.error(`Unhandled realm hosting error requestId=${GetRequestId() ?? "missing"}: ${error}`);
        SendDetailedLauncherError(res, new LauncherApiError("INTERNAL", "The realm hosting request failed."));
    }
}

export function CreateRealmHostingRouter(deps: RealmHostingRouterDeps = {}): Router {
    const router = Router();
    const auth = deps.auth ?? HasLauncherAuth;
    const hosting = deps.guards?.hosting ?? RequireActiveAccount({ consent: true });
    const active = deps.guards?.active ?? RequireActiveAccount({ consent: false });

    router.post("/launcher/v1/realm-hosting/hubs/start", auth, hosting, (req: Request, res: Response) =>
        Handle(res, "realm-hub-start", async () => CreateRealmHubSession(AccountIdOf(req), req.body))
    );

    router.post("/launcher/v1/realm-hosting/hubs/stop", auth, (req: Request, res: Response) =>
        Handle(res, "realm-hub-stop", async () => StopRealmHubSession(AccountIdOf(req), req.body))
    );

    router.post("/launcher/v1/p2p/hunts/:sessionId/peers", auth, active, (req: Request, res: Response) =>
        Handle(res, "realm-hub-peers", async () => ListHubPeers(AccountIdOf(req), String(req.params.sessionId), req.body))
    );

    // [2026-10-14 realms S3] The host's panel: its hubs, realm hunts and the players in them (only the realm's host may read it).
    router.get("/launcher/v1/realm-hosting/status", auth, (req: Request, res: Response) =>
        Handle(res, "realm-hosting-status", async () => GetRealmHostingStatus(AccountIdOf(req)))
    );

    return router;
}

export const realmHostingRouter = CreateRealmHostingRouter();
