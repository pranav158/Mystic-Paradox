import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LauncherNotices, LauncherPolicy, LogPaths, OfficialPlay, ServerStatusResponse, UsernameAvailabilityResponse } from "./types";
import type { SessionSummary } from "../lib/sessions";

/** [2026-10-13 realms S1] The three kinds of server the launcher can play on. */
export type ServerKind = "official" | "paradox_realm" | "local";

export interface InstallStatus {
  located: boolean;
  exePath?: string | null;
  exeSha256?: string | null;
  runtimeRepairRequired: boolean;
  error?: string | null;
  /** The Dauntless changelist this launcher and its signed runtime target. */
  targetChangelist?: number;
  /** Which server this status describes: the selected one unless a call named another. Absent = official. */
  serverId?: string;
  serverKind?: ServerKind;
  serverName?: string;
  /** Set when Play is off for this server whatever its installation holds (a local server whose warning is not accepted). */
  playBlockedReason?: string | null;
  /** False when the realm's own runtime files are used and the launcher neither checks nor updates them. */
  runtimeManaged?: boolean;
}

/** The selected server's installation, or `serverId`'s. */
export async function getInstallStatus(serverId?: string): Promise<InstallStatus> {
  return invoke<InstallStatus>("get_install_status", { serverId });
}

/**
 * Opens the folder picker for the selected server, or for `serverId`. A cancelled dialog changes nothing. A Paradox realm
 * with no folder of its own runs from the official install, so its picker locates that install; `ownFolder` makes the
 * picked folder the realm's own instead.
 */
export async function pickInstallPath(serverId?: string, ownFolder?: boolean): Promise<InstallStatus> {
  return invoke<InstallStatus>("pick_install_path", { serverId, ownFolder });
}

export interface ServerView {
  id: string;
  kind: ServerKind;
  name: string;
  /** Local servers: `scheme://host[:port]`. */
  backendUrl?: string | null;
  /** Paradox realms: the realm's directory name. */
  realmName?: string | null;
  gameExePath?: string | null;
  /** Where the folder comes from: the server's own, the official install (a realm with no folder of its own), or none. */
  folderSource: "own" | "official" | "none";
  /** The game executable the server runs from (its own, or the official install's), when it has one. */
  folder?: string | null;
  /**
   * [2026-10-14 realms] Paradox realms: the host key the player agreed to. Absent until the host is confirmed; Play
   * needs it. The key itself is not a secret; the UI shows its short fingerprint.
   */
  hostPublicKey?: string | null;
  /** The server Play, the updater and the install check work on. */
  selected: boolean;
  /** Everything but the built-in official server. */
  removable: boolean;
  /** The game executable exists on disk. */
  located: boolean;
  /** Our signed runtime feed serves this server (false: the realm's own files). */
  usesOfficialFeed: boolean;
  playBlockedReason?: string | null;
  /** Why the saved folder cannot be used (for example it is the official install). */
  folderProblem?: string | null;
  /**
   * [2026-10-13 realms S5] The LOCAL SERVER WARNING was accepted for this launcher run, or remembered. Always true for
   * a server that has no such warning. Nothing is sent to a local server before this.
   */
  acknowledged: boolean;
  /** "Don't show again" is saved for this server. */
  warningRemembered: boolean;
}

export interface NewServerRequest {
  kind: "paradox_realm" | "local";
  name?: string;
  backendUrl?: string;
  realmName?: string;
}

export async function listServers(): Promise<ServerView[]> {
  return invoke<ServerView[]>("list_servers");
}

/** Rejects with a readable validation message. Resolves with the refreshed list. */
export async function addServer(server: NewServerRequest): Promise<ServerView[]> {
  return invoke<ServerView[]>("add_server", { server });
}

export async function removeServer(serverId: string): Promise<ServerView[]> {
  return invoke<ServerView[]>("remove_server", { serverId });
}

export async function selectServer(serverId: string): Promise<ServerView[]> {
  return invoke<ServerView[]>("select_server", { serverId });
}

/**
 * The player's "I agree" in a local server's warning. `remember` is the "Don't show again" box: ticked it is saved for
 * this server, clear it only lasts for this launcher run. Resolves with the refreshed list.
 */
export async function acknowledgeLocalServer(serverId: string, remember: boolean): Promise<ServerView[]> {
  return invoke<ServerView[]>("acknowledge_local_server", { serverId, remember });
}

/** `path` is the game executable or the folder that holds it. */
export async function setServerGameExe(serverId: string, path: string): Promise<ServerView[]> {
  return invoke<ServerView[]>("set_server_game_exe", { serverId, path });
}

