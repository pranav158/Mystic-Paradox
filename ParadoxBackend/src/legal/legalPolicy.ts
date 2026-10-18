/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] The Terms of Use and Privacy Policy versions the launcher shows (ParadoxLauncher/src/legal/legalMeta.ts) and the
// minimum age. TERMS_VERSION, PRIVACY_VERSION and MINIMUM_AGE must equal the launcher's values: change both sides together, and
// bump a version whenever the text changes in substance so signed-in players are asked to accept it again. legalPolicy.test.ts
// reads the launcher file and fails when they drift apart.

export const TERMS_VERSION = "2026-10-14";
export const PRIVACY_VERSION = "2026-10-17";
export const MINIMUM_AGE = 16;

export interface LegalRequirements {
    termsVersion: string;
    privacyVersion: string;
    minimumAge: number;
}

// [2026-10-15] Earlier privacy versions still counted as accepted, for a transition. 2026-10-15 only adds the tester log-upload
// text (tester accounts only). A 0.1.66 launcher carries 2026-10-14.2: with an exact match its players were stopped at the consent
// screen, unable to accept the new text and unable to reach their update. Drop an entry once the Guard minimum launcher shows the
// current version (0.1.67 for 2026-10-15).
// [2026-10-16] 2026-10-16 only states plainly that log files come from tester accounts alone (upload switched off for everyone
// else, never collected). Launchers up to 0.1.73 carry 2026-10-15, so it stays accepted until the Guard minimum launcher shows
// 2026-10-16.
// [2026-10-17] 2026-10-17 describes the wider tester log upload (the newest session and the logs since, the game servers a
// tester's PC runs for their realm, which name the other players there, connection logs and the game's settings files).
// Launchers before it carry 2026-10-16 or older, so every earlier version stays accepted until the Guard minimum launcher
// shows 2026-10-17; dropping only the older ones now would ask some players to accept twice.
export const PRIVACY_VERSIONS_STILL_ACCEPTED: readonly string[] = ["2026-10-16", "2026-10-15", "2026-10-14.2"];

/** Whether a privacy version counts as accepted: the current one, or one still accepted during its transition. */
export function IsAcceptedPrivacyVersion(version: unknown, required: LegalRequirements = CurrentLegalRequirements()): boolean {
    if (typeof version !== "string") return false;
    if (version === required.privacyVersion) return true;
    return required.privacyVersion === PRIVACY_VERSION && PRIVACY_VERSIONS_STILL_ACCEPTED.includes(version);
}

export function CurrentLegalRequirements(): LegalRequirements {
    return { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, minimumAge: MINIMUM_AGE };
}
