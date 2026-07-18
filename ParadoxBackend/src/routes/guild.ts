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

import { Router } from "express";
import { logger } from "../logger";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";

export const guildRouter = Router();

guildRouter.get("/guild/invite/player", HasParadoxBackendAuth, (req: any, res) => {
    logger.info("Guild invites (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            invites: []
        }
    });
});

guildRouter.get("/guild", HasParadoxBackendAuth, (req: any, res) => {
    logger.info("Current guild (stubbed)");

    res.status(204);
    res.send();
});