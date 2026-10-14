/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../../logger";
import { IncrementMetric } from "../../observability/metrics";

// [2026-10-14 realms wave 2, host route census] Which backend routes a player-host runtime actually calls. It only observes:
// nothing is blocked, because the host route allowlist waits for this list (owner decision). Counted are the requests the host
// runtime authentication accepted (req.AuthData.IsPlayerHostRuntime, set in security/hostRuntimeAuth.ts), by method, Express route
// pattern (with the router's mount path), status class and the session's kind when known. One `[HostRoute] summary {...}` line
// per window when there was traffic. Route patterns come from the code: never a raw URL, an id or a header value.
// Switch: MYSTICPARADOX_HOST_ROUTE_CENSUS=off (default on).

export const HOST_ROUTE_CENSUS_WINDOW_MS = 60_000;
export const HOST_ROUTE_CENSUS_MAX_ROWS = 200;
/** The header a player-host runtime authenticates with; a request without it is never a host runtime's. */
export const HOST_RUNTIME_CAPABILITY_HEADER = "x-mystic-host-capability";
/** res.locals key the host runtime authentication sets: the kind of the session the runtime serves. */
export const HOST_ROUTE_SESSION_LOCAL = "hostRouteSession";

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const KIND_PATTERN = /^[A-Z_]{1,32}$/;
const MAX_ROUTE_LENGTH = 160;
const NO_ROUTE = "(no route)";

/** The session a host runtime serves, as the authentication knows it (undefined fields are not known). */
export interface HostRouteSession {
    sessionKind?: string;
    hubKind?: string;
}

/** What one answered host request contributes. */
export interface HostRouteSample {
    method: string;
    route: string;
    statusCode: number;
    sessionKind?: string;
    hubKind?: string;
}

/** The counts of one (method, route, status class, session kind, hub kind). */
export interface HostRouteRow {
    method: string;
    route: string;
    status: string;
    sessionKind: string;
    hubKind: string | null;
    count: number;
}

export interface HostRouteSummary {
    windowSeconds: number;
    total: number;
    /** Most requests first, then by key; at most the row limit. */
    routes: HostRouteRow[];
    /** Rows left out of `routes` (keeps the log line bounded). */
    omittedRows: number;
}

/** "2xx" and so on; "other" for a code outside 100-599. */
export function HostRouteStatusClass(statusCode: number): string {
    return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : "other";
}

/** The sample as it is counted: a method outside the usual set is OTHER, an odd kind is "unknown" (no hub kind: null). */
export function NormalizeHostRouteSample(sample: HostRouteSample): Omit<HostRouteRow, "count"> {
    return {
        method: KNOWN_METHODS.has(sample.method) ? sample.method : "OTHER",
        route: sample.route.length > 0 && sample.route.length <= MAX_ROUTE_LENGTH ? sample.route : NO_ROUTE,
        status: HostRouteStatusClass(sample.statusCode),
        sessionKind: sample.sessionKind !== undefined && KIND_PATTERN.test(sample.sessionKind) ? sample.sessionKind : "unknown",
        hubKind: sample.hubKind !== undefined && KIND_PATTERN.test(sample.hubKind) ? sample.hubKind : null
    };
}

/**
 * The Express route pattern that answered the request, with the router's mount path. "(no route)" when no route answered; a route
 * whose pattern is not a string (a RegExp) reads "(pattern)". Never the request's URL.
 */
export function HostRouteOf(req: { route?: unknown; baseUrl?: string }): string {
    if (req.route === undefined || req.route === null) return NO_ROUTE;
    const pattern = (req.route as { path?: unknown }).path;
    return typeof pattern === "string" ? `${req.baseUrl ?? ""}${pattern}` : "(pattern)";
}

function RowKey(row: Omit<HostRouteRow, "count">): string {
    return [row.method, row.route, row.status, row.sessionKind, row.hubKind ?? ""].join("|");
}

function AddSample(counts: Map<string, HostRouteRow>, sample: HostRouteSample): void {
    const normalized = NormalizeHostRouteSample(sample);
    const key = RowKey(normalized);
    const existing = counts.get(key);
    if (existing !== undefined) existing.count += 1;
    else counts.set(key, { ...normalized, count: 1 });
}

/** Pure: the samples merged into one row per (method, route, status class, session kind, hub kind). */
export function AggregateHostRouteSamples(samples: Iterable<HostRouteSample>): HostRouteRow[] {
    const counts = new Map<string, HostRouteRow>();
    for (const sample of samples) AddSample(counts, sample);
    return [...counts.values()];
}

/**
 * Pure: the summary of merged rows, most requests first (ties by key), capped at `maxRows`. Undefined when nothing was counted,
 * so an idle minute logs nothing.
 */
