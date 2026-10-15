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
export const PRIVACY_VERSION = "2026-10-15";
export const MINIMUM_AGE = 16;

export interface LegalRequirements {
    termsVersion: string;
    privacyVersion: string;
    minimumAge: number;
}

export function CurrentLegalRequirements(): LegalRequirements {
    return { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, minimumAge: MINIMUM_AGE };
}
