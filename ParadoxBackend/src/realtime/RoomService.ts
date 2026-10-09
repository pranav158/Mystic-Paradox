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

/**
 * WP8 (task #7) — secure Party MUC. Captured room JID (plan §27):
 *   Party-<partyId>@muc.prod.ol.epicgames.com/<nick>   (nick = displayName:userId:resource)
 * where <partyId> already carries the `_<base64(buildId)>` suffix from MakePartyId — so the room
 * localpart is exactly `Party-` + partyId (do NOT append another suffix).
 *
 * AUTHORIZATION IS BY THE AUTHENTICATED ACCOUNT, NEVER THE NICK: a client joins Party-<partyId>
 * only if the durable GetPartyForPlayer(accountId).partyId === partyId. The nick is presentation data echoed
 * back. City-<uuid> rooms are dev-gated + explicitly insecure (DEV_CITY_MUC) until an
 * accountId->instance mapping exists (task #8).
 *
 * MUC subset implemented (XEP-0045 over RFC 7395): join -> existing occupants' presence to joiner
 * + self-presence(110); notify existing occupants of the newcomer; groupchat message fanout;
 * leave/disconnect -> unavailable presence to remaining occupants; room removed when empty.
 */

const MUC_DOMAIN = "muc.prod.ol.epicgames.com";
const XMPP_DOMAIN = "prod.ol.epicgames.com";
const NS_MUC_USER = "http://jabber.org/protocol/muc#user";
const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const MAX_GROUPCHAT_BYTES = 4 * 1024;
const MAX_ROOM_LOCAL_LENGTH = 256;
const MAX_NICK_LENGTH = 256;
const MAX_STANZA_ID_LENGTH = 128;

// DEV-ONLY, INSECURE: City (Ramsgate instance) rooms have no authoritative accountId->instance
// mapping yet (plan §27 / reviewer task #8), so we cannot verify a user really belongs to a given
// City-<uuid>. When enabled (default during this dev phase), ANY authenticated user may join ANY
// City-* room. Set REALTIME_XMPP_DEV_CITY_MUC=false to disable until the mapping exists.
const DEV_CITY_MUC = process.env.REALTIME_XMPP_DEV_CITY_MUC !== "false";

// DEV-ONLY, INSECURE: same story as City rooms above, but for Hunt (island) instances. Without this,
// authorizeJoin() falls through to "unknown room type" and the client is denied every Hunt-<uuid> MUC
// join, retrying forever - island chat is silently and permanently broken. Set
// REALTIME_XMPP_DEV_HUNT_MUC=false to disable until an accountId->instance mapping exists.
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

/** Parse "Party-<id>@muc.domain/<nick>" -> parts. Returns undefined if not a well-formed room JID. */
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
    // Emit the canonical owned domain even if the client used different casing.
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

    /**
     * Handle a MUC join (directed available presence). Sends occupant/self presence directly to the
     * relevant connections and returns any frames the JOINER's own connection should send.
     */
    async joinRoom(conn: RegisteredConnection, to: string): Promise<string[]> {
        const target = parseRoomJid(to, true);
        const accountId = conn.accountId;
        const resource = conn.resource;
        if (!target || !accountId || !resource) return [];

        const auth = await this.authorizeJoin(target.roomLocal, accountId);
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

        // 1) Existing occupants' presence -> the joiner.
        for (const occ of room.values()) {
            frames.push(this.occupantPresence(target.roomBare, occ.nick, fullJid(occ.accountId, occ.resource), joinerFull, false));
            // 2) Newcomer presence -> each existing occupant.
            occ.conn.send(this.occupantPresence(target.roomBare, target.nick, joinerFull, fullJid(occ.accountId, occ.resource), false));
        }

        // Register the occupant (replacing any prior same-resource entry).
        room.set(occupantKey(accountId, resource), joiner);

        // 3) Self-presence (status 110) -> the joiner, last.
        frames.push(this.occupantPresence(target.roomBare, target.nick, joinerFull, joinerFull, true));

        logger.info(`[XMPP] MUC join room=${sanitizeName(target.roomLocal)} occupants=${room.size}`);
        return frames;
    }

    /** Fan out a groupchat message to every occupant of the room. Sender must be an occupant. */
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

    /** Explicit leave (unavailable presence to a room). */
    leaveRoom(conn: RegisteredConnection, to: string): void {
        const target = parseRoomJid(to);
        if (!target || !conn.accountId || !conn.resource) return;
        this.removeOccupant(target.roomLocal, conn.accountId, conn.resource);
    }

    /**
     * Room-join authorization. Party-<partyId>: the authenticated account must be a member of that
     * Phoenix party (never the nick). City-<uuid>: dev-gated + insecure (no instance mapping yet).
     */
    private async authorizeJoin(roomLocal: string, accountId: string): Promise<{ ok: boolean; reason: string }> {
        if (roomLocal.startsWith("Party-")) {
            const partyId = roomLocal.slice("Party-".length);
            const party = await GetPartyForPlayer(accountId);
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

    /** Remove a closed connection from every room it occupied (called on teardown). */
    onConnectionClosed(conn: RegisteredConnection): void {
        if (!conn.accountId || !conn.resource) return;
        for (const roomLocal of [...this.rooms.keys()]) {
            this.removeOccupant(roomLocal, conn.accountId, conn.resource);
        }
    }

    /** Evict every live resource for an account after a committed durable membership removal. */
    evictPartyMember(partyId: string, accountId: string): void {
        const roomLocal = `Party-${partyId}`;
        const room = this.rooms.get(roomLocal);
        if (room == undefined) return;
        for (const occupant of [...room.values()]) {
            if (occupant.accountId === accountId) this.removeOccupant(roomLocal, accountId, occupant.resource);
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

    /** occupantFull is the JID of the occupant this presence describes; toFull is the recipient. */
    private occupantPresence(roomBare: string, nick: string, occupantFull: string, toFull: string, isSelf: boolean): string {
        const selfStatus = isSelf ? `<status code="110"/>` : "";
        return (
            `<presence from="${escapeXml(roomBare)}/${escapeXml(nick)}" to="${escapeXml(toFull)}">` +
            `<x xmlns="${NS_MUC_USER}"><item affiliation="member" role="participant" jid="${escapeXml(occupantFull)}"/>${selfStatus}</x></presence>`
        );
    }
}

export const roomService = new RoomService();
