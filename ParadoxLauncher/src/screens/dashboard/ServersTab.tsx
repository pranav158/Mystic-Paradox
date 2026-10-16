import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  listServers,
  pickInstallPath,
  realmLookup,
  realmRequestJoin,
  removeServer,
  selectServer,
  useOfficialInstall,
  type ServerView,
} from "../../api/tauri";
import { Button } from "../../components/Button";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { AlertIcon, FolderIcon, ServersIcon, ShieldIcon } from "../../components/icons";
import { useServer } from "../../servers/ServerContext";
import { serverNaming } from "../../servers/serverNames";
import { serverUnavailable } from "../../servers/officialPlay";
import { realmStanding, type RealmStanding } from "../../servers/realmStatus";
import { AddServerForm } from "../../servers/AddServerForm";
import { RealmInvitations } from "../../servers/RealmInvites";

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

/**
 * [2026-10-16] Where the player stands with a realm, as the directory answered: allowed in, a join request waiting for the host,
 * an invite waiting for the player, or none of these. Unknown until the realm is looked up (or when it cannot be).
 */
// [2026-10-16] The same standing Home reads (servers/realmStatus.ts), for the signed-in account.
type Standing = RealmStanding;

const STANDING_CHIP: Record<Standing, { text: string; tone: string }> = {
  own: { text: "Your realm", tone: "good" },
  member: { text: "Allowed", tone: "good" },
  open: { text: "Open to all", tone: "good" },
  requested: { text: "Request sent", tone: "warn" },
  invited: { text: "Invited", tone: "live" },
  none: { text: "Not allowed yet", tone: "" },
  // [2026-10-16] Closed to everyone but its host: no Ask to join (the request would be refused).
  solo: { text: "Unavailable: solo mode", tone: "warn" },
};

function signInDetail(kind: ServerView["kind"]): string {
  return kind === "local"
    ? "This server's own accounts. Their sign-in is stored on this PC only, and is never your Mystic Paradox account."
    : "Your Mystic Paradox account.";
}

