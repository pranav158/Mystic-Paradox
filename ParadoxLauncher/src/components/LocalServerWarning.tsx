import { useState, type ReactNode } from "react";
import type { ServerView } from "../api/tauri";
import { Button } from "./Button";
import { Modal } from "./Modal";

// [2026-10-13 realms S5] The LOCAL SERVER WARNING (hosting plan §3.3). Nothing is sent to a local server until the
// player has pressed "I agree" here: the launcher enforces that natively as well, so this popup is the only way in.

function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

interface LocalServerWarningProps {
  server: Pick<ServerView, "id" | "name" | "backendUrl" | "warningRemembered">;
  /** The player pressed "I agree". `remember` is the "Don't show again" box. May reject with a readable message. */
  onAgree: (remember: boolean) => Promise<void>;
  /** The player cancelled (or pressed Escape): nothing is recorded. */
  onClose: () => void;
}

export function LocalServerWarning({ server, onAgree, onClose }: LocalServerWarningProps) {
  const [remember, setRemember] = useState(server.warningRemembered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agree = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAgree(remember);
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Local server warning"
      tone="danger"
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
            <span>Don't show again for this server</span>
          </label>
          <div className="modal-actions">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={() => void agree()} loading={busy} loadingLabel="Saving…">I agree</Button>
          </div>
        </>
      )}
    >
      <p className="modal-lead">
        <strong>{server.name}</strong> is a local server, not in the Mystic Paradox directory.
        {server.backendUrl && <> You are about to connect to <span className="mono">{server.backendUrl}</span>.</>}
      </p>
      <p>
        This server is not run, hosted, listed, monitored or checked by Mystic Paradox; the person who runs it is
        responsible for it. Only join if you trust the host.
      </p>
      <ul className="modal-points">
        <li>
          The runtime files used with this server are not installed or checked by Mystic Paradox and may contain
          malware. Mystic Paradox takes no responsibility for any harm caused by them or by the server.
        </li>
        <li>
          Your progress on this server is stored only on the host's PC. It is never synced to the official Mystic
          Paradox network, and it is lost if the host loses it.
        </li>
        <li>
          Players who join can see the server's address (IP) unless the host puts their own relay, VPN or tunnel in
          front of it. The host can see the address you connect from.
        </li>
        <li>
          The account you create or sign in to belongs to that server, not to Mystic Paradox. Do not reuse your
          official password.
        </li>
      </ul>
      <p className="modal-fine">
        The software is provided under the AGPL-3.0 licence (sections 15 and 16: no warranty, no liability).
      </p>
      {error && <p className="feedback bad" role="alert">{error}</p>}
    </Modal>
  );
}

/** The red badge every local server carries. It opens the same popup, whatever "Don't show again" says. */
export function LocalServerBadge({ onOpen, children }: { onOpen: () => void; children?: ReactNode }) {
  return (
    <button type="button" className="chip bad chip-button" onClick={onOpen} title="Read the local server warning">
      {children ?? "LOCAL SERVER WARNING"}
    </button>
  );
}
