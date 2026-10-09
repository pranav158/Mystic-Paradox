const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;

// Execute the real TSX components with real React/DOM scheduling. Only native IPC and
// unrelated presentation imports are replaced; no production logic is copied into the tests.
function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  new Function('require', 'module', 'exports', source)(
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name), module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root, dom;
async function mount(Component, props = {}) {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Component, props)));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  dom?.window.close();
  root = dom = undefined;
});
function button(label) {
  return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
}

const account = { userId: 'a', displayName: 'Slayer', needsUsername: false };
// Any icon name renders nothing; the tests target behaviour, not artwork.
const icons = new Proxy({}, { get: () => () => null });
const sessionsLib = load('src/lib/sessions.ts', {});
const services = { health: 'online', checkedAt: 0, refreshing: false, supportedChangelist: 647472, refresh: async () => {} };
const policy = { channel: 'beta', roles: ['tester'] };
const install = { located: true, exeSha256: 'approved', runtimeRepairRequired: false };
function home(api, refreshPolicy = async () => policy, serviceState = services) {
  return load('src/screens/dashboard/HomeTab.tsx', {
    '../../auth/AuthContext': { useAuth: () => ({ account }) },
    '../../policy/PolicyContext': { usePolicy: () => ({ policy, refreshPolicy }) },
    '../../services/ServicesContext': { useServices: () => serviceState },
    '../../api/tauri': {
      getInstallStatus: async () => install,
      isGameRunning: async () => false,
      onGameExited: async () => () => {},
      checkRuntimeUpdate: async () => ({ available: false, version: '0.2.80' }),
      getRecentSessions: async () => [],
      ...api,
    },
    '../../lib/sanitize': { sanitizeError: (error) => error },
    '../../lib/sessions': sessionsLib,
    '../../components/icons': icons,
    '../../components/AetherMark': { AetherMark: () => null },
    '../../components/ArtBackdrop': { ArtBackdrop: () => null, heroArt: 'art.webp' },
  }).HomeTab;
}

test('Play is single-flight, avoids a WebView runtime pass, and retries after failure', async () => {
  const launch = deferred();
  let calls = 0, repairs = 0;
  await mount(home({
    installRuntimeUpdate: async () => { repairs++; },
    secureLaunch: (channel) => {
      assert.equal(channel, 'beta');
      calls++;
      return calls === 1 ? launch.promise : Promise.resolve();
    },
    isGameRunning: async () => false,
  }));
  const play = button('Play');
  assert.ok(play);
  await act(async () => { play.click(); play.click(); });
  assert.equal(calls, 1);
  assert.equal(repairs, 0);
  assert.equal(button('Play'), undefined);
  await act(async () => launch.reject(new Error('temporary outage')));
  assert.ok(button('Play'), 'a failed launch must remain retryable');
  await act(async () => button('Play').click());
  assert.equal(calls, 2);
  assert.ok(button('Check status'));
  await act(async () => button('Check status').click());
  assert.ok(button('Play'), 'exit status must restore Play without an artificial delay');
});

