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

import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { IsValidGameserverAPIKey } from "../controllers/apikeys";
import { JwtPayload } from "jsonwebtoken";
import { GetRepositories } from "../persistence";
import { IsAccountEligible } from "../security/accountEligibility";
import { GetP2PExtension } from "../extensions/p2p";

export async function IsCurrentLauncherAccountEligible(Payload: JwtPayload): Promise<boolean> {
    if (typeof Payload.userId !== "string") return true;
    const Account = await GetRepositories().launcherAccounts.findByUserId(Payload.userId);
    // Gameserver/service/dev identities are not launcher accounts and retain
    // their existing API-key/JWT behavior.
    return Account == undefined || IsAccountEligible(Account);
}

export async function HasParadoxBackendAuth(req: Request, res: Response, next: NextFunction){
    const AuthHeader = req.headers.authorization;

    const GameserverAuthHeader = req.headers["x-mysticparadox-gameserver-apikey"];

    if(GameserverAuthHeader !== undefined){
        const IsValid = await IsValidGameserverAPIKey(GameserverAuthHeader as string);

        if(IsValid){
            // [1.14.7 2026-10-03] INVALID -> known account resolution (the documented 1.12 unlock).
            //
            // A dedicated hub runs this WindowsClient build, which always spawns a phantom
            // ULocalPlayer during map init; that phantom PlayerState has no valid UniqueId, so
            // the hub's per-player data loaders build URLs like
            //   GET /loadout/INVALID//all   GET /inventory/INVALID/
            // (and, for the save path, PUT/POST .../INVALID). The hub holds the gameserver API
            // key but no player bearer token, so the route parameter really is the literal
            // string "INVALID" -> empty data -> empty loadout -> invalid PlayerState ->
            // UArchonLoadManager::LoadFailed after 66s -> "LoadMap: failed to Listen" -> the hub
            // dies when a client joins. Progress/SESSION_HANDOFF.md records the original fix:
            // "for gameserver requests where params.userId === 'INVALID', resolve to the known
            // single-account dev user (single-account private server). Applied to per-player
            // READ routes only. This made the player load real data."
            //
            // This restores exactly that: gameserver-authenticated READ requests whose path
            // carries the INVALID sentinel are re-pointed at the configured account before any
            // router sees them. Writes are deliberately NOT rewritten, so the phantom can never
            // overwrite real progression. Override the account with GAMESERVER_NO_PLAYER_USER_ID.
            if (req.method === "GET" || req.method === "HEAD") {
                const NoPlayerUserId = (process.env.GAMESERVER_NO_PLAYER_USER_ID ?? process.env.DEV_USER_ID ?? "mystpax").trim();
                const [PathPart, QueryPart] = req.url.split("?", 2);
                if (NoPlayerUserId.length > 0 && /(^|\/)INVALID(\/|$)/.test(PathPart)) {
                    const Rewritten = PathPart.replace(/(^|\/)INVALID(\/|$)/g, `$1${encodeURIComponent(NoPlayerUserId)}$2`);
                    req.url = QueryPart == undefined ? Rewritten : `${Rewritten}?${QueryPart}`;
                    logger.info(`Gameserver INVALID sentinel resolved to '${NoPlayerUserId}' for ${req.method} ${Rewritten}`);
                }
            }

            if(AuthHeader != undefined){ // Why this double-auth amalgam? Sometimes the client sends it's Bearer auth to the server, and the server makes reqs where the only userId identifying factor is that auth token. This fixes that up, so we have that context.
                const Token = AuthHeader.slice("bearer ".length);

                const Payload = ValidateMetagameJWTAndGetPayload(Token);
                if (!(await IsCurrentLauncherAccountEligible(Payload as JwtPayload))) {
                    res.status(403).send();
                    return;
                }

                (req as any).AuthData = {
                    IsGameserver: true,
                    ...(Payload as JwtPayload)
                };
            }
            else{
                // [1.14.7 2026-10-03] Gameserver request with NO player bearer token. Routes that
                // read AuthData.userId (character, inventory bodies, pjm, cooldown...) then saw
                // undefined and either returned empty data or rejected the body - which is what
                // made the hub's phantom local player fail its inventory fetch and leave the map.
                // Attribute such requests to the configured single-account identity, exactly like
                // the documented 1.12 rule for the path-based INVALID sentinel. A gameserver that
                // does carry a player bearer keeps that player's identity (branch above).
                const NoPlayerUserId = (process.env.GAMESERVER_NO_PLAYER_USER_ID ?? process.env.DEV_USER_ID ?? "").trim();
                (req as any).AuthData = {
                    IsGameserver: true,
                    ...(NoPlayerUserId.length > 0 ? { userId: NoPlayerUserId } : {}),
                };
            }

            next();

            return;
        }
        else{
            res.status(401);
            res.send();
            logger.error(`Invalid Gameserver API Key Auth`);
            return;
        }
    }

    // An optional module may authenticate its own runtime credential (src/extensions).
    if (await GetP2PExtension().http.authenticate(req, res, next)) {
        return;
    }

    if(AuthHeader == undefined || (!AuthHeader?.startsWith("bearer ") && !AuthHeader?.startsWith("Bearer ") && !AuthHeader?.startsWith("BEARER "))){
        res.status(401);
        res.send();

        logger.error(`Unauthenticated ${req.method} to ${req.path} which needs Mystic Paradox Metagame auth!`);

        return;
    }

    const Token = AuthHeader.slice("bearer ".length);

    try{
        const Payload = ValidateMetagameJWTAndGetPayload(Token);
        if (!(await IsCurrentLauncherAccountEligible(Payload as JwtPayload))) {
            res.status(403).send();
            return;
        }

        (req as any).AuthData = Payload;

        next();
    } catch {
        res.status(401);
        res.send();

        logger.warn("Request with bad Mystic Paradox Metagame auth!");

        return;
    }
}
