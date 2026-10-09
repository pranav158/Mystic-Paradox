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

import { logger } from "../logger";

/**
 * Minimal connection surface the registry needs. XMPPConnection satisfies this structurally, which
 * keeps the registry decoupled from the connection implementation (and avoids a runtime import cycle).
 */
export interface RegisteredConnection {
    readonly connId: string;
    readonly accountId?: string;
    readonly resource?: string;
    /** Send a raw RFC 7395 frame to this client (presence/room fan-out). */
    send(frame: string): void;
    close(code: number, reason: string): void;
}

/**
 * Task #4 — in-memory session/resource registry: accountId -> resource -> connection. Single
 * process (plan §17 scaling boundary). Backs the duplicate-resource policy (deterministic
 * replacement) and aggregate presence: an account is online iff it has >= 1 live resource. WP5
 * presence and later message/room routing consult this.
 */
export class SessionRegistry {
    private readonly byAccount = new Map<string, Map<string, RegisteredConnection>>();

    /**
     * Register (accountId, resource) -> conn. If the same key was already held by a DIFFERENT
     * connection, that displaced connection is returned so the caller can close it (deterministic
     * replacement policy, plan §10.3).
     */
    bind(accountId: string, resource: string, conn: RegisteredConnection): RegisteredConnection | undefined {
        let resources = this.byAccount.get(accountId);
        if (resources === undefined) {
            resources = new Map<string, RegisteredConnection>();
            this.byAccount.set(accountId, resources);
        }
        const prev = resources.get(resource);
        resources.set(resource, conn);
        if (prev !== undefined && prev !== conn) {
            logger.info(`[XMPP] registry: resource "${resource}" replaced (conn ${prev.connId} -> ${conn.connId})`);
            return prev;
        }
        return undefined;
    }

    /** Remove (accountId, resource) only if the stored connection is `conn` (never clobber a replacement). */
    unbind(accountId: string, resource: string, conn: RegisteredConnection): void {
        const resources = this.byAccount.get(accountId);
        if (resources === undefined) return;
        if (resources.get(resource) === conn) {
            resources.delete(resource);
            if (resources.size === 0) this.byAccount.delete(accountId);
        }
    }

    isOnline(accountId: string): boolean {
        const r = this.byAccount.get(accountId);
        return r !== undefined && r.size > 0;
    }

    connectionsFor(accountId: string): RegisteredConnection[] {
        const r = this.byAccount.get(accountId);
        return r ? [...r.values()] : [];
    }

    /** Resolve one exact full-JID resource; used when a direct message targets a full JID. */
    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined {
        return this.byAccount.get(accountId)?.get(resource);
    }

    onlineAccountCount(): number {
        return this.byAccount.size;
    }

    /** Snapshot the deduplicated account identities currently holding at least one live resource. */
    onlineAccountIds(): string[] {
        return [...this.byAccount.keys()];
    }
}

export const sessionRegistry = new SessionRegistry();
