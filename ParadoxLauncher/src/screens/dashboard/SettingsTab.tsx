import { useCallback, useEffect, useState, type ComponentType, type CSSProperties } from "react";
import { usePolicy } from "../../policy/PolicyContext";
import { getLogPaths, onLogUploadProgress, openLogFolder, uploadLogs } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { setUiPrefs, useUiPrefs, type SidebarMode, type UiScale } from "../../lib/prefs";
import type { LogPaths, LogUploadProgress, LogUploadReport } from "../../api/types";
import { CopyIcon, FolderIcon, SidebarIcon, SparkIcon, UploadIcon, ZoomIcon } from "../../components/icons";
import { ArtBackdrop } from "../../components/ArtBackdrop";

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: LogUploadProgress | null }
  | { status: "done"; report: LogUploadReport }
  | { status: "error"; message: string };

/** What "Upload logs" sends (launch/log_upload.rs on the native side). */
const UPLOAD_CONTENTS = [
  "The launcher log and the session details of your newest Play session.",
  "The game's own log for that session (the newest 8 MB at most).",
  "The logs of the newest game servers you host (up to 4, the newest 8 MB of each). They name the players in your realm and what they did in the game.",
  "Connection logs (transport, host and join) and the realm host log.",
  "The game's settings files (Game.ini, Engine.ini, GameUserSettings.ini).",
  "A list of what was sent and left out.",
];
type Feedback = { kind: "ok" | "bad"; message: string };

const UI_SIZES: { id: UiScale; label: string }[] = [
  { id: 0.85, label: "Small" },
  { id: 0.92, label: "Medium" },
  { id: 1, label: "Large" },
];

const SIDEBAR_MODES: { id: SidebarMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "expanded", label: "Expanded" },
  { id: "compact", label: "Compact" },
];

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

// Extra cards of an optional launcher module (src/p2p/*Card.tsx, absent from the dedicated-only build).
const OPTIONAL_CARDS = Object.values(
  import.meta.glob<{ default: ComponentType<{ style: CSSProperties }> }>("../../p2p/*Card.tsx", { eager: true }),
).map((module) => module.default);

