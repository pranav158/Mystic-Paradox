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

import { FriendEdgeRecord, FriendshipRepository } from "../../contracts/FriendshipRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// One directed edge per document, _id = `${ownerId}:${otherId}`.
function EdgeId(ownerId: string, otherId: string): string {
    return `${ownerId}:${otherId}`;
}

function ToRecord(Doc: Doc): FriendEdgeRecord {
    return {
        ownerId: Doc.ownerId,
        otherId: Doc.otherId,
        status: Doc.status,
        direction: Doc.direction ?? undefined,
        created: Doc.created,
        favorite: Doc.favorite ?? false
    };
}

export class SqliteFriendshipRepository implements FriendshipRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async listForOwner(ownerId: string): Promise<FriendEdgeRecord[]> {
        return this.db.read(undefined, (c) => Tables.friendships.find(c, "ownerId = ?", [ownerId]).map(ToRecord));
    }

    async find(ownerId: string, otherId: string): Promise<FriendEdgeRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.friendships.get(c, EdgeId(ownerId, otherId));
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async upsert(edge: FriendEdgeRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Id = EdgeId(edge.ownerId, edge.otherId);
            const Fields = {
                ownerId: edge.ownerId,
                otherId: edge.otherId,
                status: edge.status,
                direction: edge.direction ?? null,
                created: edge.created,
                favorite: edge.favorite ?? false
            };
            const Row = Tables.friendships.row(c, Id);
            if (Row === undefined) Tables.friendships.insert(c, Id, Fields);
            else Tables.friendships.patch(c, Row, Fields);
        });
    }

    async remove(ownerId: string, otherId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.friendships.deleteById(c, EdgeId(ownerId, otherId));
        });
    }
}
