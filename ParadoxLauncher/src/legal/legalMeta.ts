/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] The Terms of Use and Privacy Policy the launcher shows and asks players to accept. The backend requires the
// same versions and minimum age (ParadoxBackend/src/legal/legalPolicy.ts); change both together, and bump a version whenever
// the text changes in substance so signed-in players are asked to accept it again.
export const LEGAL = {
  termsVersion: "2026-10-14",
  privacyVersion: "2026-10-17",
  minimumAge: 16,
  /** {{PRIVACY_EMAIL}}: privacy and data requests only (access, correction, export, deletion questions). */
  contactEmail: "privacy@mysticfox.dev",
  /** {{SUPPORT_EMAIL}}: help, bug and abuse reports, bans and appeals. */
  supportEmail: "support@mysticfox.dev",
} as const;