export function ServersTab() {
  // [2026-10-13 realms S5] Sign-in, the policy and the status chip follow the selected server, so every change made
  // here is also handed to the shared server state; the red badge of a local server opens its warning popup.
  const { sync, officialPlay } = useServer();
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // [2026-10-16] Each realm's standing (looked up once per realm), and a row's success line (a request sent, an answer).
  const [standing, setStanding] = useState<Record<string, Standing>>({});
  const [rowNote, setRowNote] = useState<{ id: string; message: string } | null>(null);
  // [2026-10-16] The join request sent right after an add: its answer, under the add form.
  const [addAsk, setAddAsk] = useState<{ tone: "ok" | "bad"; message: string } | null>(null);
  const lookedUpRef = useRef(new Set<string>());
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

  // [2026-10-16] Looks every realm in the list up once (where the player stands); a failed lookup leaves the row without a chip.
  const realmIds = (servers ?? []).filter((server) => server.kind === "paradox_realm").map((server) => server.id).join(",");
  useEffect(() => {
    for (const id of realmIds.split(",").filter(Boolean)) {
      if (lookedUpRef.current.has(id)) continue;
      lookedUpRef.current.add(id);
      realmLookup(id)
        .then((found) => {
          if (!mountedRef.current) return;
          const next: Standing = realmStanding(found, found.own === true);
          setStanding((current) => ({ ...current, [id]: next }));
        })
        .catch(() => {});
    }
  }, [realmIds]);

  // [2026-10-16] Asks the realm's host to let the player in: sent when a realm is added, and from its row ("Ask to join").
  // After an add the answer is also shown under the add form, where the player is looking: a refusal shown only on the row
  // further down went unnoticed (REALM_NAME_INVALID for a reserved realm name, 16 Oct).
  const askToJoin = useCallback(async (server: ServerView, fromAdd = false) => {
    setRowError(null);
    setRowNote(null);
    setAddAsk(null);
    const name = serverNaming(server).primary;
    try {
      const answer = await realmRequestJoin(server.id);
      if (!mountedRef.current) return;
      setStanding((current) => ({ ...current, [server.id]: answer === "MEMBER" ? "member" : "requested" }));
      const message = answer === "MEMBER"
        ? `You can join ${name}.`
        : `Request sent to the host of ${name}. You can play there once they approve it.`;
      setRowNote({ id: server.id, message });
      if (fromAdd) setAddAsk({ tone: "ok", message });
    } catch (err) {
      if (!mountedRef.current) return;
      const message = friendly(err);
      setRowError({ id: server.id, message });
      if (fromAdd) setAddAsk({ tone: "bad", message: `The join request to ${name} was not sent: ${message}` });
    }
  }, []);

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

  const realmAdded = (list: ServerView[], added: ServerView | undefined) => {
    if (!mountedRef.current) return;
    setServers(list);
    if (added?.kind === "paradox_realm") {
      lookedUpRef.current.add(added.id);
      void askToJoin(added, true);
    }
  };

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Where you play</p>
          <h1 className="page-title">Realms</h1>
          <p className="page-desc">
            A Paradox realm is a player&apos;s game hosted on their own PC. You join it with your Mystic Paradox account, from
            the official install. The official server is built in.
          </p>
        </header>

        {/* [2026-10-16] Invites from realm hosts come first (shown only while one waits). */}
        <RealmInvitations onChanged={(list) => { if (mountedRef.current) setServers(list); }} style={at(1)} />

        {/* [2026-10-14] The add form, then the list of servers. Hosting a realm is on the Host realm page. */}
        <section className="glass card reveal" style={at(1)} aria-label="Add a realm">
          <AddServerForm onAdded={realmAdded} />
          {addAsk && (
            <div className="section add-ask">
              <p className={`feedback ${addAsk.tone}`} role={addAsk.tone === "bad" ? "alert" : "status"}>{addAsk.message}</p>
            </div>
          )}
        </section>

        <section className="glass card reveal" style={at(2)} aria-label="Your realms">
          {servers == null && !loadError && <div className="section"><div className="loader-bar" /></div>}
          {loadError && <div className="section"><p className="feedback bad" role="alert">{loadError}</p></div>}
          {servers?.map((server) => {
            const error = rowError?.id === server.id ? rowError.message : null;
            const note = rowNote?.id === server.id ? rowNote.message : null;
            const realmStanding = server.kind === "paradox_realm" ? standing[server.id] : undefined;
            // [2026-10-16] Local servers are not supported by this launcher any more: only removing them is offered.
            const unsupported = server.kind === "local";
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
                        {/* [2026-10-15] The official server's play switch is off: a red chip beside its Official one. */}
                        {serverUnavailable(server, officialPlay) && <span className="chip bad">Currently unavailable</span>}
                        {server.kind === "paradox_realm" && <span className="chip live">Paradox realm</span>}
                        {realmStanding && (
                          <span className={`chip${STANDING_CHIP[realmStanding].tone ? ` ${STANDING_CHIP[realmStanding].tone}` : ""}`}>
                            {STANDING_CHIP[realmStanding].text}
                          </span>
                        )}
                        {unsupported && <span className="chip bad">Not supported</span>}
                        {server.selected && <span className="chip good">In use</span>}
                      </h2>
                      {naming.secondary && <span className="server-alias" title={naming.secondary}>{naming.secondary}</span>}
                      {/* [2026-10-16] Only a local server's line is an address, so only it is in the code font. */}
                      <p className={`section-desc truncate${server.kind === "local" ? " mono" : ""}`} title={serverDetail(server)}>{serverDetail(server)}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    {realmStanding === "none" && (
                      <Button variant="secondary" size="sm" disabled={working} onClick={() => void askToJoin(server)}>
                        Ask to join
                      </Button>
                    )}
                    {!server.selected && !unsupported && (
                      <Button variant="secondary" size="sm" disabled={working} onClick={() => void handleSelect(server)}>
                        {/* [2026-10-16] The page is "Realms": a realm row says realm, the built-in official row says server. */}
                        {server.kind === "paradox_realm" ? "Use this realm" : "Use this server"}
                      </Button>
                    )}
                  </div>
                </div>
                {!unsupported && (<dl className="kv">
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
                </dl>)}
                {unsupported && (
                  <p className="note warning with-icon">
                    <AlertIcon />
                    <span>
                      Local servers are not supported by this launcher any more. Remove it from your list; a server you host
                      yourself is played with a launcher built for it.
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
                  {unsupported ? null : server.kind === "paradox_realm" && server.folderSource !== "own" ? (
                    <Button variant="secondary" size="sm" disabled={working} onClick={() => void handleFolder(server)}>
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
                {note && <p className="feedback ok" role="status">{note}</p>}
                {error && <p className="feedback bad" role="alert">{error}</p>}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
