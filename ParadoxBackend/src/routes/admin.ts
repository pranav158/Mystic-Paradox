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
        res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
