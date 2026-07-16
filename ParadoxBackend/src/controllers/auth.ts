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

import jwt, {JwtPayload} from "jsonwebtoken";
import crypto from "crypto";
import { GetRepositories } from "../persistence";
import { logger } from "../logger";

const PRIVKEY = Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64!, "base64").toString("utf-8");
const PUBKEY = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64!, "base64").toString("utf-8");

function HashUserAPIKey(UserAPIKeyToHash: string){
    return crypto.createHash("sha256").update(UserAPIKeyToHash, "utf8").digest("hex");
}

export async function DrainAndRegisterUserAPIKeys(){
    const APIKeysToRegister = await GetRepositories().apiKeys.findAllUserKeysToRegister();

    await GetRepositories().apiKeys.clearUserKeysToRegister();

    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertUserKeyHash(APIKey.userId, HashUserAPIKey(APIKey.key));
    }

    logger.info(`Registered ${APIKeysToRegister.length} new User API Key(s) on boot!`);
}

export async function GetUserIDForAPIKey(UserAPIKey: string){
    const AllAPIKeyHashes = await GetRepositories().apiKeys.findAllUserKeyHashes();

    const IncomingUserAPIKeyHashBuffer = Buffer.from(HashUserAPIKey(UserAPIKey), "hex");

    let UserId: string | undefined = undefined;

    for(const CmpAPIKeyHash of AllAPIKeyHashes){
        const CmpAPIKeyHashBuffer = Buffer.from(CmpAPIKeyHash.keyHash!, "hex");

        if(CmpAPIKeyHashBuffer.length !== IncomingUserAPIKeyHashBuffer.length){
            continue;
        }

        if(crypto.timingSafeEqual(IncomingUserAPIKeyHashBuffer, CmpAPIKeyHashBuffer)){
            UserId = CmpAPIKeyHash.userId;
        }
    }

    return UserId;
}

function SignMetagameJWTForUid(userId: string){
    return jwt.sign({
        userId: userId
    }, PRIVKEY, {
        algorithm: "RS256",
        expiresIn: "24h",
        issuer: "paradox-backend",
        audience: "paradox-backend"
    });
}

function ValidateMetagameJWTAndGetPayload(token: string){
    return jwt.verify(token, PUBKEY, {
        algorithms: ["RS256"],
        issuer: "paradox-backend",
        audience: "paradox-backend"
    });
}







function SignLadyLuckPurchaseToken(payload: { userId: string; characterId: string; skuId: string }){
    return jwt.sign(payload, PRIVKEY, {
        algorithm: "RS256",
        expiresIn: "10m",
        issuer: "mysticparadox-store",
        audience: "mysticparadox-store-purchase"
    });
}

function ValidateLadyLuckPurchaseToken(token: string){
    return jwt.verify(token, PUBKEY, {
        algorithms: ["RS256"],
        issuer: "mysticparadox-store",
        audience: "mysticparadox-store-purchase"
    }) as { userId: string; characterId: string; skuId: string };
}

export { SignMetagameJWTForUid, ValidateMetagameJWTAndGetPayload, SignLadyLuckPurchaseToken, ValidateLadyLuckPurchaseToken }