export function SettingsTab() {
  const { policy } = usePolicy();
  const prefs = useUiPrefs();
  const isTester = policy?.roles.includes("tester") ?? false;
  const [paths, setPaths] = useState<LogPaths | null>(null);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null);
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });

  const refreshPaths = useCallback(async () => {
    try {
      setPaths(await getLogPaths());
      setPathsError(null);
    } catch (err) {
      setPathsError(sanitizeError(err instanceof Error ? err.message : String(err)));
    }
  }, []);

  useEffect(() => {
    void refreshPaths();
  }, [refreshPaths]);

  const handleCopyPath = useCallback(async () => {
    if (!paths) return;
    try {
      await navigator.clipboard.writeText(paths.sessionsRoot);
      setActionFeedback({ kind: "ok", message: "Log folder path copied to the clipboard." });
    } catch {
      setActionFeedback({ kind: "bad", message: "Couldn't copy the log folder path." });
    }
  }, [paths]);

  const handleOpenFolder = useCallback(async () => {
    try {
      await openLogFolder();
      setActionFeedback({ kind: "ok", message: "Opened the session log folder." });
    } catch (err) {
      setActionFeedback({ kind: "bad", message: sanitizeError(err instanceof Error ? err.message : String(err)) });
    }
  }, []);

  const handleUpload = useCallback(async () => {
    setUpload({ status: "uploading", progress: null });
    const stopListening = await onLogUploadProgress((progress) => {
      setUpload((current) => (current.status === "uploading" ? { status: "uploading", progress } : current));
    }).catch(() => null);
    try {
      const report = await uploadLogs();
      setUpload({ status: "done", report });
      void refreshPaths();
    } catch (err) {
      setUpload({ status: "error", message: sanitizeError(err instanceof Error ? err.message : String(err)) });
    } finally {
      stopListening?.();
    }
  }, [refreshPaths]);

  const sidebarIndex = SIDEBAR_MODES.findIndex((mode) => mode.id === prefs.sidebar);
  const sizeIndex = UI_SIZES.findIndex((size) => size.id === prefs.scale);
  const logsIndex = 2 + OPTIONAL_CARDS.length;

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Launcher preferences</p>
          <h1 className="page-title">Settings</h1>
          <p className="page-desc">Layout, motion and diagnostics.</p>
        </header>

        <section className="glass card reveal" style={at(1)} aria-label="Interface">
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon"><ZoomIcon /></div>
                <div>
                  <h2 className="section-title">Interface size</h2>
                  <p className="section-desc">Scales text and controls. Small matches the classic launcher density.</p>
                </div>
              </div>
              <div className="segmented" style={{ "--count": UI_SIZES.length, "--index": Math.max(sizeIndex, 0) } as CSSProperties} role="group" aria-label="Interface size">
                <span className="segmented-thumb" aria-hidden="true" />
                {UI_SIZES.map((size) => (
                  <button key={size.id} type="button" aria-pressed={prefs.scale === size.id} onClick={() => setUiPrefs({ scale: size.id })}>
                    {size.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon"><SidebarIcon /></div>
                <div>
                  <h2 className="section-title">Sidebar layout</h2>
                  <p className="section-desc">Auto switches to icons only when the window is narrow.</p>
                </div>
              </div>
              <div className="segmented" style={{ "--count": SIDEBAR_MODES.length, "--index": Math.max(sidebarIndex, 0) } as CSSProperties} role="group" aria-label="Sidebar layout">
                <span className="segmented-thumb" aria-hidden="true" />
                {SIDEBAR_MODES.map((mode) => (
                  <button key={mode.id} type="button" aria-pressed={prefs.sidebar === mode.id} onClick={() => setUiPrefs({ sidebar: mode.id })}>
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon"><SparkIcon /></div>
                <div>
                  <h2 className="section-title">Reduce motion</h2>
                  <p className="section-desc">Turns off drifting art, glows and page animations. Windows' own reduce-motion setting is always respected.</p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={prefs.motion === "reduced"}
                aria-label="Reduce motion"
                onClick={() => setUiPrefs({ motion: prefs.motion === "reduced" ? "full" : "reduced" })}
              />
            </div>
          </div>
        </section>

        {OPTIONAL_CARDS.map((Card, index) => <Card key={index} style={at(2 + index)} />)}

        <section className="glass card reveal" style={at(logsIndex)} aria-label="Diagnostics and logs">
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon"><FolderIcon /></div>
                <div className="min-w-0">
                  <h2 className="section-title">Session logs</h2>
                  {pathsError
                    ? <p className="section-desc status-bad" role="alert">{pathsError}</p>
                    : <p className="section-desc mono truncate" title={paths?.sessionsRoot}>{paths?.sessionsRoot ?? "Loading…"}</p>}
                </div>
              </div>
              <div className="section-actions">
                <button type="button" className="btn btn-secondary" onClick={() => void handleCopyPath()} disabled={!paths}>
                  <CopyIcon />Copy path
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void handleOpenFolder()} disabled={!paths}>
                  <FolderIcon />Open folder
                </button>
              </div>
            </div>
            {actionFeedback && (
              <p className={`feedback ${actionFeedback.kind}`} role={actionFeedback.kind === "bad" ? "alert" : "status"}>{actionFeedback.message}</p>
            )}
          </div>
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon"><UploadIcon /></div>
                <div className="min-w-0">
                  <h2 className="section-title">Logs</h2>
                  <p className="section-desc">
                    Sends your newest session and the logs written since it started, including the game servers you host, to the team.
                    Password- and token-like values are removed first.
                  </p>
                  <UploadResult upload={upload} />
                  {!isTester && <p className="note">Log upload is available to tester accounts.</p>}
                </div>
              </div>
              {isTester && (
                <div className="section-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleUpload()}
                    disabled={upload.status === "uploading"}
                  >
                    {upload.status === "uploading" ? <><span className="spinner" aria-hidden="true" />Uploading…</> : <><UploadIcon />Upload logs</>}
                  </button>
                </div>
              )}
            </div>
            {isTester && (
              <details className="log-contents">
                <summary>What's included</summary>
                <ul>
                  {UPLOAD_CONTENTS.map((line) => <li key={line}>{line}</li>)}
                </ul>
                <p className="note">Nothing is sent until you press Upload logs.</p>
              </details>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** The upload's progress and result: how many files went, which failed and why, and why it stopped. */
function UploadResult({ upload }: { upload: UploadState }) {
  if (upload.status === "uploading") {
    return (
      <p className="feedback" role="status">
        {upload.progress ? `Uploading ${upload.progress.index} of ${upload.progress.total}…` : "Preparing the upload…"}
      </p>
    );
  }
  if (upload.status === "error") return <p className="feedback bad" role="alert">{upload.message}</p>;
  if (upload.status !== "done") return null;
  const { report } = upload;
  const complete = report.failed.length === 0 && report.stopped === null;
  return (
    <div className="log-result">
      <p className={`feedback ${complete ? "ok" : "bad"}`} role={complete ? "status" : "alert"}>
        Uploaded {report.uploaded} of {report.total} file{report.total === 1 ? "" : "s"}
        {report.uploadKind === "host" ? " (your hosted servers; no Play session on this PC)" : ""}.
        {report.stopped ? ` Stopped: ${report.stopped}` : ""}
      </p>
      {report.failed.length > 0 && (
        <ul className="log-problems">
          {report.failed.map((problem) => (
            <li key={problem.name}>
              <span className="mono">{problem.name}</span>: {problem.reason}
            </li>
          ))}
        </ul>
      )}
      {report.skipped.length > 0 && (
        <details className="log-contents">
          <summary>{report.skipped.length} left out</summary>
          <ul className="log-problems">
            {report.skipped.map((problem) => (
              <li key={problem.name}>
                <span className="mono">{problem.name}</span>: {problem.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
