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

import crypto from "node:crypto";

import { parse as parseXml } from "ltx";

import { authenticateSasl } from "./XMPPAuth";
import { escapeXml, sanitizeName } from "./xml";
import { XmppState } from "./types";



const NS_FRAMING = "urn:ietf:params:xml:ns:xmpp-framing";
const NS_SASL = "urn:ietf:params:xml:ns:xmpp-sasl";
const NS_BIND = "urn:ietf:params:xml:ns:xmpp-bind";
const NS_STREAMS = "http://etherx.jabber.org/streams";

const MAX_AUTH_FAILURES = 3;
const MAX_RESOURCE_LEN = 128;

interface XmlNodeLike {
    name: string;
    attrs: Record<string, string>;
    children: Array<XmlNodeLike | string>;
}

export interface SessionAction {
    
    send: string[];
    nextState?: XmppState;
    
    accountId?: string;
    
    resource?: string;
    
    close?: { code: number; reason: string };
    
    authFailed?: boolean;
    
    presence?: { available: boolean };
    
    room?:
        | { kind: "join"; to: string }
        | { kind: "leave"; to: string }
        | { kind: "groupchat"; to: string; stanzaId: string; body: string };
    
    direct?: { to: string; stanzaId: string; body: string };
    
    note: string;
}

export class XMPPSession {
    private domain = "prod.ol.epicgames.com";
    private authenticated = false;
    private accountId = "";
    private boundResource = "";
    private authFailures = 0;

    isAuthenticated(): boolean {
        return this.authenticated;
    }

