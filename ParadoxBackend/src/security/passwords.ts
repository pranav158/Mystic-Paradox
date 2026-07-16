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

import { hash, verify } from "@node-rs/argon2";






const DUMMY_HASH_FOR_TIMING = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

export async function HashPassword(password: string): Promise<string> {
    return hash(password);
}

export async function VerifyPassword(passwordHash: string | undefined, password: string): Promise<boolean> {
    if (passwordHash == undefined) {
        await verify(DUMMY_HASH_FOR_TIMING, password).catch(() => false);
        return false;
    }

    return verify(passwordHash, password).catch(() => false);
}
