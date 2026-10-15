import { useEffect, useState } from "react";
import { useServer } from "../servers/ServerContext";
import { AddServerForm } from "../servers/AddServerForm";
import { serverNaming } from "../servers/serverNames";
import { serverUnavailable } from "../servers/officialPlay";
import { LocalServerBadge } from "./LocalServerWarning";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { ServersIcon } from "./icons";

const ADD_OPTION = "__add__";
const SWITCH_ID = "server-switch-select";

// [2026-10-14] Keyboard focus across a server change. Choosing a server here ends in a restore, and AppShell shows its
// "Restoring your session" card meanwhile, so the sign-in card unmounts and comes back as new elements. Its email field
// autofocuses on arrival and would take the focus the player was keeping on this switcher. The chosen server is recorded
// before the change starts: the card that comes back for that server does not autofocus its email field, and this
// switcher takes the focus again when it mounts. A change that fails clears the record.
let focusReturnsFor: string | null = null;

/** True while the server with this id was just chosen on a switcher, so its sign-in card keeps the focus on the switcher. */
export function switcherReturnsFocusTo(serverId: string | undefined): boolean {
  return serverId !== undefined && focusReturnsFor === serverId;
}

function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 300);
  if (err instanceof Error && err.message) return err.message.slice(0, 300);
  return "Couldn't switch servers.";
}

/**
 * [2026-10-13 realms S5] "Which server am I signing in to?" on the sign-in and registration cards. Sign-in follows the
 * selected server, so the card says which one it is and lets the player switch (a local server's account is not the
 * official one, and a player who only has an official account must be able to get back to it from here).
 * [2026-10-14 realms] "Add a server..." is always there, so a player with no sign-in on the official server can still add a
 * local server or a realm. It opens the same form as the Servers page, under the list; a local server still waits for its
 * LOCAL SERVER WARNING before anything is sent to it.
 * [2026-10-14] The list is the launcher's own dropdown (components/Dropdown.tsx), not a native select. A realm is named by
 * its realm name, with the player's own name under it only when they differ (servers/serverNames.ts).
 */
export function ServerSwitcher() {
  const { servers, selected, select, openWarning, officialPlay } = useServer();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const selectedId = selected?.id;

  // A switcher that mounts after a change takes the focus back (see focusReturnsFor). Declared before the early return.
  useEffect(() => {
    if (!selectedId || focusReturnsFor !== selectedId) return;
    focusReturnsFor = null;
    document.getElementById(SWITCH_ID)?.focus();
  }, [selectedId]);

  if (!selected) return null;

  const change = async (serverId: string) => {
    if (serverId === ADD_OPTION) {
      setError(null);
      setMessage(null);
      setAdding(true);
      return;
    }
    if (busy || serverId === selected.id) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    focusReturnsFor = serverId;
    try {
      await select(serverId);
    } catch (err) {
      focusReturnsFor = null;
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  const options: DropdownOption[] = servers.map((server) => {
    const naming = serverNaming(server);
    // [2026-10-15] The official server while its play switch is off reads "Unavailable" in red, instead of "Official".
    const tag = server.kind === "local"
      ? { text: "Local", tone: "local" as const }
      : server.kind === "paradox_realm"
        ? { text: "Realm", tone: "realm" as const }
        : serverUnavailable(server, officialPlay)
          ? { text: "Unavailable", tone: "danger" as const }
          : { text: "Official", tone: "official" as const };
    return { value: server.id, label: naming.primary, detail: naming.secondary, tag };
  });

  return (
    <div className="server-switch" data-kind={selected.kind}>
      <div className="server-switch-row">
        <span className="server-switch-icon" aria-hidden="true"><ServersIcon /></span>
        <span id="server-switch-label" className="server-switch-label">Server</span>
        <Dropdown
          id={SWITCH_ID}
          className="server-switch-dropdown"
          labelledBy="server-switch-label"
          value={selected.id}
          options={options}
          actions={[{ value: ADD_OPTION, label: "Add a server..." }]}
          disabled={busy}
          onChange={(serverId) => void change(serverId)}
          onAction={(value) => void change(value)}
        />
      </div>
      {selected.kind === "local" && (
        <div className="server-switch-note">
          <LocalServerBadge onOpen={() => openWarning(selected.id)} />
          <span className="mono truncate" title={selected.backendUrl ?? ""}>{selected.backendUrl}</span>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      {message && !adding && <p className="note" role="status">{message}</p>}
      {adding && (
        <AddServerForm
          compact
          onCancel={() => setAdding(false)}
          onAdded={(_list, added) => {
            setAdding(false);
            setMessage(added ? `Added ${serverNaming(added).primary}. Choose it in Server to use it.` : null);
          }}
        />
      )}
    </div>
  );
}
