/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Player-hosted (P2P) hunt module of DeployServer. Loaded through src/extensions/p2p.ts when this folder
// is present; nothing outside this folder imports it directly.

import express from "express";
import type { P2PExtension } from "../extensions/p2p";
import { logger } from "../logger";
import { ResolvePlayerHostedLaunchManifest } from "./huntLaunchManifest";

export function CreateP2PExtension(): P2PExtension {
    return {
        loaded: true,
        mountMatchmakerRoutes(router) {
            // Control-plane-only resolver used by Metagame before selecting a player host. It deliberately
            // performs no spawn, port allocation, process mutation, or credential issuance.
            router.post("/resolve-hunt-launch-manifest", express.json(), (req, res) => {
                try {
                    res.status(200).json(ResolvePlayerHostedLaunchManifest(req.body.HuntId, req.body.ExpectedPlayers));
                } catch (error: any) {
                    logger.error(`resolve-hunt-launch-manifest failed: ${error?.message ?? error}`);
                    res.status(400).json({ error: "hunt_manifest_invalid" });
                }
            });
        }
    };
}
