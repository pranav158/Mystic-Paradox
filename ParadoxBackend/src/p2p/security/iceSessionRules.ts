/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { P2PHuntSessionRecord, P2PHuntState, RealmHubPresenceRecord } from "../persistence";
import { PRESENCE_LIVE_STATES } from "../realm/realmHubRules";

// [2026-10-13] Who may set up an ICE connection with whom in a player-hosted hunt, the signals they exchange
// through the backend, and the keys that encrypt each host-joiner pair. Pure functions; the routes are in
// controllers/p2pIce.ts. Plan: SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md §5.5.

export type IceRole = "HOST" | "JOIN";
export type IceSignalKind = "DESCRIPTION" | "CANDIDATE" | "GATHERING_DONE";

export interface IceSignal {
    generation: number;
    toAccountId: string;
    kind: IceSignalKind;
    data: string;
}

/**
 * [2026-10-13 realms S1] The members of a realm hub as the ICE rules read them: its presence rows. A hub has no roster, so every
 * rule below that names a joiner takes these rows for a hub session (and ignores them for a hunt).
 */
export type IcePresenceRow = Pick<RealmHubPresenceRecord, "accountId" | "peerId" | "state">;

/** Most joiners a hub host's peer set carries (the runtime's hub ceiling). */
export const MAXIMUM_HUB_PEERS = 64;

/**
 * Hunt states in which participants may (re)build their connections. [2026-10-15] DRAINING: the members still on a drained
 * server keep their transport; admission is still refused there (TICKETABLE_STATES), so no one new joins by signalling alone.
 */
export const ICE_ACTIVE_STATES: readonly P2PHuntState[] = ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"];

const SIGNAL_KINDS: readonly IceSignalKind[] = ["DESCRIPTION", "CANDIDATE", "GATHERING_DONE"];
const ACCOUNT_ID = /^[A-Za-z0-9-]{8,64}$/;
// Printable ASCII and line breaks only: ICE descriptions and candidates are SDP attribute lines.
const SIGNAL_DATA = /^[\x20-\x7e\r\n]*$/;
export const MAX_SIGNAL_BYTES = 4096;
// Lines a description may keep when relay-only is enforced; everything else could reveal an address.
const RELAY_ONLY_KEEP = /^(?:a=ice-ufrag:|a=ice-pwd:|a=ice-options:|a=end-of-candidates$)/;
const CANDIDATE_LINE = /^(?:a=)?candidate:/;
const RELAY_CANDIDATE = / typ relay(?: |$)/;

export function IsIceActiveState(state: P2PHuntState): boolean {
    return ICE_ACTIVE_STATES.includes(state);
}

/** The caller's role in the hunt, or undefined when it is not (or no longer) part of it. */
export function ResolveIceRole(hunt: P2PHuntSessionRecord, accountId: string, presence?: readonly IcePresenceRow[]): IceRole | undefined {
    if (hunt.hostAccountId === accountId) return "HOST";
    // A hub: a member that is expected (PENDING, TICKETED) or connected (ADMITTED). A LOST member needs a fresh entry first.
    if (hunt.sessionKind === "REALM_HUB") {
        return presence?.some((row) => row.accountId === accountId && PRESENCE_LIVE_STATES.includes(row.state)) === true ? "JOIN" : undefined;
    }
    const participant = hunt.roster.find((entry) => entry.accountId === accountId);
    return participant != undefined && participant.returnedToHubAt == undefined ? "JOIN" : undefined;
}

/** Joiners still in the hunt (the host and players back in Ramsgate excluded). */
export function ActiveJoiners(hunt: P2PHuntSessionRecord, presence?: readonly IcePresenceRow[]): string[] {
    if (hunt.sessionKind === "REALM_HUB") {
        const accounts = (presence ?? []).filter((row) => row.accountId !== hunt.hostAccountId && PRESENCE_LIVE_STATES.includes(row.state))
            .map((row) => row.accountId);
        return [...new Set(accounts)].slice(0, MAXIMUM_HUB_PEERS);
    }
    return hunt.roster
        .filter((entry) => entry.accountId !== hunt.hostAccountId && entry.returnedToHubAt == undefined)
        .map((entry) => entry.accountId);
}

/**
 * The key that encrypts one host-joiner pair's traffic for one hunt generation: 32 bytes, base64url. Derived, not
 * stored, so the host and the joiner receive the same key from separate requests, and no other participant can
 * read that pair's packets.
 */
export function DeriveIcePairKey(secret: string, sessionId: string, generation: number,
    hostAccountId: string, joinerAccountId: string): string {
    return crypto.createHmac("sha256", secret)
        .update(`mysticparadox-ice-pair-v1\n${sessionId}\n${generation}\n${hostAccountId}\n${joinerAccountId}`)
        .digest("base64url");
}

/** The peers this participant connects to, each with its pair key: every active joiner for the host, the host for a joiner. */
export function IcePeersFor(hunt: P2PHuntSessionRecord, accountId: string, role: IceRole, secret: string,
    presence?: readonly IcePresenceRow[]) {
    const key = (joiner: string) => DeriveIcePairKey(secret, hunt.sessionId, hunt.generation, hunt.hostAccountId, joiner);
    if (role === "HOST") {
        return ActiveJoiners(hunt, presence).map((joiner) => ({ accountId: joiner, role: "JOIN" as const, transportKey: key(joiner) }));
    }
    return [{ accountId: hunt.hostAccountId, role: "HOST" as const, transportKey: key(accountId) }];
}

/** A signal body, or undefined when any field is missing, malformed or too large. */
export function ParseIceSignal(body: any): IceSignal | undefined {
    const generation = body?.generation;
    const toAccountId = body?.toAccountId;
    const kind = body?.kind;
    const data = body?.data ?? "";
    if (!Number.isSafeInteger(generation) || generation < 0) return undefined;
    if (typeof toAccountId !== "string" || !ACCOUNT_ID.test(toAccountId)) return undefined;
    if (!SIGNAL_KINDS.includes(kind)) return undefined;
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_SIGNAL_BYTES || !SIGNAL_DATA.test(data)) return undefined;
    if (kind !== "GATHERING_DONE" && data.trim().length === 0) return undefined;
    return { generation, toAccountId, kind, data };
}

/** Signals go only between the host and a joiner, never between two joiners or to oneself. */
export function SignalRouteAllowed(hunt: P2PHuntSessionRecord, fromAccountId: string, toAccountId: string,
    presence?: readonly IcePresenceRow[]): boolean {
    if (fromAccountId === toAccountId) return false;
    const from = ResolveIceRole(hunt, fromAccountId, presence);
    const to = ResolveIceRole(hunt, toAccountId, presence);
    return from != undefined && to != undefined && (from === "HOST") !== (to === "HOST");
}

/**
 * With relay-only enforced, a signal keeps only relay candidates and the ICE credentials, so neither side learns
 * the other's IP address even with a modified client. Returns undefined when nothing is left to deliver.
 */
export function FilterRelayOnly(kind: IceSignalKind, data: string): string | undefined {
    if (kind === "GATHERING_DONE") return data;
    const separator = data.includes("\r\n") ? "\r\n" : "\n";
    const kept = data.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
        if (line.length === 0) return false;
        if (CANDIDATE_LINE.test(line)) return RELAY_CANDIDATE.test(line);
        return kind === "DESCRIPTION" && RELAY_ONLY_KEEP.test(line);
    });
    if (kind === "CANDIDATE") return kept.length === 1 ? kept[0] : undefined;
    return kept.some((line) => line.startsWith("a=ice-ufrag:")) ? kept.join(separator) : undefined;
}
