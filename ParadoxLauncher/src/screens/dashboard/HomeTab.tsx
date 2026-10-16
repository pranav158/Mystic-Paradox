import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useAccountRules } from "../../auth/AccountRules";
import { usePolicy } from "../../policy/PolicyContext";
import { useServices } from "../../services/ServicesContext";
import {
  checkRuntimeUpdate,
  getInstallStatus,
  getRecentSessions,
  installRuntimeUpdate,
  isGameRunning,
  onGameExited,
  pickInstallPath,
  REALM_HOST_KEY_REQUIRED,
  REALM_JOIN_REQUESTED,
  REALM_OWNER_CHANGED,
  secureLaunch,
  type InstallStatus,
  type RuntimeUpdateStatus,
} from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { deactivationMessage, isDeactivationRefusal } from "../../lib/accountDeletion";
import { buildName, describeExit, formatClock, formatDuration, formatWhen, type SessionSummary } from "../../lib/sessions";
import { AccountIcon, AlertIcon, BuildIcon, CheckIcon, HistoryIcon, PlayIcon, RuntimeIcon } from "../../components/icons";
import { AetherMark } from "../../components/AetherMark";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { Banner } from "../../components/Banner";
import { DeactivationBanner } from "../../components/DeactivationBanner";
import { LocalServerBadge } from "../../components/LocalServerWarning";
import { useServer } from "../../servers/ServerContext";
import { serverNaming, statusNaming } from "../../servers/serverNames";
import { officialUnavailable, officialUnavailableNote, serverStatusBadge } from "../../servers/officialPlay";
import { getVersion } from "@tauri-apps/api/app";
import { useRealmTrust } from "../../servers/RealmTrust";
import { realmPlayBlock } from "../../servers/realmStatus";
import { useRealmStatus } from "../../servers/useRealmStatus";

function gameRootPath(exePath: string): string {
  return exePath
    .replace(/\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Dauntless-Win64-Shipping\.exe$/i, "");
}

/** Stagger index for the `.reveal` entry animation. */
function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

type PlayPhase =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "verifying" }
  | { status: "checkingStatus" }
  | { status: "updatingRuntime" }
  | { status: "requestingSession" }
  | { status: "launching" }
  | { status: "running" }
  | { status: "error"; message: string };

function phaseLabel(phase: PlayPhase): string | null {
  switch (phase.status) {
    case "verifying": return "Verifying installation…";
    case "checkingStatus": return "Verifying game status…";
    case "updatingRuntime": return "Updating runtime…";
    case "locating": return "Selecting install path…";
    case "requestingSession": return "Requesting game session…";
    case "launching": return "Launching Dauntless…";
    default: return null;
  }
}

type RuntimeView =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "known"; status: RuntimeUpdateStatus }
  | { state: "unavailable" };

// The manifest check is a network call; reuse a recent answer when Home remounts on tab switches.
let runtimeCache: { channel: string; serverId: string; at: number; status: RuntimeUpdateStatus } | null = null;
const RUNTIME_CACHE_MS = 120_000;

interface HomeTabProps {
  onOpenAccount?: () => void;
  onNavigate?: (tab: "settings" | "library") => void;
}

