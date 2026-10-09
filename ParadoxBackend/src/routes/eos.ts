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
import { JwtPayload } from "jsonwebtoken";
import { logger } from "../logger";
import { GetUserIDForAPIKey, SignMetagameJWTForUid, ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { GetUsernameForUserId } from "../controllers/login";
import { GetRepositories } from "../persistence";
import { HashOpaqueToken } from "../security/launcherTokens";
import { IsAccountEligible } from "../security/accountEligibility";
import { LauncherApiError } from "../security/launcherErrors";
import {
    AssertRuntimeChannelMatchesAccount,
    AssertRuntimeHashApproved,
    ParseRuntimeChannel
} from "../security/runtimeAuthorization";

export const eosRouter = Router();

const DEV_USER_ID = process.env.DEV_USER_ID ?? "dev-user";
const DEV_USER_NAME = process.env.DEV_USER_NAME ?? "Dev Slayer";
// OAuth client-credentials grants authenticate the game application, not a
// player. Keep that token distinct from a real launcher account: the player's
// identity is established only by the preceding one-time exchange code.
const LAUNCHER_CLIENT_CREDENTIALS_USER_ID = "__launcher_client_credentials__";

// [hardening 2026-07-14] The AUTH_MODE=NONE branch below auto-creates and logs in as ANY
// arbitrary account with zero real authentication - it exists for local development only and
// must never be reachable in a real deployment. It was previously gated only by
// `NODE_ENV !== "production"`, which is a single easy-to-leave-unset environment variable away
// from silently activating in a real deployment (NODE_ENV is not guaranteed to be set by every
// process manager/host). Now ALSO requires this explicit second flag, so a real deployment must
// affirmatively opt into no-auth mode twice, not rely on a single env var's absence.
//
// Full removal of this fallback (replacing local dev's auth with AUTH_MODE=APIKEY end-to-end) is
// flagged as separate, explicit follow-up work before shipping multiplayer - it is not done here
// because it would break the current local dev workflow with no documented replacement in place.
const ALLOW_NO_AUTH_DEV_MODE = process.env.ALLOW_NO_AUTH_DEV_MODE === "true";

async function EnsureDevUser(userId: string){
    const ExistingUser = await GetRepositories().accounts.findByUserId(userId);

    if(ExistingUser === undefined){
        await GetRepositories().accounts.create({
            userId,
            name: DEV_USER_NAME,
            notes: 0
        });
    }
}

function GetBearerToken(req: any){
    const AuthHeader = req.headers.authorization;

    if(typeof AuthHeader !== "string"){
        return undefined;
    }

    const Parts = AuthHeader.split(" ");

    if(Parts.length !== 2 || Parts[0].toLowerCase() !== "bearer"){
        return undefined;
    }

    return Parts[1];
}

function GetUserIdFromBearerToken(req: any){
    const Token = GetBearerToken(req);

    if(Token === undefined){
        return undefined;
    }

    try{
        const Payload = ValidateMetagameJWTAndGetPayload(Token) as JwtPayload;

        if(typeof Payload.userId === "string" && Payload.userId.length > 0){
            return Payload.userId;
        }
    } catch {
        logger.warn("EOS oauth/token received an invalid bearer token while trying to preserve session identity");
    }

    return undefined;
}

eosRouter.post("/account/api/oauth/token", async (req, res) => {
    if(process.env.AUTH_MODE === "NONE" && process.env.NODE_ENV !== "production" && ALLOW_NO_AUTH_DEV_MODE){
        const ExchangeCode = req.body.exchange_code;
        const UserId = (typeof ExchangeCode === "string" && ExchangeCode.length > 0 && ExchangeCode !== "INVALID") ? ExchangeCode : (GetUserIdFromBearerToken(req) ?? DEV_USER_ID);

        await EnsureDevUser(UserId);

        logger.info("Logging in a user in no-auth dev mode.");

        const AuthToken = SignMetagameJWTForUid(UserId);

        res.json({
            "access_token": AuthToken,
            "token_type": "bearer",
            "expires_at": "2085-09-09T01:01:01.703Z", // TODO: We sign 24hr JWTs so we're unlikely to hit this, but just in case (tm)
            "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
            "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
            "product_id": "prod-jackal",
            "sandbox_id": "jackal",
            "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
            "expires_in": 86400,
            "refresh_token": "refresh.token.lol", // TODO: IDK if we need to support this considering our intended flow, but flagged regardless
            "refresh_expires_at": "2085-09-09T01:01:01.703Z",
            "account_id": UserId
        });
    }
    else if(process.env.AUTH_MODE === "APIKEY"){
        const ApiKey = req.body.exchange_code;

        const UserId = await GetUserIDForAPIKey(ApiKey);

        if(UserId != undefined){
            logger.info("Logging in a user by API key.");

            const AuthToken = SignMetagameJWTForUid(UserId);

            res.json({
                "access_token": AuthToken,
                "token_type": "bearer",
                "expires_at": "2085-09-09T01:01:01.703Z", // TODO: We sign 24hr JWTs so we're unlikely to hit this, but just in case (tm)
                "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
                "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
                "product_id": "prod-jackal",
                "sandbox_id": "jackal",
                "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
                "expires_in": 86400,
                "refresh_token": "refresh.token.lol", // TODO: IDK if we need to support this considering our intended flow, but flagged regardless
                "refresh_expires_at": "2085-09-09T01:01:01.703Z",
                "account_id": UserId
            });
        }
        else{
            logger.error(`Invalid API key auth!`);

            res.status(400);
            res.send();
        }
    }
    // [launcher wiring] Consumes the one-time codes POST /launcher/v1/game-sessions
    // issues (controllers/launcherAuth.ts RequestGameExchangeCode) — this is the one
    // integration point Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md flagged as the
    // remaining piece. The launcher's own auth (register/login/refresh) never touches
    // this route; this is only the game client trading a code for its normal game JWT.
    else if(process.env.AUTH_MODE === "LAUNCHER"){
        const RawExchangeCode = req.body.exchange_code;

        if(typeof RawExchangeCode !== "string" || RawExchangeCode.length === 0){
            // The 1.12 client makes a second normal OAuth request after its
            // player exchange: grant_type=client_credentials. It intentionally
            // contains no exchange_code because it authenticates the game app,
            // not the player. Do not consume or replay a player handoff code
            // here; return a separate service token instead.
            if(req.body?.grant_type === "client_credentials"){
                logger.info("LAUNCHER auth: issuing client-credentials token");

                const AuthToken = SignMetagameJWTForUid(LAUNCHER_CLIENT_CREDENTIALS_USER_ID);

                res.json({
                    "access_token": AuthToken,
                    "token_type": "bearer",
                    "expires_at": "2085-09-09T01:01:01.703Z",
                    "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
                    "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
                    "product_id": "prod-jackal",
                    "sandbox_id": "jackal",
                    "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
                    "expires_in": 86400
                });
                return;
            }

            logger.error("LAUNCHER auth: missing exchange_code");

            res.status(400);
            res.send();
            return;
        }

        const CodeRecord = await GetRepositories().gameExchangeCodes.consumeByCodeHash(HashOpaqueToken(RawExchangeCode));

        if(CodeRecord === undefined){
            // Retained dev/backup identity: when no one-time game-session code matches AND dev
            // mode is explicitly enabled (non-production), treat the value as a dev userId so the
            // kept-for-backup account (e.g. "mystpax", launched via start-client-direct.bat) can
            // still play alongside real launcher accounts. Gated by ALLOW_NO_AUTH_DEV_MODE so a
            // real deployment (flag unset) rejects any non-code value instead — launcher codes
            // remain single-use and this never weakens them.
            if(ALLOW_NO_AUTH_DEV_MODE && process.env.NODE_ENV !== "production"){
                logger.info(`LAUNCHER auth: no game-session code matched; dev fallback login as "${RawExchangeCode}"`);

                await EnsureDevUser(RawExchangeCode);

                const DevToken = SignMetagameJWTForUid(RawExchangeCode);

                res.json({
                    "access_token": DevToken,
                    "token_type": "bearer",
                    "expires_at": "2085-09-09T01:01:01.703Z",
                    "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
                    "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
                    "product_id": "prod-jackal",
                    "sandbox_id": "jackal",
                    "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
                    "expires_in": 86400,
                    "refresh_token": "refresh.token.lol",
                    "refresh_expires_at": "2085-09-09T01:01:01.703Z",
                    "account_id": RawExchangeCode
                });
                return;
            }

            logger.warn("LAUNCHER auth: exchange code missing, expired, or already consumed");

            res.status(401);
            res.send();
            return;
        }

        const TargetChangelist = Number(process.env.TARGET_CHANGELIST ?? NaN);

        // Fails closed if TARGET_CHANGELIST is unset/misconfigured, not open.
        if(!Number.isFinite(TargetChangelist) || CodeRecord.buildChangelist !== TargetChangelist){
            logger.warn(`LAUNCHER auth: build mismatch for ${CodeRecord.userId} (code build=${CodeRecord.buildChangelist}, target=${process.env.TARGET_CHANGELIST})`);

            res.status(409);
            res.send();
            return;
        }

        const Account = await GetRepositories().launcherAccounts.findByUserId(CodeRecord.userId);

        if(Account === undefined || !IsAccountEligible(Account)){
            logger.warn(`LAUNCHER auth: account ${CodeRecord.userId} is not eligible`);

            res.status(403);
            res.send();
            return;
        }

        // Re-check the channel and exact signed-manifest runtime hash when the game redeems the
        // one-time code. A Tester revocation or runtime release change during the code's 60-second
        // lifetime therefore invalidates the code instead of allowing stale beta access.
        try {
            const RuntimeChannel = ParseRuntimeChannel(CodeRecord.runtimeChannel);
            AssertRuntimeChannelMatchesAccount(RuntimeChannel, Account.roles);
            AssertRuntimeHashApproved(RuntimeChannel, CodeRecord.runtimeSha256);
        } catch (error) {
            const Code = error instanceof LauncherApiError ? error.code : "INTERNAL";
            logger.warn(`LAUNCHER auth: runtime authorization failed for ${CodeRecord.userId} (${Code})`);
            res.status(403);
            res.send();
            return;
        }

        logger.info("Logging in a user via a launcher exchange code.");

        const AuthToken = SignMetagameJWTForUid(CodeRecord.userId);

        res.json({
            "access_token": AuthToken,
            "token_type": "bearer",
            "expires_at": "2085-09-09T01:01:01.703Z",
            "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
            "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
            "product_id": "prod-jackal",
            "sandbox_id": "jackal",
            "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
            "expires_in": 86400,
            "refresh_token": "refresh.token.lol",
            "refresh_expires_at": "2085-09-09T01:01:01.703Z",
            "account_id": CodeRecord.userId
        });
    }
    else{
        logger.fatal("No login method configured! (AUTH_MODE is unset/unrecognized, or AUTH_MODE=NONE without ALLOW_NO_AUTH_DEV_MODE=true)");
        res.status(500);
        res.send();
    }
});

eosRouter.get("/account/api/oauth/verify", (req, res) => {
    logger.info("Verifying token");

    const Token = GetBearerToken(req);

    if(Token === undefined){
        res.status(401);
        res.send();
        return;
    }

    let AccountId: string;

    try{
        const Payload = ValidateMetagameJWTAndGetPayload(Token) as JwtPayload;
        AccountId = Payload.userId;
    } catch {
        res.status(401);
        res.send();
        return;
    }

    res.json({
      "active": true,
      "scope": "basic_profile friends_list presence",
      "token_type": "bearer",
      "expires_in": 86400,
      "expires_at": "2085-09-09T01:01:01.703Z",
      "account_id": AccountId,
      "client_id": "xyza7891lhxMVYGCON7LgnKZZ8HQGD5H",
      "application_id": "fghi4567O03HROxEjwbn7kgXpBhnhWwv"
    });
});

type EpicPublicAccount = {
    id: string;
    displayName: string;
    externalAuths: Record<string, never>;
};

async function LookupEpicPublicAccount(accountId: string, displayNameOverride?: string): Promise<EpicPublicAccount | undefined> {
    const Account = await GetRepositories().accounts.findByUserId(accountId);
    const LauncherAccount = await GetRepositories().launcherAccounts.findByUserId(accountId);
    if (Account === undefined && LauncherAccount === undefined) return undefined;

    return {
        id: accountId,
        displayName: displayNameOverride ?? LauncherAccount?.displayName ?? Account?.name ?? accountId,
        // The Epic account is the core profile above. This map is only for linked
        // external platforms (PSN/XBL/etc.), so do not fabricate an "epic" entry.
        externalAuths: {}
    };
}

eosRouter.get("/account/api/public/account/:AccId", async (req, res) => {
    // Some Phoenix builds make this single-account request with the bearer
    // token attached, even though the endpoint itself is public. Apply the same
    // legacy-self alias treatment as the bulk endpoint when that token identifies
    // a launcher account; otherwise retain normal public lookup semantics.
    const RequesterId = GetUserIdFromBearerToken(req);
    const IsLegacySelfAlias = req.params.AccId === DEV_USER_ID &&
        RequesterId !== undefined && RequesterId !== DEV_USER_ID;
    const RequesterAccount = IsLegacySelfAlias
        ? await GetRepositories().launcherAccounts.findByUserId(RequesterId)
        : undefined;
    const Account = await LookupEpicPublicAccount(req.params.AccId, IsLegacySelfAlias ? RequesterAccount?.displayName : undefined);
    if (Account === undefined) {
        res.status(404).send();
        return;
    }

    res.json(Account);
});

eosRouter.get("/account/api/public/account/:AccId/externalAuths", async (req, res) => {
    const Account = await GetRepositories().accounts.findByUserId(req.params.AccId);
    if (Account === undefined) {
        res.status(404).send();
        return;
    }

    // Epic's /externalAuths contract is an array. Returning {} made the 1.12
    // client reject the identity payload and display "No Epic Account".
    res.json([]);
});

// Resolve a display name to an accountId so the client can invite a friend by name.
// Matches Epic's account-public-service display-name lookup. Searches launcher accounts
// (real registered players). Returns 404 if no such display name exists.
eosRouter.get("/account/api/public/account/displayName/:displayName", async (req, res) => {
    const DisplayName = typeof req.params.displayName === "string" ? req.params.displayName.trim() : "";
    const Account = await GetRepositories().launcherAccounts.findByDisplayNameNormalized(DisplayName.toLowerCase());

    if (Account === undefined) {
        logger.info(`Display-name lookup miss: ${DisplayName}`);
        res.status(404).send();
        return;
    }

    logger.info(`Display-name lookup: ${DisplayName} -> ${Account.userId}`);
    res.json({
        id: Account.userId,
        displayName: Account.displayName,
        externalAuths: {}
    });
});

eosRouter.delete("/account/api/oauth/sessions/kill", (req, res) => {
    logger.info("Session kill (stubbed)");

    // TODO: Is this needed?

    res.json({});
})

eosRouter.delete("/account/api/oauth/sessions/kill/:AuthToken", (req, res) => {
    logger.info("Session kill (stubbed)");

    // TODO: Is this needed?

    res.json({});
})

eosRouter.get("/account/api/public/account", HasParadoxBackendAuth, async (req: any, res) => {
    // This is Epic's bulk public-account lookup. The query key may be repeated:
    //   ?accountId=a&accountId=b
    // The response must always be an array, even for a single requested account.
    // Previously this ignored the query and returned one full profile object for
    // the authenticated user; 1.12 rejected it ("users is of the wrong type").
    const QueryValue = req.query.accountId;
    const RequestedIds = (Array.isArray(QueryValue) ? QueryValue : [QueryValue])
        .filter((Value): Value is string => typeof Value === "string" && Value.length > 0);

    // Preserve the old self-lookup behavior for callers that omit accountId while
    // still honoring the array contract.
    if (RequestedIds.length === 0) RequestedIds.push(req.AuthData.userId);

    // The 1.12 client still performs one legacy self-lookup as `mystpax` even
    // after launcher authentication has established the real UUID.  Keep the
    // requested id (the client uses it as its subsystem key), but use the
    // authenticated launcher's display name for that one compatibility alias.
    // Without this, the stale legacy account name (usually "Dev Slayer") wins
    // and the Social panel's local header remains blank/mismatched.
    const AuthenticatedLauncherAccount = await GetRepositories().launcherAccounts.findByUserId(req.AuthData.userId);
    const Accounts = (await Promise.all(RequestedIds.map((RequestedId) => {
        const IsLegacySelfAlias = RequestedId === DEV_USER_ID && req.AuthData.userId !== DEV_USER_ID;
        return LookupEpicPublicAccount(RequestedId, IsLegacySelfAlias ? AuthenticatedLauncherAccount?.displayName : undefined);
    })))
        .filter((Account): Account is EpicPublicAccount => Account !== undefined);

    logger.info(`Bulk account info requested=${RequestedIds.length} resolved=${Accounts.length}`);
    res.json(Accounts);
});
