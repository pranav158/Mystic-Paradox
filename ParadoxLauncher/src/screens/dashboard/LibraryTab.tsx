import { useCallback, useEffect, useRef, useState } from "react";
import { getInstallStatus, pickInstallPath, installRuntimeUpdate, type InstallStatus } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { LibraryIcon } from "../../components/icons";

export function LibraryTab() {
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await getInstallStatus();
      if (mountedRef.current) setInstall(status);
    } catch {
      // leave install as-is
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRepair = useCallback(async () => {
    setBusy(true);
    try {
      // Missing/corrupt runtime DLLs are downloadable from the signed runtime channel. Fetch them,
      // then re-check so the status reflects the repair (fixes "DLLs missing, can't play" + a Verify
      // button that previously only re-checked without ever repairing).
      await installRuntimeUpdate("stable");
    } catch {
      // Fall through to refresh; any remaining problem is shown in the status below.
    } finally {
      try {
        const status = await getInstallStatus();
        if (mountedRef.current) setInstall(status);
      } catch { /* leave install as-is */ }
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const handleLocate = useCallback(async () => {
    setBusy(true);
    try {
      const status = await pickInstallPath();
      if (mountedRef.current) setInstall(status);
    } catch {
      // user cancelled or error — leave current state
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const located = install?.located === true;
  const hasError = install?.error != null;

  return (
    <div className="px-8 py-7">
      <h1 className="text-xl font-semibold tracking-tight text-text">Library</h1>
      <p className="mt-1 text-[13px] text-text-muted">Manage your Dauntless installation.</p>

      {located ? (
        <div className="mt-7 space-y-4">
          <div className="rounded-2xl border border-border bg-surface p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">Dauntless-Win64-Shipping.exe</p>
                <p className="mt-1 break-all text-[13px] text-text-muted">{install?.exePath}</p>
              </div>
              {hasError && (
                <span className="shrink-0 rounded-md bg-danger-muted px-2.5 py-1 text-[12px] font-medium text-danger">
                  Issues found
                </span>
              )}
              {!hasError && install?.exeSha256 && (
                <span className="shrink-0 rounded-md bg-accent-faint px-2.5 py-1 text-[12px] font-medium text-accent-hover">
                  Verified
                </span>
              )}
            </div>

            <div className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[13px]">
              <span className="text-text-faint">SHA-256</span>
              <span className="font-mono text-text-muted">
                {install?.exeSha256 ? `${install.exeSha256.slice(0, 16)}…${install.exeSha256.slice(-16)}` : "—"}
              </span>

              <span className="text-text-faint">Runtime DLLs</span>
              <span className={hasError ? "text-text-muted" : "text-online"}>
                {install?.exeSha256 ? (hasError ? "Failed" : "Present") : "—"}
              </span>

              {hasError && (
                <>
                  <span className="text-text-faint">Status</span>
                  <span className="text-danger">{sanitizeError(install?.error)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {hasError && (
              <button
                onClick={handleRepair}
                disabled={busy}
                className="rounded-lg border border-accent-muted bg-accent-muted/30 px-4 py-2 text-[13px] font-medium text-accent-hover transition-all hover:bg-accent-muted/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Downloading…" : "Download runtime DLLs"}
              </button>
            )}
            <button
              onClick={handleLocate}
              disabled={busy}
              className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-[13px] font-medium text-text transition-all hover:bg-surface active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Locate again
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-7 flex flex-col items-center rounded-2xl border border-dashed border-border px-8 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-surface-raised text-text-faint">
            <LibraryIcon className="h-5 w-5" />
          </div>
          <p className="mt-4 text-sm font-medium text-text">No trail to follow yet</p>
          <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-text-muted">
            Point the launcher at your Dauntless 1.12.0 installation and it will verify every file before you set sail.
          </p>
          <button
            onClick={handleLocate}
            disabled={busy}
            className="mt-5 rounded-lg border border-accent-muted bg-accent-muted/30 px-4 py-2 text-[13px] font-medium text-accent-hover transition-all hover:bg-accent-muted/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Opening…" : "Locate game"}
          </button>
        </div>
      )}
    </div>
  );
}
