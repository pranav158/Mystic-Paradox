/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { LEGAL } from "./legalMeta";

// [2026-10-14] Fills the placeholders of the Terms of Use and Privacy Policy from legalMeta.ts. Pure, so the tests load it
// for real; the documents themselves are imported with Vite's `?raw` in documents.ts.
export function fillLegalPlaceholders(source: string): string {
  return source
    .split("{{TERMS_VERSION}}").join(LEGAL.termsVersion)
    .split("{{PRIVACY_VERSION}}").join(LEGAL.privacyVersion)
    .split("{{MINIMUM_AGE}}").join(String(LEGAL.minimumAge))
    .split("{{PRIVACY_EMAIL}}").join(LEGAL.contactEmail)
    .split("{{SUPPORT_EMAIL}}").join(LEGAL.supportEmail);
}
