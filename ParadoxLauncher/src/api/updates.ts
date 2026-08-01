import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type LauncherUpdate = Update;

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
