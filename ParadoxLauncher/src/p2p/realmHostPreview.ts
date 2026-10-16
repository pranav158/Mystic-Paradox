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
import type {
  RealmHostBan,
  RealmHostLimits,
  RealmHostNoticeKind,
  RealmHostPlayer,
  RealmHostState,
  RealmHostStatus,
  RealmJoinPolicy,
  RealmJoinRequest,
  RealmPerson,
} from "./realmHostApi";

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
// [2026-10-15] Who may join, and the players waiting for approval (newest first, as the native side lists them).
// [2026-10-16] ?hostpolicy=solo|allowlisted|public: the mode "Who can join" starts in (allowlisted by default).
let joinPolicy: RealmJoinPolicy = params.get("hostpolicy") === "solo" ? "SOLO" : params.get("hostpolicy") === "public" ? "PUBLIC" : "INVITE_ONLY";
let requests: RealmJoinRequest[] = [
  { accountId: "acc-lyra", displayName: "LyraSpark", at: iso(-12) },
  { accountId: "acc-brann", displayName: "BrannOak", at: iso(-95) },
];

// [2026-10-16] The allowed players and the unanswered invites (newest first).
let members: RealmPerson[] = [
  { accountId: "acc-nova", displayName: "NovaBlade", at: iso(-2 * 24 * 60) },
  { accountId: "acc-ash", displayName: "AshWarden", at: iso(-6 * 24 * 60) },
];
let invites: RealmPerson[] = [
  { accountId: "acc-mira", displayName: "MiraVale", at: iso(-40) },
];
const KNOWN_USERNAMES = ["LyraSpark", "BrannOak", "MiraVale", "Mysticzzz", "QuietFox"];

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
    realm: { name: "ember-hold", serving: state === "online", joinPolicy, joinRequestCount: requests.length },
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
  const payload = (args ?? {}) as { options?: RealmHostLimits; accountId?: string; reason?: string | null; username?: string; joinPolicy?: string };
  switch (cmd) {
    case "realm_host_join_requests":
      return delay({ requests: [...requests], error: null }, 120);
    case "realm_host_approve_request":
    case "realm_host_deny_request": {
      if (!validAccountId(payload.accountId)) return say("That is not a player id.", 250, "error");
      if (!requests.some((request) => request.accountId === payload.accountId)) {
        return say("That player has not asked to join your realm.", 250, "error");
      }
      const decided = requests.find((request) => request.accountId === payload.accountId)!;
      requests = requests.filter((request) => request.accountId !== payload.accountId);
      if (cmd === "realm_host_approve_request") members = [{ accountId: decided.accountId, displayName: decided.displayName, at: iso(0) }, ...members];
      return say(cmd === "realm_host_approve_request" ? "The player can join your realm now." : "The request was denied.", 300);
    }
    case "realm_host_invite_player": {
      const typed = (payload.username ?? "").trim();
      if (typed === "" || typed.length > 64) return say("Enter a username of 1 to 64 characters.", 250, "error");
      const name = KNOWN_USERNAMES.find((known) => known.toLowerCase() === typed.toLowerCase());
      if (!name) return say("No player has that username.", 300, "error");
      const accountId = `acc-${name.toLowerCase()}`;
      if (members.some((member) => member.accountId === accountId)) return say(`${name} can join your realm.`, 300);
      // A player who asked to join is let in at once, as the backend does.
      if (requests.some((request) => request.accountId === accountId)) {
        requests = requests.filter((request) => request.accountId !== accountId);
        members = [{ accountId, displayName: name, at: iso(0) }, ...members];
        return say(`${name} can join your realm.`, 300);
      }
      if (!invites.some((invite) => invite.accountId === accountId)) invites = [{ accountId, displayName: name, at: iso(0) }, ...invites];
      return say(`Invite sent to ${name}. They can join once they accept it in their launcher.`, 300);
    }
    case "realm_host_cancel_invite": {
      if (!invites.some((invite) => invite.accountId === payload.accountId)) return say("That player has no invite waiting.", 250, "error");
      invites = invites.filter((invite) => invite.accountId !== payload.accountId);
      return say("The invite was cancelled.", 300);
    }
    case "realm_host_people":
      return delay({ members: [...members], invites: [...invites], error: null }, 150);
    case "realm_host_set_join_policy": {
      if (payload.joinPolicy !== "SOLO" && payload.joinPolicy !== "INVITE_ONLY" && payload.joinPolicy !== "PUBLIC") {
        return say("Choose who can join: solo, allowlisted or public.", 250, "error");
      }
      joinPolicy = payload.joinPolicy;
      return say(joinPolicy === "PUBLIC"
        ? "Anyone can join your realm now."
        : joinPolicy === "SOLO"
          ? "Your realm is in solo mode now: only you can enter. Players already inside stay until they leave."
          : "Only players you approve can join your realm now.", 300);
    }
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
      members = members.filter((member) => member.accountId !== payload.accountId);
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
