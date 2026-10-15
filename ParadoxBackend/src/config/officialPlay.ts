/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { DedicatedServersConfigured } from "./dedicatedServers";

export const OFFICIAL_PLAY_ENV = "MYSTICPARADOX_OFFICIAL_PLAY";
/** What the launcher shows when official play is off (the status route and the refused game session both say it). */
export const OFFICIAL_PLAY_UNAVAILABLE_MESSAGE = "The official server is currently unavailable. Join or host a realm.";

export interface OfficialPlayStatus {
    /** Whether a launch with no realm (official play) is offered. */
    available: boolean;
    /** Set when official play is off: the message the launcher shows. */
    message?: string;
}

const ReportedRefusals = new Set<string>();

function Unavailable(): OfficialPlayStatus {
    return { available: false, message: OFFICIAL_PLAY_UNAVAILABLE_MESSAGE };
}

/**
 * [2026-10-15] MYSTICPARADOX_OFFICIAL_PLAY=on|off: whether official play (a launch with no realm) is offered. Unset or blank is the
 * default: on when DEPLOYSERVER_URL is set, otherwise off, because official hunts and hubs need a DeployServer. Only on and off are
 * recognised, case-insensitively and trimmed. Any other value fails closed to off, with one warning, as
 * MYSTICPARADOX_REGISTRATION_APPROVAL does. Realm play is not affected by this switch.
 */
export function ReadOfficialPlay(environment: NodeJS.ProcessEnv = process.env): OfficialPlayStatus {
    const raw = (environment[OFFICIAL_PLAY_ENV] ?? "").trim().toLowerCase();
    if (raw === "on") return { available: true };
    if (raw === "off") return Unavailable();
    if (raw === "") return DedicatedServersConfigured(environment) ? { available: true } : Unavailable();
    const refusal = `${OFFICIAL_PLAY_ENV} must be on or off (got ${JSON.stringify(raw)}); official play is treated as off`;
    if (!ReportedRefusals.has(refusal)) {
        ReportedRefusals.add(refusal);
        logger.warn(`[OfficialPlay] WARNING: ${refusal}`);
    }
    return Unavailable();
}
