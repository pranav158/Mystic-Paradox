/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../../logger";

// [2026-10-17] MYSTICPARADOX_HUNT_EVIDENCE=on|off: whether a hosted hunt's server produces Hunt Guard evidence (the bootstrap's
// evidenceCollection; the launcher then sets MYSTICPARADOX_HUNT_GUARD_EVENTS=1 for the hunt server it starts, launcher
// p2p/session/hub.rs plan_host). Off by default at trust tier 0, because the evidence lags every hosted hunt:
//   - the host's transport (ParadoxTransport transport_app.cpp RunIceHost) relays the game's packets and posts each Guard event to the
//     backend on the same thread, one blocking HTTPS request per event, so every post stops the packets of every player in the hunt
//     (the host's own client too) for one round trip to the backend, a few hundred ms for players far from the server;
//   - a fight queues events faster than they post, the loop drains the queue before it pumps packets again, and the players rubber-band
//     (they appear to teleport);
//   - the events then used up the hunt's Guard traffic window, the host's lease renewals got 429 with them (routes/p2pHunts.ts) and the
//     hunt was fenced under its players.
// Tier 0 pays no reward from the evidence (rewards are the host's tagged writes) and the Guard there only observes, so nothing in play
// depends on it; a hunt whose host does not play has always run without it. Tier 1 rewards are decided from the evidence, so there the
// default is on. Turn it back on once a transport posts off its packet thread.

export const HUNT_EVIDENCE_ENV = "MYSTICPARADOX_HUNT_EVIDENCE";

export interface HuntEvidenceSetting {
    enabled: boolean;
    /** True when the variable is unset or blank and the tier's default applies. */
    isDefault: boolean;
    /** Set when the variable held an unrecognised value (the tier's default then applies). */
    warning?: string;
}

/** Pure: the setting from the environment. on/off (trimmed, case-insensitive); otherwise on at trust tier 1, off at tier 0. */
export function ResolveHuntEvidence(environment: NodeJS.ProcessEnv = process.env): HuntEvidenceSetting {
    const TierDefault = environment.P2P_TRUST_TIER?.trim() === "1";
    const Raw = (environment[HUNT_EVIDENCE_ENV] ?? "").trim().toLowerCase();
    if (Raw === "") return { enabled: TierDefault, isDefault: true };
    if (Raw === "on") return { enabled: true, isDefault: false };
    if (Raw === "off") return { enabled: false, isDefault: false };
    return {
        enabled: TierDefault, isDefault: false,
        warning: `${HUNT_EVIDENCE_ENV} must be on or off (got ${JSON.stringify(Raw)}); the trust tier's default applies ` +
            `(${TierDefault ? "on" : "off"})`
    };
}

/** Whether hosted hunts collect Hunt Guard evidence now. */
export function HuntEvidenceEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return ResolveHuntEvidence(environment).enabled;
}

/** One startup line with the setting (plus a warning when the value was unrecognised). */
export function LogHuntEvidence(setting: HuntEvidenceSetting = ResolveHuntEvidence(),
    sink: { info(message: string): void; warn(message: string): void } = logger): void {
    if (setting.warning !== undefined) sink.warn(`[Startup] WARNING: ${setting.warning}`);
    const Source = setting.isDefault ? " not set (the trust tier's default)" : "";
    sink.info(setting.enabled
        ? `[Startup] ${HUNT_EVIDENCE_ENV}${Source || "=on"}: hosted hunts send Hunt Guard evidence (the host's transport posts it ` +
            "on its packet thread)"
        : `[Startup] ${HUNT_EVIDENCE_ENV}${Source || "=off"}: hosted hunts send no Hunt Guard evidence`);
}
