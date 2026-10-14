import { invoke } from "@tauri-apps/api/core";

// [2026-10-14 realms hub design 6.2] The launcher's realm host commands (src-tauri/src/p2p/realm.rs). Every command
// answers the whole refreshed status. A refusal (memory, a bad limit, a player id) comes back as the status's `notice`,
// not as a rejected call; a rejected call means the IPC itself failed. This file lives in src/p2p so a build without that
// folder has no host commands at all.

export type RealmHostState = "stopped" | "starting" | "online" | "restarting" | "stopping";

export interface RealmHostLimits {
  /** 1 to 64. */
  maxPlayers: number;
  /** 1 to 8. The realm's Ramsgate and Training count, and so does every hunt. */
  maxServers: number;
  /** Seconds before an idle player is removed. 0 = never, null = the launcher's default. */
  afkSeconds: number | null;
}

export type RealmHostPlaceKind = "HUB" | "TRAINING" | "HUNT";

export interface RealmHostPlace {
  kind: RealmHostPlaceKind;
  sessionId: string;
  huntId: string | null;
}

export interface RealmHostPlayer {
  accountId: string;
  displayName: string | null;
  where: RealmHostPlace;
  since: string | null;
  route: string | null;
}

export interface RealmHostBan {
  accountId: string;
  displayName: string | null;
  reason: string | null;
  at: string | null;
}

export interface RealmHostHub {
  sessionId: string;
  state: string;
  startedAt: string | null;
  players: number;
}

export interface RealmHostTraining {
  sessionId: string;
  state: string;
  players: number;
}

export interface RealmHostHunt {
  sessionId: string;
  huntId: string;
  state: string;
  players: number;
}

export interface RealmHostCapacity {
  maxPlayers: number;
  maxServers: number;
  activeServers: number;
  afkSeconds: number | null;
  freeMemMiB: number;
  totalMemMiB: number;
}

/** `info` tells the host what happened; `error` is a refusal or failure (shown in the error style). */
export type RealmHostNoticeKind = "info" | "error";

export interface RealmHostStatus {
  state: RealmHostState;
  /** A line for the host: why the realm is restarting, why it stopped by itself, or why a request was refused. */
  notice: string | null;
  /** [2026-10-14] What kind of notice this is. A kick, ban or unban refused as "error" keeps its dialog open. */
  noticeKind: RealmHostNoticeKind;
  realm: { name: string; serving: boolean } | null;
  hub: RealmHostHub | null;
  training: RealmHostTraining | null;
  hunts: RealmHostHunt[];
  players: RealmHostPlayer[];
  bans: RealmHostBan[];
  capacity: RealmHostCapacity;
}

export function realmHostStatus(): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_status");
}

export function realmHostStart(options: RealmHostLimits): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_start", { options });
}

export function realmHostStop(): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_stop");
}

export function realmHostKick(accountId: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_kick", { accountId });
}

/** `reason` is null when the host gave none. */
export function realmHostBan(accountId: string, reason: string | null): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_ban", { accountId, reason });
}

export function realmHostUnban(accountId: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_unban", { accountId });
}

export function realmHostSetLimits(options: RealmHostLimits): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_set_limits", { options });
}
