/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";

// The UDP encryption keys handed out by /key/generate and fetched back by the game server on /key/consume
// (routes/matchmaking.ts). The game server never names a candidate on consume - it sends { token, gameId } - so
// each key is also kept under the token it was issued with: the caller's own bearer token, unique per player.
// Looking a consume up by that token is what keeps two players who generate keys moments apart from receiving
// each other's key (10 Oct 19:41: the party leader got the member's key and failed with SessionIdMismatch).

export interface IssuedEncryptionKey {
    key: string;
    nonce: string;
    token: string;
    at: number;
}

export type EncryptionKeyMatch = "candidateId" | "token" | "most-recent";

export interface EncryptionKeyLookup {
    issued: IssuedEncryptionKey | null;
    matchedBy: EncryptionKeyMatch | "none";
    // A token was supplied but no key was issued under it (the most-recent fallback may be another player's).
    unknownToken: boolean;
}

export const kEncryptionKeyTtlMs = 30 * 60 * 1000;

// The same token may arrive with or without its "BEARER " prefix and with stray whitespace.
export function NormalizeEncryptionKeyToken(Raw: unknown): string {
    return String(Raw ?? "").trim().replace(/^bearer\s+/i, "").trim();
}

// Identifies a token in the log without printing it.
export function EncryptionKeyTokenFingerprint(Raw: unknown): string {
    const Normalized = NormalizeEncryptionKeyToken(Raw);
    return Normalized.length > 0 ? crypto.createHash("sha256").update(Normalized).digest("hex").slice(0, 12) : "none";
}

export class EncryptionKeyStore {
    private readonly byCandidate = new Map<string, IssuedEncryptionKey>();
    private readonly byToken = new Map<string, IssuedEncryptionKey>();
    private mostRecent: IssuedEncryptionKey | null = null;

    constructor(private readonly ttlMs: number = kEncryptionKeyTtlMs) {}

    issue(CandidateId: string, Issued: IssuedEncryptionKey): void {
        if (CandidateId.length > 0) this.byCandidate.set(CandidateId, Issued);
        const TokenKey = NormalizeEncryptionKeyToken(Issued.token);
        if (TokenKey.length > 0) this.byToken.set(TokenKey, Issued);
        this.mostRecent = Issued;
    }

    lookup(CandidateId: string, Token: unknown, Now: number): EncryptionKeyLookup {
        for (const Pending of [this.byCandidate, this.byToken]) {
            for (const [Id, Issued] of Pending) {
                if (Now - Issued.at > this.ttlMs) Pending.delete(Id);
            }
        }
        const TokenKey = NormalizeEncryptionKeyToken(Token);
        if (CandidateId.length > 0 && this.byCandidate.has(CandidateId)) {
            return { issued: this.byCandidate.get(CandidateId)!, matchedBy: "candidateId", unknownToken: false };
        }
        if (TokenKey.length > 0 && this.byToken.has(TokenKey)) {
            return { issued: this.byToken.get(TokenKey)!, matchedBy: "token", unknownToken: false };
        }
        // Kept for request shapes that name neither a candidate nor a known token.
        if (this.mostRecent && Now - this.mostRecent.at <= this.ttlMs) {
            return { issued: this.mostRecent, matchedBy: "most-recent", unknownToken: TokenKey.length > 0 };
        }
        return { issued: null, matchedBy: "none", unknownToken: TokenKey.length > 0 };
    }
}
