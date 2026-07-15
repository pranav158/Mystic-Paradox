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
import { WalletRecord } from "../mapping/domainTypes";







const SAFE_BALANCE_FIELD = /^[A-Za-z0-9_]+$/;
export function IsValidBalanceCatalogId(catalogId: unknown): catalogId is string {
    return typeof catalogId === "string" && catalogId.length > 0 && catalogId.length <= 128 && SAFE_BALANCE_FIELD.test(catalogId);
}








export interface WalletRepository {
    findByUserId(userId: string, session?: ClientSession): Promise<WalletRecord | undefined>;

    create(wallet: WalletRecord, session?: ClientSession): Promise<void>;

    
    createIfMissing(wallet: WalletRecord, session?: ClientSession): Promise<WalletRecord>;

    
    incrementBalance(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<WalletRecord | undefined>;

    
    migrateLegacyStringBalances(userId: string): Promise<void>;
}
