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
 * Minimal ambient declarations for the "ltx" XMPP XML library, which ships no
 * TypeScript types. We declare only the surface we use (parse, escapeXML, and the
 * streaming Parser for future stanza handling) plus the Element fields we read.
 * If a future ltx version ships its own typings, remove this shim.
 */
declare module "ltx" {
    export interface Element {
        name: string;
        attrs: Record<string, string>;
        children: Array<Element | string>;
        getText(): string;
        getChild(name: string, xmlns?: string): Element | undefined;
        getChildren(name: string, xmlns?: string): Element[];
        toString(): string;
    }

    /** Parse a complete XML document/element into an Element tree. Throws on malformed input. */
    export function parse(data: string): Element;

    /** Escape a string for safe inclusion in XML text/attributes. */
    export function escapeXML(s: string): string;

    /** Streaming SAX-style XMPP parser (used later for continuous-stream framing). */
    export class Parser {
        constructor(options?: unknown);
        write(data: string): void;
        end(data?: string): void;
        on(event: "start" | "element" | "end" | "error" | string, listener: (...args: unknown[]) => void): this;
    }
}
