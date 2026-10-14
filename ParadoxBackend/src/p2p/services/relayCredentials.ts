/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { logger } from "../../logger";
import { P2PIceConfig, RelayConfigured } from "../config/p2pIcePolicy";

// [2026-10-13] ICE servers for one participant of one player-hosted hunt: the STUN servers, plus short-lived TURN
// relay credentials when the relay is configured and the account is within its monthly relay quota. Without relay
// credentials the participant still gets STUN, so a direct connection can work. Plan: SteamDocs/
// HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md §5.5. Credentials and API tokens are never logged.

export interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export type RelayDeniedReason = "RELAY_NOT_CONFIGURED" | "RELAY_QUOTA_EXCEEDED" | "RELAY_PROVIDER_ERROR";

export interface RelayGrant {
    iceServers: IceServer[];
    relay: { allowed: true; ttlSeconds: number; expiresAt: string } | { allowed: false; reason: RelayDeniedReason };
}

export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<any> }>;

const CLOUDFLARE_RTC_API = "https://rtc.live.cloudflare.com/v1";
const CLOUDFLARE_GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
const PROVIDER_TIMEOUT_MS = 5_000;
const USAGE_CACHE_MS = 10 * 60_000;
const STUN_URL = /^stuns?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const TURN_URL = /^turns?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/;
// Cloudflare may add an alternate port-53 URL; many networks block it and ICE then waits for it to time out.
const PORT_53 = /:53(?:\?|$)/;
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;

class RelayProviderError extends Error {}

/**
 * [2026-10-14] The identifier the relay provider sees for an account (the Cloudflare customIdentifier, the TURN REST username):
 * SHA-256 of a fixed label and the account id, 32 hex characters. It is stable, so the monthly usage query finds the same account
 * again, and the account id itself never leaves this server (Privacy Policy section 3). Account ids are random UUIDs, so the
 * digest cannot be reversed by guessing.
 */
export function RelayAccountTag(accountId: string): string {
    return crypto.createHash("sha256").update(`mysticparadox-relay-tag-v1\n${accountId}`).digest("hex").slice(0, 32);
}

