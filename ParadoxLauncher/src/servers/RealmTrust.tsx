import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onRealmNotice, realmLookup, setRealmHostKey, type RealmLookup, type RealmNotice, type ServerView } from "../api/tauri";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { RealmTrustNote } from "../components/RealmTrustNote";
import { useServer } from "./ServerContext";
import { serverNaming } from "./serverNames";

// [2026-10-14 realms] Who hosts a realm. The player agrees to a realm's host once (its host key is stored with the realm and
// sent at every Play), is warned when the realm's name later belongs to another host, and is told when a realm they are in
// ends for them. Mounted once, under ServerProvider, so Home and the Servers page (or the sign-in card) share one dialog.

type Host = Pick<ServerView, "id" | "kind" | "hostPublicKey">;

/**
 * A realm notice as Home shows it. The launcher's notice does not name the realm, so `realm` is the name the selected server
 * is shown by when it is a realm (its label, [2026-10-16] "MysticFox's Realm", or its realm name: serverNaming): the selection
 * cannot change while a realm session runs, so that is the realm the player was in. Null when no realm is selected.
 */
export type RealmNoticeView = RealmNotice & { realm: string | null };

export interface RealmTrust {
  /** The latest notice from a realm session. Home shows it until the player dismisses it. */
  notice: RealmNoticeView | null;
  dismissNotice: () => void;
  /**
   * Before a Play into a realm, and after one is added: the realm's host must be agreed to. Resolves true when the launch
   * may go on (not a realm, a host already agreed, or agreed now) and false when the player cancelled. Rejects with a
   * readable message when the directory cannot be asked (for example there is no official sign-in yet).
   */
  ensureHost: (server: Host) => Promise<boolean>;
  /**
   * Play was refused because the realm's name now belongs to another host. Shows the change. Resolves true when the player
   * trusts the new host (its key is stored) and false when they cancelled, which keeps the old key and does not play.
   */
  trustNewHost: (server: Host) => Promise<boolean>;
}

interface Pending {
  kind: "join" | "owner";
  serverId: string;
  lookup: RealmLookup;
  resolve: (agreed: boolean) => void;
}

const IDLE: RealmTrust = {
  notice: null,
  dismissNotice: () => {},
  ensureHost: async () => true,
  trustNewHost: async () => false,
};

const RealmTrustContext = createContext<RealmTrust>(IDLE);

export function useRealmTrust(): RealmTrust {
  return useContext(RealmTrustContext);
}

function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

export function RealmTrustProvider({ children }: { children: ReactNode }) {
  const { sync, selected } = useServer();
  const [notice, setNotice] = useState<RealmNoticeView | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // The dialog that is open, read by the buttons. A second request replaces it and releases the first with "no".
  const openRef = useRef<Pending | null>(null);
  // The selected server, read by the notice listener, which is registered once.
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    onRealmNotice((next) => {
      if (cancelled) return;
      const current = selectedRef.current;
      setNotice({ ...next, realm: current?.kind === "paradox_realm" ? serverNaming(current).primary : null });
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const open = useCallback((next: Pending) => {
    openRef.current?.resolve(false);
    openRef.current = next;
    setPending(next);
  }, []);

  const close = useCallback((agreed: boolean) => {
    const current = openRef.current;
    openRef.current = null;
    setPending(null);
    current?.resolve(agreed);
  }, []);

  // The player pressed "Join realm" or "Trust the new host": the key the dialog showed is stored, then the caller goes on.
  const agree = useCallback(async () => {
    const current = openRef.current;
    if (!current) return;
    sync(await setRealmHostKey(current.serverId, current.lookup.hostPublicKey));
    close(true);
  }, [sync, close]);

  const ensureHost = useCallback(async (server: Host): Promise<boolean> => {
    if (server.kind !== "paradox_realm" || server.hostPublicKey) return true;
    const lookup = await realmLookup(server.id);
    return new Promise<boolean>((resolve) => open({ kind: "join", serverId: server.id, lookup, resolve }));
  }, [open]);

  const trustNewHost = useCallback(async (server: Host): Promise<boolean> => {
    const lookup = await realmLookup(server.id);
    if (!lookup.ownershipChanged) {
      throw new Error("The realm's host did not change. Press Play again.");
    }
    return new Promise<boolean>((resolve) => open({ kind: "owner", serverId: server.id, lookup, resolve }));
  }, [open]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<RealmTrust>(
    () => ({ notice, dismissNotice, ensureHost, trustNewHost }),
    [notice, dismissNotice, ensureHost, trustNewHost],
  );

  return (
    <RealmTrustContext.Provider value={value}>
      {children}
      {pending && (
        <RealmHostDialog
          key={`${pending.kind}:${pending.serverId}`}
          pending={pending}
          onAgree={agree}
          onCancel={() => close(false)}
        />
      )}
    </RealmTrustContext.Provider>
  );
}

function RealmHostDialog({ pending, onAgree, onCancel }: {
  pending: Pending;
  onAgree: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lookup } = pending;
  const joining = pending.kind === "join";
  const hostName = lookup.hostName ?? null;

  const agree = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAgree();
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={joining ? "Join this realm?" : "This realm has a new host"}
      tone={joining ? "default" : "danger"}
      onClose={busy ? () => {} : onCancel}
      footer={(
        <div className="modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            variant={joining ? "primary" : "danger"}
            onClick={() => void agree()}
            loading={busy}
            loadingLabel={joining ? "Joining…" : "Trusting…"}
          >
            {joining ? "Join realm" : "Trust the new host"}
          </Button>
        </div>
      )}
    >
      {joining ? (
        <>
          <p className="modal-lead">
            {hostName
              ? <>Join realm <strong>{lookup.name}</strong> hosted by <strong>{hostName}</strong>?</>
              : <>Join realm <strong>{lookup.name}</strong>? Its host has not given a name.</>}
          </p>
          <p>
            The host runs this realm&apos;s Ramsgate server and its hunts on their own PC. Only join a realm whose host you trust.
            Your progress saves to your Mystic Paradox account.
          </p>
          <p className="modal-fine">
            Host key <span className="mono">{lookup.fingerprint}</span>. The launcher remembers it, and asks again if the realm&apos;s
            name ever belongs to another host.
          </p>
          <RealmTrustNote />
        </>
      ) : (
        <>
          <p className="modal-lead">
            The realm <strong>{lookup.name}</strong> now belongs to a different host{hostName ? <>, <strong>{hostName}</strong></> : ""}.
          </p>
          <p>
            You agreed to join this realm with its earlier host. Its name now belongs to someone else, so Play was stopped.
            Trust the new host only if you know who they are. Cancel keeps the earlier host and does not start the game.
          </p>
          <p className="modal-fine">New host key <span className="mono">{lookup.fingerprint}</span>.</p>
        </>
      )}
      {error && <p className="feedback bad" role="alert">{error}</p>}
    </Modal>
  );
}
