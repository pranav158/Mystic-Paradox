/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M2] Who the Metagame believes about a client's address. Only a loopback peer may speak for a client: when nginx
// (or another proxy on this machine) forwards a request, the peer is 127.0.0.1 and the client is the X-Forwarded-For entry
// the proxy appended. Any other peer is its own address, whatever the header says.

/** Express's `trust proxy` setting. req.ip is taken from X-Forwarded-For only when the socket peer is loopback. */
export const TRUST_PROXY_SETTING = "loopback";

const LOOPBACK_ADDRESS = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const MAX_ADDRESS_LENGTH = 64;

export function IsLoopbackAddress(address: string | undefined): boolean {
    return address != undefined && LOOPBACK_ADDRESS.test(address);
}

/**
 * The client address for a request that may have come through a loopback proxy: the rightmost X-Forwarded-For entry that is
 * not loopback (the rule Express applies to req.ip under TRUST_PROXY_SETTING). A peer that is not loopback is the client itself.
 */
export function ForwardedClientAddress(peerAddress: string | undefined, forwardedFor: string | string[] | undefined): string | undefined {
    if (peerAddress == undefined || !IsLoopbackAddress(peerAddress)) return peerAddress;
    const Header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
    const Hops = Header.split(",")
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0 && hop.length <= MAX_ADDRESS_LENGTH);
    for (let Index = Hops.length - 1; Index >= 0; Index--) {
        if (!IsLoopbackAddress(Hops[Index])) return Hops[Index];
    }
    return peerAddress;
}
