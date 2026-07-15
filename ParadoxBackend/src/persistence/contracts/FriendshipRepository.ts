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







export type FriendshipStatus = "ACCEPTED" | "PENDING" | "BLOCKED";
export type FriendshipDirection = "INBOUND" | "OUTBOUND";

export interface FriendEdgeRecord {
    ownerId: string;
    otherId: string;
    status: FriendshipStatus;
    
    direction?: FriendshipDirection;
    created: string;
    favorite?: boolean;
}

export interface FriendshipRepository {
    
    listForOwner(ownerId: string): Promise<FriendEdgeRecord[]>;
    find(ownerId: string, otherId: string): Promise<FriendEdgeRecord | undefined>;
    upsert(edge: FriendEdgeRecord): Promise<void>;
    remove(ownerId: string, otherId: string): Promise<void>;
}
