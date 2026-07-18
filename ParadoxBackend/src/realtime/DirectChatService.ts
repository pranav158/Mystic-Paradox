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

import type { FriendshipRepository } from "../persistence/contracts/FriendshipRepository";
import { GetRepositories } from "../persistence";
import { logger } from "../logger";
import { parseJid } from "./jid";
import { RegisteredConnection, sessionRegistry } from "./SessionRegistry";
import { escapeXml, sanitizeName } from "./xml";

const XMPP_DOMAIN = "prod.ol.epicgames.com";
const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const MAX_DIRECT_MESSAGE_BYTES = 4 * 1024;
const MAX_STANZA_ID_LENGTH = 128;
const MAX_RESOURCE_LENGTH = 128;



const PER_CONNECTION_LIMIT = 12;
const PER_CONNECTION_WINDOW_MS = 10_000;
const PER_ACCOUNT_LIMIT = 60;
const PER_ACCOUNT_WINDOW_MS = 60_000;

interface RegistryLookup {
    connectionsFor(accountId: string): RegisteredConnection[];
    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined;
}

type FriendshipLookup = Pick<FriendshipRepository, "find">;

interface RateWindow {
    startedAt: number;
    count: number;
}

function fullJid(accountId: string, resource: string): string {
    return `${accountId}@${XMPP_DOMAIN}/${resource}`;
}

function messageError(from: string, to: string, stanzaId: string, type: string, condition: string): string {
    const id = safeStanzaId(stanzaId);
    const idAttr = id.length > 0 ? ` id="${escapeXml(id)}"` : "";
    return (
        `<message type="error" from="${escapeXml(from)}" to="${escapeXml(to)}"${idAttr}>` +
        `<error type="${escapeXml(type)}"><${condition} xmlns="${NS_STANZAS}"/></error></message>`
    );
}

function safeStanzaId(stanzaId: string): string {
    return stanzaId.length <= MAX_STANZA_ID_LENGTH ? stanzaId : "";
}


export class DirectChatService {
    private readonly connectionRates = new Map<string, RateWindow>();
    private readonly accountRates = new Map<string, RateWindow>();

    constructor(
        private readonly getFriendships: () => FriendshipLookup,
        private readonly registry: RegistryLookup,
        private readonly now: () => number = Date.now,
    ) {}

    
    async routeDirectMessage(
        sender: RegisteredConnection,
        rawTarget: string,
        stanzaId: string,
        body: string,
    ): Promise<string[]> {
        const senderId = sender.accountId;
        const senderResource = sender.resource;
        if (!senderId || !senderResource) return [];

        const senderFull = fullJid(senderId, senderResource);
        const target = parseJid(rawTarget);
        if (
            !target ||
            target.local.length === 0 ||
            target.domain !== XMPP_DOMAIN ||
            target.resource.length > MAX_RESOURCE_LENGTH
        ) {
            logger.warn(`[XMPP] direct chat denied sender=${sanitizeName(senderId)} reason=bad-target`);
            return [messageError(rawTarget, senderFull, stanzaId, "modify", "jid-malformed")];
        }

        const recipientId = target.local;
        const bytes = Buffer.byteLength(body, "utf8");
        if (body.trim().length === 0 || bytes > MAX_DIRECT_MESSAGE_BYTES) {
            logger.warn(`[XMPP] direct chat denied sender=${sanitizeName(senderId)} recipient=${sanitizeName(recipientId)} reason=invalid-body bytes=${bytes}`);
            return [messageError(rawTarget, senderFull, stanzaId, "modify", "not-acceptable")];
        }

        if (
            !this.consumeRate(this.connectionRates, sender.connId, PER_CONNECTION_LIMIT, PER_CONNECTION_WINDOW_MS) ||
            !this.consumeRate(this.accountRates, senderId, PER_ACCOUNT_LIMIT, PER_ACCOUNT_WINDOW_MS)
        ) {
            logger.warn(`[XMPP] direct chat rate-limited sender=${sanitizeName(senderId)}`);
            return [messageError(rawTarget, senderFull, stanzaId, "wait", "resource-constraint")];
        }

        if (recipientId === senderId) {
            return [messageError(rawTarget, senderFull, stanzaId, "cancel", "not-allowed")];
        }

        let accepted = false;
        try {
            const friendships = this.getFriendships();
            const [outbound, inbound] = await Promise.all([
                friendships.find(senderId, recipientId),
                friendships.find(recipientId, senderId),
            ]);
            accepted = outbound?.status === "ACCEPTED" && inbound?.status === "ACCEPTED";
        } catch (e) {
            logger.error(`[XMPP] direct chat friendship lookup failed sender=${sanitizeName(senderId)} recipient=${sanitizeName(recipientId)}: ${e}`);
            return [messageError(rawTarget, senderFull, stanzaId, "wait", "internal-server-error")];
        }

        if (!accepted) {
            logger.warn(`[XMPP] direct chat denied sender=${sanitizeName(senderId)} recipient=${sanitizeName(recipientId)} reason=not-friends`);
            return [messageError(rawTarget, senderFull, stanzaId, "auth", "forbidden")];
        }

        const recipients = target.resource.length > 0
            ? [this.registry.connectionFor(recipientId, target.resource)].filter((c): c is RegisteredConnection => c !== undefined)
            : this.registry.connectionsFor(recipientId);

        if (recipients.length === 0) {
            logger.info(`[XMPP] direct chat recipient offline sender=${sanitizeName(senderId)} recipient=${sanitizeName(recipientId)}`);
            return [messageError(rawTarget, senderFull, stanzaId, "cancel", "service-unavailable")];
        }

        const clientId = safeStanzaId(stanzaId);
        const idAttr = clientId.length > 0 ? ` id="${escapeXml(clientId)}"` : "";
        const deliveryId = crypto.randomBytes(8).toString("hex");
        for (const recipient of recipients) {
            if (!recipient.resource) continue;
            recipient.send(
                `<message type="chat" from="${escapeXml(senderFull)}" to="${escapeXml(fullJid(recipientId, recipient.resource))}"${idAttr}>` +
                `<body>${escapeXml(body)}</body></message>`,
            );
        }

        logger.info(
            `[XMPP] direct chat delivered id=${deliveryId} sender=${sanitizeName(senderId)} ` +
            `recipient=${sanitizeName(recipientId)} resources=${recipients.length} bytes=${bytes}`,
        );
        return [];
    }

    private consumeRate(store: Map<string, RateWindow>, key: string, limit: number, windowMs: number): boolean {
        const now = this.now();
        const current = store.get(key);
        if (!current || now - current.startedAt >= windowMs) {
            store.set(key, { startedAt: now, count: 1 });
            return true;
        }
        if (current.count >= limit) return false;
        current.count += 1;
        return true;
    }
}

export const directChatService = new DirectChatService(
    () => GetRepositories().friendships,
    sessionRegistry,
);
