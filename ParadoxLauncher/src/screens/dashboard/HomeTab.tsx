import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "../../auth/AuthContext";
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
  secureLaunch,
  type InstallStatus,
  type RuntimeUpdateStatus,
} from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { buildName, describeExit, formatClock, formatDuration, formatWhen, type SessionSummary } from "../../lib/sessions";
import { AccountIcon, AlertIcon, BuildIcon, CheckIcon, ChevronRightIcon, HistoryIcon, PlayIcon, RuntimeIcon } from "../../components/icons";
import { AetherMark } from "../../components/AetherMark";
import { ArtBackdrop } from "../../components/ArtBackdrop";

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
let runtimeCache: { channel: string; at: number; status: RuntimeUpdateStatus } | null = null;
const RUNTIME_CACHE_MS = 120_000;

interface HomeTabProps {
  onOpenAccount?: () => void;
  onNavigate?: (tab: "settings" | "library") => void;
}

export function HomeTab({ onOpenAccount = () => {}, onNavigate = () => {} }: HomeTabProps) {
  const { account, accountCheckedAt, accountRefreshing, accountRefreshError } = useAuth();
  const { policy, refreshPolicy } = usePolicy();
  const services = useServices();
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [phase, setPhase] = useState<PlayPhase>({ status: "idle" });
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
  useEffect(() => {
    if (!channel || !located) {
      setRuntime({ state: "idle" });
      return;
    }
    if (runtimeCache && runtimeCache.channel === channel && Date.now() - runtimeCache.at < RUNTIME_CACHE_MS) {
      setRuntime({ state: "known", status: runtimeCache.status });
      return;
    }
    let cancelled = false;
    setRuntime({ state: "checking" });
    checkRuntimeUpdate(channel)
      .then((status) => {
        runtimeCache = { channel, at: Date.now(), status };
        if (!cancelled) setRuntime({ state: "known", status });
      })
      .catch(() => { if (!cancelled) setRuntime({ state: "unavailable" }); });
    return () => { cancelled = true; };
  }, [channel, located, runtimeNonce]);

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
    playLockRef.current = true;
    setPhase({ status: "requestingSession" });

    try {
      // Re-sync flags and channel from current account policy immediately before launch.
      const freshPolicy = await refreshPolicy();
      if (!freshPolicy) throw new Error("Couldn't verify your account access. Check your connection and try again.");
      if (!mountedRef.current) return;
      // Rust repairs/verifies signed runtime, validates the executable and entitlement, then requests the ticket.
      setPhase({ status: "launching" });
      await secureLaunch(freshPolicy.channel);
      if (mountedRef.current) {
        setPhase({ status: "running" });
        setSessionsNonce((value) => value + 1);
        invalidateRuntime();
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : err instanceof Error ? err.message : undefined) || "Couldn't launch Dauntless." });
      }
    } finally {
      playLockRef.current = false;
    }
  }, [install, account, phase.status, refreshPolicy, invalidateRuntime]);

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
  const canPlay = ready && (install?.exeSha256 != null || runtimeRepairRequired) && (phase.status === "idle" || phase.status === "error");
  const canRepair = located && runtimeRepairRequired && !gameRunning && (phase.status === "idle" || phase.status === "error");
  const busy = phase.status !== "idle" && phase.status !== "error" && phase.status !== "running";
  const liveSession = gameRunning && sessions?.[0] && !sessions[0].exitedAt ? sessions[0] : null;

  const statusTitle = gameRunning
    ? "Dauntless is running"
    : ready
      ? runtimeRepairRequired ? "Runtime will be repaired" : "Ready to launch"
      : located
        ? "Installation needs attention"
        : "Select your game folder";
  const statusDescription = gameRunning
    ? liveSession
      ? `Started at ${formatClock(Date.parse(liveSession.startedAt))}. Play returns when the game closes.`
      : "Play returns when the game closes."
    : ready && runtimeRepairRequired
      ? "The signed runtime is downloaded and verified when you press Play."
      : ready
        ? "Game folder found. Files and the signed runtime are verified with the server on Play."
        : located && hasError
          ? sanitizeError(install?.error)
          : "Point the launcher at your Dauntless folder to get started.";

  const buttonText = gameRunning
    ? "Check status"
    : busy
      ? progressLabel ?? "Please wait…"
      : canPlay
        ? "Play"
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
  if (located && runtimeRepairRequired) {
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

  const heroCopy = gameRunning
    ? "Your Slayer is out in the Shattered Isles. The launcher keeps watch until the game closes."
    : "Ramsgate is waiting. Prepare your Slayer and return to the Shattered Isles.";
  const nonStableChannel = channel && channel !== "stable" ? channel : null;

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

      <div className="home-body">
        <div className="home-primary">
          <section className="glass glow launch reveal" style={at(3)} aria-label="Installation and launch status">
            <div className="launch-emblem"><AetherMark title={null} /></div>
            <div className="launch-copy">
              <h2 className="launch-title" aria-live="polite">
                <span key={busy ? progressLabel : statusTitle} className="swap">{busy ? progressLabel : statusTitle}</span>
                {ready && !busy && !gameRunning && !runtimeRepairRequired && (
                  <span className="badge-ok" aria-label="Verified"><CheckIcon /></span>
                )}
              </h2>
              <p className="launch-desc">{statusDescription}</p>
              {located && install?.exePath && (
                <p className="launch-path mono" title={gameRootPath(install.exePath)}>{gameRootPath(install.exePath)}</p>
              )}
              {busy && <div className="loader-bar" role="progressbar" aria-label="Launcher task in progress" aria-valuetext={progressLabel ?? "Working"} />}
              {phase.status === "error" && <p className="launch-error" role="alert">{phase.message}</p>}
            </div>
            <div className="launch-actions">
              <div className={`play-wrap${canPlay && !gameRunning && !busy ? " is-ready" : ""}`}>
                <button type="button" onClick={buttonAction} disabled={busy} className={`play${playVariant}`}>
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

          <section className="stats" aria-label="Launcher details">
            <article className="glass glow lift stat reveal" style={at(4)}>
              <div className={`stat-icon${buildMatches ? " good" : buildMismatch ? " warn" : ""}`}><BuildIcon /></div>
              <div className="stat-copy">
                <div className="stat-label">Build</div>
                <div className="stat-value">{buildValue}</div>
                <div className="stat-note"><span key={buildNote} className="swap">{buildNote}</span></div>
              </div>
            </article>
            <button
              type="button"
              className="glass glow lift stat reveal"
              style={at(5)}
              onClick={onOpenAccount}
              aria-label={`Manage ${account?.displayName ?? "your"} account. ${accountNote}.`}
            >
              <div className="stat-icon"><AccountIcon /></div>
              <div className="stat-copy">
                <div className="stat-label">Account</div>
                <div className="stat-value">{account?.displayName ?? "Signed in"}</div>
                <div className="stat-note" aria-live="polite"><span key={accountNote} className="swap">{accountNote}</span></div>
              </div>
              <ChevronRightIcon className="chev" />
            </button>
            <button
              type="button"
              className="glass glow lift stat reveal"
              style={at(6)}
              onClick={() => onNavigate("library")}
              aria-label={`Runtime: ${runtimeValue}. ${runtimeNote}. Open the library.`}
            >
              <div className={`stat-icon${runtimeTone}`}>{runtimeTone === " warn" ? <AlertIcon /> : <RuntimeIcon />}</div>
              <div className="stat-copy">
                <div className="stat-label">Runtime</div>
                <div className="stat-value"><span key={runtimeValue} className="swap">{runtimeValue}</span></div>
                <div className="stat-note"><span key={runtimeNote} className="swap">{runtimeNote}</span></div>
              </div>
              <ChevronRightIcon className="chev" />
            </button>
          </section>
        </div>

        <aside className="home-side">
          <section className="glass panel reveal" style={at(7)} aria-label="Recent sessions">
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
