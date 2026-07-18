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

import { GetPartyForPlayer } from "../controllers/party";
import { logger } from "../logger";
import { RegisteredConnection } from "./SessionRegistry";
import { escapeXml, sanitizeName } from "./xml";



const MUC_DOMAIN = "muc.prod.ol.epicgames.com";
const XMPP_DOMAIN = "prod.ol.epicgames.com";
const NS_MUC_USER = "http://jabber.org/protocol/muc#user";
const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const MAX_GROUPCHAT_BYTES = 4 * 1024;
const MAX_ROOM_LOCAL_LENGTH = 256;
const MAX_NICK_LENGTH = 256;
const MAX_STANZA_ID_LENGTH = 128;





const DEV_CITY_MUC = process.env.REALTIME_XMPP_DEV_CITY_MUC !== "false";





const DEV_HUNT_MUC = process.env.REALTIME_XMPP_DEV_HUNT_MUC !== "false";

interface Occupant {
    accountId: string;
    resource: string;
    nick: string;
    conn: RegisteredConnection;
}

function occupantKey(accountId: string, resource: string): string {
    return `${accountId}\u0000${resource}`;
}

function fullJid(accountId: string, resource: string): string {
    return `${accountId}@${XMPP_DOMAIN}/${resource}`;
}


export function parseRoomJid(to: string, requireNick = false): { roomBare: string; roomLocal: string; nick: string } | undefined {
    const slash = to.indexOf("/");
    const roomBare = slash >= 0 ? to.slice(0, slash) : to;
    const nick = slash >= 0 ? to.slice(slash + 1) : "";
    const at = roomBare.indexOf("@");
    if (at <= 0 || roomBare.indexOf("@", at + 1) >= 0) return undefined;
    const roomLocal = roomBare.slice(0, at);
    const domain = roomBare.slice(at + 1).toLowerCase();
    if (
        domain !== MUC_DOMAIN ||
        roomLocal.length === 0 || roomLocal.length > MAX_ROOM_LOCAL_LENGTH ||
        (requireNick && nick.length === 0) || nick.length > MAX_NICK_LENGTH
    ) {
        return undefined;
    }
    
    return { roomBare: `${roomLocal}@${MUC_DOMAIN}`, roomLocal, nick };
}

export class RoomService {
    private readonly rooms = new Map<string, Map<string, Occupant>>();
    private cityWarned = false;
    private huntWarned = false;

