/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "crypto";
import { GetRepositories, GetUnitOfWork, LauncherAccountRecord } from "../persistence";
import { GenerateOpaqueToken, HashOpaqueToken } from "../security/launcherTokens";
import { IsAccountEligible } from "../security/accountEligibility";
import { IsRateLimited } from "../security/rateLimit";
import { ADMIN_COOKIE_NAME } from "../middleware/HasAdminAuth";
import { logger } from "../logger";

const STATE_TTL_MS = 5 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;
const DISCORD_STATE_NONCE_BYTES = 24;
const DISCORD_STATE_MAC_BYTES = 32;
const DISCORD_STATE_PATTERN = /^v1\.([a-f0-9]{48})\.([a-f0-9]{64})$/;
const DISCORD_BROWSER_BINDING_BYTES = 32;
const DISCORD_BROWSER_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ADMIN_DISCORD_BINDING_COOKIE_NAME = "mysticparadox_admin_oauth";
const ADMIN_OAUTH_ACTOR = "system:admin-discord-oauth";

interface AdminDiscordConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    allowedIds: ReadonlySet<string>;
}

interface DiscordUser {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
}

type AdminResolution =
    | { kind: "existing" | "promoted" | "bootstrapped"; account: LauncherAccountRecord }
    | { kind: "ineligible" };

export function ParseAdminDiscordAllowedIds(raw: string | undefined = process.env.ADMIN_DISCORD_ALLOWED_IDS): string[] {
    if (raw == undefined || raw.trim().length === 0) {
        throw new Error("ADMIN_DISCORD_ALLOWED_IDS_NOT_CONFIGURED");
    }

    const Ids = [...new Set(raw.split(",").map((Value) => Value.trim()).filter(Boolean))];
    if (Ids.length === 0 || Ids.some((Id) => !DISCORD_ID_PATTERN.test(Id))) {
        throw new Error("ADMIN_DISCORD_ALLOWED_IDS_INVALID");
    }
    return Ids;
}

/** Creates a valid, deterministic 3–16 character launcher name for a newly
 * bootstrapped admin account without trusting Discord display-name characters. */
export function AdminBootstrapDisplayName(discordId: string): string {
    if (!DISCORD_ID_PATTERN.test(discordId)) {
        throw new Error("ADMIN_DISCORD_ID_INVALID");
    }
    return `A${BigInt(discordId).toString(36)}`;
}

function RequireSecureUrl(raw: string | undefined, variableName: string): URL {
    if (raw == undefined || raw.trim().length === 0) {
        throw new Error(`${variableName}_NOT_CONFIGURED`);
    }

    let Url: URL;
    try {
        Url = new URL(raw);
    } catch {
        throw new Error(`${variableName}_INVALID`);
    }

    const IsLocalDevelopment = process.env.NODE_ENV !== "production"
        && Url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(Url.hostname);

    if (Url.protocol !== "https:" && !IsLocalDevelopment) {
        throw new Error(`${variableName}_MUST_USE_HTTPS`);
    }
    if (Url.username || Url.password || Url.hash) {
        throw new Error(`${variableName}_INVALID`);
    }
    return Url;
}

function AdminFrontendUrl(): URL {
    const Url = RequireSecureUrl(process.env.ADMIN_FRONTEND_URL, "ADMIN_FRONTEND_URL");
    if (Url.search) {
        throw new Error("ADMIN_FRONTEND_URL_INVALID");
    }
    if (!Url.pathname.endsWith("/")) Url.pathname += "/";
    return Url;
}

export function BuildAdminFrontendRedirect(error?: string): string {
    const Url = AdminFrontendUrl();
    if (error) Url.searchParams.set("error", error);
    return Url.toString();
}

function RequireDiscordConfig(): AdminDiscordConfig {
    const ClientId = process.env.DISCORD_CLIENT_ID;
    const ClientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!ClientId || !ClientSecret) {
        throw new Error("ADMIN_DISCORD_NOT_CONFIGURED");
    }

    const RedirectUrl = RequireSecureUrl(process.env.ADMIN_DISCORD_REDIRECT_URI, "ADMIN_DISCORD_REDIRECT_URI");
    if (RedirectUrl.search || RedirectUrl.origin !== AdminFrontendUrl().origin) {
        // The callback sets a host-only admin cookie. It must therefore terminate on
        // the same browser origin as the dashboard that subsequently calls /admin/v1.
        throw new Error("ADMIN_DISCORD_REDIRECT_URI_INVALID");
    }

    return {
        clientId: ClientId,
        clientSecret: ClientSecret,
        redirectUri: RedirectUrl.toString(),
        allowedIds: new Set(ParseAdminDiscordAllowedIds())
    };
}

