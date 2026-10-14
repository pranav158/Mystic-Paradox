import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { acknowledgeLocalServer, listServers, selectServer, type ServerView } from "../api/tauri";
import { LocalServerWarning } from "../components/LocalServerWarning";

// [2026-10-13 realms S5] The selected server, as the whole UI sees it. Sign-in, the session, the policy and the status
// chip all follow it; the launcher's native side resolves the same selection and refuses a call that names another.

export interface ServerState {
  /** The server list has been read (if it could not be, the official server is assumed). */
  ready: boolean;
  servers: ServerView[];
  selected: ServerView | null;
  /** The selected server's id; `undefined` while it is unknown (the native side then uses its own selection). */
  serverId: string | undefined;
  /** The selected server is local and its warning has not been accepted: nothing may be sent to it yet. */
  needsAck: boolean;
  /** The official backend and sign-in serve the selected server (the official server and Paradox realms). */
  officialNetwork: boolean;
  /** Replaces the list with a fresher one returned by a server command. */
  sync: (next: ServerView[]) => void;
  /** Selects a server. Rejects with a readable message (for example while a game runs). */
  select: (serverId: string) => Promise<void>;
  /** Shows a local server's warning popup (the red badge). */
  openWarning: (serverId: string) => void;
}

const IDLE: ServerState = {
  ready: true,
  servers: [],
  selected: null,
  serverId: undefined,
  needsAck: false,
  officialNetwork: true,
  sync: () => {},
  select: async () => {},
  openWarning: () => {},
};

const ServerContext = createContext<ServerState>(IDLE);

export function useServer(): ServerState {
  return useContext(ServerContext);
}

export function ServerProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<{ ready: boolean; servers: ServerView[] }>({ ready: false, servers: [] });
  const [warningFor, setWarningFor] = useState<string | null>(null);
  const promptedRef = useRef(new Set<string>());

  const sync = useCallback((next: ServerView[]) => setList({ ready: true, servers: next }), []);

  useEffect(() => {
    let cancelled = false;
    listServers()
      .then((servers) => { if (!cancelled) setList({ ready: true, servers }); })
      .catch(() => { if (!cancelled) setList({ ready: true, servers: [] }); });
    return () => { cancelled = true; };
  }, []);

  const selected = list.servers.find((server) => server.selected) ?? null;
  const needsAck = selected?.kind === "local" && !selected.acknowledged;
  const selectedId = selected?.id;

  // A local server that has just been selected (or was selected when the launcher started) asks once, on its own.
  // After a Cancel the player can reopen the popup from the screen that explains why nothing happens.
  useEffect(() => {
    if (!needsAck || !selectedId || promptedRef.current.has(selectedId)) return;
    promptedRef.current.add(selectedId);
    setWarningFor(selectedId);
  }, [needsAck, selectedId]);

  const select = useCallback(async (serverId: string) => {
    sync(await selectServer(serverId));
  }, [sync]);

  const openWarning = useCallback((serverId: string) => setWarningFor(serverId), []);

  const value = useMemo<ServerState>(() => ({
    ready: list.ready,
    servers: list.servers,
    selected,
    serverId: selectedId,
    needsAck: Boolean(needsAck),
    officialNetwork: selected ? selected.kind !== "local" : true,
    sync,
    select,
    openWarning,
  }), [list, selected, selectedId, needsAck, sync, select, openWarning]);

  const warningServer = warningFor
    ? list.servers.find((server) => server.id === warningFor && server.kind === "local") ?? null
    : null;

  return (
    <ServerContext.Provider value={value}>
      {children}
      {warningServer && (
        <LocalServerWarning
          key={warningServer.id}
          server={warningServer}
          onClose={() => setWarningFor(null)}
          onAgree={async (remember) => {
            sync(await acknowledgeLocalServer(warningServer.id, remember));
            setWarningFor(null);
          }}
        />
      )}
    </ServerContext.Provider>
  );
}
