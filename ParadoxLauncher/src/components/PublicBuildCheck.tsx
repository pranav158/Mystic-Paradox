/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { checkPublicBuilds, type PublicBuildCheck as FileCheck, type PublicBuildReport, type PublicBuildStatus } from "../api/tauri";
import { verifyInstalledRuntime, type RuntimeVerification } from "../api/updates";
import { usePolicy } from "../policy/PolicyContext";
import { Button } from "./Button";
import { BuildIcon } from "./icons";

// [2026-10-15] About -> "Check against GitHub": the installed launcher, runtime loader and co-op transport compared with the
// public repository's release builds by SHA-256 (commands/provenance.rs). The launcher runs it once at startup, in the
// background (startPublicBuildCheckAtStartup, called by the app shell); the result is kept for this session, and the button
// runs it again. Nothing is changed on this PC.

const STATUS: Record<PublicBuildStatus, { text: string; tone: string }> = {
  match: { text: "Matches", tone: "good" },
  differs: { text: "Differs", tone: "bad" },
  // [2026-10-16] "Not on GitHub": there is nothing to compare with (a test build, an older release), not a mismatch.
  notPublished: { text: "Not on GitHub", tone: "warn" },
  missing: { text: "Not installed", tone: "" },
  operatorBuild: { text: "Operator build", tone: "" },
  unavailable: { text: "Not checked", tone: "warn" },
};

/** The game runtime. It has no public build, so its row shows the signed-release check instead of a hash comparison. */
const RUNTIME_FILE = "MysticParadox.dll";

// ---- the session's check: one store shared by the startup run and every About page -----------------------------------

interface CheckStore {
  status: "idle" | "checking" | "done" | "failed";
  report: PublicBuildReport | null;
}

let store: CheckStore = { status: "idle", report: null };
const listeners = new Set<() => void>();

function publish(next: CheckStore) {
  store = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function current(): CheckStore {
  return store;
}

let inFlight: Promise<void> | null = null;

/** Runs the GitHub check now (a second call while one runs joins it). The last report stays until a new one arrives. */
export function runPublicBuildCheck(): Promise<void> {
  if (inFlight) return inFlight;
  publish({ status: "checking", report: store.report });
  inFlight = checkPublicBuilds()
    .then((report) => publish({ status: "done", report }))
    .catch(() => publish({ status: "failed", report: store.report }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Called once when the launcher starts: the check runs in the background, unless it already ran this session. */
export function startPublicBuildCheckAtStartup(): void {
  if (store.status === "idle") void runPublicBuildCheck();
}

// ---- the runtime row ------------------------------------------------------------------------------------------------

type RuntimeCheck =
  | { state: "checking" }
  | { state: "unknown" }
  | { state: "done"; result: RuntimeVerification }
  | { state: "failed"; reason: string };

function RuntimeChip({ runtime }: { runtime: RuntimeCheck }) {
  if (runtime.state === "checking") return <span className="chip">Checking…</span>;
  if (runtime.state === "unknown") return <span className="chip">Not checked</span>;
  if (runtime.state === "done" && runtime.result.verified) return <span className="chip good">Verified</span>;
  return <span className="chip bad">Not verified</span>;
}

function runtimeReason(runtime: RuntimeCheck): string | null {
  if (runtime.state === "unknown") return "Sign in to check the runtime against the signed release.";
  if (runtime.state === "failed") return runtime.reason;
  if (runtime.state === "done" && !runtime.result.verified) return runtime.result.reason ?? "The installed runtime is not the signed release.";
  return null;
}

function short(hash?: string | null): string {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : "—";
}

function Row({ file, runtime }: { file: FileCheck; runtime: RuntimeCheck }) {
  const status = STATUS[file.status] ?? STATUS.unavailable;
  const isRuntime = file.name === RUNTIME_FILE;
  const reason = isRuntime ? runtimeReason(runtime) : null;
  const showPublished = file.publishedSha256 && file.status !== "match";
  return (
    <li className="build-check-row" data-status={file.status}>
      <div className="build-check-head">
        <div className="build-check-title">
          <span className="build-check-name">{file.label}</span>
          <span className="sub">{file.name}{file.release ? ` · ${file.release}` : ""}</span>
        </div>
        {isRuntime ? <RuntimeChip runtime={runtime} /> : <span className={`chip ${status.tone}`.trim()}>{status.text}</span>}
      </div>
      <p className="section-desc">{file.note}</p>
      {reason && <p className="build-check-reason" role="status">{reason}</p>}
      <dl className="build-check-hashes">
        <dt>Installed</dt>
        <dd title={file.installedSha256 ?? undefined}><code>{short(file.installedSha256)}</code></dd>
        {showPublished && (
          <>
            <dt>Published</dt>
            <dd title={file.publishedSha256 ?? undefined}><code>{short(file.publishedSha256)}</code></dd>
          </>
        )}
      </dl>
    </li>
  );
}

export function PublicBuildCheck() {
  const { status, report } = useSyncExternalStore(subscribe, current);
  // [2026-10-15] The runtime is checked against the signed manifest of this account's channel.
  const { policy } = usePolicy();
  const channel = policy?.channel ?? null;
  const [round, setRound] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeCheck>({ state: "checking" });

  useEffect(() => {
    if (!channel) {
      setRuntime({ state: "unknown" });
      return;
    }
    let cancelled = false;
    setRuntime({ state: "checking" });
    verifyInstalledRuntime(channel)
      .then((result) => {
        if (!cancelled) setRuntime({ state: "done", result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntime({
            state: "failed",
            reason: typeof error === "string" && error.trim() ? error : "The runtime could not be checked. Try again.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel, round]);

  const launcherPath = report?.files.find((file) => file.name === "launcher.exe")?.path;
  const busy = status === "checking";

  // [2026-10-16] The header is the section row every other card uses (icon, title and description, the button on the
  // right); the results are a second section under it.
  return (
    <>
      <div className="section">
        <div className="section-row">
          <div className="section-head">
            <div className="section-icon"><BuildIcon /></div>
            <div className="min-w-0">
              <h2 className="section-title">Check this build</h2>
              <p className="section-desc">
                Compares this launcher, the runtime loader and the co-op transport with the builds GitHub made from the
                public source. The launcher checks at startup, in the background. Nothing is changed.
              </p>
            </div>
          </div>
          <div className="section-actions">
            <Button
              variant="secondary"
              loading={busy}
              loadingLabel="Checking…"
              onClick={() => {
                setRound((count) => count + 1);
                void runPublicBuildCheck();
              }}
            >
              {report ? "Check again" : "Check against GitHub"}
            </Button>
          </div>
        </div>
        {status === "failed" && <p className="feedback bad" role="alert">The check could not run. Try again.</p>}
      </div>
      {report && !busy && (
        <div className="section">
          <ul className="build-check-list" aria-label="Build check results">
            {report.files.map((file) => (
              <Row key={file.name} file={file} runtime={runtime} />
            ))}
          </ul>
          <p className="note">
            A launcher can only vouch for itself. To check without it, run{" "}
            <code>gh attestation verify &quot;{launcherPath ?? "launcher.exe"}&quot; --repo {report.repository}</code>{" "}
            (GitHub CLI), which confirms the file was built by the public repository&apos;s release workflow.
          </p>
        </div>
      )}
    </>
  );
}
