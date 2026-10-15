import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { Modal } from "../components/Modal";
import { RealmTrustNote } from "../components/RealmTrustNote";
import { TextField } from "../components/TextField";
import { AlertIcon, ServersIcon, ShieldIcon } from "../components/icons";
import { formatClock, formatDuration, formatWhen } from "../lib/sessions";
import { useServer } from "../servers/ServerContext";
import {
  realmHostAddPlayer,
  realmHostApproveRequest,
  realmHostBan,
  realmHostDenyRequest,
  realmHostJoinRequests,
  realmHostKick,
  realmHostSetJoinPolicy,
  realmHostSetLimits,
  realmHostStart,
  realmHostStatus,
  realmHostStop,
  realmHostUnban,
  type RealmHostBan,
  type RealmHostPlayer,
  type RealmHostState,
  type RealmHostStatus,
  type RealmJoinPolicy,
  type RealmJoinRequest,
} from "./realmHostApi";
import {
  EMPTY_DRAFT,
  LIMIT_RANGES,
  describeAfk,
  describeRoute,
  describeWhere,
  draftFromCapacity,
  formatMiB,
  fraction,
  huntName,
  memoryTone,
  plural,
  prettify,
  validateLimits,
  type LimitsDraft,
  type MeterTone,
} from "./realmHostModel";
import "./realmHost.css";

// [2026-10-14 realms hub design 6.2] "Host my realm": the host's controls for the official-account realm that runs on this
// PC. The backend only syncs progress; Ramsgate, Training and the hunts run here, and kick and ban are the host's. The
// launcher's native side does the work (src-tauri/src/p2p/realm.rs); this panel shows its status, polled every 5 s while
// the panel is on screen. SettingsTab-style loading: ServersTab picks up every src/p2p/*Panel.tsx, so a launcher without
// that folder has no hosting UI at all.

const POLL_MS = 5_000;

// [2026-10-15] Who may join. "Approved players only" is the realm's default (invite-only): others send a request.
const JOIN_POLICY_OPTIONS: DropdownOption[] = [
  { value: "INVITE_ONLY", label: "Approved players only", detail: "Others send a request, and you approve it below." },
  { value: "PUBLIC", label: "Anyone", detail: "Anyone signed in joins without asking." },
];

// The native messages are written for the player and are shown as they are. They are not run through sanitizeError,
// which would turn an address or a path in them into "the update server" or "a game file".
function friendly(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 400);
  if (err instanceof Error && err.message) return err.message.slice(0, 400);
  return "Something went wrong. Please try again.";
}

const STATE_CHIP: Record<RealmHostState, { label: string; tone: "" | "good" | "warn" | "live"; busy: boolean }> = {
  stopped: { label: "Stopped", tone: "", busy: false },
  starting: { label: "Starting…", tone: "live", busy: true },
  online: { label: "Online", tone: "good", busy: false },
  restarting: { label: "Restarting…", tone: "warn", busy: true },
  stopping: { label: "Stopping…", tone: "warn", busy: true },
};

function stateText(state: RealmHostState | null, uptime: string | null): string {
  switch (state) {
    case "starting": return "Starting Ramsgate on this PC…";
    case "online": return uptime ? `Online for ${uptime}.` : "Online.";
    case "restarting": return "Restarting Ramsgate…";
    case "stopping": return "Stopping the realm…";
    case "stopped": return "Your realm is offline. Start it to let your friends in.";
    default: return "Checking your realm…";
  }
}

function playerName(player: { displayName: string | null; accountId: string }): string {
  return player.displayName?.trim() || player.accountId;
}

type Confirm = { kind: "stop" } | { kind: "kick" | "ban"; player: RealmHostPlayer } | { kind: "unban"; player: RealmHostBan };

