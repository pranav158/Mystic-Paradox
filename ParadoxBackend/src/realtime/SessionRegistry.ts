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


export interface RegisteredConnection {
    readonly connId: string;
    readonly accountId?: string;
    readonly resource?: string;
    
    send(frame: string): void;
    close(code: number, reason: string): void;
}


export class SessionRegistry {
    private readonly byAccount = new Map<string, Map<string, RegisteredConnection>>();

    
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

    
    connectionFor(accountId: string, resource: string): RegisteredConnection | undefined {
        return this.byAccount.get(accountId)?.get(resource);
    }

    onlineAccountCount(): number {
        return this.byAccount.size;
    }

    
    onlineAccountIds(): string[] {
        return [...this.byAccount.keys()];
    }
}

export const sessionRegistry = new SessionRegistry();
