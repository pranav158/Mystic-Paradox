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

// Social graph for the Epic-compatible friends service (routes/friends.ts). Modelled as
// directed edges so it maps cleanly onto Epic's friends API:
//   - a friendship is two ACCEPTED edges (A->B and B->A);
//   - a pending invite is an OUTBOUND edge on the sender + an INBOUND edge on the recipient;
//   - a block is a single BLOCKED edge on the blocker.
// Document _id is `${ownerId}:${otherId}` so an edge is unique per direction.
export type FriendshipStatus = "ACCEPTED" | "PENDING" | "BLOCKED";
export type FriendshipDirection = "INBOUND" | "OUTBOUND";

export interface FriendEdgeRecord {
    ownerId: string;
    otherId: string;
    status: FriendshipStatus;
    /** Only meaningful for PENDING: OUTBOUND = owner sent the invite, INBOUND = owner received it. */
    direction?: FriendshipDirection;
    created: string;
    favorite?: boolean;
}

export interface FriendshipRepository {
    /** All edges owned by this account (friends + pending + blocked). */
    listForOwner(ownerId: string): Promise<FriendEdgeRecord[]>;
    find(ownerId: string, otherId: string): Promise<FriendEdgeRecord | undefined>;
    upsert(edge: FriendEdgeRecord): Promise<void>;
    remove(ownerId: string, otherId: string): Promise<void>;
}
