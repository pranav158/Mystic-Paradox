/**
 * Process-local Guard traffic bounds.
 *
 * Production multi-instance deployments use guardTrafficDistributed.ts when the explicit
 * distributed flag is enabled. This primitive is the bounded local-development fallback and is
 * deliberately fail-closed when either request or byte budget is
 * exhausted. Windows are bounded and old keys are evicted so the limiter
 * cannot become an unbounded memory sink.
 */
export interface GuardTrafficLimit {
    maxRequests: number;
    maxBytes: number;
    windowMs: number;
}

interface Bucket {
    startedAt: number;
    requests: number;
    bytes: number;
    touchedAt: number;
}

export class GuardTrafficLimiter {
    private readonly buckets = new Map<string, Bucket>();

    constructor(
        private readonly maxKeys = 4096,
        private readonly now: () => number = () => Date.now(),
    ) {}

    consume(key: string, bytes: number, limit: GuardTrafficLimit): boolean {
        if (!key || !Number.isSafeInteger(bytes) || bytes < 0 ||
            !Number.isSafeInteger(limit.maxRequests) || limit.maxRequests < 1 ||
            !Number.isSafeInteger(limit.maxBytes) || limit.maxBytes < 1 ||
            !Number.isSafeInteger(limit.windowMs) || limit.windowMs < 1 || bytes > limit.maxBytes) {
            return false;
        }
        const current = this.now();
        let bucket = this.buckets.get(key);
        if (bucket === undefined || current - bucket.startedAt >= limit.windowMs || current < bucket.startedAt) {
            bucket = { startedAt: current, requests: 0, bytes: 0, touchedAt: current };
        }
        if (bucket.requests >= limit.maxRequests || bucket.bytes + bytes > limit.maxBytes) {
            bucket.touchedAt = current;
            this.buckets.set(key, bucket);
            return false;
        }
        bucket.requests += 1;
        bucket.bytes += bytes;
        bucket.touchedAt = current;
        this.buckets.set(key, bucket);
        this.evictIfNeeded();
        return true;
    }

    size(): number { return this.buckets.size; }

    clear(): void { this.buckets.clear(); }

    private evictIfNeeded(): void {
        while (this.buckets.size > this.maxKeys) {
            let oldestKey: string | undefined;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [key, bucket] of this.buckets) {
                if (bucket.touchedAt < oldestAt) { oldestAt = bucket.touchedAt; oldestKey = key; }
            }
            if (oldestKey === undefined) break;
            this.buckets.delete(oldestKey);
        }
    }
}

export interface GuardRequestBudgetLimit {
    maxInFlightRequests: number;
    maxInFlightBytes: number;
}

/**
 * Bounds materialized request work before it reaches Mongo. There is no wait
 * queue: an exhausted budget is rejected and the caller may retry. Bytes are
 * released in the route's finally block, including transaction failures.
 */
export class GuardRequestBudget {
    private inFlightRequests = 0;
    private inFlightBytes = 0;

    constructor(private readonly limit: GuardRequestBudgetLimit) {}

    tryAcquire(bytes: number): (() => void) | undefined {
        if (!Number.isSafeInteger(bytes) || bytes < 0 ||
            this.inFlightRequests >= this.limit.maxInFlightRequests ||
            this.inFlightBytes + bytes > this.limit.maxInFlightBytes) {
            return undefined;
        }
        this.inFlightRequests += 1;
        this.inFlightBytes += bytes;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
            this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
        };
    }

    snapshot(): { inFlightRequests: number; inFlightBytes: number } {
        return { inFlightRequests: this.inFlightRequests, inFlightBytes: this.inFlightBytes };
    }

    reset(): void {
        this.inFlightRequests = 0;
        this.inFlightBytes = 0;
    }
}

export const HUNT_GUARD_TRAFFIC_WINDOW_MS = 60_000;
export const HUNT_GUARD_HOST_TRAFFIC_LIMIT: GuardTrafficLimit = {
    maxRequests: 180,
    maxBytes: 8 * 1024 * 1024,
    windowMs: HUNT_GUARD_TRAFFIC_WINDOW_MS,
};
export const HUNT_GUARD_SESSION_TRAFFIC_LIMIT: GuardTrafficLimit = {
    maxRequests: 120,
    maxBytes: 4 * 1024 * 1024,
    windowMs: HUNT_GUARD_TRAFFIC_WINDOW_MS,
};

export const HUNT_GUARD_REQUEST_BUDGET: GuardRequestBudgetLimit = {
    maxInFlightRequests: 64,
    maxInFlightBytes: 1024 * 1024,
};

export const CentralGuardTrafficLimiter = new GuardTrafficLimiter();
export const CentralGuardRequestBudget = new GuardRequestBudget(HUNT_GUARD_REQUEST_BUDGET);
