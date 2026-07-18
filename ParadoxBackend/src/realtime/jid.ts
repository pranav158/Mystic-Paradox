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

    
    if (domain.length === 0) return undefined;

    return {
        local: local.toLowerCase(),
        domain: domain.toLowerCase(),
        resource,
    };
}


export function bareJid(jid: Jid): string {
    return jid.local.length > 0 ? `${jid.local}@${jid.domain}` : jid.domain;
}


export function fullJid(jid: Jid): string {
    const bare = bareJid(jid);
    return jid.resource.length > 0 ? `${bare}/${jid.resource}` : bare;
}


export function sameBareJid(a: Jid, b: Jid): boolean {
    return a.local === b.local && a.domain === b.domain;
}
