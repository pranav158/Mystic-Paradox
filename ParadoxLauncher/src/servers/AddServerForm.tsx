import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { addServer, type NewServerRequest, type ServerView } from "../api/tauri";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";
import { RealmTrustNote } from "../components/RealmTrustNote";
import { ServersIcon, ShieldIcon } from "../components/icons";
import { useRealmTrust } from "./RealmTrust";
import { useServer } from "./ServerContext";
import { serverNaming } from "./serverNames";

// [2026-10-13 realms S1] The add form for a Paradox realm or a local server. It is the Servers page's form, and the sign-in
// card's "Add a server..." uses the same one, so the validation and its messages are the launcher's own in both places.
// [2026-10-14 realms] A realm added here is then asked for its host (the join popup), unless no official sign-in lets the
// directory answer yet; then its host is confirmed at the first Play.

type AddKind = NewServerRequest["kind"];

const ADD_KINDS: { id: AddKind; label: string }[] = [
  { id: "paradox_realm", label: "Paradox realm" },
  { id: "local", label: "Local server" },
];

// The messages come from the launcher's own validation and are meant to be read as written. They are not run through
// sanitizeError, which would turn the example address in "like https://realm.example.com" into "the update server".
function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

export interface AddServerFormProps {
  /** Shows a Cancel button that calls this (the sign-in card closes the form with it). */
  onCancel?: () => void;
  /** Called as soon as the server is in the list, with the refreshed list and the server that was added. */
  onAdded?: (list: ServerView[], added: ServerView | undefined) => void;
  style?: CSSProperties;
  /** Stacked layout for a narrow place (the sign-in card): head, kind switch and fields one under another. */
  compact?: boolean;
}

export function AddServerForm({ onCancel, onAdded, style, compact = false }: AddServerFormProps) {
  const { sync } = useServer();
  const { ensureHost } = useRealmTrust();
  const [addKind, setAddKind] = useState<AddKind>("paradox_realm");
  const [name, setName] = useState("");
  const [realmName, setRealmName] = useState("");
  const [backendUrl, setBackendUrl] = useState("");
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
    try {
      const request: NewServerRequest = addKind === "local"
        ? { kind: "local", name, backendUrl }
        : { kind: "paradox_realm", name, realmName };
      next = await addServer(request);
      sync(next);
      // The new server is the one this request named: a realm name is unique in the list, and so is a local name.
      added = addKind === "local"
        ? next.find((server) => server.kind === "local" && server.name === name.trim())
        : next.find((server) => server.kind === "paradox_realm" && server.realmName === realmName.trim());
      if (mountedRef.current) {
        setName("");
        setRealmName("");
        setBackendUrl("");
      }
    } catch (err) {
      if (mountedRef.current) setError(friendly(err));
    }
    if (next && added) onAdded?.(next, added);
    try {
      // The host is agreed to now (the join popup), or at the first Play when the directory cannot be asked yet. A
      // parent that closed this form has already been told about the server; the popup belongs to the provider.
      if (added?.kind === "paradox_realm") await ensureHost(added);
    } catch {
      if (mountedRef.current) setNote(`Added ${added ? serverNaming(added).primary : "the realm"}. You will be asked to confirm its host the first time you play.`);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const kindIndex = ADD_KINDS.findIndex((kind) => kind.id === addKind);

  return (
    <form className={compact ? "section add-server-compact" : "section"} style={style} onSubmit={(event) => void handleAdd(event)} noValidate>
      <div className="section-row">
        <div className="section-head">
          <div className="section-icon"><ServersIcon /></div>
          <div>
            <h2 className="section-title">Add a server</h2>
            <p className="section-desc">
              {addKind === "local"
                ? "A server run by you or someone you trust, reached by its own address."
                : "A community realm from the Mystic Paradox directory, by its realm name."}
            </p>
          </div>
        </div>
        <div className="segmented" style={{ "--count": ADD_KINDS.length, "--index": Math.max(kindIndex, 0) } as CSSProperties} role="group" aria-label="Kind of server">
          <span className="segmented-thumb" aria-hidden="true" />
          {ADD_KINDS.map((kind) => (
            <button key={kind.id} type="button" aria-pressed={addKind === kind.id} onClick={() => { setAddKind(kind.id); setError(null); setNote(null); }}>
              {kind.label}
            </button>
          ))}
        </div>
      </div>
      <div className="server-form">
        <TextField
          label={addKind === "local" ? "Name" : "Name (optional)"}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={addKind === "local" ? "My server" : "Defaults to the realm name"}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />
        {addKind === "local" ? (
          <TextField
            label="Server address"
            value={backendUrl}
            onChange={(event) => setBackendUrl(event.target.value)}
            placeholder="https://realm.example.com"
            hint="https://host or https://host:port. http:// works only for localhost."
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        ) : (
          <TextField
            label="Realm name"
            value={realmName}
            onChange={(event) => setRealmName(event.target.value.toLowerCase())}
            placeholder="ember-hold"
            hint="3 to 24 lowercase letters, digits or hyphens."
            maxLength={24}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>
      {error && <p className="feedback bad" role="alert">{error}</p>}
      {note && <p className="feedback" role="status">{note}</p>}
      <div className="server-actions">
        <Button type="submit" loading={busy} loadingLabel="Adding…" disabled={busy}>
          Add server
        </Button>
        {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
      <p className="note with-icon">
        <ShieldIcon />
        <span>
          Every server has its own sign-in. The launcher keeps a separate saved session for each, and never sends
          your Mystic Paradox account to a local server, or a local server's account to Mystic Paradox.{" "}
          {addKind === "local"
            ? "A local server needs its own copy of Dauntless: pick its folder after adding it."
            : "A realm plays from the official Dauntless install, so there is no folder to pick."}
        </span>
      </p>
      {/* [2026-10-14] For a realm only: a local server has its own warning popup (LocalServerWarning). */}
      {addKind === "paradox_realm" && <RealmTrustNote />}
    </form>
  );
}
