/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { EconomyRollupKey, EconomyRollupRepository } from "../../contracts/EconomyRollupRepository";
import type { SqliteDatabase } from "../database";
import { Doc, RoundTrip, Stored } from "../docTable";
import { Tables } from "../tables";

// Read-modify-write inside one write transaction (BEGIN IMMEDIATE): the same result as the MongoDB $inc upsert.
export class SqliteEconomyRollupRepository implements EconomyRollupRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async addToRollup(key: EconomyRollupKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>> {
        const Id = `${key.userId}:${key.day}:${key.currency}`;
        return this.db.write(undefined, (c) => {
            const Row = Tables.economyDaily.row(c, Id);
            const Body: Doc = Row ? { ...Row.doc } : { userId: key.userId, day: key.day, currency: key.currency };
            delete Body._id;
            for (const [Path, Amount] of Object.entries(increments)) AddAtPath(Body, Path, Amount);
            Body.ttlAt = Stored(ttlAt);
            if (Row) {
                if (!Tables.economyDaily.replaceFrom(c, Row, Body)) {
                    throw new Error(`SQLITE_CONCURRENT_MODIFICATION: economyDaily/${Id} changed during a read-modify-write`);
                }
            } else {
                Tables.economyDaily.insert(c, Id, Body);
            }
            return RoundTrip(Id, Body);
        });
    }
}

/** Adds `amount` at a dotted path (creating the objects on the way), as MongoDB's $inc does. */
function AddAtPath(target: Doc, path: string, amount: number): void {
    const Parts = path.split(".");
    let Node: Doc = target;
    for (const Part of Parts.slice(0, -1)) {
        if (typeof Node[Part] !== "object" || Node[Part] === null) Node[Part] = {};
        Node = Node[Part];
    }
    const Last = Parts[Parts.length - 1];
    Node[Last] = (Number(Node[Last]) || 0) + amount;
}
