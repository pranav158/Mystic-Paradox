import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

export type LauncherUpdate = Update;

/**
 * [2026-10-15] Why the launcher's own update must wait right now (a game runs, or this PC hosts a realm or a session), or
 * null. Installing restarts the launcher, which closes a game it started and ends what this PC hosts.
 */
export async function launcherUpdateHoldReason(): Promise<string | null> {
  return (await invoke<string | null>("launcher_update_hold_reason")) ?? null;
}

/** [2026-10-15] About -> Runtime: the installed runtime DLL against the signed release for `channel` (read-only). */
export interface RuntimeVerification {
  verified: boolean;
  reason?: string | null;
  version?: string | null;
}

export async function verifyInstalledRuntime(channel: string): Promise<RuntimeVerification> {
  return invoke<RuntimeVerification>("verify_installed_runtime", { channel });
}

export async function checkLauncherUpdate(): Promise<LauncherUpdate | null> {
  return check({ timeout: 15_000 });
}

export async function installLauncherUpdate(update: LauncherUpdate): Promise<void> {
  // On Windows the NSIS updater (installMode "passive") downloads, then CLOSES and RE-OPENS the app
  // itself as part of the install. Calling relaunch() right after races that: the app restarts the
  // OLD version while the passive installer is mid-swap, so the installer aborts and nothing changes
  // ("installer flashes for a moment, then nothing"). Let downloadAndInstall own the close+reopen on
  // Windows; only relaunch on non-Windows platforms, where the installer does not restart the app.
  await update.downloadAndInstall();

  const isWindows =
    (typeof navigator !== "undefined" &&
      (navigator.userAgent.includes("Windows") || navigator.platform?.startsWith("Win"))) ??
    false;
  if (!isWindows) {
    await relaunch();
  }
}
