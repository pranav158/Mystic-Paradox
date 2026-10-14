import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  listServers,
  pickInstallPath,
  removeServer,
  selectServer,
  useOfficialInstall,
  type ServerView,
} from "../../api/tauri";
import { Button } from "../../components/Button";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { LocalServerBadge } from "../../components/LocalServerWarning";
import { AlertIcon, FolderIcon, ServersIcon, ShieldIcon } from "../../components/icons";
import { useServer } from "../../servers/ServerContext";
import { serverNaming } from "../../servers/serverNames";
import { AddServerForm } from "../../servers/AddServerForm";

// [2026-10-13 realms S1] The launcher's server list: the built-in official server, Paradox realms (our backend, playing
// from the official install unless they have a folder of their own) and local servers (the player's own backend). Every
// command returns the whole refreshed list.

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

function gameRootPath(exePath: string): string {
  return exePath
    .replace(/\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Dauntless-Win64-Shipping\.exe$/i, "");
}

// The messages come from the launcher's own validation and are meant to be read as written. They are not run
// through sanitizeError, which would turn the example address in "like https://realm.example.com" into
// "the update server".
function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

function serverDetail(server: ServerView): string {
  switch (server.kind) {
    case "official":
      return "Built-in Mystic Paradox servers";
    case "paradox_realm":
      return `Realm ${server.realmName ?? ""}`;
    default:
      return server.backendUrl ?? "";
  }
}

function signInDetail(kind: ServerView["kind"]): string {
  return kind === "local"
    ? "This server's own accounts. Their sign-in is stored on this PC only, and is never your Mystic Paradox account."
    : "Your Mystic Paradox account.";
}

