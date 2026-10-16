/**
 * DEV ONLY: lets `npm run dev` render the launcher in an ordinary browser for design work and
 * screenshots. main.tsx imports this only when `import.meta.env.DEV` is true and there is no Tauri
 * runtime, so none of it reaches a release build. Every value here is sample data.
 *
 * URL switches: ?screen=login|register|checking|restore|pending, ?running, ?repair, ?nolocate,
 * ?sessions=0, ?channel=beta, ?offline, ?server=<id> (selected server: s-realm or s-local), ?noservers,
 * ?acknowledged (the local server's warning is already accepted), ?remembered (and "Don't show again" is saved),
 * ?localsession (the local server has a saved sign-in). The optional hosting module adds its own switches (src/p2p/*Preview.ts).
 * [2026-10-14 realms] ?realmnokey (the Ember Hold realm has no agreed host yet: the join popup comes first), ?realmchanged
 * (its name now belongs to another host: Play is refused until the new one is trusted), ?nosignin (the directory cannot be
 * asked: no official sign-in).
 * [2026-10-15] Sign-in: ?unverified (sign-in asks for the emailed code; the code is 123456), ?verify (sign-up asks for the code),
 * "Forgot password?" opens the reset flow (?emailoff: the server cannot send mail), ?officialdown (the official server is
 * unavailable: a red badge, Play waits). Account: ?unlinked (Discord not linked), ?nodiscord (no Discord status from the
 * server). About: ?runtimebad (the installed runtime is not the signed release).
 * [2026-10-16] ?buildkind=unofficial|development: the UNOFFICIAL BUILD / DEVELOPMENT BUILD badge (sidebar, sign-in, About).
 * [2026-10-14] Terms and deletion: ?gate (the current documents are not accepted: the consent gate opens after sign-in),
 * ?gate=outdated (the acceptance is refused: update the launcher), ?consent404 (a backend without consent routes),
 * ?deactivated (the account is deactivated, deleted 20 days from now), ?nodeletion (a backend without the deletion route).
 * [2026-10-16] Realm invites and join requests: two invites wait by default (?noinvites shows none); a realm added in the
 * preview answers "Request sent" (?realmpublic: "Allowed" at once); the Ember Hold realm is already "Allowed".
 * [2026-10-15] Launcher notices are on by default (the EXPERIMENTAL BUILD tag and the restart notice for the next 00:00 UTC);
 * ?nonotices shows none.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { LEGAL } from "../legal/legalMeta";

// IPC mocks of an optional launcher module (src/p2p/*Preview.ts). Each answers its own commands and returns `undefined`
// for any other; a build without that folder has none.
const optionalMocks = Object.values(
  import.meta.glob<{ default: (cmd: string, args: unknown) => unknown }>("../p2p/*Preview.ts", { eager: true }),
).map((module) => module.default);

const params = new URLSearchParams(window.location.search);
const screen = params.get("screen");
const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();

const account = {
  userId: "preview-user",
  displayName: params.get("name") ?? "MysticFox",
  email: "slayer@example.com",
  discordLinked: true,
  // [2026-10-15] ?unlinked: Discord is not linked (Link Discord); ?nodiscord: the server sends no Discord status.
  discord: params.has("nodiscord") ? undefined : params.has("unlinked") ? { linked: false } : { linked: true, username: "MysticFox" },
  status: "active",
  approvalStatus: "approved",
  needsUsername: screen === "username",
};

const channel = params.get("channel") ?? "stable";
const running = params.has("running");
const sessions = params.get("sessions") === "0" ? [] : [
  ...(running ? [{ id: "s0", startedAt: iso(-18), exitedAt: null, exitCode: null, channel }] : []),
  { id: "s1", startedAt: iso(-26 * 60), exitedAt: iso(-26 * 60 + 134), exitCode: 0, channel },
  { id: "s2", startedAt: iso(-50 * 60), exitedAt: iso(-50 * 60 + 22), exitCode: 0xc0000005, channel },
  { id: "s3", startedAt: iso(-4 * 24 * 60), exitedAt: iso(-4 * 24 * 60 + 61), exitCode: 0xe302, channel },
  { id: "s4", startedAt: iso(-6 * 24 * 60), exitedAt: iso(-6 * 24 * 60 + 47), exitCode: 0, channel },
].slice(0, 4);

const install = params.has("nolocate")
  ? { located: false, runtimeRepairRequired: false, targetChangelist: 647472 }
  : {
    located: true,
    exePath: "C:\\Games\\Dauntless\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe",
    exeSha256: "3a4f9c2be1d07788aa5be0c9311f52d6c8e1f0aa9e27c4b6d1f88f02e4c5a9b7",
    runtimeRepairRequired: params.has("repair"),
    error: params.has("repair") ? "winmm.dll is missing from the game folder." : null,
    targetChangelist: 647472,
  };

const delay = <T,>(value: T, ms = 350) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

// [2026-10-15] The next 00:00 UTC, the event time of the preview's restart notice.
function nextMidnightUtc(): string {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

// [2026-10-13 realms S1] An in-memory server list that follows the native rules closely enough to preview the page.
interface PreviewServer {
  id: string;
  kind: "official" | "paradox_realm" | "local";
  name: string;
  backendUrl?: string;
  realmName?: string;
  gameExePath?: string | null;
  /** [2026-10-14 realms] The host key the player agreed to (a realm only). */
  hostPublicKey?: string | null;
}
const LOCAL_WARNING_REQUIRED = "Read and accept the local server warning before playing here.";
// The LOCAL SERVER WARNING choices and the per-server sign-in, kept in memory like the list.
const acknowledgedServers = new Set<string>(params.has("acknowledged") || params.has("remembered") ? ["s-local"] : []);
const rememberedServers = new Set<string>(params.has("remembered") ? ["s-local"] : []);
const signedInServers = new Set<string>(params.has("localsession") ? ["s-local"] : []);
const localAccount = { ...account, userId: "preview-local-user", displayName: "LocalFriend", email: "friend@example.com", discordLinked: false };
const accountFor = (serverId: string | undefined) => {
  const server = servers.find((candidate) => candidate.id === (serverId ?? selectedServerId));
  return server?.kind === "local" ? localAccount : account;
};
const sampleExe = (folder: string) => `D:\\Games\\${folder}\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe`;
// [2026-10-14 realms] The realm directory's host: `?realmchanged` makes the name belong to another host (Play is refused
// until the player trusts it); `?realmnokey` leaves the realm without an agreed host (the join popup comes first).
const previewHostKey = () => (params.has("realmchanged") ? "KEY-NEWHOST0123456789abcd" : "KEY-0123456789abcdefghijklmnop");
const previewFingerprint = (key: string) => (key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-8)}`);
// [2026-10-14] The Terms of Use and deletion state of the official account, kept in memory like the list.
let consentAccepted = !params.has("gate");
let deletionRequest: { requestedAt: string; scheduledFor: string } | null = params.has("deactivated")
  ? { requestedAt: iso(-10 * 24 * 60), scheduledFor: iso(20 * 24 * 60) }
  : null;
const consentView = () => (params.has("consent404")
  ? { supported: false, required: null, accepted: null, upToDate: true }
  : {
    supported: true,
    required: { termsVersion: LEGAL.termsVersion, privacyVersion: LEGAL.privacyVersion, minimumAge: LEGAL.minimumAge },
    accepted: consentAccepted ? { termsVersion: LEGAL.termsVersion, privacyVersion: LEGAL.privacyVersion, ageConfirmed: true, acceptedAt: iso(-40 * 24 * 60) } : null,
    upToDate: consentAccepted,
  });
const deletionView = () => (params.has("nodeletion")
  ? { supported: false, holdDays: 30, request: null }
  : { supported: true, holdDays: 30, request: deletionRequest });
// [2026-10-16] Realm invites waiting for the player, and the realms whose join request waits for its host.
let previewInvites = params.has("noinvites") ? [] : [
  { realmName: "frost-keep", hostName: "Brann", at: iso(-25), online: true },
  { realmName: "quiet-vale", hostName: "Mira", at: iso(-3 * 60), online: false },
];
const previewRequested = new Set<string>();

let servers: PreviewServer[] = [
  { id: "official", kind: "official", name: "Mystic Paradox", gameExePath: "exePath" in install ? install.exePath : null },
  ...(params.has("noservers") ? [] : [
    { id: "s-realm", kind: "paradox_realm" as const, name: "Ember Hold", realmName: "ember-hold", gameExePath: null, hostPublicKey: params.has("realmnokey") ? null : "KEY-0123456789abcdefghijklmnop" },
    { id: "s-local", kind: "local" as const, name: "My server", backendUrl: "https://realm.example.com:8443", gameExePath: null },
  ]),
];
let selectedServerId = servers.some((server) => server.id === params.get("server")) ? (params.get("server") as string) : "official";

const warningBlock = (server: PreviewServer) => (server.kind === "local" && !acknowledgedServers.has(server.id) ? LOCAL_WARNING_REQUIRED : null);

// [2026-10-14 realms] A realm with no folder of its own runs from the official install, as the native side does.
const officialExe: string | null = "exePath" in install ? (install.exePath ?? null) : null;
const exeOf = (server: PreviewServer): string | null =>
  server.kind === "official" || (server.kind === "paradox_realm" && !server.gameExePath) ? officialExe : (server.gameExePath ?? null);
const folderSourceOf = (server: PreviewServer): "own" | "official" | "none" => {
  if (server.kind === "official") return "own";
  if (server.kind === "paradox_realm") return server.gameExePath ? "own" : "official";
  return server.gameExePath ? "own" : "none";
};

const serverViews = () => servers.map((server) => ({
  ...server,
  selected: server.id === selectedServerId,
  removable: server.kind !== "official",
  folderSource: folderSourceOf(server),
  folder: exeOf(server),
  located: Boolean(exeOf(server)),
  usesOfficialFeed: server.kind !== "local",
  playBlockedReason: warningBlock(server),
  acknowledged: server.kind !== "local" || acknowledgedServers.has(server.id),
  warningRemembered: server.kind === "local" && rememberedServers.has(server.id),
}));

function previewBuildReport(launcherDiffers: boolean) {
  const hash = (seed: string) => seed.repeat(64 / seed.length);
  const dir = "C:\\Games\\Dauntless\\Archon\\Binaries\\Win64";
  return {
    repository: "pranav158/Mystic-Paradox",
    launcherVersion: "0.1.65",
    files: [
      launcherDiffers
        ? { name: "launcher.exe", label: "Launcher", path: "C:\\Users\\you\\AppData\\Local\\Mystic Paradox Launcher\\launcher.exe", installedSha256: hash("1f"), publishedSha256: hash("d3"), release: "launcher-v0.1.65", status: "differs", note: "Not the launcher.exe of the public release launcher-v0.1.65: this launcher was built elsewhere or changed." }
        : { name: "launcher.exe", label: "Launcher", path: "C:\\Users\\you\\AppData\\Local\\Mystic Paradox Launcher\\launcher.exe", installedSha256: hash("d3"), publishedSha256: hash("d3"), release: "launcher-v0.1.65", status: "match", note: "Identical to the launcher.exe of the public release launcher-v0.1.65." },
      { name: "winmm.dll", label: "Runtime loader", path: `${dir}\\winmm.dll`, installedSha256: hash("23"), publishedSha256: hash("23"), release: "runtime-extras-v0.2.137", status: "match", note: "Identical to winmm.dll of the public release runtime-extras-v0.2.137." },
      { name: "ParadoxTransport.dll", label: "Co-op transport", path: `${dir}\\ParadoxTransport.dll`, installedSha256: hash("6e"), publishedSha256: hash("6e"), release: "runtime-extras-v0.2.137", status: "match", note: "Identical to ParadoxTransport.dll of the public release runtime-extras-v0.2.137." },
      { name: "MysticParadox.dll", label: "Runtime", path: `${dir}\\MysticParadox.dll`, installedSha256: hash("c4"), publishedSha256: null, release: null, status: "operatorBuild", note: "Built by the official server's operator: it needs the game's SDK headers, which are not public. Its source is public, and the launcher checks the runtime's signature before installing it." },
    ],
  };
}

function installFor(serverId?: string) {
  const server = servers.find((candidate) => candidate.id === (serverId ?? selectedServerId)) ?? servers[0];
  const identity = { serverId: server.id, serverKind: server.kind, serverName: server.name, runtimeManaged: server.kind !== "local", playBlockedReason: warningBlock(server) };
  if (server.id === "official" || (server.kind === "paradox_realm" && !server.gameExePath)) return { ...install, ...identity };
  if (!server.gameExePath) return { located: false, runtimeRepairRequired: false, targetChangelist: 647472, ...identity };
  return { located: true, exePath: server.gameExePath, exeSha256: "3a4f9c2be1d07788aa5be0c9311f52d6c8e1f0aa9e27c4b6d1f88f02e4c5a9b7", runtimeRepairRequired: false, error: null, targetChangelist: 647472, ...identity };
}

function previewAddServer(request: { kind?: string; name?: string; backendUrl?: string; realmName?: string }): Promise<unknown> {
  const name = (request.name ?? "").trim();
  if (request.kind === "paradox_realm") {
    const realmName = (request.realmName ?? "").trim();
    if (!/^[a-z0-9-]{3,24}$/.test(realmName)) return Promise.reject("A realm name uses 3 to 24 lowercase letters, digits or hyphens, for example ember-hold.");
    servers.push({ id: `s-${Date.now().toString(16)}`, kind: "paradox_realm", name: name || realmName, realmName, gameExePath: null });
  } else {
    const url = (request.backendUrl ?? "").trim().replace(/\/$/, "");
    if (!/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(url)) return Promise.reject("Only https:// addresses are allowed (http:// only for localhost).");
    if (!name) return Promise.reject("Enter a name for the server.");
    servers.push({ id: `s-${Date.now().toString(16)}`, kind: "local", name, backendUrl: url.toLowerCase(), gameExePath: null });
  }
  return delay(serverViews(), 200);
}

mockWindows("main");
mockIPC((cmd, args) => {
  for (const optionalMock of optionalMocks) {
    const answer = optionalMock(cmd, args);
    if (answer !== undefined) return answer;
  }
  const payload = (args ?? {}) as { serverId?: string; remember?: boolean; ownFolder?: boolean; hostPublicKey?: string; confirmUsername?: string; code?: string; server?: { kind?: string; name?: string; backendUrl?: string; realmName?: string } };
  switch (cmd) {
    case "native_restore_session": {
      if (screen === "checking") return new Promise(() => {});
      if (screen === "restore") return Promise.reject("Couldn't reach the Mystic Paradox account server.");
      const target = servers.find((candidate) => candidate.id === (payload.serverId ?? selectedServerId));
      // A local server keeps a session of its own: signed out here until the player signs in to it.
      if (target?.kind === "local") return delay(signedInServers.has(target.id) ? localAccount : null, 250);
      return delay(screen === "login" || screen === "register" || screen === "pending" ? null : account, 250);
    }
    case "native_login": {
      // [2026-10-15] ?unverified: the email is not verified yet, so the emailed code screen comes next.
      if (params.has("unverified")) return Promise.reject("AUTH_EMAIL_UNVERIFIED: Check your email for the 6-digit code.");
      const target = servers.find((candidate) => candidate.id === (payload.serverId ?? selectedServerId));
      if (target?.kind === "local") signedInServers.add(target.id);
      return delay(accountFor(payload.serverId), 500);
    }
    // [2026-10-15] ?verify: the official sign-up asks for the emailed code. Sign-up takes no name (needsUsername after the code).
    case "native_register":
      return delay({ account: { ...accountFor(payload.serverId), approvalStatus: "pending", needsUsername: true }, verificationRequired: params.has("verify") }, 500);
    // [2026-10-15] Email codes: 123456 is the right code in the preview; any other is refused as wrong.
    case "native_verify_email":
      if (payload.code !== "123456") return Promise.reject("AUTH_CODE_INVALID: That code is wrong or has expired. Check the latest email or resend the code.");
      return delay({ approvalRequired: false, account: { ...accountFor(payload.serverId), needsUsername: true } }, 500);
    case "native_reset_password":
      if (payload.code !== "123456") return Promise.reject("AUTH_CODE_INVALID: That code is wrong or has expired. Check the latest email or resend the code.");
      return delay({ approvalRequired: false, account: accountFor(payload.serverId) }, 500);
    case "native_resend_email_code":
      return delay(null, 300);
    case "native_forgot_password":
      if (params.has("emailoff")) return Promise.reject("AUTH_EMAIL_UNAVAILABLE: Email isn't available on this server right now.");
      return delay(null, 300);
    // [2026-10-15] ?officialdown: the official server's play switch is off (Home, the switcher and Servers say so).
    case "native_official_play":
      return delay(params.has("officialdown") ? { available: false } : { available: true }, 200);
    // [2026-10-15] Launcher notices: the experimental tag, and a restart notice for the next 00:00 UTC (?nonotices hides both).
    case "native_launcher_notices":
      return delay(params.has("nonotices") ? { announcements: [], tags: [] } : {
        announcements: [{
          id: "preview-restart",
          text: "The backend service will restart at {time}.",
          tone: "warning",
          eventAt: nextMidnightUtc(),
        }],
        tags: [{ id: "preview-experimental", text: "EXPERIMENTAL BUILD", tone: "warning" }],
      }, 150);
    case "native_start_discord_link":
      return delay(null, 300);
    // [2026-10-15] Unlinking: the start mails a code (answered with the masked address; ?emailoff refuses it), and the
    // confirmation takes 123456 only, as the sign-in code does.
    case "native_start_discord_unlink":
      if (params.has("emailoff")) return Promise.reject("AUTH_EMAIL_UNAVAILABLE: Email isn't available on this server right now.");
      return delay({ email: "s***@example.com" }, 300);
    case "native_confirm_discord_unlink":
      if (payload.code !== "123456") return Promise.reject("AUTH_CODE_INVALID: That code is wrong or has expired. Check the latest email or resend the code.");
      return delay({ ...account, discord: { linked: false } }, 400);
    case "native_logout":
    case "native_forget_session":
      signedInServers.delete(payload.serverId ?? selectedServerId);
      return delay(null, 100);
    case "native_check_username":
      return delay({ available: true }, 250);
    case "native_consent_status":
      return delay(consentView(), 250);
    case "native_accept_consent": {
      // The backend answers LEGAL_VERSION_OUTDATED for a launcher whose documents are not the current ones.
      if (params.get("gate") === "outdated") return Promise.reject("Update the launcher to read and accept the current Terms of Use and Privacy Policy, then try again.");
      consentAccepted = true;
      return delay(consentView(), 500);
    }
    case "native_deletion_status":
      return delay(deletionView(), 250);
    case "native_request_deletion": {
      if ((payload.confirmUsername ?? "").trim().toLowerCase() !== account.displayName.toLowerCase()) {
        return Promise.reject("Type your username exactly as it is shown to confirm.");
      }
      deletionRequest = deletionRequest ?? { requestedAt: iso(0), scheduledFor: iso(30 * 24 * 60) };
      return delay(deletionView(), 500);
    }
    case "native_cancel_deletion":
      deletionRequest = null;
      return delay(deletionView(), 500);
    case "acknowledge_local_server":
      if (payload.serverId) {
        acknowledgedServers.add(payload.serverId);
        if (payload.remember) rememberedServers.add(payload.serverId);
        else rememberedServers.delete(payload.serverId);
      }
      return delay(serverViews(), 150);
    case "native_refresh_account":
      return delay(accountFor(payload.serverId));
    case "native_get_policy":
      return delay({ policyVersion: "preview", roles: ["tester"], channel, managedFeatureIds: [], logUpload: { auto: false }, guardEnforcement: "OBSERVE", diagnosticsProfile: "PRODUCTION", coopHunts: false }, 200);
    case "native_get_server_status":
      return params.has("offline") ? Promise.reject("offline") : delay({ online: true, supportedBuildChangelist: 647472 }, 300);
    case "get_install_status":
      return delay(installFor(payload.serverId), 200);
    // [2026-10-15] About -> "Check against GitHub" (?builddiff shows a launcher that differs from its release).
    // [2026-10-15] The update toast's hold (?running holds it, as a running game does).
    case "launcher_update_hold_reason":
      return delay(params.has("running") ? "Installs after you close the game: installing restarts the launcher, which closes the game." : null, 50);
    case "check_public_builds":
      return delay(previewBuildReport(params.has("builddiff")), 900);
    // [2026-10-16] The build badge: official (no badge) unless ?buildkind=unofficial or ?buildkind=development.
    case "launcher_build_kind": {
      const kind = params.get("buildkind");
      return delay(kind === "unofficial" || kind === "development" ? kind : "official", 50);
    }
    case "list_servers":
      return delay(serverViews(), 150);
    case "add_server":
      return previewAddServer(payload.server ?? {});
    case "remove_server":
      servers = servers.filter((server) => server.id !== payload.serverId || server.kind === "official");
      if (!servers.some((server) => server.id === selectedServerId)) selectedServerId = "official";
      return delay(serverViews(), 150);
    case "select_server":
      if (params.has("running")) return Promise.reject("Close Dauntless before changing servers or install folders.");
      selectedServerId = payload.serverId ?? selectedServerId;
      return delay(serverViews(), 150);
    case "is_game_running":
      return delay(running, 50);
    // [2026-10-15] About -> Runtime. ?runtimebad: the installed file is not the signed release (the one-line reason).
    case "verify_installed_runtime":
      return delay(params.has("runtimebad")
        ? { verified: false, reason: "The installed runtime is not the signed release: Runtime update hash verification failed.", version: "0.2.136" }
        : { verified: true, reason: null, version: "0.2.136" }, 400);
    case "check_runtime_update":
      if (selectedServerId !== "official" && servers.find((server) => server.id === selectedServerId)?.kind === "local") return delay({ available: false, feedManaged: false }, 200);
      return delay({ available: false, version: "0.2.80", currentSha256: "331829b4e51d69e5c2f0a1b7d8e9f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b", latestSha256: "331829b4e51d69e5c2f0a1b7d8e9f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b", size: 929280 }, 700);
    case "install_runtime_update":
      return delay({ available: false, version: "0.2.80" }, 1200);
    case "native_recent_sessions":
      return delay(sessions, 300);
    case "native_get_log_paths":
      return delay({ sessionsRoot: "C:\\Users\\Slayer\\AppData\\Local\\MysticParadox\\Logs\\Sessions", latestSessionDir: "C:\\Users\\Slayer\\AppData\\Local\\MysticParadox\\Logs\\Sessions\\s1" });
    case "native_get_p2p_host_settings":
      return { available: !params.has("nop2p"), memoryNotice: "Hosting a party hunt uses about 4 GB of extra memory.", transportReady: false, transportStatus: "UNAVAILABLE", transportStatusDetail: "The co-op connection starts automatically when you press Play.", transportCheckedAt: iso(0) };
    // [2026-10-16] Realm invites and join requests (the player's side).
    case "realm_invites":
      return delay([...previewInvites], 200);
    case "realm_answer_invite": {
      const name = (payload as { realmName?: string }).realmName;
      if (!previewInvites.some((invite) => invite.realmName === name)) return Promise.reject("You have no invite to this realm.");
      previewInvites = previewInvites.filter((invite) => invite.realmName !== name);
      return delay(undefined, 300);
    }
    case "realm_request_join": {
      const server = servers.find((candidate) => candidate.id === payload.serverId);
      if (!server || server.kind !== "paradox_realm") return Promise.reject("Only a Paradox realm can be asked to join.");
      const answer = params.has("realmpublic") || server.id === "s-realm" ? "MEMBER" : "REQUESTED";
      if (answer === "REQUESTED") previewRequested.add(server.id);
      return delay(answer, 400);
    }
    case "realm_lookup": {
      const server = servers.find((candidate) => candidate.id === payload.serverId);
      if (!server || server.kind !== "paradox_realm" || !server.realmName) return Promise.reject("Only a Paradox realm has a host to confirm.");
      if (params.has("nosignin")) return Promise.reject("Sign in to Mystic Paradox to look up this realm.");
      const key = previewHostKey();
      return delay({
        name: server.realmName,
        hostName: params.has("realmchanged") ? "Ashen Guild" : "Tempest",
        hostPublicKey: key,
        fingerprint: previewFingerprint(key),
        online: true,
        serving: true,
        ownershipChanged: Boolean(server.hostPublicKey) && server.hostPublicKey !== key,
        member: server.id === "s-realm",
        requested: previewRequested.has(server.id),
        invited: false,
      }, 300);
    }
    case "set_realm_host_key": {
      const server = servers.find((candidate) => candidate.id === payload.serverId);
      if (!server || server.kind !== "paradox_realm") return Promise.reject("Only a Paradox realm has a host to confirm.");
      server.hostPublicKey = payload.hostPublicKey ?? null;
      return delay(serverViews(), 150);
    }
    case "secure_launch": {
      // Play refuses a realm without the host the player agreed to, and one whose name now belongs to another host.
      const server = servers.find((candidate) => candidate.id === selectedServerId);
      if (server?.kind === "paradox_realm") {
        if (!server.hostPublicKey) return Promise.reject("REALM_HOST_KEY_REQUIRED");
        if (server.hostPublicKey !== previewHostKey()) return Promise.reject("REALM_OWNER_CHANGED");
      }
      return delay(null, 2400);
    }
    case "pick_install_path": {
      const server = servers.find((candidate) => candidate.id === (payload.serverId ?? selectedServerId));
      // A realm locates the official install (not modelled here); only a local server or an own folder gets a sample path.
      if (server && server.id !== "official" && (server.kind === "local" || payload.ownFolder === true) && !server.gameExePath) {
        server.gameExePath = sampleExe(`Dauntless ${server.name}`);
      }
      return delay(installFor(payload.serverId), 600);
    }
    case "use_official_install": {
      const server = servers.find((candidate) => candidate.id === payload.serverId);
      if (server && server.kind === "paradox_realm") server.gameExePath = null;
      return delay(serverViews(), 200);
    }
    case "plugin:app|version":
      return "0.1.67";
    case "plugin:updater|check":
      return params.has("update") ? { rid: 1, currentVersion: "0.1.46", version: "0.1.47", date: null, body: "Smoother launcher, real status everywhere.", rawJson: {} } : null;
    case "plugin:window|is_maximized":
      return false;
    case "plugin:event|listen":
      return 1;
    default:
      return null;
  }
});
