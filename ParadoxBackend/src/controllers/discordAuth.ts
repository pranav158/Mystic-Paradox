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

import crypto from "crypto";
import { GetRepositories } from "../persistence";
import { GenerateOpaqueToken, HashOpaqueToken } from "../security/launcherTokens";
import { LauncherApiError } from "../security/launcherErrors";
import { CreateSessionForUser, ToAccountView, LauncherSessionResult } from "./launcherAuth";
import { logger } from "../logger";
import { AssertAccountAdmitted } from "../security/accountEligibility";

const STATE_TTL_MS = 5 * 60 * 1000; 
const COMPLETION_CODE_TTL_MS = 60 * 1000; 

function GetDeepLinkScheme(): string {
    return process.env.LAUNCHER_DEEPLINK_SCHEME ?? "mysticparadox";
}

function RequireDiscordConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
    const ClientId = process.env.DISCORD_CLIENT_ID;
    const ClientSecret = process.env.DISCORD_CLIENT_SECRET;
    const RedirectUri = process.env.DISCORD_REDIRECT_URI;

    if (!ClientId || !ClientSecret || !RedirectUri) {
        throw new LauncherApiError(
            "AUTH_DISCORD_NOT_CONFIGURED",
            "Discord sign-in isn't set up on this server yet."
        );
    }

    return { clientId: ClientId, clientSecret: ClientSecret, redirectUri: RedirectUri };
}

function Base64Url(input: Buffer): string {
    return input.toString("base64url");
}

export async function StartDiscordAuth(): Promise<{ authorizeUrl: string }> {
    const { clientId, redirectUri } = RequireDiscordConfig();

    const State = crypto.randomBytes(24).toString("hex");
    const CodeVerifier = Base64Url(crypto.randomBytes(32));
    const CodeChallenge = Base64Url(crypto.createHash("sha256").update(CodeVerifier).digest());

    const Now = new Date();

    await GetRepositories().discordOAuthTransactions.create({
        state: State,
        codeVerifier: CodeVerifier,
        createdAt: Now.toISOString(),
        expiresAt: new Date(Now.getTime() + STATE_TTL_MS).toISOString()
    });

    const Params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        
        
        
        scope: "identify",
        state: State,
        code_challenge: CodeChallenge,
        code_challenge_method: "S256"
    });

    return { authorizeUrl: `https://discord.com/api/oauth2/authorize?${Params.toString()}` };
}

interface DiscordUser {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
}

async function ExchangeDiscordCode(code: string, codeVerifier: string): Promise<DiscordUser> {
    const { clientId, clientSecret, redirectUri } = RequireDiscordConfig();

    const TokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
        })
    });

    if (!TokenResponse.ok) {
        logger.warn(`Discord token exchange failed: ${TokenResponse.status}`);
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in didn't complete. Please try again.");
    }

    const TokenBody = (await TokenResponse.json()) as { access_token: string; token_type: string };

    const UserResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `${TokenBody.token_type} ${TokenBody.access_token}` }
    });

    if (!UserResponse.ok) {
        logger.warn(`Discord user fetch failed: ${UserResponse.status}`);
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in didn't complete. Please try again.");
    }

    return (await UserResponse.json()) as DiscordUser;
}

async function ResolveOrCreateAccountForDiscordUser(discordUser: DiscordUser): Promise<string> {
    const Repos = GetRepositories();

    const ExistingIdentity = await Repos.authIdentities.findByProviderSubject("discord", discordUser.id);

    if (ExistingIdentity != undefined) {
        
        return ExistingIdentity.userId;
    }

    const UserId = crypto.randomUUID();
    const Now = new Date().toISOString();

    
    
    
    await Repos.launcherAccounts.create({
        userId: UserId,
        displayNameNormalized: UserId.toLowerCase(),
        displayName: UserId,
        status: "active",
        approvalStatus: "pending",
        roles: ["player"],
        createdAt: Now,
        usernameSet: false
        // No email/passwordHash — spec: never auto-merge accounts by email, and this
        // build doesn't request Discord's email scope in the first place.
    });

    await Repos.authIdentities.create({
        provider: "discord",
        providerSubject: discordUser.id,
        userId: UserId,
        providerUsername: discordUser.username,
        providerAvatarUrl: discordUser.avatar
            ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
            : undefined,
        linkedAt: Now
    });

    logger.info(`Launcher account created via Discord: ${UserId}`);

    return UserId;
}


export async function HandleDiscordCallback(code: string | undefined, state: string | undefined): Promise<string> {
    const Scheme = GetDeepLinkScheme();

    if (typeof code !== "string" || typeof state !== "string") {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in was cancelled.");
    }

    const Transaction = await GetRepositories().discordOAuthTransactions.consumeByState(state);

    if (Transaction == undefined) {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "That Discord sign-in link has expired.");
    }

    const DiscordUser = await ExchangeDiscordCode(code, Transaction.codeVerifier);
    const UserId = await ResolveOrCreateAccountForDiscordUser(DiscordUser);

    const CompletionCode = GenerateOpaqueToken();
    const CompletionExpiresAt = new Date(Date.now() + COMPLETION_CODE_TTL_MS).toISOString();

    await GetRepositories().discordOAuthTransactions.attachCompletionCode(
        state,
        HashOpaqueToken(CompletionCode),
        CompletionExpiresAt,
        UserId
    );

    return `${Scheme}://auth/complete?code=${CompletionCode}`;
}

export async function CompleteDiscordLogin(rawCompletionCode: string, deviceId: string, deviceName: string): Promise<LauncherSessionResult> {
    if (typeof rawCompletionCode !== "string" || rawCompletionCode.length === 0) {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in didn't complete. Please try again.");
    }

    const Transaction = await GetRepositories().discordOAuthTransactions.consumeByCompletionCodeHash(HashOpaqueToken(rawCompletionCode));

    if (Transaction == undefined || Transaction.userId == undefined) {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "That sign-in link has expired. Please try again.");
    }

    const Account = await GetRepositories().launcherAccounts.findByUserId(Transaction.userId);

    if (Account == undefined) {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in didn't complete. Please try again.");
    }

    AssertAccountAdmitted(Account);

    const Session = await CreateSessionForUser(Account.userId, deviceId, deviceName);

    return { ...Session, account: await ToAccountView(Account) };
}