function Base64Url(input: Buffer): string {
    return input.toString("base64url");
}

/**
 * Create an OAuth state that is cryptographically bound to a secret held only in a short-lived,
 * HttpOnly browser cookie. Discord sees the state value but never the browser binding, so stealing
 * or pre-seeding a state value alone cannot complete an administrator login in another browser.
 */
export function CreateBoundAdminDiscordState(
    browserBinding: string,
    nonceHex = crypto.randomBytes(DISCORD_STATE_NONCE_BYTES).toString("hex")
): string {
    if (!DISCORD_BROWSER_BINDING_PATTERN.test(browserBinding)) {
        throw new Error("ADMIN_DISCORD_BROWSER_BINDING_INVALID");
    }
    if (!/^[a-f0-9]{48}$/.test(nonceHex)) {
        throw new Error("ADMIN_DISCORD_STATE_NONCE_INVALID");
    }

    const BindingKey = Buffer.from(browserBinding, "base64url");
    if (BindingKey.length !== DISCORD_BROWSER_BINDING_BYTES) {
        throw new Error("ADMIN_DISCORD_BROWSER_BINDING_INVALID");
    }
    const Mac = crypto.createHmac("sha256", BindingKey)
        .update(`v1\0${nonceHex}`, "utf8")
        .digest("hex");
    return `v1.${nonceHex}.${Mac}`;
}

/** Verifies the browser-held binding before the Discord code is exchanged. */
export function VerifyBoundAdminDiscordState(state: string, browserBinding: string | undefined): boolean {
    const Match = DISCORD_STATE_PATTERN.exec(state);
    if (!Match || browserBinding == undefined || !DISCORD_BROWSER_BINDING_PATTERN.test(browserBinding)) {
        return false;
    }

    let Expected: string;
    try {
        Expected = CreateBoundAdminDiscordState(browserBinding, Match[1]).split(".")[2];
    } catch {
        return false;
    }
    const Actual = Buffer.from(Match[2], "hex");
    const ExpectedBytes = Buffer.from(Expected, "hex");
    return Actual.length === DISCORD_STATE_MAC_BYTES
        && ExpectedBytes.length === DISCORD_STATE_MAC_BYTES
        && crypto.timingSafeEqual(Actual, ExpectedBytes);
}

function CookieSecuritySuffix(): string {
    const Secure = process.env.NODE_ENV === "production" || /^(1|true)$/i.test(process.env.ADMIN_COOKIE_SECURE ?? "");
    return Secure ? "; Secure" : "";
}

export function AdminDiscordBindingCookie(value?: string): string {
    const Encoded = value == undefined ? "" : encodeURIComponent(value);
    const MaxAge = value == undefined ? 0 : Math.ceil(STATE_TTL_MS / 1000);
    // SameSite=Lax is intentional: Discord returns via a cross-site, top-level GET. Strict would
    // suppress this one-time binding on the callback and make the secure flow unusable.
    return `${ADMIN_DISCORD_BINDING_COOKIE_NAME}=${Encoded}; Path=/admin/v1/auth/discord; HttpOnly; SameSite=Lax; Max-Age=${MaxAge}${CookieSecuritySuffix()}`;
}

function AdminCookieOptions(maxAgeSeconds = ADMIN_SESSION_TTL_MS / 1000): string {
    const Secure = process.env.NODE_ENV === "production" || /^(1|true)$/i.test(process.env.ADMIN_COOKIE_SECURE ?? "");
    return `Path=/admin/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${Secure ? "; Secure" : ""}`;
}

export async function StartAdminDiscordAuth(ip: string): Promise<{ authorizeUrl: string; setCookie?: string }> {
    const Config = RequireDiscordConfig();
    if (IsRateLimited(`admin-discord-start:${ip}`, 12, OAUTH_RATE_WINDOW_MS)) {
        return { authorizeUrl: BuildAdminFrontendRedirect("rate_limited") };
    }

    const BrowserBinding = Base64Url(crypto.randomBytes(DISCORD_BROWSER_BINDING_BYTES));
    const State = CreateBoundAdminDiscordState(BrowserBinding);
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
        client_id: Config.clientId,
        redirect_uri: Config.redirectUri,
        response_type: "code",
        scope: "identify",
        state: State,
        code_challenge: CodeChallenge,
        code_challenge_method: "S256"
    });

    return {
        authorizeUrl: `https://discord.com/api/oauth2/authorize?${Params.toString()}`,
        setCookie: AdminDiscordBindingCookie(BrowserBinding)
    };
}

