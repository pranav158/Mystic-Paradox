// Mirrors Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md — the /launcher/v1 contract
// this client is built against, and src/security/launcherErrors.ts on the backend
// for the exact LauncherErrorCode union (SERVER_UNAVAILABLE is the one exception:
// client-synthesized on fetch failure, never sent by the server).

export type LauncherErrorCode =
  | "AUTH_VALIDATION_FAILED"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_EMAIL_TAKEN"
  | "AUTH_DISPLAY_NAME_TAKEN"
  | "AUTH_ACCOUNT_DISABLED"
  | "AUTH_ACCOUNT_BANNED"
  | "AUTH_APPROVAL_PENDING"
  | "AUTH_APPROVAL_REJECTED"
  // [2026-10-15] Email codes: sign-in needs the emailed code, a wrong or expired code, and a server that cannot send mail.
  | "AUTH_EMAIL_UNVERIFIED"
  | "AUTH_CODE_INVALID"
  | "AUTH_EMAIL_UNAVAILABLE"
  // [2026-10-15] Discord: sign-in never creates an account; linking and unlinking in Settings.
  | "AUTH_DISCORD_NOT_LINKED"
  | "AUTH_DISCORD_ACCOUNT_HAS_LINK"
  | "AUTH_DISCORD_ONLY_LOGIN"
  | "AUTH_USERNAME_REQUIRED"
  | "AUTH_REFRESH_INVALID"
  | "AUTH_UNAUTHORIZED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_DISCORD_NOT_CONFIGURED"
  | "AUTH_DISCORD_CANCELLED"
  | "AUTH_DISCORD_ALREADY_LINKED"
  | "GAME_EXCHANGE_CODE_EXPIRED"
  | "GAME_BUILD_UNSUPPORTED"
  | "NOT_FOUND"
  | "INTERNAL"
  | "SERVER_UNAVAILABLE"
  | "UNKNOWN";

export interface LauncherAccount {
  userId: string;
  displayName: string;
  email: string;
  discordLinked: boolean;
  status: "active" | "banned" | "disabled";
  approvalStatus: "pending" | "approved" | "rejected";
  /** True for a fresh Discord account with no chosen username yet — the launcher
   *  must show the set-username step before the account can play. */
  needsUsername: boolean;
  /** [2026-10-15] The account's Discord link. Missing means unknown (an older backend), not "not linked". */
  discord?: { linked: boolean; username?: string };
}

export interface UsernameAvailabilityResponse {
  available: boolean;
  reason?: string;
}

export interface ServerStatusResponse {
  online: boolean;
  supportedBuildChangelist: number;
  /** [2026-10-15] The official server's play switch. Absent on an older backend, which means available. */
  officialPlay?: OfficialPlay;
}

/** [2026-10-15] `officialPlay` of `/launcher/v1/status`: when `available` is false the official server cannot be played. */
export interface OfficialPlay {
  available: boolean;
  message?: string;
}

/** [2026-10-15] Launcher notices (`GET /launcher/v1/notices`, read from the official backend). Text only, never markup. */
export type NoticeTone = "info" | "warning" | "critical";
export type TagTone = "info" | "warning" | "danger" | "success";

export interface LauncherAnnouncement {
  id: string;
  text: string;
  tone: NoticeTone;
  /** When `{time}` shows, as an ISO time. Absent when the text has no time. */
  eventAt?: string;
}

export interface LauncherTag {
  id: string;
  text: string;
  tone: TagTone;
}

export interface LauncherNotices {
  announcements: LauncherAnnouncement[];
  tags: LauncherTag[];
}

/** [2026-10-15] A registration answer: a code was emailed when `verificationRequired` (the account is not signed in yet). */
export interface RegistrationOutcome {
  account: LauncherAccount;
  verificationRequired: boolean;
}

/** [2026-10-15] A verify or reset answer: signed in, or waiting for approval (`approvalRequired`, no session). */
export interface EmailOutcome {
  approvalRequired: boolean;
  account: LauncherAccount;
}

export interface LauncherPolicy {
  policyVersion: string;
  roles: string[];
  channel: "stable" | "beta" | "dev";
  managedFeatureIds: string[];
  logUpload: { auto: boolean };
  guardEnforcement: "ENFORCE" | "OBSERVE";
  diagnosticsProfile: "PRODUCTION" | "DEVELOPMENT";
  /** The server's half of the co-op switch; absent on a dedicated-only server. */
  coopHunts: boolean;
  /** [2026-10-17] Present only for a test-channel account: the channels the Library's switch offers and the one in use. */
  channelSwitch?: { channels: string[]; current: string };
}

export interface LogPaths {
  sessionsRoot: string;
  latestSessionDir: string | null;
}

/** [2026-10-17] One file of a log upload that was not sent, and why. */
export interface LogUploadProblem {
  name: string;
  reason: string;
}

/** [2026-10-17] The result of "Upload logs" (`native_upload_logs`). */
export interface LogUploadReport {
  uploadId: string;
  /** `play`: the newest Play session and the logs since; `host`: no Play session of this account, its host logs. */
  uploadKind: "play" | "host";
  uploaded: number;
  total: number;
  failed: LogUploadProblem[];
  skipped: LogUploadProblem[];
  /** Why the upload stopped before its last file. */
  stopped: string | null;
}

/** [2026-10-17] Sent before each file of an upload (index from 1). */
export interface LogUploadProgress {
  index: number;
  total: number;
  name: string;
}
