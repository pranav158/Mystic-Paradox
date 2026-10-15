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
import {
    StartDiscordAuth, StartDiscordLink, HandleDiscordCallback, CompleteDiscordLogin, StartDiscordUnlink, ConfirmDiscordUnlink
} from "../controllers/discordAuth";
// [2026-10-15] The email routes (email verification, resend, password reset by code) and their code flow (controllers/emailCodes.ts).
import { ResendEmailCode, RequestPasswordResetCode, ResetPasswordWithCode, VerifyEmailWithPassword } from "../controllers/launcherEmail";
import { GetLauncherPolicy } from "../controllers/launcherPolicy";
// [2026-10-15] The launcher notices the launcher shows (controllers/launcherNotices.ts): public, the sign-in screen shows them too.
import { GetPublicLauncherNotices } from "../controllers/launcherNotices";
import { AcceptConsent, CancelAccountDeletion, GetConsentState, GetDeletionState, RequestAccountDeletion } from "../controllers/launcherAccount";
import { CurrentLegalRequirements } from "../legal/legalPolicy";
import { ReadOfficialPlay } from "../config/officialPlay";
import { ParseRuntimeChannel } from "../security/runtimeAuthorization";

// Implements the /launcher/v1 contract from Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md.
// Deliberately additive to the running Metagame: nothing here touches routes/eos.ts,
// routes/party.ts, or any other existing game route/controller. The one documented
// remaining integration point — a new AUTH_MODE=LAUNCHER branch in eos.ts that
// consumes the codes /game-sessions issues below — is intentionally NOT implemented
// here; see that file's header note and the requirements doc's "status" section.
export const launcherAuthRouter = Router();

// Scoped to this router only — not a global app.ts middleware — so it can't
// change behavior for any existing game route. The launcher's frontend runs
// as a browser-origin WebView (Tauri) or a plain dev browser during testing,
// either of which needs actual CORS headers to complete requests; the game
// client and DeployServer/gameserver calls elsewhere in this app aren't
// browsers and were never subject to CORS to begin with.
//
// Allow-list, not a wildcard — LAUNCHER_ALLOWED_ORIGINS (comma-separated) lets
// the production Tauri webview's real origin be added once it's known; the
// Vite dev server origin below is always included since it's fixed by
// Launcher/src-tauri/tauri.conf.json's devUrl. See
// Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md's status notes — Tauri's exact
// production origin (WebView2 on Windows) is https://tauri.localhost for
// Tauri 2 packaged builds — confirmed now against the real launcher.exe.
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:1420", "https://tauri.localhost"];

function GetAllowedOrigins(): string[] {
    const FromEnv = (process.env.LAUNCHER_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

    return [...DEFAULT_ALLOWED_ORIGINS, ...FromEnv];
}

launcherAuthRouter.use((req, res, next) => {
    // This router is mounted at "/", so this middleware also runs for game and
    // fall-through requests. Only the launcher API (browser/WebView) needs CORS, so
    // scope it to /launcher/ — otherwise non-browser game requests (which correctly
    // have no Origin) log a spurious "[CORS] No origin header" warning on their way
    // to the 404 handler.
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
        // DELETE is for DELETE /launcher/v1/account/deletion (restore a deactivated account); nothing else uses it.
        res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

/** Every handler below funnels errors through here so a thrown LauncherApiError
 *  becomes the documented {error:{code,message,requestId}} body, and anything
 *  unexpected is logged (never leaked to the client) and reported as INTERNAL. */
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
        return RegisterAccount(req.body?.displayName, req.body?.email, req.body?.password, deviceName, deviceId, GetClientIp(req), req.body?.consent);
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
        // This endpoint's client is the player's system browser mid-redirect, not
        // the launcher's fetch-based API client — errors go back as a deep link
        // (which the launcher listens for) rather than a JSON body no one reads.
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

// [2026-10-15] Email verification and password reset by code. Verify takes the password and the code; resend and forgot always answer
// { sent: true }; reset takes the code and the new password. Each route is limited per address and per IP (controllers/launcherEmail.ts).
launcherAuthRouter.post("/launcher/v1/auth/email/verify", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return VerifyEmailWithPassword(req.body?.email, req.body?.password, req.body?.code, deviceId, deviceName, GetClientIp(req));
    })
);

launcherAuthRouter.post("/launcher/v1/auth/email/resend", (req, res) =>
    Handle(req, res, () => ResendEmailCode(req.body?.email, GetClientIp(req)))
);

launcherAuthRouter.post("/launcher/v1/auth/password/forgot", (req, res) =>
    Handle(req, res, () => RequestPasswordResetCode(req.body?.email, GetClientIp(req)))
);

launcherAuthRouter.post("/launcher/v1/auth/password/reset", (req, res) =>
    Handle(req, res, () => {
        const { deviceId, deviceName } = GetDeviceFields(req);
        return ResetPasswordWithCode(req.body?.email, req.body?.code, req.body?.newPassword, deviceId, deviceName, GetClientIp(req));
    })
);

// [2026-10-15] Link Discord to the signed-in account in Settings (the OAuth comes back to mysticparadox://link/done or link/error). Unlinking
// is two steps: the start mails a code (purpose "unlink"), and the confirm checks it and unlinks. The one-click DELETE is gone.
launcherAuthRouter.post("/launcher/v1/account/discord/link/start", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => StartDiscordLink((req as any).LauncherAuthData.userId))
);