/** A Paradox realm gives up its own folder and runs from the official install again. Resolves with the refreshed list. */
export async function useOfficialInstall(serverId: string): Promise<ServerView[]> {
  return invoke<ServerView[]>("use_official_install", { serverId });
}

/**
 * [2026-10-14 realms] What the realm directory says about a Paradox realm's host. With a host key stored,
 * `ownershipChanged` says whether the realm's name now belongs to a different key. Needs the official sign-in.
 */
export interface RealmLookup {
  name: string;
  hostName?: string | null;
  hostPublicKey: string;
  /** The short form of the key, for the player to compare. */
  fingerprint: string;
  online: boolean;
  serving: boolean;
  ownershipChanged: boolean;
  /** [2026-10-16] The player may enter (a member, or the host). */
  member?: boolean;
  /** [2026-10-16] The player's join request waits for the host. */
  requested?: boolean;
  /** [2026-10-16] The host invited the player and the player has not answered. */
  invited?: boolean;
  /** [2026-10-16] The player is this realm's host. */
  own?: boolean;
  /** [2026-10-16] Who may join: "PUBLIC" (anyone signed in; Play joins) or "INVITE_ONLY", when the directory says. */
  joinPolicy?: string | null;
}

export async function realmLookup(serverId: string): Promise<RealmLookup> {
  return invoke<RealmLookup>("realm_lookup", { serverId });
}

/** [2026-10-16] A realm invite the signed-in player has not answered. */
export interface RealmInvite {
  realmName: string;
  hostName: string | null;
  at: string | null;
  online: boolean;
}

/** [2026-10-16] The realm invites the signed-in player has not answered (needs the official sign-in). */
export async function realmInvites(): Promise<RealmInvite[]> {
  return invoke<RealmInvite[]>("realm_invites");
}

/** [2026-10-16] Accepts or declines a realm invite. After an accept, add the realm to the list with addServer. */
export async function realmAnswerInvite(realmName: string, accept: boolean): Promise<void> {
  return invoke<void>("realm_answer_invite", { realmName, accept });
}

/** [2026-10-16] MEMBER: the player may enter now. REQUESTED: the request waits for the host. */
export type RealmJoinAnswer = "MEMBER" | "REQUESTED";

/** [2026-10-16] Asks to join a Paradox realm in the list (sent when it is added, and from its row). */
export async function realmRequestJoin(serverId: string): Promise<RealmJoinAnswer> {
  return invoke<RealmJoinAnswer>("realm_request_join", { serverId });
}

/** Stores the host key the player agreed to for a Paradox realm. Resolves with the refreshed list. */
export async function setRealmHostKey(serverId: string, hostPublicKey: string): Promise<ServerView[]> {
  return invoke<ServerView[]>("set_realm_host_key", { serverId, hostPublicKey });
}

/**
 * [2026-10-14 realms] Play was refused because the realm's name now belongs to another host (REALM_OWNER_CHANGED), or
 * because the realm has no host key yet (REALM_HOST_KEY_REQUIRED). The native side answers these exact tokens.
 */
export const REALM_OWNER_CHANGED = "REALM_OWNER_CHANGED";
export const REALM_HOST_KEY_REQUIRED = "REALM_HOST_KEY_REQUIRED";
/** [2026-10-15] Play asked the realm's host for approval (invite-only, no invite): information, not a failure. */
export const REALM_JOIN_REQUESTED = "REALM_JOIN_REQUESTED";

/** A member's realm session ended for a reason worth a banner. The game keeps running. */
export interface RealmNotice {
  reason: "HOST_OFFLINE" | "KICKED" | "BANNED";
  message: string;
}

/** Fires when a realm this player is in ends for them (the host went offline, or they were removed or banned). */
export function onRealmNotice(handler: (notice: RealmNotice) => void): Promise<UnlistenFn> {
  return listen<RealmNotice>("realm-notice", (event) => handler(event.payload));
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
  /** False for a local server: its runtime files are the realm's own and the launcher does not update them. */
  feedManaged?: boolean;
}

export async function checkRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("check_runtime_update", { channel });
}

export async function installRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("install_runtime_update", { channel });
}

/** The selected server's policy. `serverId` is the server the screen shows: a different selection is refused. */
export async function getPolicy(serverId?: string): Promise<LauncherPolicy> {
  return invoke<LauncherPolicy>("native_get_policy", { serverId });
}

/** The selected server's backend status (`/launcher/v1/status` of that server, never of another). */
export async function getServerStatus(serverId?: string): Promise<ServerStatusResponse> {
  return invoke<ServerStatusResponse>("native_get_server_status", { serverId });
}

/**
 * [2026-10-15] The official server's play switch, read from its own status whatever server is selected. It rejects when
 * the status cannot be read; the caller then shows no note (the official server is not marked unavailable).
 */
