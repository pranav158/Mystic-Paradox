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

import { GameExchangeCodeRecord, GameExchangeCodeRepository } from "../../contracts/GameExchangeCodeRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { IsNullOrMissing, Tables } from "../tables";

function ToRecord(Doc: Doc): GameExchangeCodeRecord {
    return {
        codeHash: Doc.codeHash,
        userId: Doc.userId,
        launcherSessionId: Doc.launcherSessionId,
        buildChangelist: Doc.buildChangelist,
        executableSha256: Doc.executableSha256,
        runtimeChannel: Doc.runtimeChannel,
        runtimeSha256: Doc.runtimeSha256,
        runtimeManifestVersion: Doc.runtimeManifestVersion,
        runtimeArtifactSetSha256: Doc.runtimeArtifactSetSha256,
        ...(typeof Doc.realmId === "string" ? { realmId: Doc.realmId } : {}),
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        consumedAt: Doc.consumedAt ?? undefined
    };
}

export class SqliteGameExchangeCodeRepository implements GameExchangeCodeRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async create(code: GameExchangeCodeRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.gameExchangeCodes.insert(c, code.codeHash, { ...code, ttlAt: new Date(code.expiresAt) });
        });
    }

    /** Find-and-consume: succeeds at most once per code, and only before expiry (the write queue makes it atomic). */
    async consumeByCodeHash(codeHash: string): Promise<GameExchangeCodeRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.gameExchangeCodes.findOneRow(
                c,
                `_id = ? AND ${IsNullOrMissing("consumedAt")} AND json_extract(doc, '$.expiresAt') > ?`,
                [codeHash, new Date().toISOString()]
            );
            if (Row === undefined) return undefined;
            return ToRecord(Tables.gameExchangeCodes.patch(c, Row, { consumedAt: new Date().toISOString() }));
        });
    }

    async revokeUnusedForUser(userId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Now = new Date().toISOString();
            for (const Row of Tables.gameExchangeCodes.rows(c, `userId = ? AND ${IsNullOrMissing("consumedAt")}`, [userId])) {
                Tables.gameExchangeCodes.patch(c, Row, { consumedAt: Now, revoked: true });
            }
        });
    }
}
