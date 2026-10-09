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

import { AccountRecord } from "../mapping/domainTypes";

// Repository contract for the `users` table (plan section 4.2 target: `accounts`).
//
// Covers every current call site: routes/login.ts (/login, DEV lookups),
// controllers/login.ts (GetUsernameForUserId), controllers/store.ts
// (GetNotesForUser's ensure-row-exists), routes/eos.ts (EnsureDevUser).
export interface AccountRepository {
    findByUserId(userId: string): Promise<AccountRecord | undefined>;

    /** Insert a new account row. Caller is responsible for checking existence first
     *  (matches current behavior in login.ts/store.ts/eos.ts, which is not itself
     *  race-free — Phase M1 does not change this, only names it). */
    create(account: AccountRecord): Promise<void>;
}
