import { NextFunction, Request, Response } from "express";
import { JwtPayload } from "jsonwebtoken";
import { ValidateMetagameJWTAndGetPayload } from "../../controllers/auth";
import { logger } from "../../logger";
import { IsCurrentLauncherAccountEligible } from "../../middleware/HasParadoxBackendAuth";
import { GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import {
    BuildPlayerHostRuntimeAuthData,
    ParseOptionalHostRuntimeBearerToken,
    ResolveActiveHostRuntimeContext,
    ResolvePlayerHostRuntimeRequestIdentity
} from "./hostCapabilities";

// A player-hosted hunt may use its opaque, short-lived capability only to run the
// local game-server's normal per-player API calls.  It is deliberately represented
// as the selected host with ordinary player authority, never as IsGameserver.
//
// UE's server-side player-data loaders are inconsistent about forwarding the
// client's Authorization header. For the requests that carry an acting account in
// their route (or in the well-known inventory/character bodies), preserve that
// identity so the host process cannot accidentally read the host's data for P2.
// Do not inspect arbitrary body.accountId fields: several social lookup endpoints
// use that field as an object, not the caller identity.
//
// Returns false when the request carries no host capability (the shared middleware continues).
export async function AuthenticateHostRuntimeRequest(req: Request, res: Response, next: NextFunction): Promise<boolean> {
    const HostRuntimeCapability = req.headers["x-mystic-host-capability"];
    if (HostRuntimeCapability === undefined) return false;
    const AuthHeader = req.headers.authorization;

    const context = await ResolveActiveHostRuntimeContext(HostRuntimeCapability);
    if (context == undefined) {
        res.status(401).send();
        logger.warn(`Invalid or inactive player-host runtime capability for ${req.method} ${req.path}`);
        return true;
    }

    // The durable operator stop blocks all player-host API activity, including the
    // game's ordinary inventory/profile calls made through this capability.
    if ((await GetP2POperationsPolicy()).p2pEmergencyStop) {
        res.status(503).json({ error: { code: "P2P_EMERGENCY_STOP",
            message: "Player-hosted hunts are temporarily stopped by operations policy." } });
        return true;
    }

    let Payload: JwtPayload | undefined;
    try {
        const Token = ParseOptionalHostRuntimeBearerToken(AuthHeader);
        if (Token != undefined) {
            const Verified = ValidateMetagameJWTAndGetPayload(Token);
            if (typeof Verified === "string") throw new Error("invalid JWT payload");
            Payload = Verified as JwtPayload;
        }
    } catch {
        res.status(401).send();
        logger.warn(`Player-host runtime request carried bad Metagame auth for ${req.method} ${req.path}`);
        return true;
    }

    const requestedUserId = ResolvePlayerHostRuntimeRequestIdentity(req);
    const AuthData = BuildPlayerHostRuntimeAuthData(context, Payload, { requestedUserId });
    if (AuthData == undefined) {
        res.status(403).send();
        logger.warn(`Player-host runtime request was outside its admitted hunt roster for ${req.method} ${req.path}` +
            (requestedUserId == undefined ? "" : ` requestedUserId=${requestedUserId}`));
        return true;
    }
    if (!(await IsCurrentLauncherAccountEligible(AuthData))) {
        res.status(403).send();
        return true;
    }

    const identitySource = Payload != undefined ? "bearer" :
        requestedUserId != undefined ? "request" : "host-fallback";
    logger.info(`Player-host runtime identity userId=${AuthData.userId} source=${identitySource}` +
        ` sessionId=${AuthData.p2pSessionId} generation=${AuthData.p2pGeneration}` +
        ` request=${req.method} ${req.path}`);
    res.locals.responseLogTags = ` runtimeUserId=${AuthData.userId} runtimeIdentitySource=${identitySource}`;
    // [2026-10-14 realms wave 2] The host route census (observability/hostRouteCensus.ts) counts the session kind; a hunt has none.
    res.locals.hostRouteSession = { sessionKind: context.hunt.sessionKind ?? "HUNT", hubKind: context.hunt.hubKind };
    (req as any).AuthData = AuthData;
    next();
    return true;
}
