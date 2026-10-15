/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Router } from "express";
import { logger } from "../logger";
import { HasAdminAuth } from "../middleware/HasAdminAuth";
import { AdminLogin, AdminLogout, AdminMe, DeletePlayer, ListAudit, ListOnlinePlayers, ListPlayers, UpdatePlayerAccess, UpdatePlayerRoles } from "../controllers/admin";
import {
    ADMIN_DISCORD_BINDING_COOKIE_NAME,
    AdminDiscordBindingCookie,
    StartAdminDiscordAuth,
    HandleAdminDiscordCallback
} from "../controllers/adminDiscordAuth";
import { GetOperationsOverview, UpdateOperationsPolicy } from "../controllers/adminOperations";
import { GetGuardSession, ListGuardFindings, ListGuardSessions } from "../controllers/adminGuard";
import { AcknowledgeActivityFlag, GetActivityOverview, GetActivityPlayer, ListActivityFlags } from "../controllers/adminActivity";
import { TesterMaxPlayer } from "../controllers/testerMax";
// [2026-10-15] The launcher notices (controllers/launcherNotices.ts): the manager's read and versioned save.
import { GetAdminLauncherNotices, UpdateLauncherNotices } from "../controllers/launcherNotices";
// [2026-10-15] Player logs: the tester uploads, listed, read and deleted (controllers/adminPlayerLogs.ts; the delete is audited).
import { DeletePlayerLogSessionRoute, ListPlayerLogs, ReadPlayerLogFileRoute } from "../controllers/adminPlayerLogs";

export const adminRouter = Router();

function AllowedOrigins(): string[] {
    const Configured = process.env.ADMIN_ALLOWED_ORIGINS;
    if (Configured == undefined || Configured.trim().length === 0) {
        // Production must explicitly name the dashboard origin. Local development
        // retains the two documented Vite origins for a frictionless dev startup.
        return process.env.NODE_ENV === "production"
            ? []
            : ["http://localhost:4173", "http://localhost:5174"];
    }
    return Configured.split(",").map((Value) => Value.trim()).filter(Boolean);
}

function ReadCookieValue(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const Part of header.split(";")) {
        const [Key, ...Value] = Part.trim().split("=");
        if (Key !== name) continue;
        try {
            return decodeURIComponent(Value.join("="));
        } catch {
            return undefined;
        }
    }
    return undefined;
}

adminRouter.use("/admin/v1", (req, res, next) => {
    const Origin = req.headers.origin;
    if (typeof Origin === "string") {
        if (!AllowedOrigins().includes(Origin)) {
            logger.warn(`[ADMIN] rejected origin ${Origin}`);
            res.status(403).send();
            return;
        }
        res.header("Access-Control-Allow-Origin", Origin);
        res.header("Access-Control-Allow-Credentials", "true");
        res.header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
        // [2026-10-15] PUT is the launcher notices save (PUT /admin/v1/launcher-notices).
        res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.header("Vary", "Origin");
    }
    res.header("Cache-Control", "no-store");
    res.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});

adminRouter.post("/admin/v1/auth/login", AdminLogin);
adminRouter.post("/admin/v1/auth/logout", HasAdminAuth, AdminLogout);

// Browser-navigation flow (not fetch/JSON): the button is a plain link, Discord's
// redirect back is a top-level GET, so both ends work with a 302 rather than the
// launcher's JSON-start/deep-link-completion dance (routes/launcherAuth.ts).
adminRouter.get("/admin/v1/auth/discord/start", async (req, res) => {
    try {
        const Started = await StartAdminDiscordAuth(req.ip ?? "unknown");
        if (Started.setCookie) res.setHeader("Set-Cookie", Started.setCookie);
        res.redirect(302, Started.authorizeUrl);
    } catch (error) {
        logger.error(`[ADMIN] Discord auth start failed: ${error instanceof Error ? error.message : String(error)}`);
        res.status(503).json({ error: { code: "ADMIN_DISCORD_NOT_CONFIGURED", message: "Discord sign-in isn't configured safely on this server yet." } });
    }
});

