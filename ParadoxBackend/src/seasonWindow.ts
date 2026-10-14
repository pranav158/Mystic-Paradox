/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * [2026-10-13 realms S3 limits] The hunt-pass window arithmetic that routes/system.ts used to own, moved into a module
 * with no imports so that cooldownState.ts and bountyState.ts can bound a host's writes by it (system.ts imports both of
 * them, so they cannot import the router back). The values and the outputs of ActiveSeasonWindow are unchanged.
 *
 * [1.14.7 2026-10-08] The active pass gets a ROLLING 12-week window, not 2019-2099 (an 80-year window made every
 * bounty-board open build thousands of Challenges weeks and leak GBs, 38_ section 16.7-16.8). Live passes ran 84 days
 * starting Thursday 17:00 UTC (season24..26); the cycle is anchored on season27's real start, so the window always covers
 * the present and never spans more than 12 weeks.
 */

export const ACTIVE_SEASON_ANCHOR_MS = Date.parse("2024-09-26T17:00:00+00:00");
export const ACTIVE_SEASON_LENGTH_MS = 84 * 24 * 60 * 60 * 1000;

export function IsoUtc(Ms: number): string {
    return new Date(Ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** The window that contains `NowMs`, as instants: [startMs, endMs). */
export function ActiveSeasonWindowMs(NowMs: number): { startMs: number; endMs: number } {
    const Cycle = Math.floor((NowMs - ACTIVE_SEASON_ANCHOR_MS) / ACTIVE_SEASON_LENGTH_MS);
    const StartMs = ACTIVE_SEASON_ANCHOR_MS + Cycle * ACTIVE_SEASON_LENGTH_MS;
    return { startMs: StartMs, endMs: StartMs + ACTIVE_SEASON_LENGTH_MS };
}

/** The same window as the "+00:00" strings the served progression config carries. */
export function ActiveSeasonWindow(NowMs: number): { start: string; end: string } {
    const { startMs, endMs } = ActiveSeasonWindowMs(NowMs);
    return { start: IsoUtc(startMs), end: IsoUtc(endMs) };
}
