export interface MongoRuntimeConfig {
    appName: string;
    connectTimeoutMS: number;
    serverSelectionTimeoutMS: number;
    maxPoolSize: number;
    maxIdleTimeMS: number;
    transactionMaxCommitTimeMS: number;
}

const Defaults: MongoRuntimeConfig = {
    appName: "paradox-backend",
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 20,
    maxIdleTimeMS: 60_000,
    transactionMaxCommitTimeMS: 2_000
};

function ReadBoundedInteger(
    environment: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    const raw = environment[name]?.trim();
    if (raw == undefined || raw.length === 0) return fallback;
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

function ReadAppName(environment: NodeJS.ProcessEnv): string {
    const value = (environment.MONGODB_APP_NAME ?? Defaults.appName).trim();
    if (value.length === 0 || value.length > 128 || /[\u0000-\u001F\u007F]/u.test(value)) {
        throw new Error("MONGODB_APP_NAME must contain 1-128 printable characters");
    }
    return value;
}

/**
 * Read the bounded Mongo settings used by both the connection pool and the
 * transaction wrapper. The MongoDB driver accepts non-negative integers for
 * these options, but production safety deliberately rejects infinite waits,
 * an empty pool, and unbounded application-specific commit/connection waits.
 */
export function ReadMongoRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): MongoRuntimeConfig {
    return {
        appName: ReadAppName(environment),
        connectTimeoutMS: ReadBoundedInteger(environment, "MONGODB_CONNECT_TIMEOUT_MS", Defaults.connectTimeoutMS, 250, 30_000),
        serverSelectionTimeoutMS: ReadBoundedInteger(environment, "MONGODB_SERVER_SELECTION_TIMEOUT_MS", Defaults.serverSelectionTimeoutMS, 250, 30_000),
        maxPoolSize: ReadBoundedInteger(environment, "MONGODB_MAX_POOL_SIZE", Defaults.maxPoolSize, 1, 500),
        maxIdleTimeMS: ReadBoundedInteger(environment, "MONGODB_MAX_IDLE_TIME_MS", Defaults.maxIdleTimeMS, 0, 300_000),
        transactionMaxCommitTimeMS: ReadBoundedInteger(environment, "MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS", Defaults.transactionMaxCommitTimeMS, 250, 30_000)
    };
}

export const MongoRuntimeInternals = { Defaults, ReadBoundedInteger, ReadAppName };
