/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { LEGAL_DOCUMENTS, type LegalDocumentId } from "../legal/documents";
import { renderLegalMarkdown } from "../legal/legalMarkdown";

// [2026-10-14] The Terms of Use and Privacy Policy, read in a dialog. The text is the documents' own (src/legal), rendered
// by the safe renderer; links open in the system browser (or the mail app for an address).

function openInBrowser(href: string) {
  openUrl(href).catch(() => window.open(href, "_blank", "noopener"));
}

export function LegalDocumentDialog({ docId, onClose }: { docId: LegalDocumentId; onClose: () => void }) {
  const doc = LEGAL_DOCUMENTS[docId];
  return (
    <Modal
      title={doc.title}
      onClose={onClose}
      footer={(
        <div className="modal-actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      )}
    >
      <div className="legal-doc" role="region" aria-label={doc.title} tabIndex={0}>
        {renderLegalMarkdown(doc.text, openInBrowser)}
      </div>
    </Modal>
  );
}

/** A screen's viewer state: `open` shows a document, `dialog` is rendered by the screen (null while closed). */
export function useLegalViewer(): { open: (docId: LegalDocumentId) => void; dialog: ReactNode } {
  const [shown, setShown] = useState<LegalDocumentId | null>(null);
  return {
    open: (docId) => setShown(docId),
    dialog: shown ? <LegalDocumentDialog docId={shown} onClose={() => setShown(null)} /> : null,
  };
}

/** The two document names as buttons: "Terms of Use · Privacy Policy". */
export function LegalLinks({ onOpen, className = "legal-links" }: { onOpen: (docId: LegalDocumentId) => void; className?: string }) {
  return (
    <p className={className}>
      <button type="button" className="link" onClick={() => onOpen("terms")}>Terms of Use</button>
      <span aria-hidden="true">·</span>
      <button type="button" className="link" onClick={() => onOpen("privacy")}>Privacy Policy</button>
    </p>
  );
}
