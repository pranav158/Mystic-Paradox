/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Hook points for the optional player-hosted (P2P) hunt module.
//
// DeployServer is complete without it: the defaults add nothing. When a `p2p` folder is present next to
// this one, GetP2PExtension() loads it once and uses its hooks instead. MYSTICPARADOX_P2P_MODULE=off keeps
// the defaults even when the folder exists. Shared code never imports the module directly.

import fs from "node:fs";
import path from "node:path";
import type { Router } from "express";
import { logger } from "../logger";

export interface P2PExtension {
    readonly loaded: boolean;
    /** Extra routes under /api/matchmaker. */
    mountMatchmakerRoutes(router: Router): void;
}

const DEDICATED_ONLY: P2PExtension = {
    loaded: false,
    mountMatchmakerRoutes: () => undefined
};

let Extension: P2PExtension | undefined;

function LoadP2PExtension(): P2PExtension {
    if (/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_P2P_MODULE?.trim() ?? "")) {
        logger.info("[P2P] module disabled by MYSTICPARADOX_P2P_MODULE; dedicated hunts only");
        return DEDICATED_ONLY;
    }
    const modulePath = path.join(__dirname, "..", "p2p");
    if (!fs.existsSync(modulePath)) return DEDICATED_ONLY;
    const module = require(modulePath) as { CreateP2PExtension?: () => P2PExtension };
    if (typeof module.CreateP2PExtension !== "function") {
        throw new Error(`${modulePath} does not export CreateP2PExtension().`);
    }
    logger.info("[P2P] player-hosted hunt module loaded");
    return module.CreateP2PExtension();
}

export function GetP2PExtension(): P2PExtension {
    Extension ??= LoadP2PExtension();
    return Extension;
}
