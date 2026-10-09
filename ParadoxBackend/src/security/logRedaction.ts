/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Keep request diagnostics useful without persisting bearer-like query values. This transforms only
// the string sent to the logger; Express routing continues to use the untouched request URL.
export function sanitizeUrlForLog(url: string): string {
    return url.replace(
        /([?&](?:token|access_token|refresh_token|code|exchange_code|authorization|api_key|apikey|signature)=)[^&#]*/gi,
        "$1[REDACTED]"
    );
}