function Meter({ label, text, ratio, tone }: { label: string; text: string; ratio: number; tone: MeterTone }) {
  const percent = Math.round(ratio * 100);
  return (
    <div className="rh-meter" data-tone={tone}>
      <div className="rh-meter-head">
        <span className="rh-meter-label">{label}</span>
        <span className="rh-meter-text">{text}</span>
      </div>
      <div className="rh-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={text}>
        <span className="rh-meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function RealmHostCard({ style }: { style?: CSSProperties }) {
  const { account } = useAuth();
  const selfId = account?.userId;
  const [status, setStatus] = useState<RealmHostStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<LimitsDraft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  // [2026-10-14] When the status shown was read: the players list is only as current as this.
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [banReason, setBanReason] = useState("");
  // [2026-10-15] Join requests (read with the status), the add-by-username field and the policy's choice.
  const [requests, setRequests] = useState<RealmJoinRequest[]>([]);
  // The list's own read error, and the error of an approve or deny (kept apart: a refresh must not clear the latter).
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addDone, setAddDone] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  // Bumped when an action starts and again when it ends: a status read that began before the action finished can no
  // longer replace the answer the action returned.
  const epochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // `force` puts the limits the native side reports into the form (after Start or Apply); otherwise edits are kept.
  const applyStatus = useCallback((next: RealmHostStatus, force = false) => {
    setStatus(next);
    setCheckedAt(Date.now());
    setStatusError(null);
    if (force) {
      dirtyRef.current = false;
      setDirty(false);
    }
    if (force || !dirtyRef.current) setDraft(draftFromCapacity(next.capacity));
  }, []);

  // [2026-10-15] The host's waiting players. A failed read is shown in the section, not in the status error.
  const loadRequests = useCallback(async () => {
    try {
      const next = await realmHostJoinRequests();
      if (!mountedRef.current) return;
      setRequests(next.requests);
      setRequestsError(next.error);
    } catch (err) {
      if (mountedRef.current) setRequestsError(friendly(err));
    }
  }, []);

  const poll = useCallback(async () => {
    const epoch = epochRef.current;
    let hasRealm = false;
    try {
      const next = await realmHostStatus();
      hasRealm = next.realm !== null;
      if (mountedRef.current && epoch === epochRef.current) applyStatus(next);
    } catch (err) {
      if (mountedRef.current && epoch === epochRef.current) setStatusError(friendly(err));
    }
    // [2026-10-15] The waiting players are read only for an account that has a realm (the list is not shown otherwise).
    if (hasRealm) void loadRequests();
  }, [applyStatus, loadRequests]);

  // Poll while the panel is on screen. Leaving the page unmounts it; a hidden window (minimised) pauses it too, and
  // coming back reads the status at once.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [poll]);

  // One action at a time. A refusal is shown where the player pressed the button. Resolves with the status the action
  // answered, or null when the call itself failed (the failure is shown already).
  const run = useCallback(async (
    key: string,
    work: () => Promise<RealmHostStatus>,
    options: { force?: boolean; onError?: (message: string) => void } = {},
  ): Promise<RealmHostStatus | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    epochRef.current += 1;
    setBusy(key);
    setActionError(null);
    try {
      const next = await work();
      if (mountedRef.current) applyStatus(next, options.force);
      return next;
    } catch (err) {
      if (mountedRef.current) (options.onError ?? setActionError)(friendly(err));
      return null;
    } finally {
      epochRef.current += 1;
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [applyStatus]);

  const editLimit = (field: keyof LimitsDraft, value: string) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const resetLimits = () => {
    dirtyRef.current = false;
    setDirty(false);
    if (status) setDraft(draftFromCapacity(status.capacity));
  };

  const check = validateLimits(draft);
  const state = status?.state ?? null;
  const working = busy != null;

  const startRealm = () => {
    if (!check.limits || state !== "stopped") return;
    const limits = check.limits;
    void run("start", () => realmHostStart(limits), { force: true });
  };

  const applyLimits = () => {
    if (!check.limits || state !== "online") return;
    const limits = check.limits;
    void run("limits", () => realmHostSetLimits(limits), { force: true });
  };

  const openConfirm = (next: Confirm) => {
    setConfirm(next);
    setConfirmError(null);
    setBanReason("");
  };
  const closeConfirm = () => setConfirm(null);

  // Runs a confirmed action. The dialog closes when it worked. A refusal comes back as the status's error notice (the
  // launcher does not reject the call), so the dialog stays open and says why; a failed call is shown in it too.
  const confirmAction = async () => {
    if (!confirm) return;
    setConfirmError(null);
    const onError = (message: string) => setConfirmError(message);
    let answer: RealmHostStatus | null;
    if (confirm.kind === "stop") {
      answer = await run("stop", () => realmHostStop(), { onError });
    } else if (confirm.kind === "kick") {
      const id = confirm.player.accountId;
      answer = await run(`kick:${id}`, () => realmHostKick(id), { onError });
    } else if (confirm.kind === "unban") {
      const id = confirm.player.accountId;
      answer = await run(`unban:${id}`, () => realmHostUnban(id), { onError });
    } else {
      const id = confirm.player.accountId;
      const reason = banReason.trim();
      answer = await run(`ban:${id}`, () => realmHostBan(id, reason === "" ? null : reason), { onError });
    }
    if (!answer || !mountedRef.current) return;
    if (confirm.kind !== "stop" && answer.noticeKind === "error") {
      setConfirmError(answer.notice ?? "The launcher refused the request.");
      return;
    }
    closeConfirm();
  };

  // [2026-10-15] Approve or deny a waiting player. A refusal comes back as the status's error notice, shown in the section.
  const decideRequest = async (player: RealmJoinRequest, approve: boolean) => {
    setRequestError(null);
    const id = player.accountId;
    const answer = await run(
      `${approve ? "approve" : "deny"}:${id}`,
      () => (approve ? realmHostApproveRequest(id) : realmHostDenyRequest(id)),
      { onError: setRequestError },
    );
    if (answer && answer.noticeKind === "error") setRequestError(answer.notice ?? "The launcher refused the request.");
    void loadRequests();
  };

  // [2026-10-15] Lets a player in by username. The native notice names them ("<name> can now join your realm directly.").
  const addPlayer = async () => {
    const username = addName.trim();
    setAddDone(null);
    if (username === "") {
      setAddError("Enter the player's username.");
      return;
    }
    setAddError(null);
    const answer = await run("add", () => realmHostAddPlayer(username), { onError: setAddError });
    if (!answer || !mountedRef.current) return;
    if (answer.noticeKind === "error") {
      setAddError(answer.notice ?? "The launcher refused the request.");
      return;
    }
    setAddDone(answer.notice ?? `${username} can now join your realm directly.`);
    setAddName("");
    void loadRequests();
  };

  const changeJoinPolicy = (value: string) => {
    const policy: RealmJoinPolicy | null = value === "PUBLIC" ? "PUBLIC" : value === "INVITE_ONLY" ? "INVITE_ONLY" : null;
    if (!realm || policy === null || policy === realm.joinPolicy) return;
    void run("policy", () => realmHostSetJoinPolicy(policy));
  };

  const chip = state ? STATE_CHIP[state] : null;
  const realm = status?.realm ?? null;
  const uptime = state === "online" && status?.hub?.startedAt ? formatDuration(status.hub.startedAt, null) : null;
  const iconTone = state === "online" ? " good" : state === "restarting" || state === "stopping" ? " warn" : "";
  const limitsLocked = !status || working || (state !== "stopped" && state !== "online");
  const players = status?.players ?? [];
  const bans = status?.bans ?? [];
  const capacity = status?.capacity ?? null;
  const showPlayers = state != null && state !== "stopped";
  const serverRows: { key: string; label: string; state: string; players: number }[] = [];
  if (status?.hub) serverRows.push({ key: status.hub.sessionId, label: "Ramsgate", state: status.hub.state, players: status.hub.players });
  if (status?.training) serverRows.push({ key: status.training.sessionId, label: "Training", state: status.training.state, players: status.training.players });
  for (const hunt of status?.hunts ?? []) serverRows.push({ key: hunt.sessionId, label: huntName(hunt.huntId), state: hunt.state, players: hunt.players });

  let headerButton;
  if (state === "stopped" || state == null) {
    headerButton = (
      <Button onClick={startRealm} disabled={state == null || !check.limits || working} loading={busy === "start"} loadingLabel="Starting…">
        Start realm
      </Button>
    );
  } else {
    headerButton = (
      <Button
        variant="danger"
        onClick={() => openConfirm({ kind: "stop" })}
        disabled={working}
        loading={state === "stopping"}
        loadingLabel="Stopping…"
      >
        Stop realm
      </Button>
    );
  }

  const confirmBusy = busy != null && confirm != null;
  const confirmName = confirm && confirm.kind !== "stop" ? playerName(confirm.player) : "";

  return (
    <section className="glass card reveal rh" style={style} aria-label="Host my realm">
      <div className="section">
        <div className="section-row">
          <div className="section-head">
            <div className={`section-icon${iconTone}`}><ServersIcon /></div>
            <div className="min-w-0">
              <h2 className="section-title rh-title">
                <span>Host my realm</span>
                {chip && (
                  <span className={`chip${chip.tone ? ` ${chip.tone}` : ""}`}>
                    {chip.busy ? <span className="spinner rh-chip-spinner" aria-hidden="true" /> : state === "online" ? <span className="dot pulse" aria-hidden="true" /> : null}
                    {chip.label}
                  </span>
                )}
                {state === "online" && realm && (
                  <span className={`chip ${realm.serving ? "good" : "warn"}`}>{realm.serving ? "Serving" : "Not serving yet"}</span>
                )}
              </h2>
              <p className="section-desc">
                {realm && <><span className="mono">{realm.name}</span> · </>}
                {stateText(state, uptime)}
              </p>
            </div>
          </div>
          <div className="section-actions">{headerButton}</div>
        </div>
        <p className="note with-icon">
          <ShieldIcon />
          <span>Hosting runs Ramsgate, Training and hunts on this PC. Players on it use their official accounts.</span>
        </p>
        <RealmTrustNote />
        {status?.notice && (
          // [2026-10-14] A refusal or failure is in the error style; a notice about the realm's own state is not. Both are
          // notices (role status), not failed calls: a failed call is the alert below.
          <p
            className="rh-notice"
            data-tone={status.noticeKind === "error" ? "bad" : state === "online" ? "info" : "warn"}
            data-kind={status.noticeKind}
            role="status"
          >
            <AlertIcon /><span>{status.notice}</span>
          </p>
        )}
        {actionError && <p className="feedback bad" role="alert">{actionError}</p>}
        {statusError && <p className="feedback bad" role="alert">Couldn't read the realm status. {statusError}</p>}
        {!status && !statusError && <div className="loader-bar rh-loading" />}
      </div>

      {/* [2026-10-15] Who may join, the players waiting for approval, and adding a player by name. Shown once the realm exists. */}
      {realm && (
        <div className="section">
          <div className="rh-head">
            <h3 className="rh-heading">Who can join</h3>
            <span className="rh-sub">You can change this at any time.</span>
          </div>
          <div className="rh-policy">
            <Dropdown
              label="Who can join"
              value={realm.joinPolicy || null}
              options={JOIN_POLICY_OPTIONS}
              onChange={changeJoinPolicy}
              disabled={working}
            />
          </div>
        </div>
      )}

      {realm && (
        <div className="section">
          <div className="rh-head">
            <h3 className="rh-heading">Join requests</h3>
            {requests.length > 0 && <span className="chip warn">{requests.length} waiting</span>}
            <Button variant="ghost" size="sm" onClick={() => void loadRequests()} disabled={working}>Refresh</Button>
          </div>
          {requests.length === 0 ? (
            <p className="note">No pending requests.</p>
          ) : (
            <ul className="rh-list">
              {requests.map((player) => (
                <li className="rh-row" key={player.accountId}>
                  <div className="rh-who">
                    <div className="rh-name"><span className="rh-name-text" title={player.accountId}>{playerName(player)}</span></div>
                    <div className="rh-meta">
                      {player.at && <span className="rh-sub">Asked {formatWhen(player.at)}</span>}
                    </div>
                  </div>
                  <div className="rh-actions">
                    <Button
                      size="sm"
                      disabled={working}
                      loading={busy === `approve:${player.accountId}`}
                      loadingLabel="Approving…"
                      onClick={() => void decideRequest(player, true)}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={working}
                      loading={busy === `deny:${player.accountId}`}
                      loadingLabel="Denying…"
                      onClick={() => void decideRequest(player, false)}
                    >
                      Deny
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {requestsError && <p className="feedback bad" role="alert">{requestsError}</p>}
          {requestError && <p className="feedback bad" role="alert">{requestError}</p>}
        </div>
      )}

      {realm && (
        <div className="section">
          <div className="rh-head">
            <h3 className="rh-heading">Add a player</h3>
            <span className="rh-sub">They join without sending a request.</span>
          </div>
          <form
            className="rh-add"
            onSubmit={(event) => {
              event.preventDefault();
              void addPlayer();
            }}
          >
            <TextField
              label="Username"
              value={addName}
              onChange={(event) => {
                setAddName(event.target.value);
                setAddDone(null);
              }}
              error={addError ?? undefined}
              hint="Their launcher username. Letter case does not matter."
              disabled={working}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={working || addName.trim() === ""} loading={busy === "add"} loadingLabel="Adding…">
              Allow
            </Button>
          </form>
          {addDone && <p className="feedback ok" role="status">{addDone}</p>}
        </div>
      )}

      <div className="section">
        <div className="rh-head">
          <h3 className="rh-heading">Limits</h3>
          <span className="rh-sub">
            {state === "online"
              ? "Max servers applies at once. Max players and AFK apply when Ramsgate next starts."
              : "Used when you start the realm."}
          </span>
        </div>
        <div className="rh-limits">
          <TextField
            label="Max players"
            value={draft.maxPlayers}
            onChange={(event) => editLimit("maxPlayers", event.target.value)}
            error={status ? check.errors.maxPlayers : undefined}
            hint={`${LIMIT_RANGES.maxPlayers.min} to ${LIMIT_RANGES.maxPlayers.max} in the realm at once.`}
            disabled={limitsLocked}
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="Max servers"
            value={draft.maxServers}
            onChange={(event) => editLimit("maxServers", event.target.value)}
            error={status ? check.errors.maxServers : undefined}
            hint={`${LIMIT_RANGES.maxServers.min} to ${LIMIT_RANGES.maxServers.max}. Ramsgate, Training and each hunt count.`}
            disabled={limitsLocked}
            inputMode="numeric"
            maxLength={2}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="AFK kick (seconds)"
            value={draft.afkSeconds}
            onChange={(event) => editLimit("afkSeconds", event.target.value)}
            placeholder="Default"
            error={status ? check.errors.afkSeconds : undefined}
            hint={describeAfk(draft.afkSeconds)}
            disabled={limitsLocked}
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {(state === "online" || dirty) && (
          <div className="server-actions">
            {state === "online" && (
              <Button variant="secondary" size="sm" onClick={applyLimits} disabled={!dirty || !check.limits || working} loading={busy === "limits"} loadingLabel="Applying…">
                Apply limits
              </Button>
            )}
            {dirty && <Button variant="ghost" size="sm" onClick={resetLimits} disabled={working}>Reset</Button>}
          </div>
        )}
      </div>

      {capacity && (
        <div className="section">
          <div className="rh-head"><h3 className="rh-heading">Capacity</h3></div>
          <div className="rh-meters">
            <Meter
              label="Servers in use"
              text={`${capacity.activeServers} of ${capacity.maxServers}`}
              ratio={fraction(capacity.activeServers, capacity.maxServers)}
              tone={capacity.maxServers > 0 && capacity.activeServers >= capacity.maxServers ? "warn" : "ok"}
            />
            <Meter
              label="Players"
              text={`${players.length} of ${capacity.maxPlayers}`}
              ratio={fraction(players.length, capacity.maxPlayers)}
              tone={capacity.maxPlayers > 0 && players.length >= capacity.maxPlayers ? "warn" : "ok"}
            />
            <Meter
              label="Free memory"
              text={capacity.totalMemMiB > 0 ? `${formatMiB(capacity.freeMemMiB)} free of ${formatMiB(capacity.totalMemMiB)}` : "Unknown"}
              ratio={capacity.totalMemMiB > 0 ? fraction(capacity.totalMemMiB - capacity.freeMemMiB, capacity.totalMemMiB) : 0}
              tone={capacity.totalMemMiB > 0 ? memoryTone(capacity.freeMemMiB) : "ok"}
            />
          </div>
          {serverRows.length > 0 && (
            <dl className="kv rh-servers">
              {serverRows.map((row) => (
                <div className="rh-server" key={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{prettify(row.state)} · {plural(row.players, "player")}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {showPlayers && (
        <div className="section">
          <div className="rh-head">
            <h3 className="rh-heading">Players</h3>
            <span className="rh-sub">{capacity ? `${players.length} of ${capacity.maxPlayers}` : plural(players.length, "player")}</span>
            {checkedAt != null && <span className="rh-sub">Read at {formatClock(checkedAt)}</span>}
          </div>
          {players.length === 0 ? (
            <p className="note">Nobody is in your realm right now.</p>
          ) : (
            <ul className="rh-list">
              {players.map((player) => {
                const name = playerName(player);
                const route = describeRoute(player.route);
                const duration = player.since ? formatDuration(player.since, null) : null;
                const isSelf = selfId != null && player.accountId === selfId;
                return (
                  <li className="rh-row" key={`${player.accountId}:${player.where.sessionId}`}>
                    <div className="rh-who">
                      <div className="rh-name">
                        <span className="rh-name-text" title={player.accountId}>{name}</span>
                        {/* [2026-10-15] The host's own game is listed too (realm.rs host_player), so its row says so. */}
                        {isSelf && <span className="chip accent">You (host)</span>}
                      </div>
                      <div className="rh-meta">
                        <span className="chip live">{describeWhere(player.where)}</span>
                        {route && <span className="chip" title="Connection">{route}</span>}
                        {duration && <span className="rh-sub">{duration}</span>}
                      </div>
                    </div>
                    {!isSelf && (
                      <div className="rh-actions">
                        <Button variant="secondary" size="sm" disabled={working} onClick={() => openConfirm({ kind: "kick", player })}>Kick</Button>
                        <Button variant="danger" size="sm" disabled={working} onClick={() => openConfirm({ kind: "ban", player })}>Ban</Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {(bans.length > 0 || showPlayers) && (
        <div className="section">
          <div className="rh-head">
            <h3 className="rh-heading">Banned players</h3>
            <span className="rh-sub">{bans.length > 0 ? String(bans.length) : ""}</span>
          </div>
          {bans.length === 0 ? (
            <p className="note">No one is banned.</p>
          ) : (
            <ul className="rh-list">
              {bans.map((ban) => (
                <li className="rh-row" key={ban.accountId}>
                  <div className="rh-who">
                    <div className="rh-name"><span className="rh-name-text" title={ban.accountId}>{playerName(ban)}</span></div>
                    <div className="rh-meta">
                      <span className="rh-sub">{ban.reason?.trim() ? `Reason: ${ban.reason.trim()}` : "No reason given"}</span>
                      {ban.at && <span className="rh-sub">{formatWhen(ban.at)}</span>}
                    </div>
                  </div>
                  <div className="rh-actions">
                    <Button variant="secondary" size="sm" disabled={working} loading={busy === `unban:${ban.accountId}`} loadingLabel="Unbanning…" onClick={() => openConfirm({ kind: "unban", player: ban })}>
                      Unban
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirm && (
        <Modal
          title={confirm.kind === "stop"
            ? "Stop your realm?"
            : confirm.kind === "kick" ? `Kick ${confirmName}?`
              : confirm.kind === "unban" ? `Unban ${confirmName}?` : `Ban ${confirmName}?`}
          tone={confirm.kind === "kick" || confirm.kind === "unban" ? "default" : "danger"}
          onClose={confirmBusy ? () => {} : closeConfirm}
          footer={(
            <div className="modal-actions">
              <Button variant="ghost" onClick={closeConfirm} disabled={confirmBusy}>{confirm.kind === "stop" ? "Keep running" : "Cancel"}</Button>
              <Button
                variant={confirm.kind === "kick" || confirm.kind === "unban" ? "secondary" : "danger"}
                onClick={() => void confirmAction()}
                loading={confirmBusy}
                loadingLabel={confirm.kind === "stop" ? "Stopping…" : confirm.kind === "kick" ? "Kicking…" : confirm.kind === "unban" ? "Unbanning…" : "Banning…"}
              >
                {confirm.kind === "stop" ? "Stop realm" : confirm.kind === "kick" ? "Kick" : confirm.kind === "unban" ? "Unban" : "Ban"}
              </Button>
            </div>
          )}
        >
          {confirm.kind === "stop" && (
            <p>
              Ramsgate, Training and every hunt on this PC close.{" "}
              {players.length > 0
                ? `${plural(players.length, "player")} will be disconnected and the realm goes offline.`
                : "Nobody is playing right now. The realm stays offline until you start it again."}
            </p>
          )}
          {confirm.kind === "kick" && (
            <p><strong>{confirmName}</strong> is removed from your realm now. They can join again.</p>
          )}
          {confirm.kind === "unban" && (
            <p><strong>{confirmName}</strong> can join your realm again.</p>
          )}
          {confirm.kind === "ban" && (
            <>
              <p><strong>{confirmName}</strong> is removed now and cannot join your realm until you unban them.</p>
              <TextField
                label="Reason (optional)"
                value={banReason}
                onChange={(event) => setBanReason(event.target.value)}
                maxLength={200}
                hint="Shown in your ban list."
                disabled={confirmBusy}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          {confirmError && <p className="feedback bad" role="alert">{confirmError}</p>}
        </Modal>
      )}
    </section>
  );
}

/**
 * The panel shows only for the official server and for Paradox realms, which both use the Mystic Paradox accounts. A
 * local server has its own backend and its own accounts, so nothing is rendered and no status is polled for it.
 */
export default function RealmHostPanel({ style }: { style?: CSSProperties }) {
  const { ready, selected } = useServer();
  const applies = selected?.kind === "official" || selected?.kind === "paradox_realm";
  if (!ready || !applies) return null;
  return <RealmHostCard style={style} />;
}