export async function getOfficialPlay(): Promise<OfficialPlay> {
  return invoke<OfficialPlay>("native_official_play");
}

/**
 * [2026-10-15] The launcher notices from the official backend. No sign-in. Rejects only when the backend cannot be
 * reached; any other answer (including none, from an older backend) is an answer with no notices.
 */
export async function getLauncherNotices(): Promise<LauncherNotices> {
  return invoke<LauncherNotices>("native_launcher_notices");
}

/** Whether a username is free on the selected server (a local server's usernames are its own). */
export async function checkUsername(name: string, serverId?: string): Promise<UsernameAvailabilityResponse> {
  return invoke<UsernameAvailabilityResponse>("native_check_username", { serverId, name });
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


// [2026-10-14] The Terms of Use and Privacy Policy, and account deletion. They belong to Mystic Paradox accounts (the
// official server and Paradox realms): the native side refuses them for a local server, which keeps its own accounts.

export interface LegalRequirements {
  termsVersion: string;
  privacyVersion: string;
  minimumAge: number;
}

export interface ConsentRecord {
  termsVersion: string;
  privacyVersion: string;
  ageConfirmed: boolean;
  acceptedAt: string;
}

export interface ConsentStatus {
  /** False when the backend has no consent routes: nothing is asked and no gate is shown. */
  supported: boolean;
  required: LegalRequirements | null;
  accepted: ConsentRecord | null;
  /** The accepted versions are the current ones. */
  upToDate: boolean;
}

export interface DeletionRequest {
  requestedAt: string;
  /** The day the account is deleted for good (ISO 8601). */
  scheduledFor: string;
}

export interface DeletionStatus {
  /** False when the backend has no deletion route: nothing is offered. */
  supported: boolean;
  holdDays: number;
  /** Set while the account is deactivated and waiting for its deletion. */
  request: DeletionRequest | null;
}

/** What a registration carries: the player ticked both boxes. */
export interface ConsentInput {
  termsVersion: string;
  privacyVersion: string;
  ageConfirmed: true;
}

/** The selected server's consent state (the official backend's). */
export async function getConsentStatus(serverId?: string): Promise<ConsentStatus> {
  return invoke<ConsentStatus>("native_consent_status", { serverId });
}

/** Records the player's acceptance of these versions. Rejects with a readable message (an outdated launcher, for one). */
export async function acceptConsent(termsVersion: string, privacyVersion: string, serverId?: string): Promise<ConsentStatus> {
  return invoke<ConsentStatus>("native_accept_consent", { serverId, termsVersion, privacyVersion, ageConfirmed: true });
}

export async function getDeletionStatus(serverId?: string): Promise<DeletionStatus> {
  return invoke<DeletionStatus>("native_deletion_status", { serverId });
}

/** Deactivates the account at once and schedules its deletion. `confirmUsername` must be the account's username. */
export async function requestAccountDeletion(confirmUsername: string, serverId?: string): Promise<DeletionStatus> {
  return invoke<DeletionStatus>("native_request_deletion", { serverId, confirmUsername });
}

/** Restores a deactivated account while its 30-day hold lasts. */
export async function cancelAccountDeletion(serverId?: string): Promise<DeletionStatus> {
  return invoke<DeletionStatus>("native_cancel_deletion", { serverId });
}

// ---- [2026-10-15] About -> "Check against GitHub" ----

export type PublicBuildStatus = "match" | "differs" | "notPublished" | "missing" | "operatorBuild" | "unavailable";

/** One installed file compared with the public repository's release build (commands/provenance.rs). */
export interface PublicBuildCheck {
  name: string;
  label: string;
  /** The installed file's full path, for checking it by hand. */
  path?: string | null;
  installedSha256?: string | null;
  publishedSha256?: string | null;
  /** The release tag the published hash comes from. */
  release?: string | null;
  status: PublicBuildStatus;
  note: string;
}

export interface PublicBuildReport {
  /** The public repository (owner/name). */
  repository: string;
  launcherVersion: string;
  files: PublicBuildCheck[];
}

/** Compares this launcher, the runtime loader and the co-op transport with the public release builds. Contacts GitHub. */
export async function checkPublicBuilds(): Promise<PublicBuildReport> {
  return invoke<PublicBuildReport>("check_public_builds");
}

/** [2026-10-16] "official" (built by the official release with its build profile), "unofficial" (any other release build) or
 * "development" (a debug build). A courtesy label for the badge, not a security check. */
export type BuildKind = "official" | "unofficial" | "development";

export async function launcherBuildKind(): Promise<BuildKind> {
  return invoke<BuildKind>("launcher_build_kind");
}
