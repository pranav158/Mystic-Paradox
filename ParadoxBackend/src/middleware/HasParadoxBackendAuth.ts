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

async function IsCurrentLauncherAccountEligible(Payload: JwtPayload): Promise<boolean> {
    if (typeof Payload.userId !== "string") return true;
    const Account = await GetRepositories().launcherAccounts.findByUserId(Payload.userId);
    
    
    return Account == undefined || IsAccountEligible(Account);
}

export async function HasParadoxBackendAuth(req: Request, res: Response, next: NextFunction){
    const AuthHeader = req.headers.authorization;

    const GameserverAuthHeader = req.headers["x-mysticparadox-gameserver-apikey"];

    if(GameserverAuthHeader !== undefined){
        const IsValid = await IsValidGameserverAPIKey(GameserverAuthHeader as string);

        if(IsValid){
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
                (req as any).AuthData = {
                    IsGameserver: true,
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
