/**
 * DEV ONLY: lets `npm run dev` render the launcher in an ordinary browser for design work and
 * screenshots. main.tsx imports this only when `import.meta.env.DEV` is true and there is no Tauri
 * runtime, so none of it reaches a release build. Every value here is sample data.
 *
 * URL switches: ?screen=login|register|checking|restore|pending, ?running, ?repair, ?nolocate,
 * ?sessions=0, ?channel=beta, ?offline.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const params = new URLSearchParams(window.location.search);
const screen = params.get("screen");
const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();

const account = {
  userId: "preview-user",
  displayName: params.get("name") ?? "MysticFox",
  email: "slayer@example.com",
  discordLinked: true,
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

mockWindows("main");
mockIPC((cmd) => {
  switch (cmd) {
    case "native_restore_session":
      if (screen === "checking") return new Promise(() => {});
      if (screen === "restore") return Promise.reject("Couldn't reach the Mystic Paradox account server.");
      return delay(screen === "login" || screen === "register" || screen === "pending" ? null : account, 250);
    case "native_refresh_account":
      return delay(account);
    case "native_get_policy":
      return delay({ policyVersion: "preview", roles: ["tester"], channel, managedFeatureIds: [], logUpload: { auto: false }, guardEnforcement: "OBSERVE", diagnosticsProfile: "PRODUCTION", coopHunts: false }, 200);
    case "native_get_server_status":
      return params.has("offline") ? Promise.reject("offline") : delay({ online: true, supportedBuildChangelist: 647472 }, 300);
    case "get_install_status":
      return delay(install, 200);
    case "is_game_running":
      return delay(running, 50);
    case "check_runtime_update":
      return delay({ available: false, version: "0.2.80", currentSha256: "331829b4e51d69e5c2f0a1b7d8e9f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b", latestSha256: "331829b4e51d69e5c2f0a1b7d8e9f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b", size: 929280 }, 700);
    case "install_runtime_update":
      return delay({ available: false, version: "0.2.80" }, 1200);
    case "native_recent_sessions":
      return delay(sessions, 300);
    case "native_get_log_paths":
      return delay({ sessionsRoot: "C:\\Users\\Slayer\\AppData\\Local\\MysticParadox\\Logs\\Sessions", latestSessionDir: "C:\\Users\\Slayer\\AppData\\Local\\MysticParadox\\Logs\\Sessions\\s1" });
    case "native_get_p2p_host_settings":
      return { available: !params.has("nop2p"), memoryNotice: "Hosting a party hunt uses about 4 GB of extra memory.", transportReady: false, transportStatus: "UNAVAILABLE", transportStatusDetail: "The co-op connection starts automatically when you press Play.", transportCheckedAt: iso(0) };
    case "secure_launch":
      return delay(null, 2400);
    case "pick_install_path":
      return delay(install, 600);
    case "plugin:app|version":
      return "0.1.46";
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
