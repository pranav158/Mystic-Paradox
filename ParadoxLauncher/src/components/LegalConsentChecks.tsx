/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { LegalDocumentId } from "../legal/documents";

// [2026-10-14] The two boxes a player ticks before an account is created or the current documents are accepted: the age,
// and the Terms of Use and Privacy Policy. Each document name opens its text in the viewer (`onOpen`); the names are
// buttons inside the label, so a click on them does not tick the box.
interface LegalConsentChecksProps {
  minimumAge: number;
  age: boolean;
  agree: boolean;
  disabled?: boolean;
  onAgeChange: (checked: boolean) => void;
  onAgreeChange: (checked: boolean) => void;
  onOpen: (document: LegalDocumentId) => void;
}

export function LegalConsentChecks({ minimumAge, age, agree, disabled = false, onAgeChange, onAgreeChange, onOpen }: LegalConsentChecksProps) {
  return (
    <div className="legal-checks">
      <label className="check legal-check">
        <input type="checkbox" checked={age} disabled={disabled} onChange={(event) => onAgeChange(event.target.checked)} />
        <span>I am {minimumAge} or older</span>
      </label>
      <label className="check legal-check">
        <input type="checkbox" checked={agree} disabled={disabled} onChange={(event) => onAgreeChange(event.target.checked)} />
        <span>
          I agree to the{" "}
          <button type="button" className="link" onClick={() => onOpen("terms")}>Terms of Use</button>
          {" "}and the{" "}
          <button type="button" className="link" onClick={() => onOpen("privacy")}>Privacy Policy</button>
        </span>
      </label>
    </div>
  );
}
