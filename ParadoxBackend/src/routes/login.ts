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
import { GetRepositories } from "../persistence";
import { GetUsernameForUserId } from "../controllers/login";

export const loginRouter = Router();

loginRouter.get("/features/platform/win", (req, res) => {
    logger.info("Features");

    res.send({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "crossplay" : true,
           "crossprogression" : true
        }
    });
});

loginRouter.get("/account/link/epic/:AccId", (req, res) => {
    logger.info("Account Linking");

    res.json({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "isLinked" : true
        }
    });
});

loginRouter.post("/login", HasParadoxBackendAuth, async (req: any, res) => {
    if(req.AuthData.userId !== req.body.email){
        res.status(400);
        res.send();

        logger.error(`UserID from MysticParadox Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);

        return;
    }

    let UserRecord = await GetRepositories().accounts.findByUserId(req.AuthData.userId);

    if(UserRecord == undefined){
        res.status(400);
        res.send();

        logger.error(`UserID from MysticParadox Auth ${req.AuthData.userId} had no database entry!`);

        return;
    }

    logger.info(`${req.body.email} is logging in!`);

    res.json({
        "error_code": "TicketRateOk",
        "message": "",
        "state": "OPEN",
        "timeout": 8000,
        "title": ""
    });
});

loginRouter.get("/accountinfo", HasParadoxBackendAuth, async (req: any, res) => {
    logger.info("Account info")

    const Username = await GetUsernameForUserId(req.AuthData.userId);

    res.json({
        "accountId" : req.AuthData.userId,
        "creationDate" : "2000-01-01 00:00:00",
        "email" : null,
        "preferredLanguage" : null,
        "username" : Username,
        "verified" : true
    });
});

loginRouter.get("/tags", HasParadoxBackendAuth, (req: any, res) => {
    logger.info("Tags")

    res.json({
        "accountId" : req.AuthData.userId,
        "tags": []
    });
});

loginRouter.put("/gamesession/epic", HasParadoxBackendAuth, (req: any, res) => {
    const AuthHeader = req.headers.authorization;

    const Token = AuthHeader.slice("bearer ".length);

    
    
    
    
    

    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "error_code": null,
            "sessionid": "SESSION_ID_LOL", // TODO: This is surfaced in the UI, but I don't think it matters for anything else
            "sessionToken": Token 
        }
    })
});

loginRouter.post("/accountinfo/public", HasParadoxBackendAuth, async (req: any, res) => {
    const AccountIdToLookupFromRequest = req.body.accountId;

    
    
    
    
    const AuthenticatedUserId = req.AuthData.userId;
    const NameLookupUserId = AccountIdToLookupFromRequest === (process.env.DEV_USER_ID ?? "mysticparadox") &&
        AuthenticatedUserId !== AccountIdToLookupFromRequest
        ? AuthenticatedUserId
        : AccountIdToLookupFromRequest;
    const Username = await GetUsernameForUserId(NameLookupUserId);

    
    
    
    
    

    res.status(200);
    res.json({
        accountId: AccountIdToLookupFromRequest,
        isSubscribed: true,
        language: null,
        linkedAccounts: [
            {
                accountId: AccountIdToLookupFromRequest,
                accountType: "epic"
            }
        ],
        username: Username
    });
});

loginRouter.post("/migration/trigger", HasParadoxBackendAuth, (req, res) => {
    logger.debug("Migration trigger (stubbed)");

    res.status(200);
    res.json({
        migration_failed: false,
        migration_finished: true
    });
});

loginRouter.get("/migration/status", HasParadoxBackendAuth, (req, res) => {
    logger.debug("Migration status (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            migration_failed: false,
            migration_finished: true
        }
    });
});



loginRouter.get("/isbanned", (req, res) => {
    logger.info("Is banned check (stubbed)");

    res.status(200).json({
        "isBanned": false
    });
});
