import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { checkRuntimeUpdate, getInstallStatus, installRuntimeUpdate, pickInstallPath, type InstallStatus, type RuntimeUpdateStatus } from "../../api/tauri";
import { usePolicy } from "../../policy/PolicyContext";
import { sanitizeError } from "../../lib/sanitize";
import { buildName, shortHash } from "../../lib/sessions";
import { AlertIcon, FolderIcon, LibraryIcon, RuntimeIcon, ShieldIcon } from "../../components/icons";
import { ArtBackdrop, heroArt } from "../../components/ArtBackdrop";

type Feedback = { kind: "ok" | "bad"; message: string } | null;

function at(index: number, extra?: Record<string, string>): CSSProperties {
  return { "--i": index, ...extra } as CSSProperties;
}

export function LibraryTab() {
  const { refreshPolicy } = usePolicy();
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeUpdateStatus | null>(null);
  const [runtimeChannel, setRuntimeChannel] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [busy, setBusy] = useState<"repair" | "locate" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mountedRef = useRef(true);
  // The runtime check must not re-run whenever the caller hands us a new refreshPolicy.
  const refreshPolicyRef = useRef(refreshPolicy);
  refreshPolicyRef.current = refreshPolicy;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await getInstallStatus();
      if (mountedRef.current) setInstall(status);
    } catch {
      // Leave the current view intact if the native status check is unavailable.
    }
  }, []);

  const refreshRuntime = useCallback(async () => {
    try {
      const policy = await refreshPolicyRef.current();
      if (!policy) return;
      const status = await checkRuntimeUpdate(policy.channel);
      if (mountedRef.current) {
        setRuntime(status);
        setRuntimeChannel(policy.channel);
        setRuntimeError(false);
      }
    } catch {
      if (mountedRef.current) setRuntimeError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const located = install?.located === true;
  useEffect(() => {
    if (located) void refreshRuntime();
  }, [located, refreshRuntime]);

  const handleRepair = useCallback(async () => {
    setBusy("repair");
    setFeedback(null);
    try {
      // Repair the account's own channel, as Home and Play do; a tester must not get the
      // stable runtime from here.
      const freshPolicy = await refreshPolicy();
      if (!freshPolicy) throw "Couldn't verify your account access. Check your connection and try again.";
      const result = await installRuntimeUpdate(freshPolicy.channel);
      if (mountedRef.current) {
        setFeedback({ kind: "ok", message: result?.version ? `Runtime v${result.version} is installed and verified.` : "Runtime files are installed and verified." });
      }
    } catch (err) {
      // Refresh below so any remaining issue is visible in the installation state.
      if (mountedRef.current) {
        setFeedback({ kind: "bad", message: sanitizeError(typeof err === "string" ? err : undefined) || "Couldn't repair the runtime." });
      }
    } finally {
      try {
        const status = await getInstallStatus();
        if (mountedRef.current) setInstall(status);
      } catch { /* leave the current state visible */ }
      void refreshRuntime();
      if (mountedRef.current) setBusy(null);
    }
  }, [refreshPolicy, refreshRuntime]);

  const handleLocate = useCallback(async () => {
    setBusy("locate");
    setFeedback(null);
    try {
      const status = await pickInstallPath();
      if (mountedRef.current) setInstall(status);
    } catch (err) {
      // A cancelled picker leaves the current installation unchanged.
      if (mountedRef.current && typeof err === "string") setFeedback({ kind: "bad", message: sanitizeError(err) });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const hasError = install?.error != null;
  const target = install?.targetChangelist ?? null;
  const targetName = buildName(target);
  const targetLabel = target ? `${targetName ? `Dauntless ${targetName} · ` : ""}CL ${target}` : "—";
  const runtimeLabel = runtimeError
    ? "Couldn't reach the update server. Play verifies the runtime anyway."
    : !runtime
      ? "Checking the signed manifest…"
      : runtime.version
        ? `Version ${runtime.version}${runtimeChannel ? ` on the ${runtimeChannel} channel` : ""}`
        : `No release is published on the ${runtimeChannel ?? "current"} channel.`;
  const runtimeChip = runtimeError || !runtime
    ? null
    : !runtime.version
      ? { tone: "warn", label: "Not published" }
      : runtime.available
        ? { tone: "warn", label: "Update available" }
        : { tone: "good", label: "Runtime up to date" };

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Game library</p>
          <h1 className="page-title">Library</h1>
          <p className="page-desc">Your Dauntless installation and the signed Mystic Paradox runtime it uses.</p>
        </header>

        {located ? (
          <>
            <section className="glass glow game-tile reveal" style={at(1, { "--art": `url("${heroArt}")` })}>
              <div className="game-tile-art" aria-hidden="true" />
              <div>
                <p className="eyebrow">Installed</p>
                <h2 className="game-tile-title">Dauntless</h2>
                <div className="game-tile-meta">
                  {target && <span className="chip">{targetLabel}</span>}
                  <span className={`chip ${hasError ? "warn" : "good"}`}>{hasError ? "Needs attention" : "Game files present"}</span>
                  {runtimeChip && <span className={`chip ${runtimeChip.tone}`}>{runtimeChip.label}</span>}
                </div>
              </div>
            </section>

            <section className="glass card reveal" style={at(2)} aria-label="Installation details">
              <div className="section">
                <div className="section-row">
                  <div className="section-head">
                    <div className="section-icon"><FolderIcon /></div>
                    <div className="min-w-0">
                      <h3 className="section-title">Game folder</h3>
                      <p className="section-desc mono">{install?.exePath}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    <button type="button" onClick={handleLocate} disabled={busy != null} className="btn btn-secondary">
                      {busy === "locate" ? "Opening…" : "Change folder"}
                    </button>
                  </div>
                </div>
                <dl className="kv">
                  <dt>Executable SHA-256</dt>
                  <dd className="mono">{shortHash(install?.exeSha256, 12) ?? "Not available"}</dd>
                  <dt>Launcher target</dt>
                  <dd>{targetLabel}</dd>
                  {hasError && (
                    <>
                      <dt>Status</dt>
                      <dd className="status-bad">{sanitizeError(install?.error)}</dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="section">
                <div className="section-row">
                  <div className="section-head">
                    <div className={`section-icon${hasError ? " warn" : runtimeChip?.tone === "good" ? " good" : ""}`}>
                      {hasError ? <AlertIcon /> : <RuntimeIcon />}
                    </div>
                    <div>
                      <h3 className="section-title">Mystic Paradox runtime</h3>
                      <p className="section-desc">{runtimeLabel}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    <button type="button" onClick={handleRepair} disabled={busy != null} className={`btn ${hasError ? "btn-primary" : "btn-secondary"}`}>
                      {busy === "repair" ? <><span className="spinner" aria-hidden="true" />Verifying…</> : hasError ? "Repair runtime" : "Verify runtime"}
                    </button>
                  </div>
                </div>
                {runtime?.currentSha256 && (
                  <dl className="kv">
                    <dt>Installed DLL</dt>
                    <dd className="mono">{shortHash(runtime.currentSha256, 12)}</dd>
                    {runtime.latestSha256 && runtime.latestSha256 !== runtime.currentSha256 && (
                      <>
                        <dt>Latest release</dt>
                        <dd className="mono">{shortHash(runtime.latestSha256, 12)}</dd>
                      </>
                    )}
                  </dl>
                )}
                {feedback && <p className={`feedback ${feedback.kind}`} role={feedback.kind === "bad" ? "alert" : "status"}>{feedback.message}</p>}
                <p className="note with-icon"><ShieldIcon />Every runtime file is signed. Play re-checks the game and runtime hashes with the server before it starts.</p>
              </div>
            </section>
          </>
        ) : (
          <section className="glass card reveal" style={at(1)}>
            <div className="section">
              <div className="section-row">
                <div className="section-head">
                  <div className="section-icon"><LibraryIcon /></div>
                  <div>
                    <h2 className="section-title">No installation selected</h2>
                    <p className="section-desc">Choose your Dauntless folder. The launcher finds the game files and checks them before you play.</p>
                  </div>
                </div>
                <div className="section-actions">
                  <button type="button" onClick={handleLocate} disabled={busy != null} className="btn btn-primary">
                    {busy === "locate" ? "Opening folder picker…" : "Locate game"}
                  </button>
                </div>
              </div>
              {feedback && <p className={`feedback ${feedback.kind}`} role="alert">{feedback.message}</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
