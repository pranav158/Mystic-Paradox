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



export type PlainParse =
    | { ok: true; authcid: string; password: string }
    | { ok: false; reason: string };

const MAX_SASL_B64_LEN = 8 * 1024; 
const MAX_SASL_DECODED_LEN = 6 * 1024; 

export function parseSaslPlain(mechanism: string, saslB64: string): PlainParse {
    if ((mechanism ?? "").toUpperCase() !== "PLAIN") {
        return { ok: false, reason: "unsupported mechanism" };
    }
    const b64 = (saslB64 ?? "").trim();
    if (b64.length === 0 || b64.length > MAX_SASL_B64_LEN) {
        return { ok: false, reason: "sasl length" };
    }
    let decoded: string;
    try {
        const buf = Buffer.from(b64, "base64");
        if (buf.length === 0 || buf.length > MAX_SASL_DECODED_LEN) {
            return { ok: false, reason: "decoded length" };
        }
        decoded = buf.toString("utf8");
    } catch {
        return { ok: false, reason: "base64" };
    }
    
    const parts = decoded.split("\u0000");
    if (parts.length !== 3) {
        return { ok: false, reason: "malformed PLAIN layout" };
    }
    const authcid = parts[1];
    const password = parts[2];
    if (authcid.length === 0 || password.length === 0) {
        return { ok: false, reason: "empty authcid/credential" };
    }
    return { ok: true, authcid, password };
}