adminRouter.get("/admin/v1/auth/discord/callback", async (req, res) => {
    try {
        const BrowserBinding = ReadCookieValue(req.headers.cookie, ADMIN_DISCORD_BINDING_COOKIE_NAME);
        const { redirectUrl, setCookie } = await HandleAdminDiscordCallback(
            req.query.code as string | undefined,
            req.query.state as string | undefined,
            BrowserBinding,
            req.ip ?? "unknown",
            String(req.headers["user-agent"] ?? "discord-oauth")
        );
        // Always burn the transient browser binding, including cancellation/mismatch paths.
        const Cookies = [AdminDiscordBindingCookie()];
        if (setCookie) Cookies.push(setCookie);
        res.setHeader("Set-Cookie", Cookies);
        res.redirect(302, redirectUrl);
    } catch (error) {
        logger.error(`[ADMIN] Discord auth callback configuration failed: ${error instanceof Error ? error.message : String(error)}`);
        res.setHeader("Set-Cookie", AdminDiscordBindingCookie());
        res.status(503).json({ error: { code: "ADMIN_DISCORD_NOT_CONFIGURED", message: "Discord sign-in isn't configured safely on this server yet." } });
    }
});

adminRouter.get("/admin/v1/me", HasAdminAuth, AdminMe);
adminRouter.get("/admin/v1/online-players", HasAdminAuth, ListOnlinePlayers);
adminRouter.get("/admin/v1/players", HasAdminAuth, ListPlayers);
adminRouter.patch("/admin/v1/players/:userId/access", HasAdminAuth, UpdatePlayerAccess);
adminRouter.patch("/admin/v1/players/:userId/roles", HasAdminAuth, UpdatePlayerRoles);
adminRouter.delete("/admin/v1/players/:userId", HasAdminAuth, DeletePlayer);
adminRouter.get("/admin/v1/audit", HasAdminAuth, ListAudit);
adminRouter.get("/admin/v1/operations/overview", HasAdminAuth, GetOperationsOverview);
adminRouter.patch("/admin/v1/operations/policy", HasAdminAuth, UpdateOperationsPolicy);
// [2026-10-15] The launcher notices (SteamDocs/LAUNCHER_NOTICES_2026_10_15.md): the whole document, and the versioned save.
adminRouter.get("/admin/v1/launcher-notices", HasAdminAuth, GetAdminLauncherNotices);
adminRouter.put("/admin/v1/launcher-notices", HasAdminAuth, UpdateLauncherNotices);
// [2026-10-14] Launcher Guard sessions and module findings (read-only).
adminRouter.get("/admin/v1/guard/sessions", HasAdminAuth, ListGuardSessions);
adminRouter.get("/admin/v1/guard/sessions/:guardSessionId", HasAdminAuth, GetGuardSession);
adminRouter.get("/admin/v1/guard/findings", HasAdminAuth, ListGuardFindings);
// [2026-10-14] Activity monitor (src/activity): read-only player and overview views, and the flag review (PATCH, audited).
adminRouter.get("/admin/v1/activity/players/:userId", HasAdminAuth, GetActivityPlayer);
adminRouter.get("/admin/v1/activity/overview", HasAdminAuth, GetActivityOverview);
adminRouter.get("/admin/v1/activity/flags", HasAdminAuth, ListActivityFlags);
adminRouter.patch("/admin/v1/activity/flags/:id", HasAdminAuth, AcknowledgeActivityFlag);
// [2026-10-14, launch plan section 5] Max a tester account (controllers/testerMax.ts; the kit is game-data/tester_max_kit.json).
adminRouter.post("/admin/v1/players/:userId/tester-max", HasAdminAuth, TesterMaxPlayer);
// [2026-10-15] Player logs (controllers/adminPlayerLogs.ts): the list (newest first, paged), one file (?download=1 as an attachment), and the
// audited delete of one session.
adminRouter.get("/admin/v1/player-logs", HasAdminAuth, ListPlayerLogs);
adminRouter.get("/admin/v1/player-logs/:userId/:launchSessionId/:fileName", HasAdminAuth, ReadPlayerLogFileRoute);
adminRouter.delete("/admin/v1/player-logs/:userId/:launchSessionId", HasAdminAuth, DeletePlayerLogSessionRoute);