    constructor(
        private readonly devCityMuc = DEV_CITY_MUC,
        private readonly devHuntMuc = DEV_HUNT_MUC,
    ) {}

    
    joinRoom(conn: RegisteredConnection, to: string): string[] {
        const target = parseRoomJid(to, true);
        const accountId = conn.accountId;
        const resource = conn.resource;
        if (!target || !accountId || !resource) return [];

        const auth = this.authorizeJoin(target.roomLocal, accountId);
        if (!auth.ok) {
            logger.warn(`[XMPP] MUC join denied (${auth.reason}) room=${sanitizeName(target.roomLocal)}`);
            return [
                `<presence type="error" from="${escapeXml(target.roomBare)}/${escapeXml(target.nick)}" to="${escapeXml(fullJid(accountId, resource))}">` +
                `<error type="auth"><not-allowed xmlns="${NS_STANZAS}"/></error></presence>`,
            ];
        }

        let room = this.rooms.get(target.roomLocal);
        if (!room) {
            room = new Map<string, Occupant>();
            this.rooms.set(target.roomLocal, room);
        }

        const joiner: Occupant = { accountId, resource, nick: target.nick, conn };
        const joinerFull = fullJid(accountId, resource);
        const frames: string[] = [];

        
        for (const occ of room.values()) {
            frames.push(this.occupantPresence(target.roomBare, occ.nick, fullJid(occ.accountId, occ.resource), joinerFull, false));
            
            occ.conn.send(this.occupantPresence(target.roomBare, target.nick, joinerFull, fullJid(occ.accountId, occ.resource), false));
        }

        
        room.set(occupantKey(accountId, resource), joiner);

        
        frames.push(this.occupantPresence(target.roomBare, target.nick, joinerFull, joinerFull, true));

        logger.info(`[XMPP] MUC join room=${sanitizeName(target.roomLocal)} occupants=${room.size}`);
        return frames;
    }

    
    groupMessage(conn: RegisteredConnection, to: string, stanzaId: string, body: string): void {
        const target = parseRoomJid(to);
        const accountId = conn.accountId;
        const resource = conn.resource;
        if (!target || !accountId || !resource) return;

        const room = this.rooms.get(target.roomLocal);
        if (!room) return;
        const sender = room.get(occupantKey(accountId, resource));
        if (!sender) {
            logger.warn(`[XMPP] groupchat denied (not an occupant of ${sanitizeName(target.roomLocal)})`);
            return;
        }
        if (body.trim().length === 0 || Buffer.byteLength(body, "utf8") > MAX_GROUPCHAT_BYTES) return;

        const idAttr = stanzaId.length > 0 && stanzaId.length <= MAX_STANZA_ID_LENGTH
            ? ` id="${escapeXml(stanzaId)}"`
            : "";
        let delivered = 0;
        for (const occ of room.values()) {
            const frame =
                `<message type="groupchat" from="${escapeXml(target.roomBare)}/${escapeXml(sender.nick)}" ` +
                `to="${escapeXml(fullJid(occ.accountId, occ.resource))}"${idAttr}><body>${escapeXml(body)}</body></message>`;
            occ.conn.send(frame);
            delivered += 1;
        }
        logger.info(`[XMPP] groupchat room=${sanitizeName(target.roomLocal)} delivered=${delivered} bytes=${Buffer.byteLength(body, "utf8")}`);
    }

    
    leaveRoom(conn: RegisteredConnection, to: string): void {
        const target = parseRoomJid(to);
        if (!target || !conn.accountId || !conn.resource) return;
        this.removeOccupant(target.roomLocal, conn.accountId, conn.resource);
    }

    
    private authorizeJoin(roomLocal: string, accountId: string): { ok: boolean; reason: string } {
        if (roomLocal.startsWith("Party-")) {
            const partyId = roomLocal.slice("Party-".length);
            const party = GetPartyForPlayer(accountId);
            if (party && party.partyId === partyId) return { ok: true, reason: "" };
            return { ok: false, reason: "not a party member" };
        }
        if (roomLocal.startsWith("City-")) {
            if (!this.devCityMuc) return { ok: false, reason: "city muc disabled" };
            if (!this.cityWarned) {
                this.cityWarned = true;
                logger.warn(
                    "[XMPP][INSECURE] dev City MUC enabled: any authenticated user may join any City-* room " +
                    "(no accountId->instance authorization yet — task #8). Set REALTIME_XMPP_DEV_CITY_MUC=false to disable.",
                );
            }
            return { ok: true, reason: "" };
        }
        if (roomLocal.startsWith("Hunt-")) {
            if (!this.devHuntMuc) return { ok: false, reason: "hunt muc disabled" };
            if (!this.huntWarned) {
                this.huntWarned = true;
                logger.warn(
                    "[XMPP][INSECURE] dev Hunt MUC enabled: any authenticated user may join any Hunt-* room " +
                    "(no accountId->instance authorization yet — task #8). Set REALTIME_XMPP_DEV_HUNT_MUC=false to disable.",
                );
            }
            return { ok: true, reason: "" };
        }
        return { ok: false, reason: "unknown room type" };
    }

    
    onConnectionClosed(conn: RegisteredConnection): void {
        if (!conn.accountId || !conn.resource) return;
        for (const roomLocal of [...this.rooms.keys()]) {
            this.removeOccupant(roomLocal, conn.accountId, conn.resource);
        }
    }

    private removeOccupant(roomLocal: string, accountId: string, resource: string): void {
        const room = this.rooms.get(roomLocal);
        if (!room) return;
        const key = occupantKey(accountId, resource);
        const leaving = room.get(key);
        if (!leaving) return;
        room.delete(key);

        const roomBare = `${roomLocal}@${MUC_DOMAIN}`;
        const leavingFull = fullJid(leaving.accountId, leaving.resource);
        for (const occ of room.values()) {
            occ.conn.send(
                `<presence type="unavailable" from="${escapeXml(roomBare)}/${escapeXml(leaving.nick)}" ` +
                `to="${escapeXml(fullJid(occ.accountId, occ.resource))}"><x xmlns="${NS_MUC_USER}">` +
                `<item affiliation="member" role="participant" jid="${escapeXml(leavingFull)}"/></x></presence>`,
            );
        }
        if (room.size === 0) this.rooms.delete(roomLocal);
    }

    
    private occupantPresence(roomBare: string, nick: string, occupantFull: string, toFull: string, isSelf: boolean): string {
        const selfStatus = isSelf ? `<status code="110"/>` : "";
        return (
            `<presence from="${escapeXml(roomBare)}/${escapeXml(nick)}" to="${escapeXml(toFull)}">` +
            `<x xmlns="${NS_MUC_USER}"><item affiliation="member" role="participant" jid="${escapeXml(occupantFull)}"/>${selfStatus}</x></presence>`
        );
    }
}

export const roomService = new RoomService();
