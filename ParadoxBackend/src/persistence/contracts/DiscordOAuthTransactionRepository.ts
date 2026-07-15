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








export interface DiscordOAuthTransactionRecord {
    state: string;
    codeVerifier: string;
    createdAt: string;
    expiresAt: string;
    consumedAt?: string;
    completionCodeHash?: string;
    completionExpiresAt?: string;
    completionConsumedAt?: string;
    userId?: string;
}

export interface DiscordOAuthTransactionRepository {
    create(transaction: DiscordOAuthTransactionRecord): Promise<void>;

    
    consumeByState(state: string): Promise<DiscordOAuthTransactionRecord | undefined>;

    attachCompletionCode(state: string, completionCodeHash: string, completionExpiresAt: string, userId: string): Promise<void>;

    
    consumeByCompletionCodeHash(completionCodeHash: string): Promise<DiscordOAuthTransactionRecord | undefined>;
}
