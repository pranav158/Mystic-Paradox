/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { useState } from "react";
import { checkPublicBuilds, type PublicBuildCheck as FileCheck, type PublicBuildReport, type PublicBuildStatus } from "../api/tauri";
import { Button } from "./Button";

// [2026-10-15] About -> "Check against GitHub": the installed launcher, runtime loader and co-op transport compared with the
// public repository's release builds by SHA-256 (commands/provenance.rs). It contacts GitHub only on the button press.

const STATUS: Record<PublicBuildStatus, { text: string; tone: string }> = {
  match: { text: "Matches", tone: "good" },
  differs: { text: "Differs", tone: "bad" },
  notPublished: { text: "No public build", tone: "warn" },
  missing: { text: "Not installed", tone: "" },
  operatorBuild: { text: "Operator build", tone: "" },
  unavailable: { text: "Not checked", tone: "warn" },
};

function short(hash?: string | null): string {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : "—";
}

function Row({ file }: { file: FileCheck }) {
  const status = STATUS[file.status] ?? STATUS.unavailable;
  const showPublished = file.publishedSha256 && file.status !== "match";
  return (
    <li className="build-check-row" data-status={file.status}>
      <div className="build-check-head">
        <span className="grow">
          {file.label}
          <span className="sub">{file.name}{file.release ? ` · ${file.release}` : ""}</span>
        </span>
        <span className={`chip ${status.tone}`.trim()}>{status.text}</span>
      </div>
      <p className="section-desc">{file.note}</p>
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
  const [state, setState] = useState<"idle" | "checking" | "done" | "failed">("idle");
  const [report, setReport] = useState<PublicBuildReport | null>(null);

  async function run() {
    setState("checking");
    try {
      setReport(await checkPublicBuilds());
      setState("done");
    } catch {
      setState("failed");
    }
  }

  const launcherPath = report?.files.find((file) => file.name === "launcher.exe")?.path;
  return (
    <div className="section">
      <p className="section-desc">
        Compare this launcher and the game&apos;s runtime loader and co-op transport with the builds GitHub made from the
        public source. Pressing the button contacts GitHub; nothing is changed.
      </p>
      <div>
        <Button variant="secondary" onClick={run} loading={state === "checking"}>
          {state === "checking" ? "Checking…" : report ? "Check again" : "Check against GitHub"}
        </Button>
      </div>
      {state === "failed" && <p className="section-desc" role="alert">The check could not run. Try again.</p>}
      {report && state !== "checking" && (
        <>
          <ul className="build-check-list" aria-label="Build check results">
            {report.files.map((file) => (
              <Row key={file.name} file={file} />
            ))}
          </ul>
          <p className="section-desc">
            A launcher can only vouch for itself. To check without it, run{" "}
            <code>gh attestation verify &quot;{launcherPath ?? "launcher.exe"}&quot; --repo {report.repository}</code>{" "}
            (GitHub CLI), which confirms the file was built by the public repository&apos;s release workflow.
          </p>
        </>
      )}
    </div>
  );
}
