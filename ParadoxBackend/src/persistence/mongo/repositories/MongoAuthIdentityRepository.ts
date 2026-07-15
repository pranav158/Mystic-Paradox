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
import { AuthIdentityRepository, AuthIdentityRecord } from "../../contracts/AuthIdentityRepository";

function ToRecord(Doc: any): AuthIdentityRecord {
    return {
        provider: Doc.provider,
        providerSubject: Doc.providerSubject,
        userId: Doc.userId,
        providerUsername: Doc.providerUsername,
        providerAvatarUrl: Doc.providerAvatarUrl ?? undefined,
        linkedAt: Doc.linkedAt
    };
}

export class MongoAuthIdentityRepository implements AuthIdentityRepository {
    async findByProviderSubject(provider: "discord", providerSubject: string): Promise<AuthIdentityRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.AuthIdentities).findOne({ provider, providerSubject });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async findByUserId(provider: "discord", userId: string): Promise<AuthIdentityRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.AuthIdentities).findOne({ provider, userId });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async create(identity: AuthIdentityRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AuthIdentities).insertOne({ ...identity });
    }
}
