/**
 * DEV ONLY: IPC mocks of the realm host commands for the browser preview (`npm run dev`). dev/browserPreview.ts picks up
 * every src/p2p/*Preview.ts, so a build without that folder has none, and nothing here reaches a release build.
 *
 * One small in-memory realm, answering like src-tauri/src/p2p/realm.rs: every command resolves with the whole status, and
 * a refusal comes back as its `notice` (not as a rejected call). Start goes starting -> online after 2.5 s, Stop goes
 * stopping -> stopped after 1.5 s, there are two players (one in Ramsgate, one in a hunt) and one ban. Limits follow the
 * native rules (1-64 players, 1-8 servers, 0-7200 s; set_limits works while stopped too).
 * URL switches: ?realmonline (the realm is already online), ?realmfail (Start is refused), ?realmnotice (a restart notice).
 */
import type { RealmHostBan, RealmHostLimits, RealmHostNoticeKind, RealmHostPlayer, RealmHostState, RealmHostStatus } from "./realmHostApi";

const params = new URLSearchParams(window.location.search);
const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
const delay = <T,>(value: T, ms = 250) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

let state: RealmHostState = params.has("realmnotice") ? "restarting" : params.has("realmonline") ? "online" : "stopped";
let notice: string | null = params.has("realmnotice") ? "The Ramsgate server closed. Restarting it (attempt 1 of 5)." : null;
// [2026-10-14] The kind of the notice above: a refusal is "error" (the panel's error style, and an open dialog stays open).
let noticeKind: RealmHostNoticeKind = "info";
let startedAt: string | null = state === "stopped" ? null : iso(-84);
let limits: RealmHostLimits = { maxPlayers: 16, maxServers: 3, afkSeconds: 1200 };
let timer: ReturnType<typeof setTimeout> | undefined;

const seedPlayers = (): RealmHostPlayer[] => [
  { accountId: "acc-nova", displayName: "NovaBlade", where: { kind: "HUB", sessionId: "hub-1", huntId: null }, since: iso(-52), route: "DIRECT" },
  { accountId: "acc-ash", displayName: "AshWarden", where: { kind: "HUNT", sessionId: "hunt-1", huntId: "IslandA" }, since: iso(-9), route: "RELAY" },
];
let players: RealmHostPlayer[] = state === "stopped" ? [] : seedPlayers();
let bans: RealmHostBan[] = [
  { accountId: "acc-grim", displayName: "GrimTester", reason: "Griefing in Ramsgate", at: iso(-3 * 24 * 60) },
];

function status(): RealmHostStatus {
  const up = state === "online" || state === "restarting";
  const hub = state === "stopped" ? null : {
    sessionId: "hub-1",
    state: state === "starting" ? "STARTING" : state === "restarting" ? "RESTARTING" : state === "stopping" ? "STOPPING" : "RUNNING",
    startedAt,
    players: players.filter((player) => player.where.kind === "HUB").length,
  };
  const hunts = up ? players.filter((player) => player.where.kind === "HUNT").map((player) => ({
    sessionId: player.where.sessionId,
    huntId: player.where.huntId ?? "",
    state: "RUNNING",
    players: 1,
  })) : [];
  const training = state === "online" ? { sessionId: "train-1", state: "RUNNING", players: 0 } : null;
  return {
    state,
    notice,
    noticeKind,
    realm: { name: "ember-hold", serving: state === "online" },
    hub,
    training,
    hunts,
    players: up ? players : [],
    bans,
    capacity: {
      ...limits,
      activeServers: (hub ? 1 : 0) + (training ? 1 : 0) + hunts.length,
      freeMemMiB: state === "stopped" ? 9_800 : 6_300,
      totalMemMiB: 16_384,
    },
  };
}

function after(ms: number, next: () => void) {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; next(); }, ms);
}

