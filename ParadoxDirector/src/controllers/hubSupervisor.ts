/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * [2026-10-10 1.14.7] Supervisor for one persistent hub (Ramsgate or the Training dojo).
 *
 * Before: a failed boot start or a failed restart left the hub down for good. CleanupServer had already
 * dropped the hub from Gameservers and cleared its reference, the getters never started anything, and the
 * watchdog only walked Gameservers ("left down until the next request" was not true). A hub exit was only
 * noticed by the 60 s watchdog.
 *
 * Now, per hub:
 *   ensure(reason)  single-flight: concurrent callers share one start; never rejects (a failed start
 *                   resolves undefined and arms the retry timer). Before the backoff is due it only
 *                   re-arms the timer, so requests cannot bypass the backoff.
 *   onExit(hub)     acts only for the CURRENT hub; a late exit of a failed start or an older run is ignored.
 *                   An exit after a stable run (stableUptimeMs ready) restarts at once and resets the
 *                   failure count; an earlier exit counts as a failure (crash-loop backoff).
 *   tick()          watchdog safety net: a dead current hub without an exit event is treated as an exit,
 *                   a missing hub is retried once its backoff is due.
 * Backoff 5 s, 15 s, 30 s, 60 s, 120 s, then 300 s (cap). Retries run on one unref'd timer per hub, with the
 * watchdog tick as backup, so a hub comes back even when nobody asks for it.
 *
 * CreateSerialGate() is the promise chain both hub supervisors share so two hub cold starts never overlap
 * (a concurrent Ramsgate + dojo cold start crashed Ramsgate's FAsyncLoadingThread). Hunts keep using
 * ServerLaunchQueue.
 *
 * Pure: the logger, clock and timer are injected (no node:timers/promises here), so the tests run in the
 * public CI without game data.
 *
 * The default clock is monotonic (performance.now()), like the retry timer: the supervisor uses only
 * differences and its own deadlines, and a wall-clock step back (NTP, a manual change) must not push a
 * down hub's next attempt into the future.
 */

export const DEFAULT_HUB_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
export const DEFAULT_HUB_STABLE_UPTIME_MS = 120_000;

export type HubTimer = { cancel(): void };
export type HubLogLevel = "info" | "warn" | "error";

export type HubSupervisorOptions<T> = {
    label: string;
    // `reason` is the ensure() reason ("boot", "exit: ...", "retry", "watchdog", "request").
    start: (reason: string) => Promise<T>;
    isAlive: (hub: T) => boolean;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => HubTimer;
    log?: (level: HubLogLevel, message: string, error?: unknown) => void;
    backoffMs?: readonly number[];
    stableUptimeMs?: number;
};

export function CreateSerialGate(): <R>(fn: () => Promise<R>) => Promise<R> {
    let tail: Promise<unknown> = Promise.resolve();
    return <R>(fn: () => Promise<R>): Promise<R> => {
        const run = tail.catch(() => {}).then(fn);
        tail = run.catch(() => {});
        return run;
    };
}

function MonotonicNowMs(): number {
    return performance.now();
}

function DefaultSetTimer(fn: () => void, ms: number): HubTimer {
    const handle = globalThis.setTimeout(fn, ms);
    handle.unref?.();
    return { cancel: () => globalThis.clearTimeout(handle) };
}

export class HubSupervisor<T> {
    private hub?: T;
    private inFlight?: Promise<T | undefined>;
    private failures = 0;
    private nextAttemptAt = 0;
    private readySince = 0;
    private timer?: HubTimer;

    private readonly label: string;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => HubTimer;
    private readonly backoffMs: readonly number[];
    private readonly stableUptimeMs: number;

    constructor(private readonly options: HubSupervisorOptions<T>) {
        this.label = options.label;
        this.now = options.now ?? MonotonicNowMs;
        this.setTimer = options.setTimer ?? DefaultSetTimer;
        this.backoffMs = options.backoffMs && options.backoffMs.length > 0 ? options.backoffMs : DEFAULT_HUB_BACKOFF_MS;
        this.stableUptimeMs = options.stableUptimeMs ?? DEFAULT_HUB_STABLE_UPTIME_MS;
    }

    get current(): T | undefined { return this.hub; }
    get pending(): boolean { return this.inFlight !== undefined; }
    get failureCount(): number { return this.failures; }
    get nextAttemptDueAt(): number { return this.nextAttemptAt; }
    get retryArmed(): boolean { return this.timer !== undefined; }

    ensure(reason: string): Promise<T | undefined> {
        if (this.hub !== undefined) {
            if (this.options.isAlive(this.hub)) return Promise.resolve(this.hub);
            this.markGone(this.hub, `${reason}: process gone`);
        }
        if (this.inFlight) return this.inFlight;                      // one start per hub; callers share it
        if (this.now() < this.nextAttemptAt) {                         // requests cannot skip the backoff
            this.arm();
            return Promise.resolve(undefined);
        }
        this.cancelTimer();
        // The start runs one microtask later, so inFlight is set before run() can clear it, even when
        // options.start throws synchronously.
        const attempt = Promise.resolve().then(() => this.run(reason));
        this.inFlight = attempt;
        return attempt;
    }

    onExit(hub: T, reason: string): void {
        if (!this.markGone(hub, reason)) return;                      // late exit of a failed start or an older run
        void this.ensure(`exit: ${reason}`);
    }

    tick(): void {
        if (this.hub !== undefined) {
            if (!this.options.isAlive(this.hub)) {
                this.onExit(this.hub, "watchdog: process gone");
                return;
            }
            if (this.failures > 0 && this.now() - this.readySince >= this.stableUptimeMs) {
                this.failures = 0;
                this.log("info", `[HubSupervisor] ${this.label} stable for ${Math.round((this.now() - this.readySince) / 1000)}s - failure count reset`);
            }
            return;
        }
        if (this.inFlight) return;
        void this.ensure("watchdog");
    }

    dispose(): void {
        this.cancelTimer();
    }

    private async run(reason: string): Promise<T | undefined> {
        this.log("info", `[HubSupervisor] ${this.label} starting (${reason}, attempt ${this.failures + 1})`);
        let hub: T;
        try {
            hub = await this.options.start(reason);
        } catch (error) {
            return this.fail("start failed", error);
        }
        // An exit between ready and here was ignored by onExit (the hub was not current yet).
        if (!this.options.isAlive(hub)) return this.fail("exited right after reporting ready");
        this.inFlight = undefined;
        this.hub = hub;
        this.readySince = this.now();
        this.nextAttemptAt = 0;
        this.log("info", `[HubSupervisor] ${this.label} up (${reason}; failures so far ${this.failures})`);
        return hub;
    }

    private fail(what: string, error?: unknown): undefined {
        this.failures++;
        const delay = this.delay();
        this.nextAttemptAt = this.now() + delay;
        // inFlight must be cleared BEFORE arm(): arm() refuses while a start is in flight, which is how the
        // first design never armed the retry after a failed start.
        this.inFlight = undefined;
        this.log("error", `[HubSupervisor] ${this.label} ${what} (failure ${this.failures}); retrying in ${delay / 1000}s`, error);
        this.arm();
        return undefined;
    }

    // Clears the current hub and updates the backoff. False when `hub` is not current.
    private markGone(hub: T, reason: string): boolean {
        if (hub !== this.hub) return false;
        this.hub = undefined;
        if (this.inFlight) return true;                               // that start's outcome decides the backoff
        const upMs = this.now() - this.readySince;
        if (upMs >= this.stableUptimeMs) {
            this.failures = 0;
            this.nextAttemptAt = 0;
            this.log("warn", `[HubSupervisor] ${this.label} exited after ${Math.round(upMs / 1000)}s up (${reason}) - restarting now`);
        } else {
            this.failures++;
            const delay = this.delay();
            this.nextAttemptAt = this.now() + delay;
            this.log("warn", `[HubSupervisor] ${this.label} exited ${Math.round(upMs / 1000)}s after ready (${reason}; failure ${this.failures}) - restart in ${delay / 1000}s`);
        }
        return true;
    }

    private delay(): number {
        return this.backoffMs[Math.min(Math.max(this.failures - 1, 0), this.backoffMs.length - 1)];
    }

    private arm(): void {
        if (this.timer || this.inFlight || this.hub !== undefined) return;
        const ms = Math.max(0, this.nextAttemptAt - this.now());
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            void this.ensure("retry");
        }, ms);
    }

    private cancelTimer(): void {
        this.timer?.cancel();
        this.timer = undefined;
    }

    private log(level: HubLogLevel, message: string, error?: unknown): void {
        try { this.options.log?.(level, message, error); } catch { /* logging must never break supervision */ }
    }
}
