
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

import express from "express";
import { loginRouter } from "./routes/login.js";
import { logger } from "./logger.js";
import { eosRouter } from "./routes/eos.js";
import { systemRouter } from "./routes/system.js";
import { characterRouter } from "./routes/character.js";
import { inventoryRouter } from "./routes/inventory.js";
import { storeRouter } from "./routes/store.js";
import { guildRouter } from "./routes/guild.js";
import { tuningRouter } from "./routes/tuning.js";
import { matchmakingRouter } from "./routes/matchmaking.js";
import { partyRouter } from "./routes/party.js";
import { progressionRouter } from "./routes/progression.js";
import { loadoutRouter } from "./routes/loadout.js";
import { launcherAuthRouter } from "./routes/launcherAuth.js";
import { friendsRouter } from "./routes/friends.js";
import { launcherUpdatesRouter } from "./routes/launcherUpdates.js";
import { adminRouter } from "./routes/admin.js";



type OriginTaggedRequest = express.Request & { originHost?: string };



const ORIGIN_ALLOWLIST_APEXES = ["steelyard.ca", "steelyard.online", "ol.epicgames.com", "api.epicgames.dev"] as const;



function isAllowedOriginHost(host: string): boolean {
    if (host.length === 0 || host.length > 253) return false;
    if (!/^[a-z0-9.-]+$/.test(host)) return false;   
    if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
    return ORIGIN_ALLOWLIST_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

export const app = express();






app.set("trust proxy", "loopback");

app.use(express.json());

app.use(express.urlencoded({ extended: true }));










app.use((req, res, next) => {
    const match = /^\/__origin\/([^/?#]+)(.*)$/.exec(req.url);
    if (match) {
        let originHost: string;
        try {
            originHost = decodeURIComponent(match[1]).toLowerCase(); 
        } catch {
            logger.warn("[origin] rejected /__origin request with malformed percent-encoding");
            res.status(400).send();
            return;
        }
        
        
        
        if (!isAllowedOriginHost(originHost)) {
            logger.warn(`[origin] rejected /__origin host: ${originHost}`);
            res.status(400).send();
            return;
        }
        const rest = match[2] && match[2].length > 0 ? match[2] : "/";
        (req as OriginTaggedRequest).originHost = originHost;
        req.url = rest.startsWith("/") ? rest : `/${rest}`;
    }
    next();
});












const BODY_CAPTURE_ENABLED = /^(1|true|on|yes)$/i.test(process.env.MYSTICPARADOX_BODY_CAPTURE ?? "");

app.use((req, res, next) => {
    const started = Date.now();
    const gsKey = req.headers["x-mysticparadox-gameserver-apikey"] ? "Y" : "N";
    const authBearer = typeof req.headers.authorization === "string" && req.headers.authorization.toLowerCase().startsWith("bearer ") ? "Y" : "N";
    const originHost = (req as OriginTaggedRequest).originHost;
    logger.info(`[REQ] ${req.method} ${req.headers.host || "?"}${req.originalUrl}${originHost ? ` origin=${originHost}` : ""} gsKey=${gsKey} bearer=${authBearer}`);
    if (BODY_CAPTURE_ENABLED && req.method === "POST" && /(pjm|progression|breadcrumbs|store|reconcile|balance|purchase|unlock|merit|currenc|inventory)/i.test(req.originalUrl)) {
        try { logger.info(`[BODY-CAPTURE] ${req.method} ${req.originalUrl} body=${JSON.stringify(req.body)}`); } catch { /* ignore */ }
    }
    res.on("finish", () => {
        logger.info(`[RES] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - started}ms)`);
    });
    next();
});

app.get("/", (req, res) => {
    res.status(200).send("ok");
});

app.use("/", loginRouter);
app.use("/", eosRouter);
app.use("/", systemRouter);
app.use("/", characterRouter);
app.use("/", inventoryRouter);
app.use("/", storeRouter);
app.use("/", guildRouter);
app.use("/", tuningRouter);
app.use("/", matchmakingRouter);
app.use("/", partyRouter);
app.use("/", progressionRouter);
app.use("/", loadoutRouter);
app.use("/", friendsRouter);
app.use("/", launcherAuthRouter);
app.use("/", launcherUpdatesRouter);
app.use("/", adminRouter);

app.use((req, res) => {
    logger.warn(`Unstubbed route ${req.method} ${req.path}`)

    res.status(404);
    res.send();
});
