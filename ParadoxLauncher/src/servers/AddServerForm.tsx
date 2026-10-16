import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { addServer, type ServerView } from "../api/tauri";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";
import { RealmTrustNote } from "../components/RealmTrustNote";
import { ServersIcon, ShieldIcon } from "../components/icons";
import { useRealmTrust } from "./RealmTrust";
import { useServer } from "./ServerContext";
import { realmLabelForUsername, realmNameForUsername, serverNaming } from "./serverNames";

// [2026-10-13 realms S1] The add form, on the Servers page (the only place a server is added since 16 Oct).
// [2026-10-14 realms] A realm added here is then asked for its host (the join popup), unless no official sign-in lets the
// directory answer yet; then its host is confirmed at the first Play.
// [2026-10-16] Paradox realms only: local servers are not offered by the official launcher any more (they need a separate
// sign-in on someone else's backend; a self-hosted launcher points at its own backend instead).

// The messages come from the launcher's own validation and are meant to be read as written. They are not run through
// sanitizeError, which would turn a realm name or an address in them into "the update server".
function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

export interface AddServerFormProps {
  /** Called as soon as the realm is in the list, with the refreshed list and the server that was added. */
  onAdded?: (list: ServerView[], added: ServerView | undefined) => void;
  style?: CSSProperties;
}

// [2026-10-16, owner] A realm is found by its host's username (its realm name is that username in lower case), and is labelled
// "<username>'s Realm" unless the player names it.
export function AddServerForm({ onAdded, style }: AddServerFormProps) {
  const { sync } = useServer();
  const { ensureHost } = useRealmTrust();
  const [name, setName] = useState("");
  const [hostName, setHostName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    let next: ServerView[] | undefined;
    let added: ServerView | undefined;
    const realmName = realmNameForUsername(hostName);
    if (!realmName) {
      setError("Enter the host's username: 3 to 24 letters or digits.");
      busyRef.current = false;
      setBusy(false);
      return;
    }
    try {
      next = await addServer({ kind: "paradox_realm", name: name.trim() || realmLabelForUsername(hostName), realmName });
      sync(next);
      // The new server is the one this request named: a realm name is unique in the list.
      added = next.find((server) => server.kind === "paradox_realm" && server.realmName === realmName);
      if (mountedRef.current) {
        setName("");
        setHostName("");
      }
    } catch (err) {
      if (mountedRef.current) setError(friendly(err));
    }
    if (next && added) onAdded?.(next, added);
    try {
      // The host is agreed to now (the join popup), or at the first Play when the directory cannot be asked yet. A
      // parent that closed this form has already been told about the server; the popup belongs to the provider.
      if (added) await ensureHost(added);
    } catch {
      if (mountedRef.current) setNote(`Added ${added ? serverNaming(added).primary : "the realm"}. You will be asked to confirm its host the first time you play.`);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <form className="section" style={style} onSubmit={(event) => void handleAdd(event)} noValidate>
      <div className="section-row">
        <div className="section-head">
          <div className="section-icon"><ServersIcon /></div>
          <div>
            <h2 className="section-title">Add a realm</h2>
            <p className="section-desc">Every realm is named after the player who hosts it. Enter their username; the host gets your join request.</p>
          </div>
        </div>
      </div>
      <div className="server-form">
        <TextField
          label="Host's username"
          value={hostName}
          onChange={(event) => setHostName(event.target.value)}
          placeholder="MysticFox"
          hint="The username of the player whose realm you want to join."
          maxLength={24}
          autoComplete="off"
          spellCheck={false}
        />
        <TextField
          label="Name (optional)"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={realmLabelForUsername(hostName) ? `Defaults to ${realmLabelForUsername(hostName)}` : "Defaults to <username>'s Realm"}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {error && <p className="feedback bad" role="alert">{error}</p>}
      {note && <p className="feedback" role="status">{note}</p>}
      <div className="server-actions">
        <Button type="submit" loading={busy} loadingLabel="Adding…" disabled={busy}>
          Add realm
        </Button>
      </div>
      <p className="note with-icon">
        <ShieldIcon />
        <span>A realm uses your Mystic Paradox account and plays from the official Dauntless install, so there is no folder to pick.</span>
      </p>
      <RealmTrustNote />
    </form>
  );
}
