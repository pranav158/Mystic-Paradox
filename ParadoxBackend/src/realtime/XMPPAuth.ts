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





const LAUNCHER_CLIENT_CREDENTIALS_USER_ID = "__launcher_client_credentials__";

export type AuthOutcome =
    | { ok: true; accountId: string }
    | { ok: false; reason: string };


export async function authenticateSasl(mechanism: string, saslB64: string): Promise<AuthOutcome> {
    const parsed = parseSaslPlain(mechanism, saslB64);
    if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
    }
    const { authcid, password } = parsed;

    
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
    
    if (userId !== authcid) {
        return { ok: false, reason: "authcid/token mismatch" };
    }

    
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