export function SummarizeHostRoutes(rows: readonly HostRouteRow[], windowSeconds: number,
    maxRows: number = HOST_ROUTE_CENSUS_MAX_ROWS): HostRouteSummary | undefined {
    const counted = rows.filter((row) => row.count > 0);
    if (counted.length === 0) return undefined;
    const sorted = [...counted].sort((left, right) => right.count - left.count || RowKey(left).localeCompare(RowKey(right)));
    return {
        windowSeconds,
        total: counted.reduce((sum, row) => sum + row.count, 0),
        routes: sorted.slice(0, maxRows),
        omittedRows: Math.max(0, sorted.length - maxRows)
    };
}

export interface HostRouteCensusOptions {
    enabled: boolean;
    windowMs?: number;
    maxRows?: number;
    /** Receives the summary line (the logger by default). */
    log?: (line: string) => void;
    /** Timers, injectable for tests; the flush timer is unref'd so it never keeps the process alive. */
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
}

/** Counts the host runtime's answered requests in memory and logs them once per window. */
export class HostRouteCensus {
    private readonly counts = new Map<string, HostRouteRow>();
    private readonly windowMs: number;
    private readonly maxRows: number;
    private readonly log: (line: string) => void;
    private readonly startTimer: (callback: () => void, ms: number) => unknown;
    private readonly stopTimer: (handle: unknown) => void;
    private timer: unknown;

    constructor(private readonly options: HostRouteCensusOptions) {
        this.windowMs = options.windowMs ?? HOST_ROUTE_CENSUS_WINDOW_MS;
        this.maxRows = options.maxRows ?? HOST_ROUTE_CENSUS_MAX_ROWS;
        this.log = options.log ?? ((line) => logger.info(line));
        this.startTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
        this.stopTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    }

    get enabled(): boolean {
        return this.options.enabled;
    }

    /**
     * Mounted before the routers: attaches the count to a request that carries the host runtime's header. It is read when the
     * response finishes, when the authentication has set AuthData and the router has answered.
     */
    middleware(): (req: Request, res: Response, next: NextFunction) => void {
        return (req, res, next) => {
            if (this.options.enabled && req.headers[HOST_RUNTIME_CAPABILITY_HEADER] !== undefined) {
                res.on("finish", () => this.observe(req, res));
            }
            next();
        };
    }

    /** Counts the request when the host runtime authentication accepted it (AuthData.IsPlayerHostRuntime). */
    observe(req: Request, res: Response): void {
        const auth = (req as Request & { AuthData?: { IsPlayerHostRuntime?: unknown } }).AuthData;
        if (auth?.IsPlayerHostRuntime !== true) return;
        const session = res.locals[HOST_ROUTE_SESSION_LOCAL] as HostRouteSession | undefined;
        this.record({ method: req.method, route: HostRouteOf(req), statusCode: res.statusCode,
            sessionKind: session?.sessionKind, hubKind: session?.hubKind });
    }

    record(sample: HostRouteSample): void {
        if (!this.options.enabled) return;
        AddSample(this.counts, sample);
        const normalized = NormalizeHostRouteSample(sample);
        IncrementMetric("mysticparadox_host_route_requests_total", 1, { method: normalized.method, status: normalized.status });
        this.timer ??= this.startFlushTimer();
    }

    /** The summary of the window so far, without clearing it (diagnostics and tests). */
    peek(): HostRouteSummary | undefined {
        return SummarizeHostRoutes([...this.counts.values()], this.windowMs / 1000, this.maxRows);
    }

    /** Logs the window's summary (when there was traffic) and starts the next window. */
    flush(): HostRouteSummary | undefined {
        const summary = this.peek();
        this.counts.clear();
        if (summary !== undefined) this.log(`[HostRoute] summary ${JSON.stringify(summary)}`);
        return summary;
    }

    /** Ends the census: the last window is logged and the timer stops. */
    stop(): void {
        if (this.timer !== undefined) this.stopTimer(this.timer);
        this.timer = undefined;
        this.flush();
    }

    private startFlushTimer(): unknown {
        const handle = this.startTimer(() => { this.flush(); }, this.windowMs);
        (handle as { unref?: () => void } | undefined)?.unref?.();
        return handle;
    }
}

/** MYSTICPARADOX_HOST_ROUTE_CENSUS: on unless it is off, 0, false or no. */
export function ReadHostRouteCensusEnabled(environment: NodeJS.ProcessEnv): boolean {
    return !/^(0|false|off|no)$/i.test((environment.MYSTICPARADOX_HOST_ROUTE_CENSUS ?? "").trim());
}

export const hostRouteCensus = new HostRouteCensus({ enabled: ReadHostRouteCensusEnabled(process.env) });
