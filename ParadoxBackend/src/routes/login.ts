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

        logger.error(`UserID from ParadoxBackend Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);

        return;
    }

    let UserRecord = await GetRepositories().accounts.findByUserId(req.AuthData.userId);

    if(UserRecord == undefined){
        res.status(400);
        res.send();

        logger.error(`UserID from ParadoxBackend Auth ${req.AuthData.userId} had no database entry!`);

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

// [1.14.7 FIX 2026-10-04] Shape taken from the captured contract
// (DauntlessEndpointDocumentation/Login/GameSession/GetSessionToken.md):
//
//   URL: https://gamesession-prod.steelyard.ca/gamesession/epiceos   <- note: epiceos
//   Method: PUT
//   payload: { "error_code": null, "sessionid": "eyJ...", "sessiontoken": "eyJ..." }
//
// Two differences mattered. (1) The real field is "sessiontoken" (all lowercase) while this route sent
// "sessionToken", so a client reading the documented name got nothing. (2) "sessionid" was the literal
// placeholder "SESSION_ID_LOL" whereas the real value is a JWT, like the token beside it. Both are fixed
// below, with the old camelCase name kept as well so neither spelling can break. The documented "epiceos"
// path is registered as an alias of this handler.
loginRouter.put(["/gamesession/epic", "/gamesession/epiceos"], HasParadoxBackendAuth, (req: any, res) => {
    const AuthHeader = req.headers.authorization;

    const Token = AuthHeader.slice("bearer ".length);

    // A note on auth tokens:
    // The original flow went Epic Launcher -> Epic -> PHX
    // With each step having it's own auth token.
    // Since this is unneeded complexity for us, we just use the same token for all 3
    // Hence this echo endpoint

    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "error_code": null,
            // A real JWT, matching the captured contract (was the literal "SESSION_ID_LOL").
            "sessionid": Token,
            // Documented spelling first, then the legacy camelCase one for compatibility.
            "sessiontoken": Token,
            "sessionToken": Token
        }
    })
});

loginRouter.post("/accountinfo/public", HasParadoxBackendAuth, async (req: any, res) => {
    const AccountIdToLookupFromRequest = req.body.accountId;

    // Phoenix still sends the retained `mystpax` self-alias in one account-info
    // request after launcher auth has established the UUID. Keep the requested
    // accountId in the response, but source the display name from the authenticated
    // launcher account so the local Social header has a usable name.
    const AuthenticatedUserId = req.AuthData.userId;
    const NameLookupUserId = AccountIdToLookupFromRequest === (process.env.DEV_USER_ID ?? "mystpax") &&
        AuthenticatedUserId !== AccountIdToLookupFromRequest
        ? AuthenticatedUserId
        : AccountIdToLookupFromRequest;
    const Username = await GetUsernameForUserId(NameLookupUserId);

    // We allow anybody to look up anybody's account from their account id.
    // IMPORTANT: echo the LOOKED-UP accountId (not the requestor's own). Returning the
    // requestor's id here made every *other* player resolve to the requestor's id + epic
    // link — so the game reported "No Epic Account" for them and multiplayer player-identity
    // resolution broke (only self-lookups were ever correct, which is why single-player worked).

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


// [1.12.0] auth-prod.steelyard.ca/isbanned - login flow blocks (404->NotFound) without this.
loginRouter.get("/isbanned", (req, res) => {
    logger.info("Is banned check (stubbed)");

    res.status(200).json({
        "isBanned": false
    });
});
