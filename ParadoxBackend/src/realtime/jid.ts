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

import { Jid } from "./types";

/**
 * Parse an XMPP JID "[local@]domain[/resource]" into parts. Pure + defensive;
 * never throws. Used for identity binding (plan §10) and unit tested (§20.1).
 *
 * The observed Dauntless client resource looks like "V2:Jackal:WIN::<resource-id>"
 * and can itself contain ':' and other punctuation, so we split on the FIRST '/'
 * only and preserve the resource verbatim (resources are case-sensitive in XMPP).
 * local/domain are lowercased for case-insensitive matching (domains are
 * case-insensitive; our account IDs are lowercase UUIDs).
 */
export function parseJid(raw: string): Jid | undefined {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;

    let rest = trimmed;
    let resource = "";
    const slash = rest.indexOf("/");
    if (slash >= 0) {
        resource = rest.slice(slash + 1);
        rest = rest.slice(0, slash);
    }

    let local = "";
    let domain = rest;
    const at = rest.indexOf("@");
    if (at >= 0) {
        local = rest.slice(0, at);
        domain = rest.slice(at + 1);
    }

    // A JID must have a domain. Reject empty domain and a stray leading '@'.
    if (domain.length === 0) return undefined;

    return {
        local: local.toLowerCase(),
        domain: domain.toLowerCase(),
        resource,
    };
}

/** Bare JID "local@domain" (or just "domain" when there is no localpart), lowercased. */
export function bareJid(jid: Jid): string {
    return jid.local.length > 0 ? `${jid.local}@${jid.domain}` : jid.domain;
}

/** Full JID "local@domain/resource" (omitting empty parts). */
export function fullJid(jid: Jid): string {
    const bare = bareJid(jid);
    return jid.resource.length > 0 ? `${bare}/${jid.resource}` : bare;
}

/** True when two JIDs refer to the same bare identity (ignoring resource). */
export function sameBareJid(a: Jid, b: Jid): boolean {
    return a.local === b.local && a.domain === b.domain;
}