function AsUrlList(value: unknown): string[] {
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Reads a provider's ICE server list. Accepts both Cloudflare shapes - `iceServers` as an array (generate-ice-servers)
 * or as one object (the older generate endpoint) - and returns the STUN URLs and at most one TURN entry with
 * credentials. Port-53 URLs are dropped.
 */
export function NormalizeProviderIceServers(body: any): { stunUrls: string[]; turn?: Required<IceServer> } {
    const raw = body?.iceServers;
    const entries: any[] = Array.isArray(raw) ? raw : raw != undefined ? [raw] : [];
    const stunUrls: string[] = [];
    let turn: Required<IceServer> | undefined;
    for (const entry of entries) {
        const urls = AsUrlList(entry?.urls).filter((url) => !PORT_53.test(url));
        stunUrls.push(...urls.filter((url) => STUN_URL.test(url)));
        const turnUrls = urls.filter((url) => TURN_URL.test(url));
        if (turn == undefined && turnUrls.length > 0 &&
            typeof entry?.username === "string" && CREDENTIAL.test(entry.username) &&
            typeof entry?.credential === "string" && CREDENTIAL.test(entry.credential)) {
            turn = { urls: turnUrls, username: entry.username, credential: entry.credential };
        }
    }
    return { stunUrls: [...new Set(stunUrls)], turn };
}

async function CallProvider(fetchImpl: FetchLike, url: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        let json: any;
        try { json = await response.json(); } catch { json = undefined; }
        return { status: response.status, json };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Cloudflare TURN credentials tagged with the account's relay tag (`customIdentifier`, RelayAccountTag), so relay usage can be read
 * per account. The raw account id is never sent. The tag is not documented for generate-ice-servers; if Cloudflare rejects it, the
 * call is repeated without it and the quota for that account cannot be measured.
 */
export async function MintCloudflareCredentials(cloudflare: NonNullable<P2PIceConfig["cloudflare"]>, accountId: string,
    ttlSeconds: number, fetchImpl: FetchLike): Promise<{ stunUrls: string[]; turn: Required<IceServer> }> {
    const url = `${CLOUDFLARE_RTC_API}/turn/keys/${encodeURIComponent(cloudflare.keyId)}/credentials/generate-ice-servers`;
    let response = await CallProvider(fetchImpl, url, cloudflare.apiToken, { ttl: ttlSeconds, customIdentifier: RelayAccountTag(accountId) });
    if (response.status === 400) {
        logger.warn({ event: "p2p_relay_custom_identifier_rejected" },
            "[Relay] Cloudflare refused customIdentifier; relay usage per account cannot be measured");
        response = await CallProvider(fetchImpl, url, cloudflare.apiToken, { ttl: ttlSeconds });
    }
    if (response.status < 200 || response.status >= 300) {
        throw new RelayProviderError(`Cloudflare TURN credential request answered ${response.status}`);
    }
    const normalized = NormalizeProviderIceServers(response.json);
    if (normalized.turn == undefined) throw new RelayProviderError("Cloudflare TURN response carried no usable relay entry");
    return { stunUrls: normalized.stunUrls, turn: normalized.turn };
}

/** TURN REST credentials for a shared-secret TURN server (coturn `use-auth-secret`): user = expiry:relay tag (RelayAccountTag). */
export function MintTurnRestCredentials(turnRest: NonNullable<P2PIceConfig["turnRest"]>, accountId: string,
    ttlSeconds: number, nowMs: number): Required<IceServer> {
    const username = `${Math.floor(nowMs / 1000) + ttlSeconds}:${RelayAccountTag(accountId)}`;
    const credential = crypto.createHmac("sha1", turnRest.secret).update(username).digest("base64");
    return { urls: [...turnRest.urls], username, credential };
}

/** First day of the month (UTC) and today, as GraphQL Date literals. */
export function MonthWindow(now: Date): { from: string; to: string; month: string } {
    const month = now.toISOString().slice(0, 7);
    return { from: `${month}-01`, to: now.toISOString().slice(0, 10), month };
}

/**
 * Relay bytes Cloudflare sent to this account's clients this month (billing-safe form: one account, one value).
 * Undefined when the query fails; the sampled figure guides the quota, it is not an invoice.
 */
export async function ReadMonthlyRelayEgressBytes(analytics: NonNullable<P2PIceConfig["analytics"]>, accountId: string,
    now: Date, fetchImpl: FetchLike): Promise<number | undefined> {
    const window = MonthWindow(now);
    // Values are inlined as JSON string literals; the relay tag is a hex digest and the analytics account id is validated. The usage
    // query names the same relay tag the credentials were issued with, never the account id.
    const query = `query { viewer { usage: accounts(filter: { accountTag: ${JSON.stringify(analytics.accountId)} }) {
        callsTurnUsageAdaptiveGroups(filter: { date_geq: ${JSON.stringify(window.from)}, date_leq: ${JSON.stringify(window.to)},
            customIdentifier: ${JSON.stringify(RelayAccountTag(accountId))} }, limit: 1, orderBy: [customIdentifier_ASC]) { sum { egressBytes } } } } }`;
    try {
        const response = await CallProvider(fetchImpl, CLOUDFLARE_GRAPHQL_API, analytics.apiToken, { query });
        if (response.status !== 200 || (Array.isArray(response.json?.errors) && response.json.errors.length > 0)) return undefined;
        const viewer = response.json?.data?.viewer ?? {};
        const accounts = viewer.usage ?? viewer.accounts;
        const groups = Array.isArray(accounts) ? accounts[0]?.callsTurnUsageAdaptiveGroups : undefined;
        if (!Array.isArray(groups)) return undefined;
        const bytes = groups.reduce((sum: number, group: any) => sum + (Number(group?.sum?.egressBytes) || 0), 0);
        return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
    } catch {
        return undefined;
    }
}

/** Per-process cache of the monthly relay usage, so a burst of requests asks Cloudflare once. */
export class RelayUsageCache {
    private readonly entries = new Map<string, { month: string; bytes: number; fetchedAt: number }>();

    get(accountId: string, month: string, nowMs: number): number | undefined {
        const entry = this.entries.get(accountId);
        return entry != undefined && entry.month === month && nowMs - entry.fetchedAt < USAGE_CACHE_MS ? entry.bytes : undefined;
    }

    set(accountId: string, month: string, bytes: number, nowMs: number): void {
        if (this.entries.size > 10_000) this.entries.clear();
        this.entries.set(accountId, { month, bytes, fetchedAt: nowMs });
    }
}

/** Sliding one-hour window per key. In-process only; the request rate limiter still covers the route itself. */
export class HourlyCounter {
    private readonly hits = new Map<string, number[]>();

    allow(key: string, limit: number, nowMs: number): boolean {
        const recent = (this.hits.get(key) ?? []).filter((at) => nowMs - at < 3_600_000);
        if (recent.length >= limit) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(nowMs);
        this.hits.set(key, recent);
        if (this.hits.size > 10_000) {
            for (const [entryKey, times] of this.hits) if (times.every((at) => nowMs - at >= 3_600_000)) this.hits.delete(entryKey);
        }
        return true;
    }
}

export interface RelayGrantDependencies {
    fetchImpl: FetchLike;
    usageCache: RelayUsageCache;
    now: Date;
}

/** The ICE servers for one participant. Never throws for provider trouble: the answer then carries STUN only. */
export async function IssueRelayGrant(config: P2PIceConfig, accountId: string, ttlSeconds: number,
    deps: RelayGrantDependencies): Promise<RelayGrant> {
    const stunOnly = (reason: RelayDeniedReason): RelayGrant => ({
        iceServers: [{ urls: [...config.stunUrls] }],
        relay: { allowed: false, reason }
    });
    if (!RelayConfigured(config)) return stunOnly("RELAY_NOT_CONFIGURED");

    if (config.turnProvider === "cloudflare" && config.monthlyRelayQuotaBytes > 0 && config.analytics != undefined) {
        const { month } = MonthWindow(deps.now);
        let used = deps.usageCache.get(accountId, month, deps.now.getTime());
        if (used == undefined) {
            used = await ReadMonthlyRelayEgressBytes(config.analytics, accountId, deps.now, deps.fetchImpl);
            if (used != undefined) deps.usageCache.set(accountId, month, used, deps.now.getTime());
            // An unreadable usage figure does not block play; the per-hour request limit still applies.
            else logger.warn({ event: "p2p_relay_usage_unavailable" }, "[Relay] monthly relay usage could not be read");
        }
        if (used != undefined && used >= config.monthlyRelayQuotaBytes) return stunOnly("RELAY_QUOTA_EXCEEDED");
    }

    try {
        const expiresAt = new Date(deps.now.getTime() + ttlSeconds * 1000).toISOString();
        if (config.turnProvider === "cloudflare" && config.cloudflare != undefined) {
            const minted = await MintCloudflareCredentials(config.cloudflare, accountId, ttlSeconds, deps.fetchImpl);
            const stunUrls = [...new Set([...config.stunUrls, ...minted.stunUrls])];
            return { iceServers: [{ urls: stunUrls }, minted.turn], relay: { allowed: true, ttlSeconds, expiresAt } };
        }
        const turn = MintTurnRestCredentials(config.turnRest!, accountId, ttlSeconds, deps.now.getTime());
        return { iceServers: [{ urls: [...config.stunUrls] }, turn], relay: { allowed: true, ttlSeconds, expiresAt } };
    } catch (error) {
        const message = error instanceof RelayProviderError ? error.message : "relay provider request failed";
        logger.warn({ event: "p2p_relay_provider_error" }, `[Relay] ${message}`);
        return stunOnly("RELAY_PROVIDER_ERROR");
    }
}
