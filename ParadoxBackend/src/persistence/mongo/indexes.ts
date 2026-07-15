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

import { Db } from "mongodb";
import { Collections } from "./collections";
import { MongoWalletRepository } from "./repositories/MongoWalletRepository";









export async function EnsureMongoIndexes(Db: Db): Promise<void> {
    await Db.collection(Collections.Characters).createIndex({ userId: 1 });
    await Db.collection(Collections.Inventories).createIndex({ userId: 1 });
    await Db.collection(Collections.Loadouts).createIndex({ userId: 1 });
    await Db.collection(Collections.Breadcrumbs).createIndex({ userId: 1 });
    await Db.collection(Collections.EncounteredContent).createIndex({ userId: 1 });

    
    
    
    
    
    
    
    
    
    
    await Db.collection(Collections.GameServerApiKeys).createIndex({ keyHash: 1 });
    await Db.collection(Collections.UserApiKeys).createIndex({ keyHash: 1 });

    
    
    
    
    await Db.collection(Collections.ProgressionTracks).createIndex({ userId: 1 });

    
    
    await Db.collection(Collections.ProgressionObjectives).createIndex({ userId: 1 });

    
    
    await Db.collection(Collections.ProgressionObjectiveEvents).createIndex({ userId: 1, receivedAt: 1 });

    
    
    
    
    
    
    
    
    await Db.collection(Collections.Accounts).createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: "string" } } }
    );
    await Db.collection(Collections.Accounts).createIndex(
        { displayNameNormalized: 1 },
        { unique: true, partialFilterExpression: { displayNameNormalized: { $type: "string" } } }
    );

    await Db.collection(Collections.AuthIdentities).createIndex({ provider: 1, providerSubject: 1 }, { unique: true });
    await Db.collection(Collections.AuthIdentities).createIndex({ userId: 1 });

    await Db.collection(Collections.RefreshSessions).createIndex({ tokenHash: 1 }, { unique: true });
    await Db.collection(Collections.RefreshSessions).createIndex({ familyId: 1 });
    await Db.collection(Collections.RefreshSessions).createIndex({ userId: 1 });

    await Db.collection(Collections.GameExchangeCodes).createIndex({ userId: 1 });
    await Db.collection(Collections.AdminSessions).createIndex({ tokenHash: 1 }, { unique: true });
    await Db.collection(Collections.AdminSessions).createIndex({ userId: 1 });
    await Db.collection(Collections.AdminSessions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.AdminAudit).createIndex({ targetUserId: 1, createdAt: -1 });
    await Db.collection(Collections.AdminAudit).createIndex({ actorUserId: 1, createdAt: -1 });

    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ completionCodeHash: 1 });
    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ userId: 1 });
    await Db.collection(Collections.InventoryTransactions).createIndex({ userId: 1, characterId: 1 });
    await Db.collection(Collections.Friendships).createIndex({ ownerId: 1 });
    await Db.collection(Collections.Friendships).createIndex({ otherId: 1 });

    
    
    
    
    
    
    await Db.collection(Collections.RefreshSessions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.GameExchangeCodes).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });

    
    
    
    
    
    
    const LegacyStringWalletIds = await Db.collection(Collections.Wallets)
        .find({ balances: { $type: "string" } })
        .project({ _id: 1 })
        .toArray();
    if (LegacyStringWalletIds.length > 0) {
        const WalletRepo = new MongoWalletRepository();
        for (const Row of LegacyStringWalletIds) {
            await WalletRepo.migrateLegacyStringBalances(String(Row._id));
        }
    }

    
    
    
    
    
    
    
    await Db.collection(Collections.Accounts).updateMany(
        { displayNameNormalized: { $exists: true }, name: { $exists: false } },
        [{ $set: { name: "$displayName", notes: 0 } }]
    );
}