test('policy outage cannot launch using a guessed stable channel', async () => {
  let calls = 0;
  await mount(home({ secureLaunch: async () => { calls++; } }, async () => null));
  await act(async () => button('Play').click());
  assert.equal(calls, 0);
  assert.ok(button('Play'));
  assert.match(document.body.textContent, /Couldn't verify your account access/);
});

test('Locate keeps the selected path when account policy is offline', async () => {
  let repairs = 0;
  await mount(home({
    getInstallStatus: async () => ({ located: false }),
    pickInstallPath: async () => install,
    installRuntimeUpdate: async () => { repairs++; },
  }, async () => null));
  await act(async () => button('Locate game').click());
  assert.ok(button('Play'), 'offline repair must not strand the locating phase');
  assert.equal(repairs, 0);
});

test('Repair coalesces clicks and uses current account policy', async () => {
  const repair = deferred();
  let calls = 0;
  await mount(home({
    getInstallStatus: async () => ({ ...install, error: 'Missing DLL', runtimeRepairRequired: true }),
    installRuntimeUpdate: (channel) => { assert.equal(channel, 'beta'); calls++; return repair.promise; },
  }));
  const repairButton = button('Repair');
  await act(async () => { repairButton.click(); repairButton.click(); });
  assert.equal(calls, 1);
  await act(async () => repair.resolve());
  assert.ok(button('Play'));
});

test('a game-exited event restores Play without a manual status check', async () => {
  let exited;
  await mount(home({
    secureLaunch: async () => {},
    onGameExited: async (handler) => { exited = handler; return () => {}; },
  }));
  await act(async () => button('Play').click());
  assert.ok(button('Check status'));
  await act(async () => exited(0));
  assert.ok(button('Play'), 'the exit event must bring Play back');
});

test('Home shows a game that is already running when it mounts', async () => {
  await mount(home({ isGameRunning: async () => true }));
  assert.ok(button('Check status'));
  assert.equal(button('Play'), undefined);
});

test('Library repair installs the account channel, not stable', async () => {
  const channels = [];
  const { LibraryTab } = load('src/screens/dashboard/LibraryTab.tsx', {
    '../../api/tauri': {
      getInstallStatus: async () => ({ ...install, error: 'Missing DLL', runtimeRepairRequired: true }),
      pickInstallPath: async () => install,
      installRuntimeUpdate: async (channel) => { channels.push(channel); },
      checkRuntimeUpdate: async () => ({ available: false, version: '0.2.80' }),
    },
    '../../policy/PolicyContext': { usePolicy: () => ({ policy, refreshPolicy: async () => policy }) },
    '../../lib/sanitize': { sanitizeError: (error) => error },
    '../../lib/sessions': sessionsLib,
    '../../components/icons': icons,
    '../../components/ArtBackdrop': { ArtBackdrop: () => null, heroArt: 'art.webp' },
  });
  await mount(LibraryTab);
  await act(async () => button('Repair runtime').click());
  assert.deepEqual(channels, ['beta']);
});

test('Home cards show the real build match, runtime version and session history', async () => {
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const exitedAt = new Date(Date.now() - 1_800_000).toISOString();
  await mount(home({
    getInstallStatus: async () => ({ ...install, targetChangelist: 647472 }),
    getRecentSessions: async () => [{ id: 's1', startedAt, exitedAt, exitCode: 0xC0000005, channel: 'beta' }],
  }));
  const text = document.body.textContent;
  assert.match(text, /Dauntless 1\.14\.7/);
  assert.match(text, /CL 647472 · matches server/);
  assert.match(text, /Runtime v0\.2\.80/);
  assert.match(text, /Crashed \(0xC0000005\)/);
  assert.match(text, /30 min/);
});

test('a build the server no longer accepts is called out on Home', async () => {
  await mount(home(
    { getInstallStatus: async () => ({ ...install, targetChangelist: 647472 }) },
    async () => policy,
    { ...services, supportedChangelist: 700000 },
  ));
  assert.match(document.body.textContent, /Server expects CL 700000/);
});

test('session outcomes name the launcher exit codes', () => {
  const { describeExit, formatDuration } = sessionsLib;
  assert.equal(describeExit(0, 'x', false).label, 'Closed normally');
  assert.equal(describeExit(0xE301, 'x', false).label, 'Stopped by Launcher Guard');
  assert.equal(describeExit(0xE302, 'x', false).label, 'Stopped when the launcher closed');
  assert.equal(describeExit(0xE304, 'x', false).label, 'Stopped at sign-out');
  assert.equal(describeExit(3221225477, 'x', false).tone, 'bad');
  assert.equal(describeExit(null, null, true).label, 'Playing now');
  assert.equal(describeExit(7, 'x', false).label, 'Exited (code 7)');
  assert.equal(formatDuration('2026-10-08T10:00:00Z', '2026-10-08T12:14:00Z'), '2 h 14 min');
});

test('policy requests coalesce and an old account response cannot restore permissions', async () => {
  const responses = [deferred(), deferred()];
  let auth = { status: 'signedIn', account }, calls = 0, context;
  const { PolicyProvider, usePolicy } = load('src/policy/PolicyContext.tsx', {
    '../auth/AuthContext': { useAuth: () => auth },
    '../api/tauri': { getPolicy: () => responses[calls++].promise },
  });
  function Probe() { context = usePolicy(); return null; }
  function App() { return React.createElement(PolicyProvider, null, React.createElement(Probe)); }
  await mount(App);
  const oldRequest = context.refreshPolicy();
  assert.equal(calls, 1);
  auth = { status: 'signedIn', account: { ...account, userId: 'b' } };
  await act(async () => root.render(React.createElement(App)));
  assert.equal(calls, 2);
  await act(async () => responses[0].resolve(policy));
  assert.equal(await oldRequest, null);
  assert.equal(context.policy, null);
  await act(async () => responses[1].resolve({ channel: 'stable', roles: [] }));
  assert.equal(context.policy.channel, 'stable');
  auth = { status: 'signedOut', account: null };
  await act(async () => root.render(React.createElement(App)));
  assert.equal(context.policy, null);
  assert.equal(await context.refreshPolicy(), null);
});

test('late restore and cancelled Discord completion cannot sign the user back in', async () => {
  const restore = deferred();
  const listeners = new Map();
  let context, completions = 0;
  const { AuthProvider, useAuth } = load('src/auth/AuthContext.tsx', {
    '@tauri-apps/api/core': { invoke: (command) => {
      if (command === 'native_restore_session') return restore.promise;
      if (command === 'native_discord_complete') completions++;
      return Promise.resolve();
    } },
    '@tauri-apps/api/event': { listen: async (name, callback) => {
      listeners.set(name, callback); return () => listeners.delete(name);
    } },
    '../api/client': { LauncherApiError: class extends Error {} },
  });
  function Probe() { context = useAuth(); return null; }
  function App() { return React.createElement(AuthProvider, null, React.createElement(Probe)); }
  await mount(App);
  await act(async () => context.logout());
  await act(async () => restore.resolve(account));
  await act(async () => listeners.get('discord-auth-complete')({ payload: 'old-code' }));
  assert.equal(context.status, 'signedOut');
  assert.equal(context.account, null);
  assert.equal(completions, 0);
});
