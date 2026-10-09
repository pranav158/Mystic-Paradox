import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LauncherPolicy, LogPaths, ServerStatusResponse } from "./types";
import type { SessionSummary } from "../lib/sessions";

export interface InstallStatus {
  located: boolean;
  exePath?: string | null;
  exeSha256?: string | null;
  runtimeRepairRequired: boolean;
  error?: string | null;
  /** The Dauntless changelist this launcher and its signed runtime target. */
  targetChangelist?: number;
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

/** Fires with the exit code when the game client started by this launcher exits. */
export function onGameExited(handler: (exitCode: number) => void): Promise<UnlistenFn> {
  return listen<number>("game-exited", (event) => handler(event.payload));
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

export async function getServerStatus(): Promise<ServerStatusResponse> {
  return invoke<ServerStatusResponse>("native_get_server_status");
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

/** This account's newest Play sessions on this PC, newest first. */
export async function getRecentSessions(accountId: string, limit = 5): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("native_recent_sessions", { accountId, limit });
}

