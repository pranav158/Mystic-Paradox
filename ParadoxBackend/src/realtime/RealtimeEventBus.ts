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

import { EventEmitter } from "node:events";


export interface RealtimeEventMap {
    "friend.invited": { ownerId: string; otherId: string };
    "friend.accepted": { ownerId: string; otherId: string };
    "friend.removed": { ownerId: string; otherId: string };
    "friend.blocked": { ownerId: string; otherId: string };
    "party.invited": { partyId: string; inviterId: string; inviteeId: string };
    "party.joined": { partyId: string; accountId: string };
    "party.left": { partyId: string; accountId: string };
    "party.kicked": { partyId: string; accountId: string };
    "party.dissolved": { partyId: string };
    "session.activityChanged": { accountId: string; activity: string };
}

export type RealtimeEventName = keyof RealtimeEventMap;

export class RealtimeEventBus {
    private readonly emitter = new EventEmitter();

    constructor() {
        
        
        this.emitter.setMaxListeners(64);
    }

    publish<E extends RealtimeEventName>(event: E, payload: RealtimeEventMap[E]): void {
        this.emitter.emit(event, payload);
    }

    subscribe<E extends RealtimeEventName>(
        event: E,
        handler: (payload: RealtimeEventMap[E]) => void,
    ): () => void {
        const wrapped = handler as (...args: unknown[]) => void;
        this.emitter.on(event, wrapped);
        return () => this.emitter.off(event, wrapped);
    }
}


export const realtimeEventBus = new RealtimeEventBus();
