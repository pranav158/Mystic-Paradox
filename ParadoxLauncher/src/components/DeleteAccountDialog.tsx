/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { useState } from "react";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { TextField } from "./TextField";

// [2026-10-14] The warning before an account is deleted. It says what happens in plain words, and the player must type
// their username before the button works. The native side repeats the check (DELETION_CONFIRMATION_MISMATCH).
interface DeleteAccountDialogProps {
  username: string;
  holdDays: number;
  onCancel: () => void;
  /** Resolves once the deletion is requested; rejects with a readable message. */
  onConfirm: (typedUsername: string) => Promise<void>;
}

function readable(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err instanceof Error && err.message) return err.message;
  return "Couldn't delete the account. Try again.";
}

export function DeleteAccountDialog({ username, holdDays, onCancel, onConfirm }: DeleteAccountDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The same rule as the backend: the username, typed in any letter case.
  const matches = typed.trim().toLowerCase() === username.trim().toLowerCase();

  async function confirm() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
    } catch (err) {
      setError(readable(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete your account?"
      tone="danger"
      onClose={busy ? () => {} : onCancel}
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={!matches} loading={busy} loadingLabel="Deleting…">
            Delete account
          </Button>
        </>
      )}
    >
      <ul className="modal-points">
        <li>Your account is deactivated at once. You cannot play, host or join realms with it.</li>
        <li>It is permanently deleted after {holdDays} days.</li>
        <li>Within those {holdDays} days you can sign in and choose Restore to undo this.</li>
        <li>After deletion we keep only a minimal record, as the Privacy Policy says.</li>
        <li>Your progress, items and realms cannot be recovered after deletion.</li>
      </ul>
      <TextField
        label={`Type ${username} to confirm`}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        disabled={busy}
      />
      {error && <Banner>{error}</Banner>}
    </Modal>
  );
}
