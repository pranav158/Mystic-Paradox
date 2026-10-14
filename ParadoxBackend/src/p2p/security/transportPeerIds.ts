/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";

// [2026-10-13] Transport peer ids for the ICE co-op transport (SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md
// §6.1 step 4). The admission tickets, the roster and the transport link carry a 64-bit peer id per player; with the
// Steam transport it is the player's SteamID64. ICE has no platform identity, so the id is derived from the account:
// stable, unique per account in practice, never a SteamID, and the same on every server that runs this code. The
// account itself is proven by the launcher session that asks for its transport configuration and pair keys.

const MAXIMUM_U64 = (1n << 64n) - 1n;

/** The account's ICE peer id: SHA-256 of a fixed label and the account id, the first 63 bits, never zero. */
export function DeriveIcePeerId(accountId: string): string {
    const digest = crypto.createHash("sha256").update(`mysticparadox-ice-peer-v1\n${accountId}`).digest();
    const value = digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
    return (value === 0n ? 1n : value).toString();
}

/** A transport module's own instance id as the launcher reports it: a non-zero unsigned 64-bit decimal. */
export function ParseIcePeerReport(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
    return BigInt(value) <= MAXIMUM_U64 ? value : undefined;
}
