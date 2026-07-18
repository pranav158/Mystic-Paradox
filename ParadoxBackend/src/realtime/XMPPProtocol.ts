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



import { parse as parseXml } from "ltx";


interface XmlNodeLike {
    name: string;
    attrs: Record<string, string>;
    children: Array<XmlNodeLike | string>;
}

export interface FrameSummary {
    
    parsed: boolean;
    
    rootName: string;
    
    shape: string;
    
    bytes: number;
}


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


function leadingTagName(raw: string): string {
    const lt = raw.indexOf("<");
    if (lt < 0) return "?";
    let i = lt + 1;
    if (raw[i] === "?" || raw[i] === "/") i++; 
    let name = "";
    for (; i < raw.length && name.length < 64; i++) {
        const ch = raw[i];
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ">" || ch === "/") break;
        name += ch;
    }
    return sanitizeName(name.length > 0 ? name : "?", 64);
}
