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

// External identity links (Discord now, Steam/Epic optionally later — spec
// section "Identity model"). One provider subject links to exactly one userId.
export interface AuthIdentityRecord {
    provider: "discord";
    providerSubject: string;
    userId: string;
    providerUsername: string;
    providerAvatarUrl?: string;
    linkedAt: string;
}

export interface AuthIdentityRepository {
    findByProviderSubject(provider: "discord", providerSubject: string, session?: ClientSession): Promise<AuthIdentityRecord | undefined>;
    /** Used for the account view's `discordLinked` flag — one userId links to at most one row per provider. */
    findByUserId(provider: "discord", userId: string, session?: ClientSession): Promise<AuthIdentityRecord | undefined>;
    create(identity: AuthIdentityRecord, session?: ClientSession): Promise<void>;
}
