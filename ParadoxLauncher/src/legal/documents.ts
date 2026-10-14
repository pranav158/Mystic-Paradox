/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import termsSource from "./terms.md?raw";
import privacySource from "./privacy.md?raw";
import { fillLegalPlaceholders } from "./legalText";

// [2026-10-14] The two documents the launcher shows, with their placeholders filled. The text is the owner's: this file
// only places it (see legalMeta.ts for the versions and the rule that a version changes with the text).
export type LegalDocumentId = "terms" | "privacy";

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, { title: string; text: string }> = {
  terms: { title: "Terms of Use", text: fillLegalPlaceholders(termsSource) },
  privacy: { title: "Privacy Policy", text: fillLegalPlaceholders(privacySource) },
};