export function ServersTab() {
  // [2026-10-13 realms S5] Sign-in, the policy and the status chip follow the selected server, so every change made
  // here is also handed to the shared server state; the red badge of a local server opens its warning popup.
  const { sync, openWarning } = useServer();
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await listServers();
      if (!mountedRef.current) return;
      setServers(next);
      sync(next);
      setLoadError(null);
    } catch (err) {
      if (mountedRef.current) setLoadError(friendly(err));
    }
  }, [sync]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One action at a time; each one reports its error on the row it belongs to.
  const act = useCallback(async (key: string, rowId: string, work: () => Promise<ServerView[] | void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setRowError(null);
    setConfirmRemove(null);
    try {
      const next = await work();
      if (next) sync(next);
      if (mountedRef.current && next) setServers(next);
    } catch (err) {
      if (mountedRef.current) setRowError({ id: rowId, message: friendly(err) });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [sync]);

  const handleSelect = (server: ServerView) => act(`select:${server.id}`, server.id, () => selectServer(server.id));

  // The folder picker is the one Home and Library use, aimed at this server. A realm's picker sets a folder of its own
  // (a realm without one runs from the official install). A cancelled dialog changes nothing.
  const handleFolder = (server: ServerView) => act(`folder:${server.id}`, server.id, async () => {
    await pickInstallPath(server.id, true);
    return listServers();
  });

  const handleOfficialInstall = (server: ServerView) => act(`official:${server.id}`, server.id, () => useOfficialInstall(server.id));

  const handleRemove = (server: ServerView) => {
    if (confirmRemove !== server.id) {
      setConfirmRemove(server.id);
      setRowError(null);
      return;
    }
    void act(`remove:${server.id}`, server.id, () => removeServer(server.id));
  };

  const working = busy != null;

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Game servers</p>
          <h1 className="page-title">Servers &amp; realms</h1>
          <p className="page-desc">
            A local server plays from its own copy of Dauntless, so its files never mix with another server's. A Paradox
            realm plays from the official install and needs no folder of its own. The official server is built in.
          </p>
        </header>

        {/* [2026-10-14] The add form comes first; the list of servers follows it. Hosting a realm is on the Host realm page. */}
        <section className="glass card reveal" style={at(1)} aria-label="Add a server">
          {/* [2026-10-14 realms] The same form as the sign-in card's "Add a server...", with the same validation. */}
          <AddServerForm onAdded={(list) => { if (mountedRef.current) setServers(list); }} />
        </section>

        <section className="glass card reveal" style={at(2)} aria-label="Your servers">
          {servers == null && !loadError && <div className="section"><div className="loader-bar" /></div>}
          {loadError && <div className="section"><p className="feedback bad" role="alert">{loadError}</p></div>}
          {servers?.map((server) => {
            const error = rowError?.id === server.id ? rowError.message : null;
            const folder = server.folder ? gameRootPath(server.folder) : null;
            // [2026-10-14] A realm is named by its realm name; the player's own name for it is a line under that, if different.
            const naming = serverNaming(server);
            return (
              <div className="section server-row" key={server.id} data-selected={server.selected} data-kind={server.kind}>
                <div className="section-row">
                  <div className="section-head">
                    <div className={`section-icon${server.kind === "local" ? " bad" : server.selected ? " good" : ""}`}><ServersIcon /></div>
                    <div className="min-w-0">
                      <h2 className="section-title server-title">
                        <span className="server-name">{naming.primary}</span>
                        {server.kind === "official" && <span className="chip accent">Official</span>}
                        {server.kind === "paradox_realm" && <span className="chip live">Paradox realm</span>}
                        {server.kind === "local" && <LocalServerBadge onOpen={() => openWarning(server.id)} />}
                        {server.selected && <span className="chip good">In use</span>}
                      </h2>
                      {naming.secondary && <span className="server-alias" title={naming.secondary}>{naming.secondary}</span>}
                      <p className="section-desc mono truncate" title={serverDetail(server)}>{serverDetail(server)}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    {!server.selected && (
                      <Button variant="secondary" size="sm" disabled={working} onClick={() => void handleSelect(server)}>
                        Use this server
                      </Button>
                    )}
                  </div>
                </div>
                <dl className="kv">
                  <dt>Install folder</dt>
                  <dd>
                    {server.folderSource === "official" && (
                      <span>{folder ? "Shared with the official install: " : "The official install is not located yet (locate it from Home)."}</span>
                    )}
                    {folder && <span className="mono">{folder}</span>}
                    {!folder && server.folderSource !== "official" && <span className="muted">Not selected yet</span>}
                    {folder && !server.located && !server.folderProblem && <span className="status-bad"> (the game file is missing)</span>}
                  </dd>
                  <dt>Sign-in</dt>
                  <dd>{signInDetail(server.kind)}</dd>
                  <dt>Runtime files</dt>
                  <dd>
                    {server.usesOfficialFeed
                      ? "Signed Mystic Paradox runtime, installed and checked by the launcher."
                      : "The realm's own files. The launcher does not install, check or update them."}
                  </dd>
                  {server.folderProblem && (<><dt>Folder</dt><dd className="status-bad">{server.folderProblem}</dd></>)}
                </dl>
                {server.kind === "local" && (
                  <p className="note warning with-icon">
                    <AlertIcon />
                    <span>
                      Local server: not hosted, operated, listed or checked by Mystic Paradox, and its runtime files are
                      not ours. Only use a server run by someone you trust. Select the red badge to read the warning.
                      {" "}{server.playBlockedReason ?? ""}
                    </span>
                  </p>
                )}
                {server.kind === "paradox_realm" && (
                  <p className="note with-icon">
                    <ShieldIcon />
                    <span>Uses your Mystic Paradox account and signed runtime. Play joins this realm on its host's PC while the host is online; progress saves to your account.</span>
                  </p>
                )}
                <div className="server-actions">
                  {server.kind === "paradox_realm" && server.folderSource !== "own" ? (
                    <Button variant="ghost" size="sm" disabled={working} onClick={() => void handleFolder(server)}>
                      <FolderIcon />{busy === `folder:${server.id}` ? "Opening…" : "Use a separate folder"}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" disabled={working} onClick={() => void handleFolder(server)}>
                      <FolderIcon />{busy === `folder:${server.id}` ? "Opening…" : folder ? "Change folder" : "Choose folder"}
                    </Button>
                  )}
                  {server.kind === "paradox_realm" && server.folderSource === "own" && (
                    <Button variant="ghost" size="sm" disabled={working} onClick={() => void handleOfficialInstall(server)}>
                      {busy === `official:${server.id}` ? "Switching…" : "Use the official install"}
                    </Button>
                  )}
                  {server.removable && (
                    <Button variant={confirmRemove === server.id ? "danger" : "ghost"} size="sm" disabled={working} onClick={() => handleRemove(server)}>
                      {confirmRemove === server.id ? "Click again to remove" : "Remove"}
                    </Button>
                  )}
                  {confirmRemove === server.id && (
                    <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>Keep</Button>
                  )}
                </div>
                {error && <p className="feedback bad" role="alert">{error}</p>}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