export function HomeTab({ onOpenAccount = () => {}, onNavigate = () => {} }: HomeTabProps) {
  const { account, accountCheckedAt, accountRefreshing, accountRefreshError } = useAuth();
  const { policy, refreshPolicy } = usePolicy();
  const services = useServices();
  const { openWarning, selected, officialPlay } = useServer();
  const realmTrust = useRealmTrust();
  // [2026-10-16] A selected Paradox realm's own state (its host may not have started it), for the badge and Play.
  const realmStatus = useRealmStatus(selected);
  // [2026-10-14] A deactivated account (a deletion was requested) cannot start the game: Play says why instead.
  const rules = useAccountRules();
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // [2026-10-15] This launcher's own version, read at runtime (a muted line under Play).
  const [launcherVersion, setLauncherVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setLauncherVersion).catch(() => {});
  }, []);
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [phase, setPhase] = useState<PlayPhase>({ status: "idle" });
  // [2026-10-15] Play asked a realm's host for approval: this is information (the player waits), not an error.
  const [playNotice, setPlayNotice] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView>({ state: "idle" });
  const [runtimeNonce, setRuntimeNonce] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsNonce, setSessionsNonce] = useState(0);
  const mountedRef = useRef(true);
  const playLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshInstall = useCallback(async () => {
    setPhase({ status: "verifying" });
    try {
      // Startup prefetch already lives in Rust. Home only reads installation health;
      // policy changes must not restart repair or reset an active Play operation.
      const status = await getInstallStatus();
      // Home remounts on every tab switch; keep showing a running game instead of offering Play.
      const running = await isGameRunning().catch(() => false);
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: running ? "running" : "idle" });
      }
    } catch {
      if (mountedRef.current) {
        setPhase({ status: "error", message: "Couldn't check your installation." });
      }
    }
  }, []);

  useEffect(() => {
    refreshInstall();
  }, [refreshInstall]);

  useEffect(() => {
    // Rust emits this when the client it launched exits, so Play comes back on its own.
    const unlistenPromise = onGameExited(() => {
      if (!mountedRef.current) return;
      setPhase((current) => current.status === "running" ? { status: "idle" } : current);
      setSessionsNonce((value) => value + 1);
      getInstallStatus()
        .then((status) => { if (mountedRef.current) setInstall(status); })
        .catch(() => {});
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  // Real runtime state from the signed manifest for this account's channel.
  const channel = policy?.channel;
  const located = install?.located === true;
  // [2026-10-13 realms S1] The status describes the selected server. A local server's runtime files are the realm's
  // own, so there is no signed manifest to check for them; the cached answer belongs to one server.
  const serverId = install?.serverId ?? "official";
  const serverKind = install?.serverKind ?? "official";
  const runtimeManaged = install?.runtimeManaged !== false;
  useEffect(() => {
    if (!channel || !located || !runtimeManaged) {
      setRuntime({ state: "idle" });
      return;
    }
    if (runtimeCache && runtimeCache.channel === channel && runtimeCache.serverId === serverId && Date.now() - runtimeCache.at < RUNTIME_CACHE_MS) {
      setRuntime({ state: "known", status: runtimeCache.status });
      return;
    }
    let cancelled = false;
    setRuntime({ state: "checking" });
    checkRuntimeUpdate(channel)
      .then((status) => {
        runtimeCache = { channel, serverId, at: Date.now(), status };
        if (!cancelled) setRuntime({ state: "known", status });
      })
      .catch(() => { if (!cancelled) setRuntime({ state: "unavailable" }); });
    return () => { cancelled = true; };
  }, [channel, located, runtimeManaged, serverId, runtimeNonce]);

  const invalidateRuntime = useCallback(() => {
    runtimeCache = null;
    setRuntimeNonce((value) => value + 1);
  }, []);

  // This account's recent Play sessions, read from the local session folders.
  const accountId = account?.userId;
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    getRecentSessions(accountId, 4)
      .then((next) => { if (!cancelled) setSessions(next); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [accountId, sessionsNonce]);

  const handleLocate = useCallback(async () => {
    if (playLockRef.current) return;
    playLockRef.current = true;
    setPhase({ status: "locating" });
    try {
      let status = await pickInstallPath();
      if (status.located) {
        try {
          const freshPolicy = await refreshPolicy();
          if (!mountedRef.current) return;
          if (!freshPolicy) throw new Error("Account policy unavailable");
          await installRuntimeUpdate(freshPolicy.channel);
          status = await getInstallStatus();
        } catch {
          // Keep the selected path. Play will retry signed runtime repair if this first pass fails.
        }
      }
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: "idle" });
        invalidateRuntime();
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "Couldn't locate Dauntless." });
      }
    } finally {
      playLockRef.current = false;
    }
  }, [refreshPolicy, invalidateRuntime]);

  const handleRepair = useCallback(async () => {
    if (!install || !install.located || !install.error || playLockRef.current || (phase.status !== "idle" && phase.status !== "error")) return;
    playLockRef.current = true;
    setPhase({ status: "updatingRuntime" });
    try {
      const freshPolicy = await refreshPolicy();
      if (!freshPolicy) throw "Couldn't verify your account access. Check your connection and try again.";
      if (!mountedRef.current) return;
      await installRuntimeUpdate(freshPolicy.channel);
      const refreshed = await getInstallStatus();
      if (mountedRef.current) {
        setInstall(refreshed);
        setPhase({ status: "idle" });
        invalidateRuntime();
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "Couldn't repair the installation." });
      }
    } finally {
      playLockRef.current = false;
    }
  }, [install, phase.status, refreshPolicy, invalidateRuntime]);

  const handlePlay = useCallback(async () => {
    if (!install || !account || playLockRef.current || (phase.status !== "idle" && phase.status !== "error")) return;
    if (rules.deactivatedUntil !== null || rules.deletionChecking) return;
    playLockRef.current = true;
    setPlayNotice(null);
    setPhase({ status: "requestingSession" });

    try {
      // Re-sync flags and channel from current account policy immediately before launch.
      const freshPolicy = await refreshPolicy();
      if (!freshPolicy) throw new Error("Couldn't verify your account access. Check your connection and try again.");
      if (!mountedRef.current) return;
      // [2026-10-14 realms] A realm is entered only with the host the player agreed to: they are asked first when there is none.
      if (selected && !(await realmTrust.ensureHost(selected))) {
        if (mountedRef.current) setPhase({ status: "idle" });
        return;
      }
      // Rust repairs/verifies signed runtime, validates the executable and entitlement, then requests the ticket.
      setPhase({ status: "launching" });
      try {
        await secureLaunch(freshPolicy.channel);
      } catch (err) {
        // [2026-10-14 realms] The realm's name now belongs to another host: the player decides before anything starts. Trusting
        // the new host carries on with this Play; cancelling keeps the old host and starts nothing.
        if (err !== REALM_OWNER_CHANGED || !selected) throw err;
        if (!(await realmTrust.trustNewHost(selected))) {
          if (mountedRef.current) setPhase({ status: "idle" });
          return;
        }
        await secureLaunch(freshPolicy.channel);
      }
      if (mountedRef.current) {
        setPhase({ status: "running" });
        setSessionsNonce((value) => value + 1);
        invalidateRuntime();
      }
    } catch (err) {
      // [2026-10-15] The request to the host is sent: the player waits for an answer and presses Play again after it.
      if (err === REALM_JOIN_REQUESTED) {
        if (mountedRef.current) {
          const realmName = selected ? serverNaming(selected).primary : "";
          setPlayNotice(realmName
            ? `Request sent to ${realmName}. Wait for the host to approve it, then press Play again.`
            : "Request sent to the host. Wait for the host to approve it, then press Play again.");
          setPhase({ status: "idle" });
        }
        return;
      }
      // [2026-10-14] A refusal for a deactivated account: the sentence names the day, and the banner is read again.
      const deactivated = isDeactivationRefusal(err);
      if (deactivated) void rules.reloadDeletion().catch(() => {});
      if (mountedRef.current) {
        // [2026-10-14 realms] The host check's token reads as a sentence (the host is confirmed before the next Play).
        const text = err === REALM_HOST_KEY_REQUIRED ? "Confirm this realm's host before you play." : typeof err === "string" ? err : err instanceof Error ? err.message : undefined;
        setPhase({ status: "error", message: sanitizeError(text) || "Couldn't launch Dauntless." });
      }
    } finally {
      playLockRef.current = false;
    }
  }, [install, account, phase.status, refreshPolicy, invalidateRuntime, selected, realmTrust, rules]);

  const restoreFromHome = useCallback(async () => {
    setRestoreError(null);
    try {
      await rules.restoreAccount();
    } catch (err) {
      setRestoreError(typeof err === "string" ? err : err instanceof Error ? err.message : "Couldn't restore the account.");
    }
  }, [rules]);

  const handleCheckStatus = useCallback(async () => {
    if (playLockRef.current) return;
    playLockRef.current = true;
    setPhase({ status: "checkingStatus" });
    try {
      const running = await isGameRunning();
      if (!mountedRef.current) return;
      if (running) {
        setPhase({ status: "running" });
      } else {
        const fresh = await getInstallStatus();
        if (mountedRef.current) setInstall(fresh);
        if (mountedRef.current) setPhase({ status: "idle" });
        setSessionsNonce((value) => value + 1);
      }
    } catch {
      if (mountedRef.current) setPhase({ status: "running" });
    } finally {
      playLockRef.current = false;
    }
  }, []);

  const progressLabel = phaseLabel(phase);
  const hasError = install?.error != null;
  const runtimeRepairRequired = install?.runtimeRepairRequired === true;
  const fatalInstallError = hasError && !runtimeRepairRequired;
  const gameRunning = phase.status === "running";
  const ready = located && !fatalInstallError;
  // Play can be off for a whole server (a local server whose warning has not been accepted).
  // [2026-10-14] While the account is deactivated Play says the deletion day; while its state is being read, Play waits.
  const accountBlock = rules.deactivatedUntil !== null
    ? deactivationMessage(rules.deactivatedUntil)
    : rules.deletionChecking ? "Checking your account…" : null;
  // [2026-10-15] The official server's play switch is off: Play waits there, and says so (the backend's message, if any).
  const officialBlock = serverKind === "official" && officialUnavailable(officialPlay) ? officialUnavailableNote(officialPlay) : null;
  // [2026-10-16] A realm whose host has not started it: Play waits and says so (the player's own realm: start it first).
  const realmBlock = serverKind === "paradox_realm" ? realmPlayBlock(realmStatus) : null;
  const playBlocked = ready ? install?.playBlockedReason ?? officialBlock ?? accountBlock ?? realmBlock : null;
  const canPlay = ready && !playBlocked && (install?.exeSha256 != null || runtimeRepairRequired) && (phase.status === "idle" || phase.status === "error");
  const canRepair = located && runtimeRepairRequired && !gameRunning && (phase.status === "idle" || phase.status === "error");
  const busy = phase.status !== "idle" && phase.status !== "error" && phase.status !== "running";
  const liveSession = gameRunning && sessions?.[0] && !sessions[0].exitedAt ? sessions[0] : null;

  const statusTitle = gameRunning
    ? "Dauntless is running"
    : ready
      ? playBlocked ? "Play isn't available yet" : runtimeRepairRequired ? "Runtime will be repaired" : "Ready to launch"
      : located
        ? "Installation needs attention"
        : "Select your game folder";
  const statusDescription = gameRunning
    ? liveSession
      ? `Started at ${formatClock(Date.parse(liveSession.startedAt))}. Play returns when the game closes.`
      : "Play returns when the game closes."
    : ready && playBlocked
      ? playBlocked
    : ready && runtimeRepairRequired
      ? "The signed runtime is downloaded and verified when you press Play."
      : ready
        ? runtimeManaged
          ? "Game folder found. Files and the signed runtime are verified with the server on Play."
          : "Game folder found. This server's own backend checks your files when you press Play."
        : located && hasError
          ? sanitizeError(install?.error)
          : "Point the launcher at your Dauntless folder to get started.";

  const buttonText = gameRunning
    ? "Check status"
    : busy
      ? progressLabel ?? "Please wait…"
      : canPlay
        ? "Play"
        : playBlocked
          ? playBlocked === realmBlock
            ? realmStatus?.state === "starting" ? "Realm starting" : "Realm offline"
            : "Unavailable"
          : canRepair
            ? "Repair"
            : "Locate game";
  const buttonAction = gameRunning ? handleCheckStatus : canPlay ? handlePlay : canRepair ? handleRepair : handleLocate;
  const playVariant = busy ? " is-busy" : gameRunning ? " is-running" : canPlay ? "" : " is-secondary";

  // ---- Status cards: every value below comes from a native call or the backend. ----
  const target = install?.targetChangelist ?? null;
  const targetName = buildName(target);
  const buildValue = target ? `Dauntless ${targetName ?? `CL ${target}`}` : "Dauntless";
  const serverChangelist = services.supportedChangelist;
  const buildMatches = target != null && serverChangelist != null && target === serverChangelist;
  const buildMismatch = target != null && serverChangelist != null && target !== serverChangelist;
  const buildNote = target == null
    ? "Reading the launcher target…"
    : serverChangelist == null
      ? services.health === "unreachable" ? `CL ${target} · server unreachable` : `CL ${target}`
      : buildMatches
        ? `CL ${target} · matches server`
        : `Server expects CL ${serverChangelist}`;

  const accountStatus = account?.status === "banned"
    ? "Account banned"
    : account?.status === "disabled"
      ? "Account disabled"
      : account?.approvalStatus === "pending"
        ? "Approval pending"
        : account?.approvalStatus === "rejected"
          ? "Access rejected"
          : account?.status === "active" && account.approvalStatus === "approved"
            ? "Access approved"
            : "Status unavailable";
  const accountNote = accountRefreshing
    ? "Refreshing status…"
    : accountRefreshError
      ? "Status sync delayed"
      : accountCheckedAt
        ? `${accountStatus} · ${formatClock(accountCheckedAt)}`
        : accountStatus;

  let runtimeValue = "Needs setup";
  let runtimeNote = "Select your game folder";
  let runtimeTone: "" | " good" | " warn" | " busy" = "";
  if (located && !runtimeManaged) {
    runtimeValue = "Realm's own files";
    runtimeNote = "Not updated by the launcher";
  } else if (located && runtimeRepairRequired) {
    runtimeValue = "Repair needed";
    runtimeNote = "Fixed automatically on Play";
    runtimeTone = " warn";
  } else if (located && runtime.state === "checking") {
    runtimeValue = "Checking…";
    runtimeNote = `Signed ${channel ?? "runtime"} manifest`;
    runtimeTone = " busy";
  } else if (located && runtime.state === "known" && runtime.status.version) {
    runtimeValue = `Runtime v${runtime.status.version}`;
    runtimeNote = runtime.status.available ? "Update installs on Play" : `Up to date · ${channel ?? "stable"} channel`;
    runtimeTone = runtime.status.available ? " warn" : " good";
  } else if (located && runtime.state === "known") {
    runtimeValue = "No release published";
    runtimeNote = `Nothing on the ${channel ?? "stable"} channel`;
    runtimeTone = " warn";
  } else if (located && runtime.state === "unavailable") {
    runtimeValue = "Not checked";
    runtimeNote = "Play verifies it anyway";
  } else if (located) {
    runtimeValue = "Waiting for account";
    runtimeNote = "Checked once your policy loads";
  }

  // [2026-10-15] The owner's line, one sentence group per line (.hero-copy keeps the line break; the kicker above the name
  // says "Welcome back,").
  const heroCopy = gameRunning
    ? "Your Slayer is out in the Shattered Isles. The launcher keeps watch until the game closes."
    : "The Shattered Isles await.\nGear up, Slayer. Your next hunt begins.";
  // [2026-10-15] One status badge for the selected server, next to its kind (the official server, a realm or a local one).
  // [2026-10-16] A realm's badge follows the realm (its host's state), not only our backend's health.
  const statusBadge = serverStatusBadge({ kind: serverKind, health: services.health, officialPlay, realm: realmStatus });
  const nonStableChannel = channel && channel !== "stable" ? channel : null;
  // [2026-10-14] Which server Play uses: the kind in words, then its name (the official server is "Mystic Paradox"). A
  // realm is named by its realm name; the player's own name for it is a smaller line under that, only when it differs.
  const serverKindLabel = serverKind === "paradox_realm" ? "Paradox realm" : serverKind === "local" ? "Local server" : "Official server";
  const playNaming = statusNaming(install, selected);
  const playServerName = serverKind === "official" ? "Mystic Paradox" : playNaming?.primary || null;
  const playServerDetail = serverKind === "official" ? null : playNaming?.secondary ?? null;

  return (
    <div className="home">
      <ArtBackdrop />
      <div className="watermark" aria-hidden="true"><AetherMark title={null} /></div>

      <header className="hero">
        <p className="eyebrow reveal" style={at(0)}>Welcome back,</p>
        <h1 className="hero-name reveal" style={at(1)} title={account?.displayName}>{account?.displayName ?? "Slayer"}</h1>
        <span className="hero-rule" aria-hidden="true" />
        <p className="hero-copy reveal" style={at(2)}>{heroCopy}</p>
        {(gameRunning || nonStableChannel) && (
          <div className="hero-chips reveal" style={at(3)}>
            {gameRunning && <span className="chip good"><span className="dot pulse" />Playing now</span>}
            {nonStableChannel && <span className="chip accent">{nonStableChannel === "beta" ? "Beta" : "Dev"} channel</span>}
          </div>
        )}
      </header>

      {/* [2026-10-14] The account is deactivated and waits for its deletion: restore it, or the deletion day stands. */}
      {rules.deactivatedUntil !== null && (
        <div className="home-notice">
          <DeactivationBanner
            scheduledFor={rules.deactivatedUntil}
            restoring={rules.deletionBusy}
            error={restoreError}
            onRestore={() => void restoreFromHome()}
          />
        </div>
      )}

      {/* [2026-10-14 realms] A realm this player is in ended for them (the host went offline, or they were removed or banned). */}
      {realmTrust.notice && (
        <div className="home-notice">
          <Banner
            tone={realmTrust.notice.reason === "HOST_OFFLINE" ? "muted" : "danger"}
            onDismiss={realmTrust.dismissNotice}
          >
            {/* [2026-10-14] A realm is named by its realm name, first, so the player knows which realm it was. */}
            {realmTrust.notice.realm && <strong>{realmTrust.notice.realm}: </strong>}
            {realmTrust.notice.message}
          </Banner>
        </div>
      )}

      <div className="home-body">
        <div className="home-primary">
          <section className="glass glow launch reveal" style={at(3)} aria-label="Installation and launch status">
            <div className="launch-emblem"><AetherMark title={null} /></div>
            <div className="launch-copy">
              <h2 className="launch-title" aria-live="polite">
                <span key={busy ? progressLabel : statusTitle} className="swap">{busy ? progressLabel : statusTitle}</span>
                {ready && !busy && !gameRunning && !runtimeRepairRequired && !playBlocked && (
                  <span className="badge-ok" aria-label="Verified"><CheckIcon /></span>
                )}
              </h2>
              <p className="launch-desc">{statusDescription}</p>
              {/* [2026-10-15] The game folder and the launcher's version (a compact chip) share one line, so the card keeps its height. */}
              {((located && install?.exePath) || launcherVersion) && (
                <div className="launch-meta">
                  {located && install?.exePath && (
                    <p className="launch-path mono" title={gameRootPath(install.exePath)}>{gameRootPath(install.exePath)}</p>
                  )}
                  {launcherVersion && <span className="chip accent chip-compact">Launcher v{launcherVersion}</span>}
                </div>
              )}
              {busy && <div className="loader-bar" role="progressbar" aria-label="Launcher task in progress" aria-valuetext={progressLabel ?? "Working"} />}
              {phase.status === "error" && <p className="launch-error" role="alert">{phase.message}</p>}
              {playNotice && phase.status !== "error" && <p className="launch-notice" role="status">{playNotice}</p>}
            </div>
            <div className="launch-actions">
              {/* [2026-10-14] The server Play will use, named in words (kind and name), so it is never a surprise. */}
              <div className="play-server" data-kind={serverKind}>
                <div className="play-server-head">
                  <span className="play-server-kind">{serverKindLabel}</span>
                  {statusBadge && (
                    <span className={`chip${statusBadge.tone === "neutral" ? "" : ` ${statusBadge.tone}`}`} data-testid="server-status">
                      {statusBadge.text}
                    </span>
                  )}
                  {serverKind === "local" && (
                    <LocalServerBadge onOpen={() => openWarning(serverId)}>LOCAL SERVER WARNING</LocalServerBadge>
                  )}
                </div>
                {playServerName && <p className="play-server-name" title={playServerName}>{playServerName}</p>}
                {playServerDetail && <p className="play-server-detail" title={playServerDetail}>{playServerDetail}</p>}
              </div>
              <div className={`play-wrap${canPlay && !gameRunning && !busy ? " is-ready" : ""}`}>
                <button type="button" onClick={buttonAction} disabled={busy || (playBlocked != null && !gameRunning)} className={`play${playVariant}`}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : gameRunning ? <span className="dot pulse" aria-hidden="true" /> : canPlay ? <PlayIcon /> : null}
                  <span key={buttonText} className="swap">{buttonText}</span>
                </button>
              </div>
              {canRepair && canPlay && (
                <button type="button" className="btn btn-ghost btn-sm launch-secondary" onClick={handleRepair}>
                  Repair
                </button>
              )}
            </div>
          </section>

          <section className="glass glow stats reveal" style={at(4)} aria-label="Launcher details">
            <article className="stat">
              <div className={`stat-icon${buildMatches ? " good" : buildMismatch ? " warn" : ""}`}><BuildIcon /></div>
              <div className="stat-copy">
                <div className="stat-label">Build</div>
                <div className="stat-value">{buildValue}</div>
                <div className="stat-note"><span key={buildNote} className="swap">{buildNote}</span></div>
              </div>
            </article>
            <button
              type="button"
              className="stat"
              onClick={onOpenAccount}
              aria-label={`Manage ${account?.displayName ?? "your"} account. ${accountNote}.`}
            >
              <div className="stat-icon"><AccountIcon /></div>
              <div className="stat-copy">
                <div className="stat-label">Account</div>
                <div className="stat-value">{account?.displayName ?? "Signed in"}</div>
                <div className="stat-note" aria-live="polite"><span key={accountNote} className="swap">{accountNote}</span></div>
              </div>
            </button>
            <button
              type="button"
              className="stat"
              onClick={() => onNavigate("library")}
              aria-label={`Runtime: ${runtimeValue}. ${runtimeNote}. Open the library.`}
            >
              <div className={`stat-icon${runtimeTone}`}>{runtimeTone === " warn" ? <AlertIcon /> : <RuntimeIcon />}</div>
              <div className="stat-copy">
                <div className="stat-label">Runtime</div>
                <div className="stat-value"><span key={runtimeValue} className="swap">{runtimeValue}</span></div>
                <div className="stat-note"><span key={runtimeNote} className="swap">{runtimeNote}</span></div>
              </div>
            </button>
          </section>
        </div>

        <aside className="home-side">
          <section className="glass panel reveal" style={at(5)} aria-label="Recent sessions">
            <div className="panel-head">
              <h2 className="panel-title"><HistoryIcon />Recent sessions</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate("settings")}>Logs</button>
            </div>
            {sessions == null ? (
              <div className="loader-bar" />
            ) : sessions.length === 0 ? (
              <p className="panel-empty">No sessions yet. Your Play history on this PC appears here.</p>
            ) : (
              <ul className="session-list">
                {sessions.map((session, index) => {
                  const outcome = describeExit(session.exitCode, session.exitedAt, gameRunning && index === 0);
                  const duration = session.exitedAt || outcome.tone === "live" ? formatDuration(session.startedAt, session.exitedAt) : null;
                  return (
                    <li key={session.id}>
                      <span className={`dot tone-${outcome.tone}${outcome.tone === "live" ? " pulse" : ""}`} aria-hidden="true" />
                      <div className="session-body">
                        <div className="session-when">{formatWhen(session.startedAt)}</div>
                        <div className="session-meta">{outcome.label}{session.channel !== "stable" ? ` · ${session.channel}` : ""}</div>
                      </div>
                      <span className="session-meta">{duration ?? ""}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
