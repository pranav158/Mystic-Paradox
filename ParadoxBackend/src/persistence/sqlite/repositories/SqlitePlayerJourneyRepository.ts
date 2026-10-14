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

import { PlayerJourneyRepository } from "../../contracts/PlayerJourneyRepository";
import { PlayerJourneyRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { IsDuplicateKeyError } from "../errors";
import { Tables } from "../tables";

// _id = userId. `nodes` is the raw JSON string.
export class SqlitePlayerJourneyRepository implements PlayerJourneyRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByUserId(userId: string): Promise<PlayerJourneyRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.playerJourney.get(c, userId);
            return Doc === undefined
                ? undefined
                : { userId: Doc.userId, nodes: Doc.nodes, updateVersion: Doc.updateVersion, revision: Doc.revision ?? 0 };
        });
    }

    async createIfAbsent(record: PlayerJourneyRecord): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            try {
                Tables.playerJourney.insert(c, record.userId, {
                    userId: record.userId,
                    nodes: record.nodes,
                    updateVersion: record.updateVersion,
                    revision: record.revision
                });
                return true;
            } catch (Err) {
                if (IsDuplicateKeyError(Err)) return false;
                throw Err;
            }
        });
    }

    async updateIfRevision(userId: string, nodesJson: string, updateVersion: number, expectedRevision: number): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.playerJourney.row(c, userId);
            if (Row === undefined) return false;
            const Revision = Row.doc.revision;
            const Matches = expectedRevision === 0 ? (Revision === 0 || Revision === undefined) : Revision === expectedRevision;
            if (!Matches) return false;
            Tables.playerJourney.patch(c, Row, { nodes: nodesJson, updateVersion, revision: (Revision ?? 0) + 1 });
            return true;
        });
    }
}
