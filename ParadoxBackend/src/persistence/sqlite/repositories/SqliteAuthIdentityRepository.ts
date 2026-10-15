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

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { AuthIdentityRecord, AuthIdentityRepository } from "../../contracts/AuthIdentityRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

function ToRecord(Doc: Doc): AuthIdentityRecord {
    return {
        provider: Doc.provider,
        providerSubject: Doc.providerSubject,
        userId: Doc.userId,
        providerUsername: Doc.providerUsername,
        providerAvatarUrl: Doc.providerAvatarUrl ?? undefined,
        linkedAt: Doc.linkedAt
    };
}

// One provider subject links to exactly one account: UNIQUE (provider, providerSubject) in schema.ts.
export class SqliteAuthIdentityRepository implements AuthIdentityRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByProviderSubject(provider: "discord", providerSubject: string, session?: ClientSession): Promise<AuthIdentityRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.authIdentities.findOne(c, "provider = ? AND providerSubject = ?", [provider, providerSubject]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async findByUserId(provider: "discord", userId: string, session?: ClientSession): Promise<AuthIdentityRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.authIdentities.findOne(c, "provider = ? AND userId = ?", [provider, userId]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async create(identity: AuthIdentityRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.authIdentities.insert(c, crypto.randomUUID(), { ...identity });
        });
    }

    // [2026-10-15] The unlink (DELETE /launcher/v1/account/discord).
    async deleteForUser(provider: "discord", userId: string): Promise<number> {
        return this.db.write(undefined, (c) => Tables.authIdentities.delete(c, "provider = ? AND userId = ?", [provider, userId]));
    }
}
