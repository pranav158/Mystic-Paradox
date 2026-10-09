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

/**
 * XML text/attribute escaping and redaction helpers.
 *
 * escapeXml is for BUILDING outbound stanzas safely (message bodies are treated
 * strictly as text — plan §13). We never parse inbound XMPP with regular
 * expressions (plan §5.2); a streaming parser does that in XMPPProtocol.ts. The
 * regex here only escapes a fixed set of output characters, which is standard and
 * safe. redacted() produces the "<redacted:length>" marker used so that no
 * credential, token, or message body is ever written to logs (plan §7, §9.1).
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

/** Redaction marker: reveals only the length of a value we deliberately do not log. */
export function redacted(value: string | undefined | null): string {
    const len = typeof value === "string" ? value.length : 0;
    return `<redacted:${len}>`;
}

/** Strip control characters and cap length so an arbitrary token can't be logged verbatim. */
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
