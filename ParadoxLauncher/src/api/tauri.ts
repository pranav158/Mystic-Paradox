import { invoke } from "@tauri-apps/api/core";
import type { LauncherPolicy, LogPaths } from "./types";

export interface InstallStatus {
  located: boolean;
  exePath?: string | null;
  exeSha256?: string | null;
  error?: string | null;
}

export async function getInstallStatus(): Promise<InstallStatus> {
  return invoke<InstallStatus>("get_install_status");
}

export async function pickInstallPath(): Promise<InstallStatus> {
  return invoke<InstallStatus>("pick_install_path");
}

export async function isGameRunning(): Promise<boolean> {
  return invoke<boolean>("is_game_running");
}

export async function secureLaunch(expectedChannel: string): Promise<void> {
  return invoke<void>("secure_launch", { expectedChannel });
}

export interface RuntimeUpdateStatus {
  available: boolean;
  version?: string | null;
  currentSha256?: string | null;
  latestSha256?: string | null;
  size?: number | null;
}

export async function checkRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("check_runtime_update", { channel });
}

export async function installRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("install_runtime_update", { channel });
}

export async function getPolicy(): Promise<LauncherPolicy> {
  return invoke<LauncherPolicy>("native_get_policy");
}

export async function getLogPaths(): Promise<LogPaths> {
  return invoke<LogPaths>("native_get_log_paths");
}

export async function openLogFolder(): Promise<void> {
  return invoke<void>("native_open_log_folder");
}

export async function uploadLastSession(): Promise<number> {
  return invoke<number>("native_upload_last_session");
}
