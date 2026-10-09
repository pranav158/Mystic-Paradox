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

import { JwtPayload } from "jsonwebtoken";

import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { GetRepositories } from "../persistence";
import { logger } from "../logger";
import { parseSaslPlain } from "./saslPlain";
import { IsAccountEligible } from "../security/accountEligibility";

/**
 * WP4 — SASL authentication + identity binding for the realtime gateway.
 *
 * Captured truth (plan §27): the 1.12 client authenticates with SASL PLAIN where authcid = the
 * Mystic Paradox userId and the password = the RS256 game JWT. This validator therefore:
 *   - requires exactly PLAIN;
 *   - bounds the SASL blob size (defense-in-depth on top of the WS frame cap);
 *   - parses exactly three NUL-delimited PLAIN fields (rejects malformed layouts);
 *   - verifies the JWT (RS256 + issuer/audience/expiry, via the shared validator);
 *   - requires a nonempty string payload.userId;
 *   - requires payload.userId === authcid (identity is bound from the TOKEN, never the JID);
 *   - rejects the client-credentials service token;
 *   - requires the launcher account to still exist and be active.
 *
 * It NEVER logs the JWT or the SASL payload (plan §7). Client-facing failures are generic; the
 * `reason` is for server logs only and does not distinguish unknown-account from bad-credential.
 */

// Mirrors the sentinel in routes/eos.ts. A JWT minted for the client-credentials service token
// must never be usable as a player XMPP identity.
const LAUNCHER_CLIENT_CREDENTIALS_USER_ID = "__launcher_client_credentials__";

export type AuthOutcome =
    | { ok: true; accountId: string }
    | { ok: false; reason: string };

/** Validate a SASL PLAIN response and resolve the authenticated accountId. */
export async function authenticateSasl(mechanism: string, saslB64: string): Promise<AuthOutcome> {
    const parsed = parseSaslPlain(mechanism, saslB64);
    if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
    }
    const { authcid, password } = parsed;

    // The password is the game JWT — verify signature, issuer, audience, and expiry.
    let payload: string | JwtPayload;
    try {
        payload = ValidateMetagameJWTAndGetPayload(password);
    } catch {
        return { ok: false, reason: "jwt verify failed" };
    }
    const userId = typeof payload === "object" && payload !== null ? (payload as JwtPayload).userId : undefined;
    if (typeof userId !== "string" || userId.length === 0) {
        return { ok: false, reason: "no userId in token" };
    }
    if (userId === LAUNCHER_CLIENT_CREDENTIALS_USER_ID) {
        return { ok: false, reason: "client-credentials token not allowed" };
    }
    // Identity binding: the SASL authcid must match the verified token subject.
    if (userId !== authcid) {
        return { ok: false, reason: "authcid/token mismatch" };
    }

    // Account must still exist and be active.
    try {
        const account = await GetRepositories().launcherAccounts.findByUserId(userId);
        if (account === undefined || !IsAccountEligible(account)) {
            return { ok: false, reason: "account not eligible" };
        }
    } catch (e) {
        logger.error(`[XMPP] auth account lookup failed: ${e}`);
        return { ok: false, reason: "account lookup error" };
    }

    return { ok: true, accountId: userId };
}
