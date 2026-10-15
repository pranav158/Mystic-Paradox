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
import { CreateSessionForUser, ToAccountView, LauncherAccountView, LauncherSessionResult } from "./launcherAuth";
import { logger } from "../logger";
import { AssertAccountAdmitted } from "../security/accountEligibility";
import { IsDuplicateKeyError } from "../persistence/sqlite/errors";

// [2026-10-15] Discord never creates an account. Sign-in resolves a linked Discord user to its account (AUTH_DISCORD_NOT_LINKED
// otherwise). An account is linked from Settings (StartDiscordLink): the same OAuth, the transaction carries the signed-in account, and
// the callback links instead of signing in. The Discord user is asked for identify only, so no email comes from Discord.

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the Discord consent screen
const COMPLETION_CODE_TTL_MS = 60 * 1000; // matches the game exchange code's spec-driven lifetime

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

/**
 * [2026-10-15] Starts one OAuth transaction. Without linkUserId it is a sign-in; with it the callback links the Discord user to that account.
 */
async function CreateDiscordTransaction(linkUserId: string | undefined): Promise<{ authorizeUrl: string }> {
    const { clientId, redirectUri } = RequireDiscordConfig();

    const State = crypto.randomBytes(24).toString("hex");
    const CodeVerifier = Base64Url(crypto.randomBytes(32));
    const CodeChallenge = Base64Url(crypto.createHash("sha256").update(CodeVerifier).digest());

    const Now = new Date();

    await GetRepositories().discordOAuthTransactions.create({
        state: State,
        codeVerifier: CodeVerifier,
        createdAt: Now.toISOString(),
        expiresAt: new Date(Now.getTime() + STATE_TTL_MS).toISOString(),
        ...(linkUserId === undefined ? {} : { linkUserId })
    });

    const Params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        // identify only — spec: "email only if the product genuinely needs Discord's
        // email address," which this build doesn't (Discord-created accounts simply
        // have no email until/unless a future email/password link flow adds one).
        scope: "identify",
        state: State,
        code_challenge: CodeChallenge,
        code_challenge_method: "S256"
    });

    return { authorizeUrl: `https://discord.com/api/oauth2/authorize?${Params.toString()}` };
}

export async function StartDiscordAuth(): Promise<{ authorizeUrl: string }> {
    return CreateDiscordTransaction(undefined);
}

/**
 * [2026-10-15] POST /launcher/v1/account/discord/link/start (signed in): the Discord OAuth bound to the signed-in account, to link Discord in
 * Settings. An account that already has a Discord link is refused here as well as at the callback.
 */
