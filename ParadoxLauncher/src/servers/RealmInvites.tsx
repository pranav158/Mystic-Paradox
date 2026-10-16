import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { addServer, realmAnswerInvite, realmInvites, type RealmInvite, type ServerView } from "../api/tauri";
import { Button } from "../components/Button";
import { HostRealmIcon } from "../components/icons";
import { formatWhen } from "../lib/sessions";
import { useRealmTrust } from "./RealmTrust";
import { useServer } from "./ServerContext";

// [2026-10-16] Realm invites the player received: a host invited them by username, and they join only after accepting.
// One shared state for the dashboard: the Realms page lists the invites (accept or decline), and the sidebar shows
// how many wait. Read every 60 s while the dashboard is up, and only on our network (the official server or a Paradox realm).

const POLL_MS = 60_000;

function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 300);
  if (err instanceof Error && err.message) return err.message.slice(0, 300);
  return "Something went wrong. Please try again.";
}

export interface RealmInvitesState {
  invites: RealmInvite[];
  /** Why the list could not be read; the last list stays shown. */
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Accepts: answers the invite, adds the realm to the server list unless it is there, and asks the player to confirm its host
   * (the join popup). Resolves with the refreshed server list.
   */
  accept: (invite: RealmInvite) => Promise<ServerView[] | null>;
  decline: (invite: RealmInvite) => Promise<void>;
}

const IDLE: RealmInvitesState = {
  invites: [],
  error: null,
  refresh: async () => {},
  accept: async () => null,
  decline: async () => {},
};

const RealmInvitesContext = createContext<RealmInvitesState>(IDLE);

export function useRealmInvites(): RealmInvitesState {
  return useContext(RealmInvitesContext);
}

export function RealmInvitesProvider({ children }: { children: ReactNode }) {
  const { servers, officialNetwork, sync } = useServer();
  const { ensureHost } = useRealmTrust();
  const [invites, setInvites] = useState<RealmInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await realmInvites();
      if (!mountedRef.current) return;
      setInvites(next);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(friendly(err));
    }
  }, []);

  useEffect(() => {
    if (!officialNetwork) {
      setInvites([]);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [officialNetwork, refresh]);

  const accept = useCallback(async (invite: RealmInvite) => {
    await realmAnswerInvite(invite.realmName, true);
    let list: ServerView[] = serversRef.current;
    let realm = list.find((server) => server.kind === "paradox_realm" && server.realmName === invite.realmName);
    if (!realm) {
      list = await addServer({ kind: "paradox_realm", name: "", realmName: invite.realmName });
      sync(list);
      realm = list.find((server) => server.kind === "paradox_realm" && server.realmName === invite.realmName);
    }
    if (mountedRef.current) setInvites((current) => current.filter((item) => item.realmName !== invite.realmName));
    // The host is agreed to now, or at the first Play when the directory cannot answer.
    if (realm) await ensureHost(realm).catch(() => {});
    return list;
  }, [ensureHost, sync]);

  const decline = useCallback(async (invite: RealmInvite) => {
    await realmAnswerInvite(invite.realmName, false);
    if (mountedRef.current) setInvites((current) => current.filter((item) => item.realmName !== invite.realmName));
  }, []);

  const value = useMemo<RealmInvitesState>(
    () => ({ invites, error, refresh, accept, decline }),
    [invites, error, refresh, accept, decline],
  );
  return <RealmInvitesContext.Provider value={value}>{children}</RealmInvitesContext.Provider>;
}

/** The invitations card at the top of the Realms page. Renders nothing while no invite waits. */
export function RealmInvitations({ onChanged, style }: { onChanged?: (list: ServerView[]) => void; style?: CSSProperties }) {
  const { invites, accept, decline } = useRealmInvites();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  if (invites.length === 0 && !message) return null;

  const answer = async (invite: RealmInvite, yes: boolean) => {
    if (busy) return;
    setBusy(`${yes ? "accept" : "decline"}:${invite.realmName}`);
    setMessage(null);
    try {
      if (yes) {
        const list = await accept(invite);
        if (list) onChanged?.(list);
        setMessage({ tone: "ok", text: `You joined ${invite.realmName}. It is in your server list below.` });
      } else {
        await decline(invite);
        setMessage({ tone: "ok", text: `Invite to ${invite.realmName} declined.` });
      }
    } catch (err) {
      setMessage({ tone: "bad", text: friendly(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="glass card reveal realm-invitations" style={style} aria-label="Realm invitations">
      <div className="section">
        <div className="section-row">
          <div className="section-head">
            <div className="section-icon good"><HostRealmIcon /></div>
            <div className="min-w-0">
              <h2 className="section-title server-title">
                <span>Realm invitations</span>
                {invites.length > 0 && <span className="chip good">{invites.length}</span>}
              </h2>
              <p className="section-desc">A host invited you to their realm. Accept to join it with your Mystic Paradox account.</p>
            </div>
          </div>
        </div>
        {invites.length > 0 && (
          <ul className="invite-list">
            {invites.map((invite) => (
              <li className="invite-row" key={invite.realmName}>
                <div className="invite-who">
                  <div className="invite-name">{invite.realmName}</div>
                  <div className="invite-meta">
                    {invite.hostName ? `Invited by ${invite.hostName}` : "Invited by its host"}
                    {invite.at ? ` · ${formatWhen(invite.at)}` : ""}
                    {invite.online ? " · Online now" : ""}
                  </div>
                </div>
                <div className="invite-actions">
                  <Button
                    size="sm"
                    disabled={busy != null}
                    loading={busy === `accept:${invite.realmName}`}
                    loadingLabel="Joining…"
                    onClick={() => void answer(invite, true)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy != null}
                    loading={busy === `decline:${invite.realmName}`}
                    loadingLabel="Declining…"
                    onClick={() => void answer(invite, false)}
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {message && <p className={`feedback ${message.tone}`} role={message.tone === "bad" ? "alert" : "status"}>{message.text}</p>}
      </div>
    </section>
  );
}
