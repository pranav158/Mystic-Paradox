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
import { GetRepositories } from "../persistence";
import { logger } from "../logger";
import { FindApiKeyRecord, HashApiKey } from "../security/apiKeyHash";

const PRIVKEY = Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64!, "base64").toString("utf-8");
const PUBKEY = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64!, "base64").toString("utf-8");

function HashUserAPIKey(UserAPIKeyToHash: string){
    return HashApiKey(UserAPIKeyToHash, "user");
}

export async function DrainAndRegisterUserAPIKeys(){
    const APIKeysToRegister = await GetRepositories().apiKeys.findAllUserKeysToRegister();

    await GetRepositories().apiKeys.clearUserKeysToRegister();

    // Count the stored hashes rather than reading the key list's size into the log line.
    let Registered = 0;
    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertUserKeyHash(APIKey.userId, HashUserAPIKey(APIKey.key));
        Registered++;
    }

    logger.info(`Registered ${Registered} new User API Key(s) on boot!`);
}

export async function GetUserIDForAPIKey(UserAPIKey: string){
    const AllAPIKeyHashes = await GetRepositories().apiKeys.findAllUserKeyHashes();

    // Only HMAC records match; a user key stored before HMAC hashing (plain SHA-256) must be registered again.
    return FindApiKeyRecord(AllAPIKeyHashes, HashUserAPIKey(UserAPIKey))?.userId;
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

// [2026-07-24] Store purchase tokens (Token/Platinum/GetPurchaseToken.md + Notification/
// BuyFromPurchaseToken.md - real endpoint captures, despite the "platinum" naming the GetPurchaseToken
// doc explicitly says "any catalogId from shop"). Deliberately a distinct issuer/audience from the
// account bearer token above: this token is single-purchase-scoped (short expiry, carries
// userId+characterId+storeTag+skuId, minted by GET /token/{currency}/:id and redeemed by
// POST /notification/platinum) and must never be accepted where an account bearer token is expected.
export type StorePurchaseTokenPayload = {
    userId: string;
    characterId: string;
    skuId: string;
    // Optional only so a token minted by the pre-registry Lady Luck build remains redeemable during
    // a rolling deployment. New tokens always bind the store identity.
    storeTag?: string;
};

function SignStorePurchaseToken(payload: StorePurchaseTokenPayload){
    return jwt.sign(payload, PRIVKEY, {
        algorithm: "RS256",
        expiresIn: "10m",
        issuer: "mysticparadox-store",
        audience: "mysticparadox-store-purchase"
    });
}

function ValidateStorePurchaseToken(token: string){
    return jwt.verify(token, PUBKEY, {
        algorithms: ["RS256"],
        issuer: "mysticparadox-store",
        audience: "mysticparadox-store-purchase"
    }) as StorePurchaseTokenPayload;
}

// Backward-compatible aliases for existing Lady Luck imports. New callers should use the generic
// names and include storeTag in the payload.
function SignLadyLuckPurchaseToken(payload: { userId: string; characterId: string; skuId: string }) {
    return SignStorePurchaseToken(payload);
}

function ValidateLadyLuckPurchaseToken(token: string) {
    return ValidateStorePurchaseToken(token);
}

export {
    SignMetagameJWTForUid,
    ValidateMetagameJWTAndGetPayload,
    SignStorePurchaseToken,
    ValidateStorePurchaseToken,
    SignLadyLuckPurchaseToken,
    ValidateLadyLuckPurchaseToken,
}