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

import { ClientSession } from "mongodb";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { EntitlementRepository, IsValidEntitlementName } from "../../contracts/EntitlementRepository";
import { EntitlementRecord } from "../../mapping/domainTypes";

// `entitlements` collection. _id = userId, `entitlements` is a real BSON array of subdocuments
// (never a JSON string blob - the shape the wallet had to be migrated away from).
export class MongoEntitlementRepository implements EntitlementRepository {
    async findByUserId(userId: string, session?: ClientSession): Promise<EntitlementRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Entitlements).findOne({ _id: userId as any }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return { userId: Doc.userId, entitlements: (Doc.entitlements as EntitlementRecord["entitlements"]) ?? [] };
    }

    async createIfMissing(userId: string, session?: ClientSession): Promise<EntitlementRecord> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.Entitlements).findOneAndUpdate(
            { _id: userId as any },
            { $setOnInsert: { _id: userId as any, userId, entitlements: [] } },
            { upsert: true, returnDocument: "after", session }
        );

        if (Result == undefined) {
            throw new Error(`Unable to create or read entitlements for ${userId}`);
        }

        return { userId: (Result as any).userId, entitlements: ((Result as any).entitlements as EntitlementRecord["entitlements"]) ?? [] };
    }

    async grantIfMissing(userId: string, name: string, duration: number, activatedDate: string | null, sourceSkuId: string | undefined, session?: ClientSession): Promise<{ granted: boolean }> {
        if (!IsValidEntitlementName(name)) {
            throw new Error(`Refusing entitlement grant: unsafe entitlement name ${JSON.stringify(name)}`);
        }

        const Db = await GetMongoDb();

        // The document must exist before the guarded $push: upsert cannot be combined with the
        // `entitlements.name != name` filter, because an already-holding user fails the filter and
        // Mongo would then attempt an INSERT with the same _id (duplicate key). Create first, then
        // push under the filter - both inside the caller's session, so the pair is still atomic.
        await this.createIfMissing(userId, session);

        const Result = await Db.collection(Collections.Entitlements).updateOne(
            { _id: userId as any, "entitlements.name": { $ne: name } },
            {
                $push: {
                    entitlements: {
                        name,
                        duration: Number.isFinite(duration) ? Math.trunc(duration) : 0,
                        activatedDate,
                        grantedAt: new Date().toISOString(),
                        ...(sourceSkuId ? { sourceSkuId } : {}),
                    } as any,
                },
            },
            { session }
        );

        return { granted: Result.modifiedCount > 0 };
    }
}
