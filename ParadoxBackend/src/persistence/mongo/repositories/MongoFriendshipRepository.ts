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

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { FriendshipRepository, FriendEdgeRecord } from "../../contracts/FriendshipRepository";

function EdgeId(ownerId: string, otherId: string): string {
    return `${ownerId}:${otherId}`;
}

function ToRecord(Doc: any): FriendEdgeRecord {
    return {
        ownerId: Doc.ownerId,
        otherId: Doc.otherId,
        status: Doc.status,
        direction: Doc.direction ?? undefined,
        created: Doc.created,
        favorite: Doc.favorite ?? false
    };
}

export class MongoFriendshipRepository implements FriendshipRepository {
    async listForOwner(ownerId: string): Promise<FriendEdgeRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.Friendships).find({ ownerId }).toArray();
        return Docs.map(ToRecord);
    }

    async find(ownerId: string, otherId: string): Promise<FriendEdgeRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Friendships).findOne({ _id: EdgeId(ownerId, otherId) as any });
        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async upsert(edge: FriendEdgeRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Friendships).updateOne(
            { _id: EdgeId(edge.ownerId, edge.otherId) as any },
            {
                $set: {
                    ownerId: edge.ownerId,
                    otherId: edge.otherId,
                    status: edge.status,
                    direction: edge.direction ?? null,
                    created: edge.created,
                    favorite: edge.favorite ?? false
                }
            },
            { upsert: true }
        );
    }

    async remove(ownerId: string, otherId: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Friendships).deleteOne({ _id: EdgeId(ownerId, otherId) as any });
    }
}