launcherAuthRouter.post("/launcher/v1/account/discord/unlink/start", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => StartDiscordUnlink((req as any).LauncherAuthData.userId, GetClientIp(req)))
);

launcherAuthRouter.post("/launcher/v1/account/discord/unlink", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => ConfirmDiscordUnlink((req as any).LauncherAuthData.userId, req.body?.code, GetClientIp(req)))
);

launcherAuthRouter.get("/launcher/v1/me", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetAccountView((req as any).LauncherAuthData.userId))
);

// Availability check for the registration screen (pre-auth, read-only).
launcherAuthRouter.get("/launcher/v1/username", (req, res) =>
    Handle(req, res, () => CheckUsernameAvailable(String(req.query.name ?? "")))
);

// Set the authenticated account's unique username (Discord set-username step).
launcherAuthRouter.post("/launcher/v1/username", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => SetUsername((req as any).LauncherAuthData.userId, req.body?.username))
);

launcherAuthRouter.post("/launcher/v1/game-sessions", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => {
        const AuthData = (req as any).LauncherAuthData;
        const BuildChangelist = Number(req.body?.buildChangelist);
        const ExecutableSha256 = req.body?.executableSha256;
        const RuntimeChannel = ParseRuntimeChannel(req.body?.runtimeChannel);
        const RuntimeManifestVersion = req.body?.runtimeManifestVersion;
        const RuntimeArtifacts = req.body?.runtimeArtifacts;

        if (!Number.isFinite(BuildChangelist)) {
            throw new LauncherApiError("AUTH_VALIDATION_FAILED", "buildChangelist is required.");
        }

        if (typeof ExecutableSha256 !== "string" || ExecutableSha256.length === 0) {
            throw new LauncherApiError("AUTH_VALIDATION_FAILED", "executableSha256 is required.");
        }

        return RequestGameExchangeCode(
            AuthData.userId,
            AuthData.sid,
            BuildChangelist,
            ExecutableSha256,
            RuntimeChannel,
            RuntimeManifestVersion,
            RuntimeArtifacts,
            req.body?.realm,
            req.body?.launcher
        );
    })
);

launcherAuthRouter.get("/launcher/v1/policy", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetLauncherPolicy((req as any).LauncherAuthData.userId))
);

launcherAuthRouter.get("/launcher/v1/status", (req, res) =>
    Handle(req, res, async () => ({
        online: await GetPersistenceLifecycle().isHealthy(),
        supportedBuildChangelist: Number(process.env.TARGET_CHANGELIST ?? 0),
        // [2026-10-15] Whether official play (no realm) is offered, and the message the launcher shows when it is not. Older launchers
        // ignore the field.
        officialPlay: ReadOfficialPlay()
    }))
);

// [2026-10-14] The Terms of Use and Privacy Policy versions and the minimum age the launcher must show (no sign-in needed).
launcherAuthRouter.get("/launcher/v1/legal", (req, res) => Handle(req, res, async () => CurrentLegalRequirements()));

// [2026-10-15] The sticky announcements and tags active now (no sign-in; a read error answers the empty set).
launcherAuthRouter.get("/launcher/v1/notices", (req, res) => GetPublicLauncherNotices(req, res));

// [2026-10-14] Consent to the current documents. These routes and the deletion ones keep working while the account is deactivated.
launcherAuthRouter.get("/launcher/v1/account/consent", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetConsentState((req as any).LauncherAuthData.userId))
);

launcherAuthRouter.post("/launcher/v1/account/consent", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => AcceptConsent((req as any).LauncherAuthData.userId, req.body))
);

// [2026-10-14] Account deletion: a request deactivates the account for DELETION_HOLD_DAYS (30); DELETE restores it while the hold lasts.
launcherAuthRouter.get("/launcher/v1/account/deletion", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => GetDeletionState((req as any).LauncherAuthData.userId))
);

launcherAuthRouter.post("/launcher/v1/account/deletion", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => RequestAccountDeletion((req as any).LauncherAuthData.userId, req.body))
);

launcherAuthRouter.delete("/launcher/v1/account/deletion", HasLauncherAuth, (req, res) =>
    Handle(req, res, () => CancelAccountDeletion((req as any).LauncherAuthData.userId))
);