async function ExchangeDiscordCode(code: string, codeVerifier: string, Config: AdminDiscordConfig): Promise<DiscordUser> {
    const TokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: Config.clientId,
            client_secret: Config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: Config.redirectUri,
            code_verifier: codeVerifier
        })
    });

    if (!TokenResponse.ok) {
        logger.warn(`[ADMIN] Discord token exchange failed: ${TokenResponse.status}`);
        throw new Error("AUTH_DISCORD_CANCELLED");
    }

    const TokenBody = (await TokenResponse.json()) as { access_token?: unknown };
    if (typeof TokenBody.access_token !== "string" || TokenBody.access_token.length === 0) {
        throw new Error("AUTH_DISCORD_CANCELLED");
    }

    const UserResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${TokenBody.access_token}` }
    });

    if (!UserResponse.ok) {
        logger.warn(`[ADMIN] Discord user fetch failed: ${UserResponse.status}`);
        throw new Error("AUTH_DISCORD_CANCELLED");
    }

    const Body = (await UserResponse.json()) as Record<string, unknown>;
    if (!DISCORD_ID_PATTERN.test(String(Body.id ?? "")) || typeof Body.username !== "string") {
        throw new Error("AUTH_DISCORD_CANCELLED");
    }

    return {
        id: String(Body.id),
        username: Body.username,
        global_name: typeof Body.global_name === "string" ? Body.global_name : null,
        avatar: typeof Body.avatar === "string" ? Body.avatar : null
    };
}

function IsDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

async function ResolveAdminAccountForDiscordUser(discordUser: DiscordUser, ip: string): Promise<AdminResolution> {
    try {
        const Resolution = await GetUnitOfWork().withTransaction<AdminResolution>(async (Repos, Session) => {
            const ExistingIdentity = await Repos.authIdentities.findByProviderSubject("discord", discordUser.id, Session);
            const Now = new Date().toISOString();

            if (ExistingIdentity != undefined) {
                const Account = await Repos.launcherAccounts.findByUserId(ExistingIdentity.userId, Session);
                if (!Account) throw new Error("ADMIN_DISCORD_LINKED_ACCOUNT_MISSING");

                // Do not mutate roles on pending, rejected, disabled, banned, or
                // username-incomplete accounts. This avoids latent admin promotion.
                if (!IsAccountEligible(Account)) return { kind: "ineligible" };
                if (Account.roles.includes("admin")) return { kind: "existing", account: Account };

                const NextRoles = [...new Set([...Account.roles, "admin"])] as string[];
                const Updated = await Repos.launcherAccounts.updateRoles(
                    Account.userId,
                    NextRoles,
                    { rolesUpdatedAt: Now, rolesUpdatedBy: ADMIN_OAUTH_ACTOR },
                    Session
                );
                if (!Updated) throw new Error("ADMIN_DISCORD_ACCOUNT_DISAPPEARED");

                await Repos.admin.appendAudit({
                    id: crypto.randomUUID(),
                    actorUserId: ADMIN_OAUTH_ACTOR,
                    targetUserId: Account.userId,
                    action: "admin.discord.promote",
                    oldState: { roles: Account.roles },
                    newState: { roles: Updated.roles },
                    reason: "Allow-listed Discord identity promoted an eligible linked account.",
                    ip,
                    requestId: crypto.randomUUID(),
                    createdAt: Now
                }, Session);

                return { kind: "promoted", account: Updated };
            }

            const UserId = crypto.randomUUID();
            const DisplayName = AdminBootstrapDisplayName(discordUser.id);
            const Account: LauncherAccountRecord = {
                userId: UserId,
                displayNameNormalized: DisplayName.toLowerCase(),
                displayName: DisplayName,
                status: "active",
                approvalStatus: "approved",
                approvalUpdatedAt: Now,
                approvalUpdatedBy: ADMIN_OAUTH_ACTOR,
                roles: ["admin"],
                rolesUpdatedAt: Now,
                rolesUpdatedBy: ADMIN_OAUTH_ACTOR,
                createdAt: Now,
                usernameSet: true
            };

            await Repos.launcherAccounts.create(Account, Session);
            await Repos.authIdentities.create({
                provider: "discord",
                providerSubject: discordUser.id,
                userId: UserId,
                providerUsername: discordUser.username,
                providerAvatarUrl: discordUser.avatar
                    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
                    : undefined,
                linkedAt: Now
            }, Session);
            await Repos.admin.appendAudit({
                id: crypto.randomUUID(),
                actorUserId: ADMIN_OAUTH_ACTOR,
                targetUserId: UserId,
                action: "admin.discord.bootstrap",
                newState: { status: Account.status, approvalStatus: Account.approvalStatus, roles: Account.roles },
                reason: "Allow-listed Discord identity bootstrapped the administrator account.",
                ip,
                requestId: crypto.randomUUID(),
                createdAt: Now
            }, Session);

            return { kind: "bootstrapped", account: Account };
        });

        if (Resolution.kind === "promoted") {
            logger.info(`[ADMIN] Eligible linked account promoted via Discord: ${Resolution.account.userId}`);
        } else if (Resolution.kind === "bootstrapped") {
            logger.info(`[ADMIN] Administrator account bootstrapped via Discord: ${Resolution.account.userId}`);
        }
        return Resolution;
    } catch (error) {
        // Concurrent first logins race on the unique provider+subject index. The
        // losing transaction is rolled back completely; reuse the committed winner.
        if (!IsDuplicateKeyError(error)) throw error;

        const Repos = GetRepositories();
        const ExistingIdentity = await Repos.authIdentities.findByProviderSubject("discord", discordUser.id);
        if (!ExistingIdentity) throw error;
        const Account = await Repos.launcherAccounts.findByUserId(ExistingIdentity.userId);
        if (!Account || !Account.roles.includes("admin") || !IsAccountEligible(Account)) {
            return { kind: "ineligible" };
        }
        return { kind: "existing", account: Account };
    }
}

export async function HandleAdminDiscordCallback(
    code: string | undefined,
    state: string | undefined,
    browserBinding: string | undefined,
    ip: string,
    userAgent: string
): Promise<{ redirectUrl: string; setCookie?: string }> {
    const Config = RequireDiscordConfig();
    if (IsRateLimited(`admin-discord-callback:${ip}`, 10, OAUTH_RATE_WINDOW_MS)) {
        return { redirectUrl: BuildAdminFrontendRedirect("rate_limited") };
    }

    if (typeof code !== "string" || typeof state !== "string") {
        return { redirectUrl: BuildAdminFrontendRedirect("discord_cancelled") };
    }

    const Transaction = await GetRepositories().discordOAuthTransactions.consumeByState(state);
    if (Transaction == undefined) {
        return { redirectUrl: BuildAdminFrontendRedirect("discord_expired") };
    }

    // Consume first, then verify: a stolen state presented without the short-lived HttpOnly
    // browser binding is burned and cannot be replayed or used as a login-CSRF primitive.
    if (!VerifyBoundAdminDiscordState(state, browserBinding)) {
        logger.warn(`[ADMIN] rejected Discord OAuth state without its browser binding ip=${ip}`);
        return { redirectUrl: BuildAdminFrontendRedirect("discord_state_mismatch") };
    }

    let DiscordUser: DiscordUser;
    try {
        DiscordUser = await ExchangeDiscordCode(code, Transaction.codeVerifier, Config);
    } catch {
        return { redirectUrl: BuildAdminFrontendRedirect("discord_cancelled") };
    }

    if (!Config.allowedIds.has(DiscordUser.id)) {
        logger.warn(`[ADMIN] rejected Discord admin login from disallowed id ${DiscordUser.id}`);
        return { redirectUrl: BuildAdminFrontendRedirect("discord_not_allowed") };
    }

    try {
        const Resolution = await ResolveAdminAccountForDiscordUser(DiscordUser, ip);
        if (Resolution.kind === "ineligible") {
            logger.warn(`[ADMIN] rejected Discord admin login for ineligible linked account id ${DiscordUser.id}`);
            return { redirectUrl: BuildAdminFrontendRedirect("discord_account_ineligible") };
        }

        const Account = Resolution.account;
        if (!Account.roles.includes("admin") || !IsAccountEligible(Account)) {
            return { redirectUrl: BuildAdminFrontendRedirect("discord_not_allowed") };
        }

        // Discord OAuth is intentionally the alternate MFA path for the allow-listed
        // owner identity; the password/TOTP requirement remains on AdminLogin only.
        const RawToken = GenerateOpaqueToken();
        const Now = new Date();
        const CsrfToken = GenerateOpaqueToken();
        await GetRepositories().admin.createSession({
            id: crypto.randomUUID(),
            tokenHash: HashOpaqueToken(RawToken),
            userId: Account.userId,
            csrfToken: CsrfToken,
            createdAt: Now.toISOString(),
            expiresAt: new Date(Now.getTime() + ADMIN_SESSION_TTL_MS).toISOString(),
            ip,
            userAgent: userAgent.slice(0, 300)
        });

        return {
            redirectUrl: BuildAdminFrontendRedirect(),
            setCookie: `${ADMIN_COOKIE_NAME}=${encodeURIComponent(RawToken)}; ${AdminCookieOptions()}`
        };
    } catch (error) {
        logger.error(`[ADMIN] Discord auth completion failed: ${error instanceof Error ? error.message : String(error)}`);
        return { redirectUrl: BuildAdminFrontendRedirect("discord_failed") };
    }
}
