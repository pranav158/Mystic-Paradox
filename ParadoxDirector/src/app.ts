//0503
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
import { matchmakingRouter } from "./routes/matchmaker.js";
import { GetPersistentHubStatus } from "./controllers/gameservers.js";
import { logger } from "./logger.js";
import { GetRequestId, RequestContextMiddleware } from "./observability/requestContext.js";

export const app = express();

let persistentHubsReady = false;
export function SetPersistentHubsReady(ready: boolean): void {
    persistentHubsReady = ready;
}

app.get('/health/ready', (_req, res) => {
    res.status(persistentHubsReady ? 200 : 503).json({ ok: persistentHubsReady, service: 'deployserver' });
});

// [1.14.7 FENCING 2026-10-04] Live persistent-hub status for matchmaking revalidation. Each entry is null
// unless the hub is ready AND its process is still alive, so a caller can tell a stale cached candidate from
// a serving one before handing its address to a client. Read-only; no state is changed here.
app.get('/api/hub-status', (_req, res) => {
    res.status(200).json(GetPersistentHubStatus());
});

app.use(RequestContextMiddleware);

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    const StartedAt = Date.now();
    const RequestId = GetRequestId() ?? "missing";
    logger.info(`[REQ] requestId=${RequestId} ${req.method} ${req.originalUrl}`);
    res.on("finish", () => {
        logger.info(`[RES] requestId=${RequestId} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - StartedAt}ms)`);
    });
    next();
});

app.use("/api/matchmaker", matchmakingRouter);
