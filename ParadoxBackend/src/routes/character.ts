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
import { CreateCharacterForUid, GetCharactersForUid, GetCharacterWithUid, UpdateCharacterForUid } from "../controllers/character";
import express from "express";

export const characterRouter = Router();





const NO_PLAYER_SENTINEL = "INVALID";

function IsNoPlayerSentinel(UserId: unknown): boolean {
    return UserId === undefined || UserId === NO_PLAYER_SENTINEL;
}

characterRouter.get("/character", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    if(IsNoPlayerSentinel(UserId)){
        logger.debug(`GET /character called with no-player sentinel (userId=${UserId}) - returning empty character list, not touching DB`);

        res.status(200);
        res.json([]);
        return;
    }

    const CharactersForUid = await GetCharactersForUid(UserId);

    logger.info(`Retrieved ${CharactersForUid.length} characters for ${UserId}`);

    res.status(200);
    res.json(CharactersForUid);
});

characterRouter.put("/character", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const CharacterNameToCreate = req.body.name;

    if(IsNoPlayerSentinel(UserId)){
        logger.debug(`PUT /character called with no-player sentinel (userId=${UserId}) - refusing to create a character, not touching DB`);

        res.status(400);
        res.send();
        return;
    }

    logger.info(`Creating a character named ${CharacterNameToCreate} for user ${UserId}`);

    let NewCharacter = await CreateCharacterForUid(UserId, CharacterNameToCreate);

    res.status(200);
    res.json(NewCharacter);
})

characterRouter.post("/character", HasParadoxBackendAuth, async (req: any, res) => {
    const CharacterIdToUpdate = req.body.characterId;
    
    
    
    
    
    
    
    const UserId = req.AuthData.IsGameserver
        ? (req.body.accountId ?? req.AuthData.userId)
        : req.AuthData.userId;
    const DataToUpdateWith = req.body.data;
    const UpdateVersion = req.body.updateVersion;

    if(IsNoPlayerSentinel(UserId)){
        logger.warn(`POST /character called without a resolvable userId (authUserId=${req.AuthData.userId}, bodyAccountId=${req.body.accountId}) - refusing to update, not touching DB`);

        res.status(400);
        res.send();
        return;
    }

    logger.info(`Updating characterId ${CharacterIdToUpdate} for userId ${UserId} with updateVersion ${UpdateVersion} (IsGameserver=${req.AuthData.IsGameserver === true ? "Y" : "N"})`);

    const DidSucceed = await UpdateCharacterForUid(
        CharacterIdToUpdate,
        UserId,
        DataToUpdateWith,
        UpdateVersion,
        req.AuthData.IsGameserver === true   
    );

    if(!DidSucceed){
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        logger.warn(`Update conflict for characterId ${CharacterIdToUpdate} (userId ${UserId}) - returning HTTP 409 HTML matching real 1.12 server (Phoenix HTTP recognizes and does follow-up GET)`);

        res.status(409);
        res.setHeader("Content-Type", "text/html;charset=ISO-8859-1");
        res.send(
            "<html>\n" +
            "<head>\n" +
            "<meta http-equiv=\"Content-Type\" content=\"text/html;charset=ISO-8859-1\"/>\n" +
            "<title>Error 409 </title>\n" +
            "</head>\n" +
            "<body>\n" +
            "<h2>HTTP ERROR: 409</h2>\n" +
            "<p>Problem accessing /character. Reason:\n" +
            "<pre>    Conflict</pre></p>\n" +
            "<hr />\n" +
            "</body>\n" +
            "</html>\n"
        );
        return;
    }

    const UpdatedCharacter = await GetCharacterWithUid(CharacterIdToUpdate, UserId);

    res.status(200);
    res.json(UpdatedCharacter);
});