export async function StartDiscordLink(userId: string): Promise<{ authorizeUrl: string }> {
    RequireDiscordConfig();
    const Repos = GetRepositories();
    if ((await Repos.launcherAccounts.findByUserId(userId)) == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }
    if ((await Repos.authIdentities.findByUserId("discord", userId)) != undefined) {
        throw new LauncherApiError("AUTH_DISCORD_ACCOUNT_HAS_LINK", "This account already has a Discord account linked.");
    }
    return CreateDiscordTransaction(userId);
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

/**
 * [2026-10-15] Resolves a Discord user to the account it is linked to, and never creates one: an unlinked Discord user is refused with
 * AUTH_DISCORD_NOT_LINKED. The name is kept from the plan (SteamDocs/DRAIN_EMAIL_GUARD_PLAN_2026_10_15.md), which calls it this; accounts
 * are made by registering with an email and then linking Discord in Settings. Accounts created through Discord before this keep signing in.
 */
export async function ResolveOrCreateAccountForDiscordUser(discordUser: DiscordUser): Promise<string> {
    const Identity = await GetRepositories().authIdentities.findByProviderSubject("discord", discordUser.id);

    if (Identity == undefined) {
        throw new LauncherApiError(
            "AUTH_DISCORD_NOT_LINKED",
            "Your Discord isn't linked to a Mystic Paradox account. Register with your email, then link Discord on the Account page."
        );
    }

    return Identity.userId;
}

/**
 * [2026-10-15] The callback of a link transaction: links the Discord user to the account the transaction was started for. An account has at
 * most one Discord link, and a Discord user belongs to at most one account (the unique index also refuses a parallel second link).
 */
async function LinkDiscordIdentity(linkUserId: string, discordUser: DiscordUser): Promise<void> {
    const Repos = GetRepositories();

    if ((await Repos.launcherAccounts.findByUserId(linkUserId)) == undefined) {
        throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in didn't complete. Please try again.");
    }
    if ((await Repos.authIdentities.findByUserId("discord", linkUserId)) != undefined) {
        throw new LauncherApiError("AUTH_DISCORD_ACCOUNT_HAS_LINK", "This account already has a Discord account linked.");
    }
    if ((await Repos.authIdentities.findByProviderSubject("discord", discordUser.id)) != undefined) {
        throw new LauncherApiError("AUTH_DISCORD_ALREADY_LINKED", "That Discord account is linked to another Mystic Paradox account.");
    }

    try {
        await Repos.authIdentities.create({
            provider: "discord",
            providerSubject: discordUser.id,
            userId: linkUserId,
            providerUsername: discordUser.username,
            providerAvatarUrl: discordUser.avatar
                ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
                : undefined,
            linkedAt: new Date().toISOString()
        });
    } catch (error) {
        if (IsDuplicateKeyError(error)) {
            throw new LauncherApiError("AUTH_DISCORD_ALREADY_LINKED", "That Discord account is linked to another Mystic Paradox account.");
        }
        throw error;
    }

    logger.info(`Discord linked to account ${linkUserId}`);
}

/**
 * Route handler calls this after Discord redirects back with ?code&state, then 302-redirects the BROWSER to the URL it returns. It never throws:
 * a sign-in answers auth/complete or auth/error, and a link answers link/done or link/error (the routes wrap it as before). A failure before the
 * transaction is known answers auth/error.
 */
export async function HandleDiscordCallback(code: string | undefined, state: string | undefined): Promise<string> {
    const Scheme = GetDeepLinkScheme();
    let Channel: "auth" | "link" = "auth";

    try {
        if (typeof code !== "string" || typeof state !== "string") {
            throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "Discord sign-in was cancelled.");
        }

        const Transaction = await GetRepositories().discordOAuthTransactions.consumeByState(state);

        if (Transaction == undefined) {
            throw new LauncherApiError("AUTH_DISCORD_CANCELLED", "That Discord sign-in link has expired.");
        }

        if (Transaction.linkUserId !== undefined) {
            Channel = "link";
            const DiscordUser = await ExchangeDiscordCode(code, Transaction.codeVerifier);
            await LinkDiscordIdentity(Transaction.linkUserId, DiscordUser);
            return `${Scheme}://link/done`;
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
    } catch (error) {
        if (!(error instanceof LauncherApiError)) {
            logger.error(`Unhandled error in Discord callback: ${error}`);
        }
        const Failure = error instanceof LauncherApiError ? error.code : "INTERNAL";
        return `${Scheme}://${Channel}/error?code=${encodeURIComponent(Failure)}`;
    }
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

/**
 * [2026-10-15] DELETE /launcher/v1/account/discord (signed in): unlinks the Discord user from the account. An account without a password
 * has Discord as its only sign-in, so its link stays (AUTH_DISCORD_ONLY_LOGIN). An account with no link is answered as it is.
 */
export async function UnlinkDiscordAccount(userId: string): Promise<{ account: LauncherAccountView }> {
    const Repos = GetRepositories();
    const Account = await Repos.launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }

    if ((await Repos.authIdentities.findByUserId("discord", userId)) != undefined) {
        if (Account.passwordHash == undefined) {
            throw new LauncherApiError("AUTH_DISCORD_ONLY_LOGIN", "Discord is this account's only sign-in, so it can't be unlinked.");
        }
        await Repos.authIdentities.deleteForUser("discord", userId);
        logger.info(`Discord unlinked from account ${userId}`);
    }

    return { account: await ToAccountView(Account) };
}
