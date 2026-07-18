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

import { GetRepositories } from "../persistence";

export async function GetUsernameForUserId(userId: string){
    
    
    
    
    try {
        const LauncherAccount = await GetRepositories().launcherAccounts.findByUserId(userId);
        if(LauncherAccount?.displayName){
            return LauncherAccount.displayName;
        }
    } catch {
        // Preserve the older account lookup as a best-effort fallback during a
        // transient launcher-account/Mongo outage. Identity lookup must not turn
        // the whole game login into a 500 merely because the optional name source
        // is unavailable.
    }

    let UserFromDb = await GetRepositories().accounts.findByUserId(userId);

    return UserFromDb?.name ?? userId;
}
