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














export interface AccountRecord {
    userId: string;
    name: string;
    notes: number;
}

export interface CharacterRecord {
    characterId: string;
    userId: string;
    createdDate: string;
    lastModifiedDate: string;
    name: string;
    updateVersion: number;
    
    data: string;
}

export interface InventoryRecord {
    characterId: string;
    
    userId?: string;
    
    instancedItems: string;
    
    stackedItems: string;
    
    revision?: number;
    
    bootstrapVersion?: string;
}








export interface InventoryTransactionRecord {
    transactionId: string;
    userId: string;
    characterId: string;
    
    requestHash: string;
    status: "pending" | "completed";
    
    result?: unknown;
    createdAt: string;
    completedAt?: string;
}

export interface LoadoutRecord {
    characterId: string;
    userId: string;
    
    loadouts: string;
    
    persistent: string;
    
    unlockedTotalSlots?: number;
    
    revision?: number;
    
    bootstrapVersion?: string;
}

export interface WalletRecord {
    userId: string;
    
    balances: Record<string, number>;
    
    bootstrapVersion?: string;
}

export interface PlayerJourneyRecord {
    userId: string;
    
    nodes: string;
    updateVersion: number;
}

export interface BreadcrumbsRecord {
    characterId: string;
    userId: string;
    
    breadcrumbs: string;
    updateVersion: number;
}

export interface EncounteredContentRecord {
    characterId: string;
    userId: string;
    
    encounteredcontent: string;
}

export interface GameServerApiKeyRecord {
    id: number;
    keyHash: string | null;
}

export interface UserApiKeyRecord {
    userId: string;
    keyHash: string;
}

export interface UserApiKeyToRegisterRecord {
    userId: string;
    key: string;
}

export interface GameServerApiKeyToRegisterRecord {
    key: string;
}






export interface ProgressionTrackRecord {
    userId: string;
    progressionId: string;
    progress: number;
    confirmedFremiumRank: number;
    confirmedPremiumRank: number;
    updateVersion: number;
    createdAt: string;
    updatedAt: string;
}












export interface ProgressionObjectiveRecord {
    userId: string;
    objectiveId: string;
    value: number;
    completedCount: number;
    updatedAt: string;
}

export interface ProgressionObjectiveEventRecord {
    userId: string;
    
    rawBody: string;
    receivedAt: string;
}
