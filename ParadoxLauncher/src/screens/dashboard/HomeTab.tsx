import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAuth } from "../../auth/AuthContext";
import { usePolicy } from "../../policy/PolicyContext";
import { getInstallStatus, pickInstallPath, isGameRunning, secureLaunch, checkRuntimeUpdate, installRuntimeUpdate, type InstallStatus } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { PlayIcon } from "../../components/icons";

function gameRootPath(exePath: string): string {
  return exePath
    .replace(/\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Binaries\\Win64\\Dauntless-Win64-Shipping\.exe$/i, "")
    .replace(/\\Dauntless-Win64-Shipping\.exe$/i, "");
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

export function HomeTab() {
  const { account } = useAuth();
  const { policy, refreshPolicy } = usePolicy();
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [phase, setPhase] = useState<PlayPhase>({ status: "idle" });
  const [launcherVersion, setLauncherVersion] = useState<string>("");
  const mountedRef = useRef(true);
  const playLockRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshInstall = useCallback(async () => {
    setPhase({ status: "verifying" });
    try {
      const status = await getInstallStatus();
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: "idle" });
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
    getVersion().then((v) => { if (mountedRef.current) setLauncherVersion(v); }).catch(() => {});
  }, []);

  const handleLocate = useCallback(async () => {
    setPhase({ status: "locating" });
    try {
      const status = await pickInstallPath();
      if (mountedRef.current) {
        setInstall(status);
        setPhase({ status: "idle" });
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "Couldn't locate Dauntless." });
      }
    }
  }, []);

  const handleRepair = useCallback(async () => {
    if (!install || !install.located || !install.error || phase.status !== "idle" && phase.status !== "error") return;
    setPhase({ status: "updatingRuntime" });
    try {
      await installRuntimeUpdate(policy?.channel ?? "stable");
      const refreshed = await getInstallStatus();
      if (mountedRef.current) {
        setInstall(refreshed);
        setPhase({ status: "idle" });
      }
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : undefined) || "Couldn't repair the installation." });
      }
    }
  }, [install, phase.status, policy]);

  const handlePlay = useCallback(async () => {
    if (!install || !account || playLockRef.current || phase.status !== "idle") return;
    playLockRef.current = true;

    try {
      // Flags/channel are re-synced from the account's policy immediately before launch —
      // the runtime caches several of them for the process lifetime, so this has to happen
      // before spawn, not just periodically in the background.
      const freshPolicy = await refreshPolicy();
      const channel = freshPolicy?.channel ?? "stable";

      // Project-owned runtime updates happen before the native launch boundary.
      // Rust then re-hashes the executable, rotates the secure session, requests
      // the one-time ticket, and spawns without exposing credentials to JS.
      setPhase({ status: "verifying" });
      let verified = await getInstallStatus();
      if (!verified.located) {
        setInstall(verified);
        setPhase({ status: "error", message: "Installation not found. Locate it again." });
        return;
      }
      if (verified.error) {
        setPhase({ status: "updatingRuntime" });
        await installRuntimeUpdate(channel);
        verified = await getInstallStatus();
      }
      if (!verified.located || verified.error || !verified.exeSha256) {
        setInstall(verified);
        setPhase({ status: "error", message: verified.error ?? "Couldn't verify the installation." });
        return;
      }
      setInstall(verified);

      const runtime = await checkRuntimeUpdate(channel);
      if (runtime.available) {
        setPhase({ status: "updatingRuntime" });
        await installRuntimeUpdate(channel);
        const refreshed = await getInstallStatus();
        if (!refreshed.located || refreshed.error) {
          setInstall(refreshed);
          setPhase({ status: "error", message: refreshed.error ?? "Runtime update did not complete." });
          return;
        }
        setInstall(refreshed);
      }

      setPhase({ status: "requestingSession" });
      await secureLaunch(channel);
      if (mountedRef.current) setPhase({ status: "running" });
    } catch (err) {
      if (mountedRef.current) {
        setPhase({ status: "error", message: sanitizeError(typeof err === "string" ? err : err instanceof Error ? err.message : undefined) || "Couldn't launch Dauntless." });
      }
    } finally {
      playLockRef.current = false;
    }
  }, [install, account, phase.status, refreshPolicy]);

  const progressLabel = phaseLabel(phase);
  const isTester = policy?.roles.includes("tester") ?? false;
  const buildLabel = isTester ? "Tester build" : "Preview build";

  const located = install?.located === true;
  const hasError = install?.error != null;

  const canPlay = located && !hasError && install?.exeSha256 != null && phase.status === "idle";
  const canLocate = phase.status === "idle" || phase.status === "error";
  const gameRunning = phase.status === "running";
  const canRepair = located && hasError && !gameRunning && (phase.status === "idle" || phase.status === "error");
  const busy = phase.status !== "idle" && phase.status !== "error" && phase.status !== "running" && phase.status !== "checkingStatus";

  return (
    <div className="flex min-h-full flex-col">
      <header
        className="aether-veil relative flex h-72 shrink-0 flex-col justify-end overflow-hidden border-b border-border px-8 pb-8"
      >

        <div aria-hidden className="absolute right-10 top-8 hidden items-center gap-2 rounded-full border border-accent/20 bg-bg/25 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-hover sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-online shadow-[0_0_8px] shadow-online" />
          {launcherVersion ? `${buildLabel} ${launcherVersion}` : buildLabel}
        </div>

        <div className="relative">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent-hover">Welcome back, {account?.displayName ?? "Slayer"}</p>
          <h1 className="mt-2 max-w-lg text-[34px] font-semibold leading-tight tracking-tight text-white [text-wrap:balance]">
            Return to the light
          </h1>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-white/70">Ramsgate is waiting. Verify your installation, prepare your Slayer, and return to the Shattered Isles.</p>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 px-8 py-7">
        <section className="grid items-center gap-5 rounded-2xl border border-border bg-surface p-6 shadow-[0_18px_50px_-36px] shadow-black md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-4">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span
                className={`absolute h-full w-full rounded-full ${gameRunning ? "animate-ping bg-online/50 [animation-duration:1.5s]" : ""}`}
              />
              <span
                className={`h-2.5 w-2.5 rounded-full ${gameRunning ? "bg-online" : located ? "bg-accent" : "bg-text-faint"}`}
              />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">
                {gameRunning ? "Dauntless is running" : located ? "Installation located" : "No installation set"}
              </p>
              <p className="mt-0.5 text-[13px] text-text-muted">
                {gameRunning
                  ? "Dauntless is running now."
                  : located && hasError
                  ? sanitizeError(install.error)
                  : located
                  ? "Verified and ready to launch."
                  : "Select your Dauntless 1.12.0 folder to get started."}
              </p>
              {located && !hasError && install?.exePath && <p className="mt-2 max-w-full truncate font-mono text-[11px] text-text-faint" title={gameRootPath(install.exePath)}>{gameRootPath(install.exePath)}</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 md:justify-end">
            {progressLabel && (
              <p className="animate-pulse text-[13px] text-accent-hover [animation-duration:1.5s]">{progressLabel}</p>
            )}

            {phase.status === "error" && (
              <p className="max-w-[28ch] text-[13px] text-danger">{phase.message}</p>
            )}

            {(gameRunning || phase.status === "checkingStatus") && (
              <button
                onClick={async () => {
                  setPhase({ status: "checkingStatus" });
                  try {
                    const running = await isGameRunning();
                    if (!mountedRef.current) return;
                    if (running) {
                      setPhase({ status: "running" });
                    } else {
                      const fresh = await getInstallStatus();
                      if (mountedRef.current) setInstall(fresh);
                      await new Promise((r) => setTimeout(r, 2000));
                      if (mountedRef.current) setPhase({ status: "idle" });
                    }
                  } catch {
                    if (mountedRef.current) setPhase({ status: "idle" });
                  }
                }}
                disabled={busy}
                className="flex h-12 min-w-[132px] shrink-0 items-center justify-center gap-2 rounded-xl border border-accent-muted bg-accent-muted/10 px-5 text-[13px] font-semibold text-accent-hover transition-all hover:bg-accent-muted/25 hover:border-accent/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            )}

            {canPlay && !gameRunning && (
              <button
                onClick={handlePlay}
                disabled={busy}
                className="flex h-12 min-w-[132px] shrink-0 items-center justify-center gap-2.5 rounded-xl bg-accent px-5 text-[13px] font-semibold text-[oklch(0.13_0.02_255)] shadow-[0_2px_18px_-3px] shadow-accent/45 transition-all duration-150 ease-(--ease-out-quart) hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlayIcon className="h-4 w-4" />
                Play
              </button>
            )}

            {canRepair && !gameRunning && (
              <button
                onClick={handleRepair}
                disabled={busy}
                className="flex h-12 min-w-[132px] shrink-0 items-center justify-center gap-2 rounded-xl border border-accent-muted bg-accent-muted/20 px-5 text-[13px] font-semibold text-accent-hover transition-all hover:bg-accent-muted/40 hover:border-accent/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Repairing…" : "Repair"}
              </button>
            )}

            {!located && canLocate && !gameRunning && (
              <button
                onClick={handleLocate}
                disabled={busy}
                className="flex h-12 min-w-[132px] shrink-0 items-center justify-center gap-2 rounded-xl border border-accent-muted bg-accent-muted/30 px-5 text-[13px] font-semibold text-accent-hover transition-all hover:bg-accent-muted/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Locate game
              </button>
            )}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          {[
            ["Build", "1.12.0 · checked at launch", "The native launcher verifies the supported client before issuing a session."],
            ["Account", account?.displayName ?? "Signed in", "Your launcher identity is passed to the game session."],
            ["Runtime", located && !hasError ? "Ready to launch" : "Needs setup", "Both project runtime DLLs are checked with the installation."],
          ].map(([label, value, body]) => (
            <div key={label} className="rounded-xl border border-border/80 bg-surface/60 px-4 py-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</p>
              <p className="mt-1 text-[13px] font-medium text-text">{value}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{body}</p>
            </div>
          ))}
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-text">From the field</h2>
            <span className="text-xs text-text-faint">Dispatches from the project</span>
          </div>

          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {MOCK_NEWS.map((item) => (
              <article key={item.title} className="group px-6 py-4 transition-colors duration-150 hover:bg-surface-raised/60">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-md bg-accent-faint px-2 py-0.5 text-[11px] font-medium text-accent-hover">
                      {item.tag}
                    </span>
                    <h3 className="text-sm font-medium text-text">{item.title}</h3>
                  </div>
                  <time className="shrink-0 text-xs text-text-faint">{item.date}</time>
                </div>
                <p className="mt-1.5 max-w-[65ch] text-[13px] leading-relaxed text-text-muted">{item.body}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const MOCK_NEWS = [
  {
    tag: "Project",
    title: "The forges of Ramsgate are lit again",
    date: "Jul 10",
    body: "The launcher is in early preview while accounts and matchmaking are still being reforged. Thanks for scouting ahead.",
  },
  {
    tag: "Runtime",
    title: "1.12.0 client verified",
    date: "Jul 6",
    body: "Executable hash checks for the final Dauntless build are in place — no patched or unknown binaries slip through.",
  },
  {
    tag: "Roadmap",
    title: "Hunting parties return soon",
    date: "Jul 2",
    body: "Friends, parties, and Behemoth hunts with a full crew of four are next on the trail after launch is stable.",
  },
];
