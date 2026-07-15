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
import { PlayerJourneyRepository } from "../../contracts/PlayerJourneyRepository";
import { PlayerJourneyRecord } from "../../mapping/domainTypes";






export class MongoPlayerJourneyRepository implements PlayerJourneyRepository {
    async findByUserId(userId: string): Promise<PlayerJourneyRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.PlayerJourney).findOne({ _id: userId as any });

        if (Doc == undefined) {
            return undefined;
        }

        return { userId: Doc.userId, nodes: Doc.nodes, updateVersion: Doc.updateVersion };
    }

    async create(record: PlayerJourneyRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.PlayerJourney).insertOne({
            _id: record.userId as any,
            userId: record.userId,
            nodes: record.nodes,
            updateVersion: record.updateVersion
        });
    }

    async update(userId: string, nodesJson: string, updateVersion: number): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.PlayerJourney).updateOne(
            { _id: userId as any },
            { $set: { nodes: nodesJson, updateVersion } }
        );
    }
}
