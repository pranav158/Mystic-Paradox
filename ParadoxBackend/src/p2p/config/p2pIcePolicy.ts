/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-13] Configuration of the ICE co-op transport (SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md
// §5.5 and §6.1 step 1): STUN servers for hole punching, a TURN relay as the fallback, the relay quota and the
// secret the per-pair transport keys are derived from. Secrets never leave this module and the relay service;
// P2PIceSummary reports only whether they are set.

/** cloudflare: credentials minted through the Cloudflare TURN key API. turn-rest: a TURN server with a shared
 *  secret (coturn `use-auth-secret`), for self-hosting and local tests. none: STUN only. */
export type TurnProvider = "cloudflare" | "turn-rest" | "none";

export interface P2PIceConfig {
    stunUrls: string[];
    turnProvider: TurnProvider;
    /** Set only when the provider is cloudflare and both values are present. */
    cloudflare?: { keyId: string; apiToken: string };
    /** Set only when the provider is turn-rest and both values are valid. */
    turnRest?: { urls: string[]; secret: string };
    /** Upper bound of a credential's lifetime; Cloudflare allows at most 48 hours. */
    maxCredentialTtlSeconds: number;
    /**
     * The same bound for a realm hub (the realm's Ramsgate or Training on the host's PC), default 24 h: a hub runs for up to
     * a day and its transport cannot take a new credential while it runs, so the launcher restarts the hub before the
     * credential ends - a 3 h credential would restart every hub every 3 h. Optional so older config literals still work.
     */
    realmHubCredentialTtlSeconds?: number;
    /** Relay traffic an account may receive per calendar month (UTC); 0 = no quota. */
    monthlyRelayQuotaBytes: number;
    /** Transport configurations one account may request per hour. */
    configsPerHour: number;
    /** Cloudflare GraphQL analytics (Account Analytics permission); measures the relay quota. */
    analytics?: { accountId: string; apiToken: string };
    /** Derives the per-pair transport keys; at least 32 characters. Without it the ICE transport is unavailable. */
    transportKeySecret?: string;
}

const STUN_URL = /^stuns?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const TURN_URL = /^turns?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const ACCOUNT_TAG = /^[A-Za-z0-9]{8,64}$/;
const DEFAULT_STUN_URLS = ["stun:stun.cloudflare.com:3478"];
const GB = 1_000_000_000;

function ReadUrls(value: string | undefined, pattern: RegExp): string[] {
    return (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => pattern.test(entry));
}

function ReadBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
    if (value == undefined || value.trim().length === 0) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function ReadToken(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed != undefined && TOKEN.test(trimmed) ? trimmed : undefined;
}

export function ReadP2PIceConfig(environment: NodeJS.ProcessEnv = process.env): P2PIceConfig {
    const configuredStun = ReadUrls(environment.P2P_ICE_STUN_URLS, STUN_URL);
    const provider = environment.P2P_TURN_PROVIDER?.trim().toLowerCase();
    const turnProvider: TurnProvider = provider === "turn-rest" || provider === "none" ? provider : "cloudflare";

    const keyId = environment.P2P_CLOUDFLARE_TURN_KEY_ID?.trim();
    const apiToken = ReadToken(environment.P2P_CLOUDFLARE_TURN_API_TOKEN);
    const cloudflare = turnProvider === "cloudflare" && keyId != undefined && ACCOUNT_TAG.test(keyId) && apiToken != undefined
        ? { keyId, apiToken }
        : undefined;

    const restUrls = ReadUrls(environment.P2P_TURN_REST_URLS, TURN_URL);
    const restSecret = environment.P2P_TURN_REST_SECRET?.trim();
    const turnRest = turnProvider === "turn-rest" && restUrls.length > 0 && restSecret != undefined && restSecret.length >= 16
        ? { urls: restUrls, secret: restSecret }
        : undefined;

    const analyticsAccount = environment.P2P_CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
    const analyticsToken = ReadToken(environment.P2P_CLOUDFLARE_ANALYTICS_API_TOKEN);
    const analytics = analyticsAccount != undefined && ACCOUNT_TAG.test(analyticsAccount) && analyticsToken != undefined
        ? { accountId: analyticsAccount, apiToken: analyticsToken }
        : undefined;

    const keySecret = environment.P2P_TRANSPORT_KEY_SECRET?.trim();
    return {
        stunUrls: configuredStun.length > 0 ? configuredStun : [...DEFAULT_STUN_URLS],
        turnProvider,
        cloudflare,
        turnRest,
        maxCredentialTtlSeconds: ReadBoundedInteger(environment.P2P_TURN_MAX_TTL_SECONDS, 10_800, 300, 172_800),
        realmHubCredentialTtlSeconds: ReadBoundedInteger(environment.P2P_REALM_HUB_TURN_TTL_SECONDS, 86_400, 300, 172_800),
        monthlyRelayQuotaBytes: ReadBoundedInteger(environment.P2P_RELAY_MONTHLY_QUOTA_GB, 10, 0, 100_000) * GB,
        configsPerHour: ReadBoundedInteger(environment.P2P_ICE_CONFIGS_PER_HOUR, 30, 1, 1_000),
        analytics,
        transportKeySecret: keySecret != undefined && keySecret.length >= 32 ? keySecret : undefined
    };
}

/** True when the configured provider can issue relay credentials. */
export function RelayConfigured(config: P2PIceConfig): boolean {
    return (config.turnProvider === "cloudflare" && config.cloudflare != undefined) ||
        (config.turnProvider === "turn-rest" && config.turnRest != undefined);
}

/** Startup log fields; no secret values. */
export function P2PIceSummary(config: P2PIceConfig) {
    return {
        iceStunServers: config.stunUrls.length,
        iceTurnProvider: config.turnProvider,
        iceRelayConfigured: RelayConfigured(config),
        iceRelayQuotaGb: config.monthlyRelayQuotaBytes / GB,
        iceRelayQuotaMeasured: config.monthlyRelayQuotaBytes > 0 && config.turnProvider === "cloudflare" &&
            config.analytics != undefined,
        iceTransportKeyConfigured: config.transportKeySecret != undefined
    };
}
