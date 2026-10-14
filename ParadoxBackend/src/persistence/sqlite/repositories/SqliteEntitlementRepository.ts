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
import { EntitlementRepository, IsValidEntitlementName } from "../../contracts/EntitlementRepository";
import { EntitlementRecord } from "../../mapping/domainTypes";
import { Conn, SqliteDatabase } from "../database";
import { Tables } from "../tables";

// _id = userId, `entitlements` an array of {name, duration, activatedDate, grantedAt?, sourceSkuId?}.
export class SqliteEntitlementRepository implements EntitlementRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByUserId(userId: string, session?: ClientSession): Promise<EntitlementRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.entitlements.get(c, userId);
            return Doc === undefined
                ? undefined
                : { userId: Doc.userId, entitlements: (Doc.entitlements as EntitlementRecord["entitlements"]) ?? [] };
        });
    }

    async createIfMissing(userId: string, session?: ClientSession): Promise<EntitlementRecord> {
        return this.db.write(session, (c) => this.ensure(c, userId));
    }

    /** Appends `name` only if the account does not already hold it, so a replayed purchase never duplicates it. */
    async grantIfMissing(userId: string, name: string, duration: number, activatedDate: string | null, sourceSkuId: string | undefined, session?: ClientSession): Promise<{ granted: boolean }> {
        if (!IsValidEntitlementName(name)) {
            throw new Error(`Refusing entitlement grant: unsafe entitlement name ${JSON.stringify(name)}`);
        }
        return this.db.write(session, (c) => {
            this.ensure(c, userId);
            const Row = Tables.entitlements.row(c, userId)!;
            const Held: Array<{ name?: unknown }> = Array.isArray(Row.doc.entitlements) ? Row.doc.entitlements : [];
            if (Held.some((Entry) => Entry?.name === name)) return { granted: false };
            Tables.entitlements.patch(c, Row, {
                entitlements: [
                    ...Held,
                    {
                        name,
                        duration: Number.isFinite(duration) ? Math.trunc(duration) : 0,
                        activatedDate,
                        grantedAt: new Date().toISOString(),
                        ...(sourceSkuId ? { sourceSkuId } : {})
                    }
                ]
            });
            return { granted: true };
        });
    }

    private ensure(c: Conn, userId: string): EntitlementRecord {
        Tables.entitlements.insertIfAbsent(c, userId, { userId, entitlements: [] });
        const Doc = Tables.entitlements.get(c, userId)!;
        return { userId: Doc.userId, entitlements: (Doc.entitlements as EntitlementRecord["entitlements"]) ?? [] };
    }
}
