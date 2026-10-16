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

/** [2026-10-15] Who may join: approved players only, or anyone signed in. */
/** [2026-10-16] "SOLO": the host alone (solo mode); "INVITE_ONLY": approved players (allowlisted); "PUBLIC": anyone. */
export type RealmJoinPolicy = "SOLO" | "INVITE_ONLY" | "PUBLIC";

/** [2026-10-15] A player waiting for the host's approval. `displayName` is null when the account has none to show. */
export interface RealmJoinRequest {
  accountId: string;
  displayName: string | null;
  /** When the player asked (ISO-8601, UTC). */
  at: string | null;
}

/** [2026-10-15] The host's request list. `error` says why it could not be read (then `requests` is empty). */
export interface RealmJoinRequests {
  requests: RealmJoinRequest[];
  error: string | null;
}

export interface RealmHostStatus {
  state: RealmHostState;
  /** A line for the host: why the realm is restarting, why it stopped by itself, or why a request was refused. */
  notice: string | null;
  /** [2026-10-14] What kind of notice this is. A kick, ban or unban refused as "error" keeps its dialog open. */
  noticeKind: RealmHostNoticeKind;
  realm: {
    name: string;
    serving: boolean;
    /** [2026-10-15] Who may join now; "" when the server did not say. */
    joinPolicy: RealmJoinPolicy | "";
    /** [2026-10-15] Players waiting for the host's approval. */
    joinRequestCount: number;
  } | null;
  /** [2026-10-16] The server said this account hosts no realm yet: the panel offers to create it (realmHostCreate). */
  noRealm: boolean;
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

/** [2026-10-15] The players waiting for the host (GET /launcher/v1/realms/mine/requests). A refusal is `error`, not a rejection. */
export function realmHostJoinRequests(): Promise<RealmJoinRequests> {
  return invoke<RealmJoinRequests>("realm_host_join_requests");
}

/** [2026-10-15] Approves a waiting player: they become a member and the request goes. Answers the whole status. */
export function realmHostApproveRequest(accountId: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_approve_request", { accountId });
}

/** [2026-10-15] Denies a waiting player: the request goes; they may ask again. Answers the whole status. */
export function realmHostDenyRequest(accountId: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_deny_request", { accountId });
}

/**
 * [2026-10-16] Invites a player by launcher username; they join once they accept in their own launcher (a player who had asked
 * to join is let in at once). The notice names them; a name nobody has is an error notice.
 */
export function realmHostInvitePlayer(username: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_invite_player", { username });
}

/** [2026-10-16] Withdraws an invite the player has not answered. A refusal comes back as the status's error notice. */
export function realmHostCancelInvite(accountId: string): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_cancel_invite", { accountId });
}

/** [2026-10-16] One allowed player (`at` = when they joined) or one unanswered invite (`at` = when it was sent). */
export interface RealmPerson {
  accountId: string;
  displayName: string | null;
  at: string | null;
}

/** [2026-10-16] The host's allowed players and unanswered invites. A failed read is `error`, with both lists empty. */
export interface RealmPeople {
  members: RealmPerson[];
  invites: RealmPerson[];
  error: string | null;
}

export function realmHostPeople(): Promise<RealmPeople> {
  return invoke<RealmPeople>("realm_host_people");
}

/** [2026-10-15] Sets who may join (the realm's join policy). Answers the whole status. */
export function realmHostSetJoinPolicy(joinPolicy: RealmJoinPolicy): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_set_join_policy", { joinPolicy });
}

/**
 * [2026-10-16, owner] Creates this account's realm, named after its username ("MysticFox's Realm"), and adds it to the server list.
 * A refusal (no username yet, a name already taken) comes back as the status's error notice.
 */
export function realmHostCreate(joinPolicy: RealmJoinPolicy): Promise<RealmHostStatus> {
  return invoke<RealmHostStatus>("realm_host_create", { joinPolicy });
}
