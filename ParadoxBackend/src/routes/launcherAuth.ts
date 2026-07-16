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

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { logger } from "../logger";
import { GetPersistenceLifecycle } from "../persistence";
import { HasLauncherAuth } from "../middleware/HasLauncherAuth";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import {
    RegisterAccount,
    LoginWithPassword,
    RefreshSession,
    Logout,
    LogoutAll,
    RequestGameExchangeCode,
    GetAccountView,
    CheckUsernameAvailable,
    SetUsername
} from "../controllers/launcherAuth";
import { StartDiscordAuth, HandleDiscordCallback, CompleteDiscordLogin } from "../controllers/discordAuth";







export const launcherAuthRouter = Router();















const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:1420", "https://tauri.localhost"];

function GetAllowedOrigins(): string[] {
    const FromEnv = (process.env.LAUNCHER_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

    return [...DEFAULT_ALLOWED_ORIGINS, ...FromEnv];
}

launcherAuthRouter.use((req, res, next) => {
    
    
    
    
    
    if (!req.path.startsWith("/launcher/")) {
        next();
        return;
    }

    const Origin = req.headers.origin;

    if (typeof Origin === "string" && Origin.length > 0) {
        if (!GetAllowedOrigins().includes(Origin)) {
            logger.warn(`[CORS] Rejected launcher origin: ${Origin}`);
            res.status(403).send();
            return;
        }
        res.header("Access-Control-Allow-Origin", Origin);
        res.header("Vary", "Origin");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
        logger.info(`[CORS] Allowed origin: ${Origin}`);
    }

    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }

    next();
});

function GetClientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function GetDeviceFields(req: Request): { deviceId: string; deviceName: string } {
    const Body = req.body ?? {};

    return {
        deviceId: typeof Body.deviceId === "string" && Body.deviceId.length > 0 ? Body.deviceId : crypto.randomUUID(),
        deviceName: typeof Body.deviceName === "string" && Body.deviceName.length > 0 ? Body.deviceName : "Unknown device"
    };
}


async function Handle(req: Request, res: Response, fn: () => Promise<unknown>, successStatus = 200): Promise<void> {
    try {
        const Result = await fn();
        res.status(successStatus).json(Result ?? {});
    } catch (error) {
        if (error instanceof LauncherApiError) {
            SendLauncherError(res, error);
            return;
        }

        logger.error(`Unhandled error in launcher auth route ${req.method} ${req.path}: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "Something went wrong. Please try again."));
    }
}

launcherAuthRouter.post("/launcher/v1/auth/register", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return RegisterAccount(req.body?.displayName, req.body?.email, req.body?.password, deviceName, deviceId, GetClientIp(req));
    }, 202)
);

launcherAuthRouter.post("/launcher/v1/auth/login", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return LoginWithPassword(req.body?.email, req.body?.password, deviceId, deviceName, GetClientIp(req));
    })
);

launcherAuthRouter.post("/launcher/v1/auth/refresh", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return RefreshSession(req.body?.refreshToken, deviceId, deviceName);
    })
);

launcherAuthRouter.post("/launcher/v1/auth/logout", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => Logout((req as any).LauncherAuthData.sid))
);

launcherAuthRouter.post("/launcher/v1/auth/logout-all", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => LogoutAll((req as any).LauncherAuthData.userId))
);

launcherAuthRouter.post("/launcher/v1/auth/discord/start", (req, res) => Handle(req, res, () => StartDiscordAuth()));

launcherAuthRouter.get("/launcher/v1/auth/discord/callback", async (req, res) => {
    const Scheme = process.env.LAUNCHER_DEEPLINK_SCHEME ?? "mysticparadox";

    try {
        const RedirectUrl = await HandleDiscordCallback(req.query.code as string | undefined, req.query.state as string | undefined);
        res.redirect(302, RedirectUrl);
    } catch (error) {
        
        
        
        const Code = error instanceof LauncherApiError ? error.code : "INTERNAL";

        if (!(error instanceof LauncherApiError)) {
            logger.error(`Unhandled error in Discord callback: ${error}`);
        }

        res.redirect(302, `${Scheme}://auth/error?code=${encodeURIComponent(Code)}`);
    }
});

launcherAuthRouter.post("/launcher/v1/auth/discord/complete", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return CompleteDiscordLogin(req.body?.code, deviceId, deviceName);
    })
);

launcherAuthRouter.get("/launcher/v1/me", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetAccountView((req as any).LauncherAuthData.userId))
);


launcherAuthRouter.get("/launcher/v1/username", (req, res) =>
    Handle(req, res, () => CheckUsernameAvailable(String(req.query.name ?? "")))
);


launcherAuthRouter.post("/launcher/v1/username", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => SetUsername((req as any).LauncherAuthData.userId, req.body?.username))
);

launcherAuthRouter.post("/launcher/v1/game-sessions", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => {
        const AuthData = (req as any).LauncherAuthData;
        const BuildChangelist = Number(req.body?.buildChangelist);
        const ExecutableSha256 = req.body?.executableSha256;

        if (!Number.isFinite(BuildChangelist)) {
            throw new LauncherApiError("AUTH_VALIDATION_FAILED", "buildChangelist is required.");
        }

        if (typeof ExecutableSha256 !== "string" || ExecutableSha256.length === 0) {
            throw new LauncherApiError("AUTH_VALIDATION_FAILED", "executableSha256 is required.");
        }

        return RequestGameExchangeCode(AuthData.userId, AuthData.sid, BuildChangelist, ExecutableSha256);
    })
);

launcherAuthRouter.get("/launcher/v1/status", (req, res) =>
    Handle(req, res, async () => ({
        online: await GetPersistenceLifecycle().isHealthy(),
        supportedBuildChangelist: Number(process.env.TARGET_CHANGELIST ?? 0)
    }))
);
