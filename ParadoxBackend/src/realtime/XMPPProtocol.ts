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

import { RealtimeLimits } from "./types";
import { redacted, sanitizeName } from "./xml";

// ltx is a lightweight, XMPP-native XML library (parse + Element + escaping) used
// across the node-xmpp / xmpp.js ecosystem. We use it here for STRUCTURE only.
import { parse as parseXml } from "ltx";

/**
 * Minimal shape of an ltx element we rely on, declared locally so any drift in
 * ltx's own typings can't break our build.
 */
interface XmlNodeLike {
    name: string;
    attrs: Record<string, string>;
    children: Array<XmlNodeLike | string>;
}

export interface FrameSummary {
    /** true if the frame parsed as a complete XML element. */
    parsed: boolean;
    /** sanitized top-level element name (or the leading tag for a partial frame). */
    rootName: string;
    /** sanitized, secret-free one-line structural summary for logging. */
    shape: string;
    /** byte length of the raw frame. */
    bytes: number;
}

/**
 * Produce a sanitized structural summary of one inbound WebSocket frame (WP3, plan
 * §9.1). Policy:
 *   - element and attribute NAMES are logged;
 *   - attribute VALUES are logged but control-stripped and length-capped — these
 *     carry protocol negotiation we NEED (namespaces, logical domain, SASL
 *     mechanism name, to/from/id/type), none of which is a credential;
 *   - ALL text nodes are redacted to "<redacted:length>" — this is where the SASL
 *     credential and message bodies live, which must never be logged (plan §7).
 *
 * Framing-agnostic: each WS frame is parsed independently, which fits RFC 7395 (one
 * element per frame) and still reveals the leading tag of a legacy continuous
 * stream. Never throws — malformed input yields a "partial" summary, so bad traffic
 * cannot crash Metagame (plan §9 exit criteria).
 */
export function summarizeFrame(raw: string, limits: RealtimeLimits): FrameSummary {
    const bytes = Buffer.byteLength(raw, "utf8");
    try {
        const el = parseXml(raw) as unknown as XmlNodeLike;
        if (el && typeof el.name === "string") {
            return {
                parsed: true,
                rootName: sanitizeName(el.name),
                shape: shapeOf(el, limits, 0),
                bytes,
            };
        }
    } catch {
        // fall through to partial-frame handling
    }
    const leading = leadingTagName(raw);
    return {
        parsed: false,
        rootName: leading,
        shape: `partial/continuous <${leading}> (${bytes}B)`,
        bytes,
    };
}

function shapeOf(node: XmlNodeLike, limits: RealtimeLimits, depth: number): string {
    const name = sanitizeName(node.name);
    const attrs = node.attrs ?? {};
    const attrNames = Object.keys(attrs);

    const shownAttrs = attrNames
        .slice(0, limits.maxAttrsPerElement)
        .map((a) => `${sanitizeName(a)}=${sanitizeName(attrs[a] ?? "", 96)}`);
    if (attrNames.length > limits.maxAttrsPerElement) shownAttrs.push("...");

    let childPart = "";
    if (depth < limits.maxXmlDepth) {
        const children = node.children ?? [];
        const childEls = children.filter((c): c is XmlNodeLike => typeof c !== "string");
        const textParts = children.filter((c): c is string => typeof c === "string");
        const hasText = textParts.some((t) => t.trim().length > 0);

        const childShapes = childEls.slice(0, 8).map((c) => shapeOf(c, limits, depth + 1));
        if (childEls.length > 8) childShapes.push("...");

        const textNote = hasText ? ` text=${redacted(textParts.join(""))}` : "";
        childPart = (childShapes.length > 0 ? `{${childShapes.join(",")}}` : "") + textNote;
    } else {
        childPart = "{depth-capped}";
    }

    const attrPart = shownAttrs.length > 0 ? `[${shownAttrs.join(" ")}]` : "";
    return `${name}${attrPart}${childPart}`;
}

/** Bounded, regex-free extraction of the first tag name (for unparseable/partial frames). */
function leadingTagName(raw: string): string {
    const lt = raw.indexOf("<");
    if (lt < 0) return "?";
    let i = lt + 1;
    if (raw[i] === "?" || raw[i] === "/") i++; // skip "<?" or "</"
    let name = "";
    for (; i < raw.length && name.length < 64; i++) {
        const ch = raw[i];
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ">" || ch === "/") break;
        name += ch;
    }
    return sanitizeName(name.length > 0 ? name : "?", 64);
}
