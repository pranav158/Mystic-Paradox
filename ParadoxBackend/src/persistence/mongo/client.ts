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
import { EnsureMongoIndexes } from "./indexes";











let CachedClient: MongoClient | undefined;
let CachedDb: Db | undefined;





let ConnectPromise: Promise<MongoClient> | undefined;

function GetRequiredEnv(name: string): string {
    const Value = process.env[name];
    if (!Value) {
        throw new Error(`Missing required environment variable "${name}" for the mongodb provider.`);
    }
    return Value;
}

function GetMongoDbName(): string {
    return process.env.MONGODB_DB ?? "mysticparadox";
}

async function ConnectMongoClient(): Promise<MongoClient> {
    const Uri = GetRequiredEnv("MONGODB_URI");

    const Client = new MongoClient(Uri, {
        appName: process.env.MONGODB_APP_NAME ?? "paradox-backend",
        connectTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? 5000),
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE ?? 20),
        maxIdleTimeMS: Number(process.env.MONGODB_MAX_IDLE_TIME_MS ?? 60000)
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








export class MongoPersistenceLifecycle implements PersistenceLifecycle {
    async start(): Promise<void> {
        const Db = await GetMongoDb();
        
        
        await Db.command({ ping: 1 });
        
        
        await EnsureMongoIndexes(Db);
    }

    async isHealthy(): Promise<boolean> {
        try {
            const Db = await GetMongoDb();
            await Db.command({ ping: 1 });
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
