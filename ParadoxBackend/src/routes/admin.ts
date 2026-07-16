/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import { Router } from "express";
import { logger } from "../logger";
import { HasAdminAuth } from "../middleware/HasAdminAuth";
import { AdminLogin, AdminLogout, AdminMe, DeletePlayer, ListAudit, ListOnlinePlayers, ListPlayers, UpdatePlayerAccess } from "../controllers/admin";

export const adminRouter = Router();

function AllowedOrigins(): string[] {
    return (process.env.ADMIN_ALLOWED_ORIGINS ?? "https://admin.paradox.example.com,http://localhost:4173,http://localhost:5174")
        .split(",").map((Value) => Value.trim()).filter(Boolean);
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
adminRouter.get("/admin/v1/me", HasAdminAuth, AdminMe);
adminRouter.get("/admin/v1/online-players", HasAdminAuth, ListOnlinePlayers);
adminRouter.get("/admin/v1/players", HasAdminAuth, ListPlayers);
adminRouter.patch("/admin/v1/players/:userId/access", HasAdminAuth, UpdatePlayerAccess);
adminRouter.delete("/admin/v1/players/:userId", HasAdminAuth, DeletePlayer);
adminRouter.get("/admin/v1/audit", HasAdminAuth, ListAudit);
