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

import type { Request } from "express";
import { ipKeyGenerator, type Options } from "express-rate-limit";

// A deliberately simple in-memory sliding-window limiter — good enough to stop
// obvious single-process abuse during development, NOT the distributed/Redis-backed
// limiter spec section 14 calls for in production (documented as follow-up work
// in Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md). Resets on process restart and
// doesn't coordinate across multiple Metagame instances — both acceptable for now,
// neither acceptable for a public launch.
const Windows = new Map<string, number[]>();

export function IsRateLimited(key: string, maxAttempts: number, windowMs: number): boolean {
    const Now = Date.now();
    const Attempts = (Windows.get(key) ?? []).filter((t) => Now - t < windowMs);

    if (Attempts.length >= maxAttempts) {
        Windows.set(key, Attempts);
        return true;
    }

    Attempts.push(Now);
    Windows.set(key, Attempts);
    return false;
}

// [2026-10-11] Per-minute budget for every routed request (app.ts installs it ahead of the routers), on top of the
// stricter per-route limits above (login, register, update downloads and publishes, log uploads). Two buckets per
// address: gameserver-keyed calls, because every hub and hunt on one host shares its address, and everything else
// (game clients, launchers, the dashboard). The header only picks the bucket - HasParadoxBackendAuth still checks
// the key. Measured on the local stack 11 Oct: one player's login burst peaks at ~130 requests a minute, the hub
// serving that player at ~70. MYSTICPARADOX_RATE_LIMIT=off disables the budget;
// MYSTICPARADOX_RATE_LIMIT_PER_MINUTE and MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE change it.
export const DEFAULT_REQUESTS_PER_MINUTE = 600;
export const DEFAULT_GAMESERVER_REQUESTS_PER_MINUTE = 6000;

function IsGameserverRequest(req: Request): boolean {
    return req.headers["x-mysticparadox-gameserver-apikey"] !== undefined;
}

function PositiveInteger(value: string | undefined, fallback: number): number {
    const Parsed = Number(value?.trim());
    return Number.isInteger(Parsed) && Parsed > 0 ? Parsed : fallback;
}

export function RequestRateLimitOptions(environment: NodeJS.ProcessEnv = process.env): Partial<Options> {
    const Disabled = /^(0|off|false|no)$/i.test(environment.MYSTICPARADOX_RATE_LIMIT?.trim() ?? "");
    const PerMinute = PositiveInteger(environment.MYSTICPARADOX_RATE_LIMIT_PER_MINUTE, DEFAULT_REQUESTS_PER_MINUTE);
    const GameserverPerMinute = PositiveInteger(
        environment.MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE, DEFAULT_GAMESERVER_REQUESTS_PER_MINUTE);
    return {
        windowMs: 60_000,
        limit: (req: Request) => IsGameserverRequest(req) ? GameserverPerMinute : PerMinute,
        keyGenerator: (req: Request) =>
            `${IsGameserverRequest(req) ? "gameserver" : "client"}:${ipKeyGenerator(req.ip ?? "unknown")}`,
        skip: () => Disabled,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many requests. Please retry later." },
    };
}
