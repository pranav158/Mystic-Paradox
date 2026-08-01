import { useCallback, useEffect, useState } from "react";
import { SettingsIcon } from "../../components/icons";
import { Button } from "../../components/Button";
import { usePolicy } from "../../policy/PolicyContext";
import { getLogPaths, openLogFolder, uploadLastSession } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import type { LogPaths } from "../../api/types";

type UploadState = { status: "idle" } | { status: "uploading" } | { status: "done"; count: number } | { status: "error"; message: string };

export function SettingsTab() {
  const { policy } = usePolicy();
  const isTester = policy?.roles.includes("tester") ?? false;
  const [paths, setPaths] = useState<LogPaths | null>(null);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const handleCopyPath = useCallback(() => {
    if (!paths) return;
    void navigator.clipboard.writeText(paths.sessionsRoot).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [paths]);

  const handleOpenFolder = useCallback(() => {
    void openLogFolder().catch(() => {});
  }, []);

  const handleUpload = useCallback(async () => {
    setUpload({ status: "uploading" });
    try {
      const count = await uploadLastSession();
      setUpload({ status: "done", count });
      void refreshPaths();
    } catch (err) {
      setUpload({ status: "error", message: sanitizeError(err instanceof Error ? err.message : String(err)) });
    }
  }, [refreshPaths]);

  return (
    <div className="max-w-lg px-8 py-7">
      <h1 className="text-xl font-semibold tracking-tight text-text">Settings</h1>
      <p className="mt-1 text-[13px] text-text-muted">Tune the launcher to your liking.</p>

      <section className="mt-7 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-raised text-text-faint">
            <SettingsIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">Diagnostics &amp; logs</p>
            <p className="mt-0.5 text-xs text-text-muted">Each Play attempt writes its own session folder.</p>
          </div>
        </div>

        <div className="px-6 py-4">
          {pathsError ? (
            <p className="text-[13px] text-danger">{pathsError}</p>
          ) : (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Log folder</p>
              <p className="mt-1 truncate font-mono text-[11px] text-text-muted" title={paths?.sessionsRoot}>
                {paths?.sessionsRoot ?? "Loading…"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" className="w-auto px-4" onClick={handleCopyPath} disabled={!paths}>
                  {copied ? "Copied" : "Copy path"}
                </Button>
                <Button variant="secondary" className="w-auto px-4" onClick={handleOpenFolder} disabled={!paths}>
                  Open folder
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-border px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Last session</p>
          <p className="mt-1 text-[13px] text-text-muted">
            {paths?.latestSessionDir ? "A recorded Play attempt is available to upload." : "No Play attempts recorded yet."}
          </p>

          {isTester ? (
            <>
              <Button
                variant="secondary"
                className="mt-3 w-auto px-4"
                onClick={() => void handleUpload()}
                disabled={upload.status === "uploading" || !paths?.latestSessionDir}
              >
                {upload.status === "uploading" ? "Uploading…" : "Upload last session"}
              </Button>
              {upload.status === "done" && (
                <p className="mt-2 text-[13px] text-online">
                  Uploaded {upload.count} file{upload.count === 1 ? "" : "s"}.
                </p>
              )}
              {upload.status === "error" && <p className="mt-2 text-[13px] text-danger">{upload.message}</p>}
            </>
          ) : (
            <p className="mt-3 text-[13px] text-text-faint">Log upload is available to tester accounts.</p>
          )}
        </div>
      </section>
    </div>
  );
}
