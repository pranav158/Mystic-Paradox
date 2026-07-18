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



const XML_ESCAPES: Readonly<Record<string, string>> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
};

export function escapeXml(input: string): string {
    return input.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}


export function redacted(value: string | undefined | null): string {
    const len = typeof value === "string" ? value.length : 0;
    return `<redacted:${len}>`;
}


export function sanitizeName(name: string, maxLen = 128): string {
    let out = "";
    for (const ch of name) {
        const code = ch.codePointAt(0) ?? 0;
        out += code >= 0x20 && code !== 0x7f ? ch : "?";
        if (out.length >= maxLen) {
            out += "...";
            break;
        }
    }
    return out;
}
