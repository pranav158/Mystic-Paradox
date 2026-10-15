/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Keep request diagnostics useful without persisting bearer-like query values. This transforms only
// the string sent to the logger; Express routing continues to use the untouched request URL.
// [2026-10-15] Tokens in the PATH as well: the game's logout calls DELETE .../account/api/oauth/sessions/kill/<access
// token>, and [REQ]/[RES] logged the whole JWT (found in the VPS log). Any JWT-shaped value (three base64url parts,
// the first starting "eyJ") and whatever follows /sessions/kill/ are replaced, wherever they appear.
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

export function sanitizeUrlForLog(url: string): string {
    return url
        .replace(/(\/sessions\/kill\/)[^/?#]+/gi, "$1[REDACTED]")
        .replace(JWT_LIKE, "[REDACTED-JWT]")
        .replace(
            /([?&](?:token|access_token|refresh_token|code|exchange_code|authorization|api_key|apikey|signature)=)[^&#]*/gi,
            "$1[REDACTED]"
        );
}