    async handleFrame(raw: string): Promise<SessionAction | undefined> {
        let el: XmlNodeLike;
        try {
            el = parseXml(raw) as unknown as XmlNodeLike;
        } catch {
            return undefined; 
        }
        if (!el || typeof el.name !== "string") return undefined;

        const attrs = el.attrs ?? {};
        const xmlns = attrs["xmlns"] ?? "";
        const local = localName(el.name);

        
        if (local === "open" && xmlns === NS_FRAMING) {
            const to = attrs["to"];
            if (typeof to === "string" && to.length > 0) this.domain = to;
            const openFrame =
                `<open xmlns="${NS_FRAMING}" from="${escapeXml(this.domain)}" ` +
                `id="${crypto.randomBytes(8).toString("hex")}" version="1.0" xml:lang="en"/>`;
            if (!this.authenticated) {
                const features =
                    `<stream:features xmlns:stream="${NS_STREAMS}">` +
                    `<mechanisms xmlns="${NS_SASL}"><mechanism>PLAIN</mechanism></mechanisms></stream:features>`;
                return { send: [openFrame, features], nextState: XmppState.AuthAdvertised, note: `open -> features(SASL PLAIN) domain=${sanitizeName(this.domain)}` };
            }
            const bindFeatures =
                `<stream:features xmlns:stream="${NS_STREAMS}"><bind xmlns="${NS_BIND}"/></stream:features>`;
            return { send: [openFrame, bindFeatures], nextState: XmppState.ReopenReceived, note: "reopen -> features(bind)" };
        }

        
        if (local === "auth" && xmlns === NS_SASL) {
            if (this.authenticated) {
                return { send: [saslFailure("not-authorized")], note: "auth after already-authenticated (ignored)" };
            }
            const mechanism = attrs["mechanism"] ?? "";
            const outcome = await authenticateSasl(mechanism, textOf(el));
            if (outcome.ok) {
                this.authenticated = true;
                this.accountId = outcome.accountId;
                return { send: [`<success xmlns="${NS_SASL}"/>`], nextState: XmppState.Authenticated, accountId: outcome.accountId, note: `AUTH ok account=${sanitizeName(outcome.accountId)}` };
            }
            this.authFailures += 1;
            const action: SessionAction = {
                send: [saslFailure("not-authorized")],
                authFailed: true,
                note: `AUTH failed (${sanitizeName(outcome.reason)}) [${this.authFailures}/${MAX_AUTH_FAILURES}]`,
            };
            if (this.authFailures >= MAX_AUTH_FAILURES) {
                action.close = { code: 1008, reason: "authentication failed" };
            }
            return action;
        }

        
        if (!this.authenticated) {
            return { send: [], close: { code: 1008, reason: "not authenticated" }, note: `pre-auth stanza <${sanitizeName(local)}> rejected` };
        }

        
        if (local === "iq") {
            const id = attrs["id"] ?? "";
            const type = (attrs["type"] ?? "").toLowerCase();
            const bind = childByLocal(el, "bind");
            if (bind) {
                const resEl = childByLocal(bind, "resource");
                let resource = (resEl ? textOf(resEl) : "").trim();
                if (resource.length === 0 || resource.length > MAX_RESOURCE_LEN) {
                    resource = crypto.randomBytes(8).toString("hex"); 
                }
                this.boundResource = resource;
                
                const full = `${this.accountId}@${this.domain}/${resource}`;
                const result =
                    `<iq type="result" id="${escapeXml(id)}">` +
                    `<bind xmlns="${NS_BIND}"><jid>${escapeXml(full)}</jid></bind></iq>`;
                return { send: [result], nextState: XmppState.ResourceBound, resource, note: `BIND resource="${sanitizeName(resource)}"` };
            }
            const ping = childByLocal(el, "ping");
            if (ping) {
                
                return { send: [`<iq type="result" id="${escapeXml(id)}"/>`], note: "ping -> pong" };
            }
            if (type === "set" || type === "get") {
                
                
                return { send: [`<iq type="result" id="${escapeXml(id)}"/>`], nextState: XmppState.SessionReady, note: `IQ ${type} -> result` };
            }
            return undefined;
        }

        
        if (local === "presence") {
            const to = attrs["to"];
            if (typeof to === "string" && to.length > 0) {
                
                const type = (attrs["type"] ?? "").toLowerCase();
                if (type === "unavailable") {
                    return { send: [], room: { kind: "leave", to }, note: `MUC leave ${sanitizeName(to.split("@")[0])}` };
                }
                return { send: [], room: { kind: "join", to }, note: `MUC join ${sanitizeName(to.split("@")[0])}` };
            }
            
            
            const available = (attrs["type"] ?? "").toLowerCase() !== "unavailable";
            return { send: [], presence: { available }, note: `presence ${available ? "available" : "unavailable"}` };
        }

        
        if (local === "message") {
            const to = attrs["to"] ?? "";
            const type = (attrs["type"] ?? "").toLowerCase();
            const bodyEl = childByLocal(el, "body");
            const body = bodyEl ? textOf(bodyEl) : "";
            if (type === "groupchat" && to.length > 0) {
                return { send: [], room: { kind: "groupchat", to, stanzaId: attrs["id"] ?? "", body }, note: `groupchat -> ${sanitizeName(to.split("@")[0])}` };
            }
            if ((type === "chat" || type === "normal" || type.length === 0) && to.length > 0) {
                return { send: [], direct: { to, stanzaId: attrs["id"] ?? "", body }, note: `direct chat -> ${sanitizeName(to.split("@")[0])}` };
            }
            return undefined;
        }

        return undefined;
    }
}

function saslFailure(condition: string): string {
    return `<failure xmlns="${NS_SASL}"><${condition}/></failure>`;
}

function localName(name: string): string {
    const lower = name.toLowerCase();
    return lower.includes(":") ? lower.slice(lower.indexOf(":") + 1) : lower;
}

function textOf(node: XmlNodeLike): string {
    return (node.children ?? []).filter((c): c is string => typeof c === "string").join("");
}

function childByLocal(node: XmlNodeLike, local: string): XmlNodeLike | undefined {
    for (const c of node.children ?? []) {
        if (typeof c !== "string" && localName(c.name) === local.toLowerCase()) return c;
    }
    return undefined;
}