function validate(options: RealmHostLimits | undefined): string | null {
  if (!options) return "The realm limits are missing.";
  if (!Number.isInteger(options.maxPlayers) || options.maxPlayers < 1 || options.maxPlayers > 64) return "The player limit must be from 1 to 64.";
  if (!Number.isInteger(options.maxServers) || options.maxServers < 1 || options.maxServers > 8) return "The server limit must be from 1 to 8.";
  if (options.afkSeconds != null && (!Number.isInteger(options.afkSeconds) || options.afkSeconds < 0 || options.afkSeconds > 7200)) return "The AFK limit must be from 0 to 7200 seconds.";
  return null;
}

/** The launcher's player id rule (realm.rs `valid_account_id`). */
const validAccountId = (value: string | undefined) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

/** A refusal or a result message: it becomes the notice, and the status is answered as usual. */
function say(message: string | null, ms = 250, kind: RealmHostNoticeKind = "info") {
  notice = message;
  noticeKind = kind;
  return delay(status(), ms);
}

/** Answers a realm host command, or returns `undefined` for any other command. */
export default function realmHostPreview(cmd: string, args: unknown): Promise<unknown> | undefined {
  const payload = (args ?? {}) as { options?: RealmHostLimits; accountId?: string; reason?: string | null };
  switch (cmd) {
    case "realm_host_status":
      return delay(status(), 120);
    case "realm_host_start": {
      if (state !== "stopped") return say("The realm host is already running.", 150, "error");
      const problem = validate(payload.options);
      if (problem) return say(problem, 150, "error");
      if (params.has("realmfail")) {
        return new Promise((resolve) => setTimeout(() => {
          notice = "Not enough free memory to start the realm (2.1 GB free, 3 GB needed).";
          noticeKind = "error";
          resolve(status());
        }, 600));
      }
      limits = { ...payload.options! };
      state = "starting";
      notice = null;
      noticeKind = "info";
      startedAt = new Date().toISOString();
      after(2_500, () => { state = "online"; players = seedPlayers(); });
      return delay(status(), 300);
    }
    case "realm_host_stop":
      if (state === "stopped") return delay(status(), 100);
      state = "stopping";
      after(1_500, () => { state = "stopped"; players = []; startedAt = null; notice = null; noticeKind = "info"; });
      return delay(status(), 300);
    case "realm_host_kick": {
      if (!validAccountId(payload.accountId)) return say("That is not a player id.", 250, "error");
      players = players.filter((player) => player.accountId !== payload.accountId);
      return say("The player was removed from the realm.", 300);
    }
    case "realm_host_ban": {
      if (!validAccountId(payload.accountId)) return say("That is not a player id.", 250, "error");
      const reason = payload.reason?.trim() ?? "";
      if (reason.length > 200) return say("The ban reason must be plain text of at most 200 characters.", 250, "error");
      const target = players.find((player) => player.accountId === payload.accountId);
      players = players.filter((player) => player.accountId !== payload.accountId);
      if (!bans.some((ban) => ban.accountId === payload.accountId)) {
        bans = [...bans, { accountId: payload.accountId!, displayName: target?.displayName ?? null, reason: reason || null, at: new Date().toISOString() }];
      }
      return say("The player was banned from the realm.", 300);
    }
    case "realm_host_unban":
      if (!validAccountId(payload.accountId)) return say("That is not a player id.", 250, "error");
      bans = bans.filter((ban) => ban.accountId !== payload.accountId);
      return say("The ban was lifted.", 300);
    case "realm_host_set_limits": {
      const problem = validate(payload.options);
      if (problem) return say(problem, 250, "error");
      const running = state === "online" || state === "restarting";
      const changedLive = running && (limits.maxPlayers !== payload.options!.maxPlayers || limits.afkSeconds !== payload.options!.afkSeconds);
      limits = { ...payload.options! };
      return say(changedLive ? "The player and AFK limits apply when the hub next starts." : null, 300);
    }
    default:
      return undefined;
  }
}
