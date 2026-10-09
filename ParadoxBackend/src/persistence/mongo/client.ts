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

import { MongoClient, Db } from "mongodb";
import { PersistenceLifecycle } from "../contracts/UnitOfWork";
import { ReadMongoRuntimeConfig } from "../../config/mongoRuntime";
import { EnsureMongoIndexes } from "./indexes";

// Single pooled MongoClient for the whole process (Mongo migration plan section 9,
// "One MongoClient per process: create and reuse one pooled client instead of
// connecting per request"). This module owns that singleton; every Mongo
// repository obtains its collections through GetMongoDb() rather than
// constructing its own client.
//
// MONGODB_URI is read from the environment only — never logged, never returned
// from any function here. Only the resolved database name is safe to log
// (plan section 15.1: "Log only... database name (not URI credentials)").

let CachedClient: MongoClient | undefined;
let CachedDb: Db | undefined;
// [hardening] Caches the in-flight CONNECT PROMISE, not just the resolved client. Without this,
// two callers racing GetMongoClient() before the first connect() resolves both see
// CachedClient === undefined and both construct+connect a NEW MongoClient — leaking one pool's
// worth of sockets/servers that nothing ever closes. Caching the promise means every concurrent
// caller awaits the SAME in-flight connection instead of starting their own.
let ConnectPromise: Promise<MongoClient> | undefined;

export interface MongoTopologyHello {
    setName?: unknown;
    isWritablePrimary?: unknown;
}

/**
 * Production Guard/economy paths require Mongo transactions and a writable
 * primary. A standalone process can answer `ping` successfully while still
 * making the reward ledger unable to provide the required transaction
 * guarantees, so startup must reject it before accepting traffic.
 */
export function AssertMongoProductionTopology(
    hello: MongoTopologyHello | unknown,
    environment: NodeJS.ProcessEnv = process.env
): void {
    if (environment.NODE_ENV !== "production") return;

    const value = hello as MongoTopologyHello | null | undefined;
    const replicaSet = typeof value === "object" && value !== null
        && typeof value.setName === "string"
        && value.setName.trim().length > 0;
    const writablePrimary = typeof value === "object" && value !== null
        && value.isWritablePrimary === true;

    if (!replicaSet || !writablePrimary) {
        throw new Error("MONGODB_PRODUCTION_REPLICA_SET_PRIMARY_REQUIRED");
    }
}

function GetRequiredEnv(name: string): string {
    const Value = process.env[name];
    if (!Value) {
        throw new Error(`Missing required environment variable "${name}" for the mongodb provider.`);
    }
    return Value;
}

function GetMongoDbName(): string {
    return process.env.MONGODB_DB ?? "mystpax";
}

async function ConnectMongoClient(): Promise<MongoClient> {
    const Uri = GetRequiredEnv("MONGODB_URI");
    const Config = ReadMongoRuntimeConfig();

    const Client = new MongoClient(Uri, {
        appName: Config.appName,
        connectTimeoutMS: Config.connectTimeoutMS,
        serverSelectionTimeoutMS: Config.serverSelectionTimeoutMS,
        maxPoolSize: Config.maxPoolSize,
        maxIdleTimeMS: Config.maxIdleTimeMS
    });

    await Client.connect();

    return Client;
}

export async function GetMongoClient(): Promise<MongoClient> {
    if (CachedClient != undefined) {
        return CachedClient;
    }

    if (ConnectPromise == undefined) {
        ConnectPromise = ConnectMongoClient().catch((Err) => {
            // A failed connect must not permanently poison the cache — clear the promise so a
            // later call (e.g. after Atlas recovers) can retry instead of rethrowing forever.
            ConnectPromise = undefined;
            throw Err;
        });
    }

    CachedClient = await ConnectPromise;
    return CachedClient;
}

export async function GetMongoDb(): Promise<Db> {
    if (CachedDb == undefined) {
        const Client = await GetMongoClient();
        CachedDb = Client.db(GetMongoDbName());
    }

    return CachedDb;
}

// Lifecycle implementation for the Mongo provider (Mongo migration plan section 7.2).
//
// Unlike the SQLite lifecycle (which wraps an already-synchronous, always-available
// local file), this one genuinely needs async connect/ping/close — Atlas is a
// remote, network-dependent service. `start()` establishes the pooled connection
// once and must be awaited before the app accepts traffic (plan: "must fail
// startup if... the database is unavailable. It must not silently fall back").
export class MongoPersistenceLifecycle implements PersistenceLifecycle {
    async start(): Promise<void> {
        const Db = await GetMongoDb();
        // Fail fast if the deployment/URI/credentials are wrong, rather than
        // discovering it on the first real request.
        await Db.command({ ping: 1 });
        // A successful ping is not sufficient for reward/economy safety: the
        // configured target must expose a replica-set writable primary so
        // transaction and fencing guarantees are available in production.
        const hello = await Db.command({ hello: 1 });
        AssertMongoProductionTopology(hello);
        // Versioned index migration, run once at startup (plan section M4 exit
        // criterion), not ad hoc from controllers.
        await EnsureMongoIndexes(Db);
    }

    async isHealthy(): Promise<boolean> {
        try {
            const Db = await GetMongoDb();
            await Db.command({ ping: 1 });
            const hello = await Db.command({ hello: 1 });
            AssertMongoProductionTopology(hello);
            return true;
        } catch {
            return false;
        }
    }

    async stop(): Promise<void> {
        if (CachedClient != undefined) {
            await CachedClient.close();
            CachedClient = undefined;
            CachedDb = undefined;
            ConnectPromise = undefined;
        }
    }
}
