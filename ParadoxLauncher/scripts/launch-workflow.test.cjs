const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const React = require('react');
// React DOM decides when it loads whether the DOM supports the `input` event (typing into a controlled field). Give
// it a window to look at; every test still mounts into its own fresh JSDOM (see `mount`).
{
  const bootDom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = bootDom.window;
  global.document = bootDom.window.document;
}
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
// [2026-10-14] The realm trust note, loaded for real: the tests check its words where a realm is joined, hosted or added.
const realmTrustNote = load('src/components/RealmTrustNote.tsx', { './icons': icons });
const sessionsLib = load('src/lib/sessions.ts', {});
// [2026-10-14] The realm naming rule (a pure module) and the launcher's dropdown, loaded for real. Every factory that
// imports either one maps its import to these.
const serverNames = load('src/servers/serverNames.ts', {});
// [2026-10-15] The email-code and Discord rules, and the official server's play switch: pure modules, loaded for real.
const authRules = load('src/auth/authRules.ts', {});
const officialPlayLib = load('src/servers/officialPlay.ts', {});
const dropdownLib = load('src/components/Dropdown.tsx', { './icons': icons });
const services = { health: 'online', checkedAt: 0, refreshing: false, supportedChangelist: 647472, refresh: async () => {} };
// [2026-10-13 realms S5] The selected-server state, as a screen under test sees it.
const serverCtx = { opened: [], synced: [], openWarning(id) { serverCtx.opened.push(id); }, sync(list) { serverCtx.synced.push(list); } };
const LocalServerBadge = ({ onOpen, children }) =>
  React.createElement('button', { type: 'button', onClick: onOpen }, children ?? 'LOCAL SERVER WARNING');
const policy = { channel: 'beta', roles: ['tester'] };
const install = { located: true, exeSha256: 'approved', runtimeRepairRequired: false };
// [2026-10-14 realms] The realm trust Home sees: nothing to agree to and no notice, unless a test says otherwise.
const noTrust = () => ({ notice: null, dismissNotice() {}, ensureHost: async () => true, trustNewHost: async () => false });
const Banner = ({ tone, children, onDismiss }) => React.createElement('div', { className: 'banner', 'data-tone': tone ?? 'danger' },
  children, onDismiss ? React.createElement('button', { type: 'button', onClick: onDismiss }, 'Dismiss') : null);
function home(api, refreshPolicy = async () => policy, serviceState = services, { trust = noTrust(), selected, rules = accountRulesDefault(), officialPlay = null } = {}) {
  return load('src/screens/dashboard/HomeTab.tsx', {
    '../../auth/AuthContext': { useAuth: () => ({ account }) },
    '../../auth/AccountRules': { useAccountRules: () => rules },
    '../../components/DeactivationBanner': { DeactivationBanner },
    '../../lib/accountDeletion': accountDeletionLib,
    '../../policy/PolicyContext': { usePolicy: () => ({ policy, refreshPolicy }) },
    '../../services/ServicesContext': { useServices: () => serviceState },
    '../../servers/ServerContext': { useServer: () => ({ ...serverCtx, selected, officialPlay }) },
    '../../servers/RealmTrust': { useRealmTrust: () => trust },
    '../../components/Banner': { Banner },
    '../../components/LocalServerWarning': { LocalServerBadge },
    '../../api/tauri': {
      getInstallStatus: async () => install,
      isGameRunning: async () => false,
      onGameExited: async () => () => {},
      checkRuntimeUpdate: async () => ({ available: false, version: '0.2.80' }),
      getRecentSessions: async () => [],
      REALM_OWNER_CHANGED: 'REALM_OWNER_CHANGED',
      REALM_HOST_KEY_REQUIRED: 'REALM_HOST_KEY_REQUIRED',
      ...api,
    },
    '../../lib/sanitize': { sanitizeError: (error) => error },
    '../../lib/sessions': sessionsLib,
    '../../components/icons': icons,
    '../../components/AetherMark': { AetherMark: () => null },
    '../../components/ArtBackdrop': { ArtBackdrop: () => null, heroArt: 'art.webp' },
    '../../servers/serverNames': serverNames,
    '../../servers/officialPlay': officialPlayLib,
    '@tauri-apps/api/app': { getVersion: async () => '0.1.67' },
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
    '../../servers/ServerContext': { useServer: () => ({ selected: null }) },
    '../../servers/serverNames': serverNames,
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
    '../api/client': { LauncherApiError: class LauncherApiErrorFake extends Error { constructor(code, message) { super(message); this.code = code; } } },
    '../servers/ServerContext': { useServer: () => ({ ready: true, serverId: undefined, needsAck: false, officialNetwork: true }) },
    './authRules': authRules,
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

// ---- [2026-10-13 realms S1] multi-server launcher -------------------------------------------------------------

const LOCAL_WARNING_REQUIRED = 'Read and accept the local server warning before playing here.';
const localInstall = {
  ...install,
  serverId: 's-1',
  serverKind: 'local',
  serverName: 'My server',
  playBlockedReason: null,
  runtimeManaged: false,
};

test('Play works on a local server: its runtime is the realm\'s own and no signed manifest is checked', async () => {
  let launches = 0, runtimeChecks = 0, channelSeen = null;
  await mount(home({
    getInstallStatus: async () => localInstall,
    checkRuntimeUpdate: async () => { runtimeChecks++; return { available: false, version: '0.2.80' }; },
    secureLaunch: async (channel) => { launches++; channelSeen = channel; },
  }));
  const text = document.body.textContent;
  assert.match(text, /LOCAL SERVER WARNING/);
  assert.match(text, /Realm's own files/);
  assert.match(text, /This server's own backend checks your files/);
  assert.equal(runtimeChecks, 0, 'no signed manifest is checked for a local server');
  assert.equal(button('Unavailable'), undefined);
  await act(async () => button('Play').click());
  assert.equal(launches, 1);
  assert.equal(channelSeen, 'beta', 'the channel is the one the local server\'s own policy gave');
  assert.ok(button('Check status'));
});

test('Play stays off for a local server whose warning has not been accepted', async () => {
  let launches = 0;
  await mount(home({
    getInstallStatus: async () => ({ ...localInstall, playBlockedReason: LOCAL_WARNING_REQUIRED }),
    secureLaunch: async () => { launches++; },
  }));
  const blocked = button('Unavailable');
  assert.ok(blocked, 'the Play slot says why it is off');
  assert.equal(blocked.disabled, true);
  assert.equal(button('Play'), undefined);
  await act(async () => blocked.click());
  assert.equal(launches, 0);
  assert.match(document.body.textContent, /Read and accept the local server warning/);
});

test('the red LOCAL SERVER WARNING badge on Home opens that server\'s warning', async () => {
  serverCtx.opened = [];
  await mount(home({ getInstallStatus: async () => localInstall }));
  const badge = [...document.querySelectorAll('button')].find((item) => item.textContent.startsWith('LOCAL SERVER WARNING'));
  assert.ok(badge);
  await act(async () => badge.click());
  assert.deepEqual(serverCtx.opened, ['s-1']);
});

test('a Paradox realm plays like the official server and names itself on Home', async () => {
  let channelSeen = null;
  await mount(home({
    getInstallStatus: async () => ({ ...install, serverId: 's-2', serverKind: 'paradox_realm', serverName: 'Ember Hold', runtimeManaged: true }),
    secureLaunch: async (channel) => { channelSeen = channel; },
  }));
  // [2026-10-14] The identity block above Play names the kind and the name, in text.
  const identity = document.querySelector('.play-server');
  assert.equal(identity.dataset.kind, 'paradox_realm');
  assert.equal(identity.querySelector('.play-server-kind').textContent, 'Paradox realm');
  assert.equal(identity.querySelector('.play-server-name').textContent, 'Ember Hold');
  assert.equal(identity.querySelector('button'), null, 'no warning badge for a realm');
  await act(async () => button('Play').click());
  assert.equal(channelSeen, 'beta');
  assert.ok(button('Check status'));
});

test('Home names the official server above Play, and a local server with its warning badge', async () => {
  await mount(home({ getInstallStatus: async () => install }));
  const official = document.querySelector('.play-server');
  assert.equal(official.dataset.kind, 'official');
  assert.equal(official.querySelector('.play-server-kind').textContent, 'Official server');
  assert.equal(official.querySelector('.play-server-name').textContent, 'Mystic Paradox');
  await unmountNow();
  serverCtx.opened = [];
  await mount(home({ getInstallStatus: async () => localInstall }));
  const local = document.querySelector('.play-server');
  assert.equal(local.dataset.kind, 'local');
  assert.equal(local.querySelector('.play-server-kind').textContent, 'Local server');
  assert.equal(local.querySelector('.play-server-name').textContent, 'My server');
  await act(async () => local.querySelector('button').click());
  assert.deepEqual(serverCtx.opened, ['s-1'], 'the badge opens the local server\'s warning');
});

test('Library does not offer to repair a local server\'s own runtime files', async () => {
  let checks = 0;
  const { LibraryTab } = load('src/screens/dashboard/LibraryTab.tsx', {
    '../../servers/ServerContext': { useServer: () => ({ selected: null }) },
    '../../servers/serverNames': serverNames,
    '../../api/tauri': {
      getInstallStatus: async () => ({ ...localInstall, exePath: 'D:\\Games\\Realm\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe' }),
      pickInstallPath: async () => localInstall,
      installRuntimeUpdate: async () => {},
      checkRuntimeUpdate: async () => { checks++; return { available: false, feedManaged: false }; },
    },
    '../../policy/PolicyContext': { usePolicy: () => ({ policy, refreshPolicy: async () => policy }) },
    '../../lib/sanitize': { sanitizeError: (error) => error },
    '../../lib/sessions': sessionsLib,
    '../../components/icons': icons,
    '../../components/ArtBackdrop': { ArtBackdrop: () => null, heroArt: 'art.webp' },
  });
  await mount(LibraryTab);
  assert.equal(button('Verify runtime'), undefined);
  assert.equal(button('Repair runtime'), undefined);
  assert.equal(checks, 0);
  assert.match(document.body.textContent, /uses its own runtime files/);
});

// The Servers page, with the shared form pieces replaced by plain elements.
const officialExe = 'C:\\Games\\Dauntless\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe';
const officialServer = {
  id: 'official', kind: 'official', name: 'Mystic Paradox', selected: true, removable: false, located: true,
  acknowledged: true, warningRemembered: false, usesOfficialFeed: true, gameExePath: officialExe,
  folderSource: 'own', folder: officialExe, folderProblem: null,
};
const localServer = {
  id: 's-1', kind: 'local', name: 'My server', backendUrl: 'https://realm.example.com', selected: false, removable: true,
  located: false, usesOfficialFeed: false, playBlockedReason: LOCAL_WARNING_REQUIRED, gameExePath: null,
  acknowledged: false, warningRemembered: false, folderSource: 'none', folder: null, folderProblem: null,
};
// [2026-10-14 realms] A realm with no folder of its own: it runs from the official install.
const realmServer = {
  id: 's-2', kind: 'paradox_realm', name: 'Ember Hold', realmName: 'ember-hold', selected: false, removable: true,
  located: true, usesOfficialFeed: true, gameExePath: null, folderSource: 'official', folder: officialExe, folderProblem: null,
  acknowledged: true, warningRemembered: false, playBlockedReason: null,
};
const TestButton = ({ children, loading, loadingLabel, variant, size, block, ...rest }) =>
  React.createElement('button', { ...rest, type: rest.type ?? 'button', disabled: rest.disabled || loading }, loading ? loadingLabel : children);
const TestTextField = ({ label, hint, error, rightAdornment, ...input }) =>
  React.createElement('label', null, label, React.createElement('input', input));
// [2026-10-14 realms] The shared add form, loaded for real: the Servers page and the sign-in card both use it.
function addServerForm(api, context, trust = noTrust()) {
  return load('src/servers/AddServerForm.tsx', {
    './serverNames': serverNames,
    '../api/tauri': { addServer: async () => [], ...api },
    '../components/Button': { Button: TestButton },
    '../components/TextField': { TextField: TestTextField },
    '../components/icons': icons,
    './RealmTrust': { useRealmTrust: () => trust },
    '../components/RealmTrustNote': realmTrustNote,
    './ServerContext': { useServer: () => context },
  }).AddServerForm;
}
function serversTab(api, context = serverCtx, panels = [], trust = noTrust()) {
  return load('src/screens/dashboard/ServersTab.tsx', {
    '../../servers/serverNames': serverNames,
    '../../servers/officialPlay': officialPlayLib,
    '../../api/tauri': { listServers: async () => [officialServer, localServer], ...api },
    '../../components/Button': { Button: TestButton },
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../components/LocalServerWarning': { LocalServerBadge },
    '../../servers/ServerContext': { useServer: () => context },
    '../../servers/AddServerForm': { AddServerForm: addServerForm(api, context, trust) },
    '../../lib/optionalPanels': { OPTIONAL_PANELS: panels },
    '../../components/icons': icons,
  }).ServersTab;
}
function field(label) {
  return [...document.querySelectorAll('label')].find((item) => item.textContent.startsWith(label))?.querySelector('input');
}
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

test('Servers lists every server with its kind, folder and the red local warning', async () => {
  await mount(serversTab({}));
  const text = document.body.textContent;
  assert.match(text, /Mystic Paradox/);
  assert.match(text, /Official/);
  assert.match(text, /In use/);
  assert.match(text, /My server/);
  assert.match(text, /LOCAL SERVER WARNING/);
  assert.match(text, /https:\/\/realm\.example\.com/);
  assert.match(text, /C:\\Games\\Dauntless(?!\\)/, 'the game root, not the exe path');
  assert.match(text, /Not selected yet/);
  assert.equal([...document.querySelectorAll('button')].filter((item) => item.textContent.trim() === 'Remove').length, 1,
    'the official server has no Remove');
  assert.match(text, /does not install, check or update them/);
});

test('adding a local server shows the validation message, then clears the form on success', async () => {
  const requests = [];
  let outcome = 'Only https:// addresses are allowed (http:// only for localhost).';
  await mount(serversTab({
    addServer: async (request) => {
      requests.push(request);
      if (outcome) throw outcome;
      return [officialServer, localServer, { ...localServer, id: 's-2', name: 'Friends' }];
    },
  }));
  await act(async () => button('Local server').click());
  assert.match(document.body.textContent, /pick its folder after adding it/, 'a local server needs its own folder');
  await act(async () => typeInto(field('Name'), 'Friends'));
  await act(async () => typeInto(field('Server address'), 'http://friends.example.com'));
  await act(async () => button('Add server').click());
  assert.deepEqual(requests, [{ kind: 'local', name: 'Friends', backendUrl: 'http://friends.example.com' }]);
  assert.match(document.body.textContent, /Only https:\/\/ addresses are allowed/);
  assert.equal(field('Server address').value, 'http://friends.example.com', 'the form keeps what was typed');

  outcome = null;
  await act(async () => typeInto(field('Server address'), 'https://friends.example.com'));
  await act(async () => button('Add server').click());
  assert.equal(requests.length, 2);
  assert.equal(field('Server address').value, '');
  assert.equal(field('Name').value, '');
  assert.match(document.body.textContent, /Friends/);
});

test('a realm is added by name and its realm name is typed in lower case', async () => {
  const requests = [];
  await mount(serversTab({ addServer: async (request) => { requests.push(request); return [officialServer]; } }));
  await act(async () => typeInto(field('Realm name'), 'Ember-Hold'));
  assert.equal(field('Realm name').value, 'ember-hold');
  await act(async () => button('Add server').click());
  assert.deepEqual(requests, [{ kind: 'paradox_realm', name: '', realmName: 'ember-hold' }]);
  assert.doesNotMatch(document.body.textContent, /pick its folder/, 'a realm plays from the official install: no folder to pick');
});

test('selecting reports the native refusal on the row, and works when allowed', async () => {
  let refuse = true;
  const calls = [];
  await mount(serversTab({
    selectServer: async (id) => {
      calls.push(id);
      if (refuse) throw 'Close Dauntless before changing servers or install folders.';
      return [{ ...officialServer, selected: false }, { ...localServer, selected: true }];
    },
  }));
  await act(async () => button('Use this server').click());
  assert.deepEqual(calls, ['s-1']);
  assert.match(document.body.textContent, /Close Dauntless before changing servers/);
  assert.ok(button('Use this server'), 'the server is not selected after a refusal');
  refuse = false;
  await act(async () => button('Use this server').click());
  const rows = [...document.querySelectorAll('.server-row')];
  assert.doesNotMatch(rows[0].textContent, /In use/);
  assert.match(rows[1].textContent, /In use/);
});

test('removing needs a second click, and choosing a folder targets that server', async () => {
  const removed = [], picked = [];
  let listed = 0;
  await mount(serversTab({
    listServers: async () => { listed++; return [officialServer, localServer]; },
    removeServer: async (id) => { removed.push(id); return [officialServer]; },
    pickInstallPath: async (id, ownFolder) => { picked.push([id, ownFolder]); return {}; },
  }));
  await act(async () => button('Remove').click());
  assert.deepEqual(removed, [], 'the first click only asks');
  assert.ok(button('Click again to remove'));
  await act(async () => button('Keep').click());
  assert.equal(button('Click again to remove'), undefined);

  const before = listed;
  await act(async () => button('Choose folder').click());
  assert.deepEqual(picked, [['s-1', true]], 'the picker is asked for that server, as its own folder');
  assert.equal(listed, before + 1, 'the list is read again after the picker');

  await act(async () => button('Remove').click());
  await act(async () => button('Click again to remove').click());
  assert.deepEqual(removed, ['s-1']);
  assert.equal(button('Remove'), undefined);
});

const realmRow = () => [...document.querySelectorAll('.server-row')].find((item) => item.textContent.includes('Ember Hold'));
const serverRowButton = (row, label) => [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === label);

test('a Paradox realm with no folder of its own plays from the official install and is not asked for one', async () => {
  const picked = [];
  const list = [officialServer, localServer, realmServer];
  await mount(serversTab({
    listServers: async () => list,
    pickInstallPath: async (id, ownFolder) => { picked.push([id, ownFolder]); return {}; },
  }));
  assert.match(realmRow().textContent, /Shared with the official install/);
  assert.doesNotMatch(realmRow().textContent, /Choose folder|Change folder/, 'the default realm asks for no folder');
  assert.equal(serverRowButton(realmRow(), 'Use the official install'), undefined, 'there is nothing to switch from');
  // The optional separate folder still works, and asks for the realm's own folder.
  await act(async () => serverRowButton(realmRow(), 'Use a separate folder').click());
  assert.deepEqual(picked, [['s-2', true]]);
});

test('a realm with its own folder can go back to the official install', async () => {
  const switched = [];
  const own = { ...realmServer, folderSource: 'own', folder: 'D:\\Games\\Ember Own\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe' };
  await mount(serversTab({
    listServers: async () => [officialServer, localServer, own],
    useOfficialInstall: async (id) => { switched.push(id); return [officialServer, localServer, { ...realmServer }]; },
  }));
  assert.match(realmRow().textContent, /D:\\Games\\Ember Own(?!\\)/);
  assert.ok(serverRowButton(realmRow(), 'Change folder'), 'a realm with its own folder can change it');
  await act(async () => serverRowButton(realmRow(), 'Use the official install').click());
  assert.deepEqual(switched, ['s-2']);
  assert.match(realmRow().textContent, /Shared with the official install/);
});

// ---- [2026-10-13 realms S5] per-server sign-in, the LOCAL SERVER WARNING and the selected server's status -----------

// Real components, built bottom-up: the warning popup and the provider that owns it.
const plainButton = ({ children, loading, loadingLabel, variant, size, block, ...rest }) =>
  React.createElement('button', { ...rest, type: rest.type ?? 'button', disabled: rest.disabled || loading }, loading ? loadingLabel : children);
function realServerContext(api) {
  const Modal = load('src/components/Modal.tsx', {});
  const warning = load('src/components/LocalServerWarning.tsx', { './Button': { Button: plainButton }, './Modal': Modal });
  return load('src/servers/ServerContext.tsx', { '../api/tauri': { getOfficialPlay: async () => ({ available: true }), ...api }, '../components/LocalServerWarning': warning });
}
// ---- [2026-10-14] Terms of Use, consent and account deletion ----------------------------------------------------
// The legal text is the owner's: these tests use short stand-ins for the viewer, and read the real files only for the
// placeholder check. The components below are the real ones, with the native calls and the document files mocked.
const legalMeta = load('src/legal/legalMeta.ts', {});
const legalText = load('src/legal/legalText.ts', { './legalMeta': legalMeta });
const legalMarkdown = load('src/legal/legalMarkdown.tsx', {});
const accountDeletionLib = load('src/lib/accountDeletion.ts', {});
const ModalModule = load('src/components/Modal.tsx', {});
const ModalReal = ModalModule.Modal;
const DeactivationBanner = load('src/components/DeactivationBanner.tsx', {
  './Button': { Button: plainButton }, './icons': icons, '../lib/accountDeletion': accountDeletionLib,
}).DeactivationBanner;
const NL = String.fromCharCode(10);
const legalDocs = {
  terms: { title: 'Terms of Use', text: ['# Mystic Paradox Terms of Use', '', 'Version 2026-10-14', '', '## 1. What Mystic Paradox is', '', 'Read **carefully**, and see https://example.com.'].join(NL) },
  privacy: { title: 'Privacy Policy', text: ['# Mystic Paradox Privacy Policy', '', 'Version 2026-10-14', '', 'Contact privacy@mysticfox.dev.'].join(NL) },
};
const legalOpenedBy = [];
const LegalDocument = load('src/components/LegalDocument.tsx', {
  '@tauri-apps/plugin-opener': { openUrl: async () => {} },
  './Modal': ModalModule,
  './Button': { Button: plainButton },
  '../legal/documents': { LEGAL_DOCUMENTS: legalDocs },
  '../legal/legalMarkdown': legalMarkdown,
});
const legalViewerStub = { open: (id) => legalOpenedBy.push(id), dialog: null };
const LegalConsentChecks = load('src/components/LegalConsentChecks.tsx', {}).LegalConsentChecks;
const TextFieldPlain = ({ label, hint, error, rightAdornment, ...input }) => React.createElement('label', null, label, React.createElement('input', input));
const DeleteAccountDialog = load('src/components/DeleteAccountDialog.tsx', {
  './Banner': { Banner }, './Button': { Button: plainButton }, './Modal': ModalModule, './TextField': { TextField: TextFieldPlain },
}).DeleteAccountDialog;
const accountRulesDefault = () => ({
  gate: 'open', consent: null, consentError: null, retryConsent() {}, acceptConsent: async () => {},
  deletion: null, deletionChecking: false, deactivatedUntil: null, deletionBusy: false,
  reloadDeletion: async () => null, requestDeletion: async () => {}, restoreAccount: async () => {},
});
const acceptedConsent = {
  supported: true,
  required: { termsVersion: '2026-10-14', privacyVersion: '2026-10-14', minimumAge: 16 },
  accepted: { termsVersion: '2026-10-14', privacyVersion: '2026-10-14', ageConfirmed: true, acceptedAt: '2026-09-01T10:00:00.000Z' },
  upToDate: true,
};
const deactivatedUntil = '2026-11-13T09:00:00.000Z';
const deactivatedSentence = 'Your account is deactivated and will be deleted on 13 November 2026.';
const plainError = (error) => (typeof error === 'string' ? error : error.message);

const localEntry = {
  id: 's-1', kind: 'local', name: 'My server', backendUrl: 'https://realm.example.com:8443', selected: false, removable: true,
  located: false, usesOfficialFeed: false, gameExePath: null, acknowledged: false, warningRemembered: false,
};
const officialEntry = {
  id: 'official', kind: 'official', name: 'Mystic Paradox', selected: true, removable: false, located: true,
  usesOfficialFeed: true, acknowledged: true, warningRemembered: false,
};
const select = (list, id) => list.map((server) => ({ ...server, selected: server.id === id }));
const dialog = () => document.querySelector('[role="dialog"]');

test('the warning popup names the risks and is the only way to accept a local server', async () => {
  const acknowledged = [];
  let list = select([officialEntry, localEntry], 's-1');
  const { ServerProvider, useServer } = realServerContext({
    listServers: async () => list,
    selectServer: async (id) => (list = select(list, id)),
    acknowledgeLocalServer: async (id, remember) => {
      acknowledged.push([id, remember]);
      list = list.map((server) => server.id === id ? { ...server, acknowledged: true, warningRemembered: remember } : server);
      return list;
    },
  });
  let context;
  function Probe() { context = useServer(); return null; }
  function App() { return React.createElement(ServerProvider, null, React.createElement(Probe)); }
  await mount(App);

  // A local server is selected and not accepted: the popup opens by itself, and nothing may be sent to the server yet.
  assert.equal(context.needsAck, true);
  assert.equal(context.officialNetwork, false);
  assert.ok(dialog(), 'the popup opens on its own');
  const text = dialog().textContent;
  assert.match(text, /Local server warning/);
  assert.match(text, /My server/);
  assert.match(text, /https:\/\/realm\.example\.com:8443/);
  assert.match(text, /not run, hosted, listed, monitored or checked by Mystic Paradox/);
  assert.match(text, /may contain\s+malware/);
  assert.match(text, /takes no responsibility/);
  assert.match(text, /stored only on the host's PC/);
  assert.match(text, /never synced to the official Mystic\s+Paradox network/);
  assert.match(text, /can see the server's address \(IP\) unless the host puts their own relay, VPN or tunnel/);
  assert.match(text, /Only join if you trust the host/);
  assert.ok(button('I agree'));
  assert.ok(button('Cancel'));

  // Cancel records nothing and the server still needs its warning.
  await act(async () => button('Cancel').click());
  assert.equal(dialog(), null);
  assert.deepEqual(acknowledged, []);
  assert.equal(context.needsAck, true);

  // The badge reopens it, with the "Don't show again" box off, and agreeing saves the choice per server.
  await act(async () => context.openWarning('s-1'));
  const box = dialog().querySelector('input[type="checkbox"]');
  assert.equal(box.checked, false);
  await act(async () => box.click());
  await act(async () => button('I agree').click());
  assert.deepEqual(acknowledged, [['s-1', true]]);
  assert.equal(dialog(), null);
  assert.equal(context.needsAck, false);
  assert.equal(context.selected.warningRemembered, true);
});

test('agreeing without the box is for this run only, and a remembered choice shows ticked when reopened', async () => {
  const acknowledged = [];
  let list = select([officialEntry, { ...localEntry, acknowledged: true, warningRemembered: true }], 's-1');
  const { ServerProvider, useServer } = realServerContext({
    listServers: async () => list,
    acknowledgeLocalServer: async (id, remember) => { acknowledged.push([id, remember]); return list; },
  });
  let context;
  function Probe() { context = useServer(); return null; }
  function App() { return React.createElement(ServerProvider, null, React.createElement(Probe)); }
  await mount(App);
  assert.equal(context.needsAck, false);
  assert.equal(dialog(), null, 'an accepted server does not ask again');

  await act(async () => context.openWarning('s-1'));
  const box = dialog().querySelector('input[type="checkbox"]');
  assert.equal(box.checked, true, 'the box shows what is saved');
  await act(async () => box.click());
  await act(async () => button('I agree').click());
  assert.deepEqual(acknowledged, [['s-1', false]], 'clearing the box withdraws the saved choice');
});

test('a refused agreement keeps the popup open with the reason', async () => {
  let list = select([officialEntry, localEntry], 's-1');
  const { ServerProvider } = realServerContext({
    listServers: async () => list,
    acknowledgeLocalServer: async () => { throw "Couldn't save your server warning choice."; },
  });
  await mount(() => React.createElement(ServerProvider, null, null));
  await act(async () => button('I agree').click());
  assert.ok(dialog());
  assert.match(dialog().textContent, /Couldn't save your server warning choice/);
  assert.ok(button('I agree'), 'the player can try again');
});

test('the dialog closes on Escape, not on a click outside, and keeps focus inside', async () => {
  const closed = [];
  const Modal = load('src/components/Modal.tsx', {}).Modal;
  await mount(() => React.createElement(Modal, { title: 'Sure?', onClose: () => closed.push('closed'), footer: React.createElement('button', null, 'OK') },
    React.createElement('p', null, 'Body')));
  assert.equal(dialog().getAttribute('aria-modal'), 'true');
  assert.equal(document.activeElement, dialog());
  await act(async () => document.querySelector('.modal-scrim').click());
  assert.deepEqual(closed, [], 'a click outside is not an answer');
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.deepEqual(closed, ['closed']);
  // Tab from the last control wraps to the first.
  const ok = button('OK');
  ok.focus();
  const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => document.dispatchEvent(tab));
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, ok, 'a single control keeps the focus');
});

function authHarness(initial, handlers = {}) {
  const calls = [];
  const listeners = new Map();
  const server = { current: initial };
  const modules = load('src/auth/AuthContext.tsx', {
    '@tauri-apps/api/core': { invoke: (command, args) => {
      calls.push([command, args]);
      return handlers[command] ? handlers[command](args) : Promise.resolve();
    } },
    '@tauri-apps/api/event': { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } },
    '../api/client': { LauncherApiError: class LauncherApiErrorFake extends Error { constructor(code, message) { super(message); this.code = code; } } },
    '../servers/ServerContext': { useServer: () => server.current },
    './authRules': authRules,
  });
  let context;
  function Probe() { context = useAuth(); return null; }
  const { AuthProvider, useAuth } = modules;
  function App() { return React.createElement(AuthProvider, null, React.createElement(Probe)); }
  return { App, calls, listeners, server, get context() { return context; } };
}
const officialServerState = { ready: true, serverId: 'official', needsAck: false, officialNetwork: true };
const localServerState = { ready: true, serverId: 's-1', needsAck: false, officialNetwork: false };
const localAccount = { ...account, userId: 'local-user', displayName: 'LocalFriend' };

test('every account call names the server it is for, and a switch restores that server\'s own session', async () => {
  const harness = authHarness(officialServerState, {
    native_restore_session: ({ serverId }) => Promise.resolve(serverId === 'official' ? account : null),
    native_login: () => Promise.resolve(localAccount),
    native_register: () => Promise.resolve({ account: { ...localAccount, approvalStatus: 'pending' }, verificationRequired: false }),
  });
  await mount(harness.App);
  assert.equal(harness.context.status, 'signedIn');
  assert.equal(harness.context.account.userId, 'a');
  assert.equal(harness.context.serverId, 'official');
  assert.deepEqual(harness.calls[0], ['native_restore_session', { serverId: 'official' }]);

  // Another server is a different session: the official account is gone from the screen, and the local server's saved
  // session is looked for (there is none), so its own sign-in shows.
  harness.server.current = localServerState;
  await act(async () => root.render(React.createElement(harness.App)));
  assert.equal(harness.context.status, 'signedOut');
  assert.equal(harness.context.account, null);
  assert.deepEqual(harness.calls.at(-1), ['native_restore_session', { serverId: 's-1' }]);

  await act(async () => harness.context.login('friend@example.com', 'a long password'));
  assert.deepEqual(harness.calls.at(-1), ['native_login', { serverId: 's-1', email: 'friend@example.com', password: 'a long password' }]);
  assert.equal(harness.context.status, 'signedIn');
  assert.equal(harness.context.account.userId, 'local-user');

  await act(async () => harness.context.register('friend@example.com', 'a long password', undefined, 'Friend'));
  assert.deepEqual(harness.calls.at(-1), ['native_register', { serverId: 's-1', displayName: 'Friend', email: 'friend@example.com', password: 'a long password' }]);
  await act(async () => harness.context.logout());
  assert.deepEqual(harness.calls.at(-1), ['native_logout', { serverId: 's-1' }]);

  // And back: the official session is restored for the official server.
  harness.server.current = officialServerState;
  await act(async () => root.render(React.createElement(harness.App)));
  assert.deepEqual(harness.calls.at(-1), ['native_restore_session', { serverId: 'official' }]);
  assert.equal(harness.context.status, 'signedIn');
  assert.equal(harness.context.account.userId, 'a');
});

test('a local server is not contacted at all until its warning is accepted', async () => {
  const harness = authHarness({ ...localServerState, needsAck: true }, {
    native_restore_session: () => Promise.resolve(localAccount),
  });
  await mount(harness.App);
  assert.equal(harness.context.status, 'needsServerConsent');
  assert.equal(harness.context.account, null);
  assert.deepEqual(harness.calls, [], 'no session restore, no request of any kind');

  // The player agrees: the saved session of that server is restored.
  harness.server.current = { ...localServerState, needsAck: false };
  await act(async () => root.render(React.createElement(harness.App)));
  assert.deepEqual(harness.calls, [['native_restore_session', { serverId: 's-1' }]]);
  assert.equal(harness.context.status, 'signedIn');
});

test('Discord sign-in is not applied while a local server is selected', async () => {
  const harness = authHarness(localServerState, {
    native_restore_session: () => Promise.resolve(null),
    native_discord_complete: () => Promise.resolve(account),
  });
  await mount(harness.App);
  await act(async () => harness.listeners.get('discord-auth-complete')({ payload: 'code' }));
  assert.equal(harness.calls.some(([command]) => command === 'native_discord_complete'), false,
    'Discord belongs to the official account system, not to a local server');
  assert.equal(harness.context.status, 'signedOut');

  // On the official server the same return from the browser is completed.
  harness.server.current = officialServerState;
  await act(async () => root.render(React.createElement(harness.App)));
  await act(async () => harness.listeners.get('discord-auth-complete')({ payload: 'code' }));
  assert.equal(harness.calls.filter(([command]) => command === 'native_discord_complete').length, 1);
  assert.equal(harness.context.status, 'signedIn');
});

function loginScreen(serverState) {
  const TextField = ({ label, hint, error, rightAdornment, ...input }) =>
    React.createElement('label', null, label, React.createElement('input', input));
  return load('src/screens/LoginScreen.tsx', {
    '../servers/serverNames': serverNames,
    '../auth/AuthContext': { useAuth: () => ({ login: async () => {}, startDiscordLogin: async () => {}, authError: null }), describeAuthError: String },
    '../components/TextField': { TextField, RevealToggle: () => null },
    '../components/Button': { Button: plainButton },
    '../components/Banner': { Banner: ({ children }) => React.createElement('div', null, children) },
    '../components/AuthLayout': {
      AuthLayout: ({ children }) => React.createElement('div', null, children),
      AuthCard: ({ title, subtitle, children }) => React.createElement('section', null, React.createElement('h1', null, title), React.createElement('p', null, subtitle), children),
    },
    '../components/icons': icons,
    '../components/ServerSwitcher': { ServerSwitcher: () => React.createElement('div', { id: 'switcher' }), switcherReturnsFocusTo: () => false },
    '../components/LegalDocument': LegalDocument,
    '../servers/ServerContext': { useServer: () => serverState },
  }).LoginScreen;
}

test('the sign-in card names a local server and offers no Discord there', async () => {
  await mount(loginScreen({ selected: { ...localEntry, acknowledged: true, selected: true }, officialNetwork: false }), { onCreateAccount() {} });
  assert.match(document.querySelector('h1').textContent, /Sign in to My server/);
  assert.match(document.body.textContent, /never sees it/);
  assert.equal(button('Sign in with Discord'), undefined);
  assert.ok(button('Sign in'));
  assert.match(document.body.textContent, /New to this server\?/);
  assert.ok(document.getElementById('switcher'), 'the card lets the player switch server');
});

test('the official sign-in card is unchanged and keeps Discord', async () => {
  await mount(loginScreen({ selected: officialEntry, officialNetwork: true }), { onCreateAccount() {} });
  assert.match(document.querySelector('h1').textContent, /Welcome back, Slayer/);
  assert.ok(button('Sign in with Discord'));
  assert.match(document.body.textContent, /New to Mystic Paradox\?/);
});

test('the policy is read from the selected server and never reused by another server', async () => {
  const responses = [deferred(), deferred()];
  const asked = [];
  let auth = { status: 'signedIn', account, serverId: 'official' }, calls = 0, context;
  const { PolicyProvider, usePolicy } = load('src/policy/PolicyContext.tsx', {
    '../auth/AuthContext': { useAuth: () => auth },
    '../api/tauri': { getPolicy: (serverId) => { asked.push(serverId); return responses[calls++].promise; } },
  });
  function Probe() { context = usePolicy(); return null; }
  function App() { return React.createElement(PolicyProvider, null, React.createElement(Probe)); }
  await mount(App);
  assert.deepEqual(asked, ['official']);
  await act(async () => responses[0].resolve({ channel: 'beta', roles: ['tester'] }));
  assert.equal(context.policy.channel, 'beta');

  // The same account id on another server is another account: the beta policy of the official server is gone at once.
  auth = { status: 'signedIn', account, serverId: 's-1' };
  await act(async () => root.render(React.createElement(App)));
  assert.equal(context.policy, null);
  assert.deepEqual(asked, ['official', 's-1']);
  await act(async () => responses[1].resolve({ channel: 'stable', roles: [] }));
  assert.equal(context.policy.channel, 'stable');
});

test('the services chip checks the selected server and drops an answer for the one it left', async () => {
  const pending = [deferred(), deferred()];
  const asked = [];
  const server = { current: { serverId: 'official' } };
  const { ServicesProvider, useServices } = load('src/services/ServicesContext.tsx', {
    '../api/tauri': { getServerStatus: (serverId) => { asked.push(serverId); return pending[asked.length - 1].promise; } },
    '../servers/ServerContext': { useServer: () => server.current },
    './authRules': authRules,
  });
  let context;
  function Probe() { context = useServices(); return null; }
  function App() { return React.createElement(ServicesProvider, null, React.createElement(Probe)); }
  await mount(App);
  assert.deepEqual(asked, ['official']);
  assert.equal(context.health, 'checking');

  // The player switches to a local server while the official check is still in flight.
  server.current = { serverId: 's-1' };
  await act(async () => root.render(React.createElement(App)));
  assert.deepEqual(asked, ['official', 's-1']);
  assert.equal(context.health, 'checking');
  assert.equal(context.supportedChangelist, null, 'the old server\'s build is forgotten');

  await act(async () => pending[0].resolve({ online: true, supportedBuildChangelist: 111 }));
  assert.equal(context.health, 'checking', 'the answer of the server that was left is dropped');
  assert.equal(context.supportedChangelist, null);

  await act(async () => pending[1].resolve({ online: false, supportedBuildChangelist: 647472 }));
  assert.equal(context.health, 'degraded');
  assert.equal(context.supportedChangelist, 647472);
});

test('the Servers page shares every change with the selected-server state and opens the warning from the red badge', async () => {
  const shared = [], opened = [];
  const after = [{ ...officialServer, selected: false }, { ...localServer, selected: true }];
  const context = { sync: (list) => shared.push(list), openWarning: (id) => opened.push(id) };
  await mount(serversTab({ selectServer: async () => after }, context));
  assert.ok(shared.length >= 1, 'the list read on mount is shared');
  await act(async () => button('LOCAL SERVER WARNING').click());
  assert.deepEqual(opened, ['s-1']);
  shared.length = 0;
  await act(async () => button('Use this server').click());
  assert.deepEqual(shared, [after], 'the new selection reaches sign-in and the status chip');
  assert.match(document.body.textContent, /Sign-in/);
  assert.match(document.body.textContent, /This server's own accounts/);
  assert.match(document.body.textContent, /never sends\s+your Mystic Paradox account to a local server/);
});

// ---- [2026-10-14 realms hub 6.2] "Host my realm" panel ------------------------------------------------------------
// The real panel, model and command wrappers run; only the native IPC (a small fake realm behind `invoke`), the server
// and account state and the icons are replaced. Polling runs on Node's mock clock.

const { mock } = require('node:test');
const RealButton = load('src/components/Button.tsx', {}).Button;
const RealTextField = load('src/components/TextField.tsx', {}).TextField;
const RealModal = load('src/components/Modal.tsx', {}).Modal;
const realmModel = load('src/p2p/realmHostModel.ts', {});

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const novaPlayer = { accountId: 'acc-nova', displayName: 'NovaBlade', where: { kind: 'HUB', sessionId: 'hub-1', huntId: null }, since: minutesAgo(52), route: 'DIRECT' };
const ashPlayer = { accountId: 'acc-ash', displayName: 'AshWarden', where: { kind: 'HUNT', sessionId: 'hunt-1', huntId: 'IslandA' }, since: minutesAgo(9), route: 'RELAY' };
const grimBan = { accountId: 'acc-grim', displayName: 'GrimTester', reason: 'Griefing in Ramsgate', at: minutesAgo(3 * 24 * 60) };
function realmStatus(patch = {}) {
  return {
    state: 'stopped', notice: null, noticeKind: 'info', realm: { name: 'ember-hold', serving: false },
    hub: null, training: null, hunts: [], players: [], bans: [],
    capacity: { maxPlayers: 16, maxServers: 3, activeServers: 0, afkSeconds: 1200, freeMemMiB: 9800, totalMemMiB: 16384 },
    ...patch,
  };
}
const onlineStatus = (patch = {}) => realmStatus({
  state: 'online', realm: { name: 'ember-hold', serving: true },
  hub: { sessionId: 'hub-1', state: 'RUNNING', startedAt: minutesAgo(84), players: 1 },
  training: { sessionId: 'train-1', state: 'RUNNING', players: 0 },
  hunts: [{ sessionId: 'hunt-1', huntId: 'IslandA', state: 'RUNNING', players: 1 }],
  players: [novaPlayer, ashPlayer], bans: [grimBan],
  capacity: { maxPlayers: 16, maxServers: 3, activeServers: 3, afkSeconds: 1200, freeMemMiB: 6300, totalMemMiB: 16384 },
  ...patch,
});

// A small fake of the launcher's realm host: every command answers the whole refreshed status, like the real ones.
function fakeNative(initial) {
  const native = { status: initial, fail: {}, refuse: {}, calls: [] };
  const patch = (changes) => (native.status = { ...native.status, ...changes });
  native.invoke = (command, args) => {
    native.calls.push([command, args]);
    return Promise.resolve().then(() => {
      if (native.fail[command]) throw native.fail[command];
      // The launcher answers a refusal as the status's notice, not as a failed call (realm.rs).
      if (native.refuse[command]) return patch({ notice: native.refuse[command], noticeKind: 'error' });
      const { status } = native;
      switch (command) {
        case 'realm_host_status': return status;
        case 'realm_host_start': return patch({ state: 'starting', notice: null, capacity: { ...status.capacity, ...args.options } });
        case 'realm_host_stop': return patch({ state: 'stopping' });
        // A member action answers its own notice, as realm.rs does (an earlier refusal does not linger).
        case 'realm_host_kick': return patch({ players: status.players.filter((player) => player.accountId !== args.accountId), notice: 'The player was removed from the realm.', noticeKind: 'info' });
        case 'realm_host_ban': {
          const target = status.players.find((player) => player.accountId === args.accountId);
          return patch({
            players: status.players.filter((player) => player.accountId !== args.accountId),
            bans: [...status.bans, { accountId: args.accountId, displayName: target?.displayName ?? null, reason: args.reason, at: new Date().toISOString() }],
            notice: 'The player was banned from the realm.',
            noticeKind: 'info',
          });
        }
        case 'realm_host_unban': return patch({ bans: status.bans.filter((ban) => ban.accountId !== args.accountId), notice: 'The ban was lifted.', noticeKind: 'info' });
        case 'realm_host_set_limits': return patch({ capacity: { ...status.capacity, ...args.options } });
        default: throw `unknown command ${command}`;
      }
    });
  };
  native.sent = (command) => native.calls.filter(([name]) => name === command);
  return native;
}

const officialSelected = { ready: true, selected: officialEntry };
function realmPanel(native, { server = officialSelected, self = 'host-account' } = {}) {
  const api = load('src/p2p/realmHostApi.ts', { '@tauri-apps/api/core': { invoke: native.invoke } });
  return load('src/p2p/RealmHostPanel.tsx', {
    '../auth/AuthContext': { useAuth: () => ({ account: { userId: self, displayName: 'Host' } }) },
    '../components/Button': { Button: RealButton },
    '../components/Modal': { Modal: RealModal },
    '../components/TextField': { TextField: RealTextField },
    '../components/RealmTrustNote': realmTrustNote,
    '../components/icons': icons,
    '../lib/sessions': sessionsLib,
    '../servers/ServerContext': { useServer: () => server },
    './realmHostApi': api,
    './realmHostModel': realmModel,
    './realmHost.css': {},
  }).default;
}

async function withMockTimers(run) {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await run();
  } finally {
    if (root) {
      await act(async () => root.unmount());
      root = undefined;
    }
    mock.timers.reset();
  }
}
const tick = (ms) => act(async () => mock.timers.tick(ms));
const realmText = () => document.querySelector('.rh')?.textContent ?? '';
const dialogEl = () => document.querySelector('[role="dialog"]');
const dialogButton = (label) => [...dialogEl().querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const rowFor = (name) => [...document.querySelectorAll('.rh-row')].find((row) => row.textContent.includes(name));
const rowButton = (name, label) => [...rowFor(name).querySelectorAll('button')].find((item) => item.textContent.trim() === label);
function inputOf(label) {
  const element = [...document.querySelectorAll('label')].find((item) => item.textContent.startsWith(label));
  return element ? document.getElementById(element.htmlFor) : null;
}
const meterOf = (label) => document.querySelector(`[role="meter"][aria-label="${label}"]`);
async function unmountNow() {
  if (root) {
    await act(async () => root.unmount());
    root = undefined;
  }
}

test('Start realm sends the limits, shows Starting, then Online with servers and players', async () => {
  const native = fakeNative(realmStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.deepEqual(native.calls[0], ['realm_host_status', undefined]);
    let text = realmText();
    assert.match(text, /Host my realm/);
    assert.match(text, /Stopped/);
    assert.match(text, /ember-hold/);
    assert.match(text, /Hosting runs Ramsgate, Training and hunts on this PC\. Players on it use their official accounts\./);
    assert.match(text, /Only join realms and invite players you trust/, 'the host panel carries the trust warning');
    assert.equal(inputOf('Max players').value, '16');
    assert.equal(inputOf('Max servers').value, '3');
    assert.equal(inputOf('AFK kick').value, '1200');
    assert.equal(button('Stop realm'), undefined);
    assert.equal(document.querySelector('.rh-list'), null, 'no player list while the realm is stopped');

    await act(async () => typeInto(inputOf('Max players'), '24'));
    await act(async () => button('Start realm').click());
    assert.deepEqual(native.sent('realm_host_start'), [['realm_host_start', { options: { maxPlayers: 24, maxServers: 3, afkSeconds: 1200 } }]]);
    assert.match(realmText(), /Starting…/);
    assert.ok(button('Stop realm'), 'Start turns into Stop while the realm starts');
    assert.equal(inputOf('Max players').disabled, true, 'the limits are fixed while the realm starts');
    assert.equal(inputOf('Max players').value, '24', 'the form shows the limits the launcher reports');

    native.status = onlineStatus({ capacity: { ...onlineStatus().capacity, maxPlayers: 24 } });
    await tick(5000);
    text = realmText();
    assert.match(text, /Online/);
    assert.match(text, /Serving/);
    assert.match(text, /Read at \d{1,2}:\d{2}/, 'the players list says when the status it shows was read');
    assert.match(text, /Online for 1 h 24 min\./);
    assert.match(text, /NovaBlade/);
    assert.match(text, /AshWarden/);
    assert.match(rowFor('NovaBlade').textContent, /Ramsgate/);
    assert.match(rowFor('NovaBlade').textContent, /Direct/);
    assert.match(rowFor('AshWarden').textContent, /Hunt IslandA/);
    assert.match(rowFor('AshWarden').textContent, /Relay/);
    assert.match(text, /Running · 1 player/);
    assert.equal(button('Start realm'), undefined);
    assert.equal(inputOf('Max players').disabled, false, 'the limits can change while the realm is online');
  });
});

test('a refused Start shows the launcher\'s message as written and can be retried', async () => {
  const native = fakeNative(realmStatus());
  native.fail.realm_host_start = 'Not enough free memory to start the realm (2.1 GB free, 3 GB needed).';
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => button('Start realm').click());
    assert.match(realmText(), /Not enough free memory to start the realm \(2\.1 GB free, 3 GB needed\)\./);
    assert.ok(document.querySelector('.rh [role="alert"]'), 'announced as an alert');
    assert.match(realmText(), /Stopped/);
    assert.equal(button('Start realm').disabled, false);
    native.fail.realm_host_start = null;
    await act(async () => button('Start realm').click());
    assert.doesNotMatch(realmText(), /Not enough free memory/, 'the old refusal is cleared by the next attempt');
    assert.match(realmText(), /Starting…/);
  });
});

test('a refusal the launcher answers as its notice is shown as written, and nothing starts', async () => {
  const native = fakeNative(realmStatus());
  native.refuse.realm_host_start = 'Not enough free memory to start the realm (2.1 GB free, 3 GB needed).';
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => button('Start realm').click());
    assert.match(realmText(), /Not enough free memory to start the realm \(2\.1 GB free, 3 GB needed\)\./);
    assert.equal(document.querySelector('.rh-notice').dataset.tone, 'bad');
    assert.equal(document.querySelector('.rh [role="alert"]'), null, 'a notice is not a failed call');
    assert.match(realmText(), /Stopped/);
    assert.equal(button('Start realm').disabled, false);
    await tick(5000);
    assert.match(realmText(), /Not enough free memory/, 'the launcher keeps the notice for the next read');
    native.refuse.realm_host_start = null;
    await act(async () => button('Start realm').click());
    assert.doesNotMatch(realmText(), /Not enough free memory/, 'a start that works clears the old notice');
    assert.match(realmText(), /Starting…/);
  });
});

test('a status that cannot be read is explained, keeps Start off, and the next poll recovers', async () => {
  const native = fakeNative(realmStatus());
  native.fail.realm_host_status = 'The launcher could not reach the Mystic Paradox backend.';
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.match(realmText(), /Couldn't read the realm status\. The launcher could not reach the Mystic Paradox backend\./);
    assert.equal(button('Start realm').disabled, true, 'nothing is started before the state is known');
    native.fail.realm_host_status = null;
    await tick(5000);
    assert.doesNotMatch(realmText(), /Couldn't read the realm status/);
    assert.equal(button('Start realm').disabled, false);
  });
});

test('restarting and stopped realms show the launcher\'s notice', async () => {
  const native = fakeNative(onlineStatus({ state: 'restarting', notice: 'The Ramsgate server closed. Restarting it (attempt 2 of 5).' }));
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.match(realmText(), /Restarting…/);
    assert.match(realmText(), /The Ramsgate server closed\. Restarting it \(attempt 2 of 5\)\./);
    assert.equal(document.querySelector('.rh-notice').dataset.tone, 'warn');
    assert.ok(button('Stop realm'), 'a restarting realm can still be stopped');
    native.status = realmStatus({ notice: 'The realm stopped after 5 restarts in 10 minutes.', noticeKind: 'error' });
    await tick(5000);
    assert.match(realmText(), /Stopped/);
    assert.match(realmText(), /stopped after 5 restarts/);
    assert.equal(document.querySelector('.rh-notice').dataset.tone, 'bad');
    assert.ok(button('Start realm'));
  });
});

test('limits are validated before anything is sent', async () => {
  const native = fakeNative(realmStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    for (const bad of ['0', '65', 'abc', '', '1.5', '-3']) {
      await act(async () => typeInto(inputOf('Max players'), bad));
      assert.match(realmText(), /Enter a whole number from 1 to 64\./, `players "${bad}"`);
      assert.equal(button('Start realm').disabled, true);
    }
    await act(async () => typeInto(inputOf('Max players'), '64'));
    assert.doesNotMatch(realmText(), /Enter a whole number from 1 to 64/);
    assert.equal(button('Start realm').disabled, false);

    for (const bad of ['0', '9', 'x']) {
      await act(async () => typeInto(inputOf('Max servers'), bad));
      assert.match(realmText(), /Enter a whole number from 1 to 8\./, `servers "${bad}"`);
      assert.equal(button('Start realm').disabled, true);
    }
    await act(async () => typeInto(inputOf('Max servers'), '8'));

    for (const bad of ['7201', '-1', 'abc', '1e3']) {
      await act(async () => typeInto(inputOf('AFK kick'), bad));
      assert.match(realmText(), /Enter seconds from 0 to 7200, or leave it empty for the default\./, `afk "${bad}"`);
      assert.equal(button('Start realm').disabled, true);
    }
    await act(async () => button('Start realm').click());
    assert.equal(native.sent('realm_host_start').length, 0, 'an invalid form sends nothing');

    await act(async () => typeInto(inputOf('AFK kick'), '0'));
    assert.match(realmText(), /Idle players are never removed\./);
    await act(async () => typeInto(inputOf('AFK kick'), '90'));
    assert.match(realmText(), /Idle players are removed after 1 min 30 s\./);
    await act(async () => typeInto(inputOf('AFK kick'), ''));
    assert.match(realmText(), /Leave empty to use the default\./);
    await act(async () => typeInto(inputOf('Max players'), ' 8 '));
    await act(async () => typeInto(inputOf('Max servers'), '2'));
    await act(async () => button('Start realm').click());
    assert.deepEqual(native.sent('realm_host_start'), [['realm_host_start', { options: { maxPlayers: 8, maxServers: 2, afkSeconds: null } }]],
      'an empty AFK field is the launcher default (null)');
  });
});

test('while online the limits are applied with Apply limits, and a poll does not overwrite what is typed', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.match(realmText(), /Max servers applies at once\. Max players and AFK apply when Ramsgate next starts\./);
    assert.equal(button('Apply limits').disabled, true, 'nothing to apply yet');
    assert.equal(button('Reset'), undefined);
    await act(async () => typeInto(inputOf('Max servers'), '5'));
    assert.equal(button('Apply limits').disabled, false);
    native.status = onlineStatus({ capacity: { ...onlineStatus().capacity, maxServers: 2 } });
    await tick(5000);
    assert.equal(inputOf('Max servers').value, '5', 'an edit in progress is kept');

    await act(async () => typeInto(inputOf('Max servers'), '9'));
    assert.equal(button('Apply limits').disabled, true, 'an invalid value cannot be applied');
    await act(async () => button('Reset').click());
    assert.equal(inputOf('Max servers').value, '2', 'Reset brings back what the launcher reports');
    assert.equal(button('Apply limits').disabled, true);

    await act(async () => typeInto(inputOf('Max servers'), '5'));
    await act(async () => typeInto(inputOf('AFK kick'), '0'));
    await act(async () => button('Apply limits').click());
    assert.deepEqual(native.sent('realm_host_set_limits'), [['realm_host_set_limits', { options: { maxPlayers: 16, maxServers: 5, afkSeconds: 0 } }]]);
    assert.equal(inputOf('Max servers').value, '5');
    assert.equal(button('Apply limits').disabled, true, 'applied');
    native.status = onlineStatus({ capacity: { ...onlineStatus().capacity, maxServers: 4 } });
    await tick(5000);
    assert.equal(inputOf('Max servers').value, '4', 'with nothing pending, the form follows the launcher again');
  });
});

test('capacity meters show servers, players and free memory, and warn when they run short', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.equal(meterOf('Servers in use').getAttribute('aria-valuetext'), '3 of 3');
    assert.equal(meterOf('Servers in use').getAttribute('aria-valuenow'), '100');
    assert.equal(meterOf('Servers in use').closest('.rh-meter').dataset.tone, 'warn', 'full');
    assert.equal(meterOf('Players').getAttribute('aria-valuetext'), '2 of 16');
    assert.equal(meterOf('Players').closest('.rh-meter').dataset.tone, 'ok');
    assert.equal(meterOf('Free memory').getAttribute('aria-valuetext'), '6.2 GB free of 16 GB');
    assert.equal(meterOf('Free memory').closest('.rh-meter').dataset.tone, 'ok');

    native.status = onlineStatus({ capacity: { ...onlineStatus().capacity, activeServers: 1, freeMemMiB: 2000 } });
    await tick(5000);
    assert.equal(meterOf('Servers in use').closest('.rh-meter').dataset.tone, 'ok');
    assert.equal(meterOf('Free memory').closest('.rh-meter').dataset.tone, 'warn');
    native.status = onlineStatus({ capacity: { ...onlineStatus().capacity, freeMemMiB: 900 } });
    await tick(5000);
    assert.equal(meterOf('Free memory').closest('.rh-meter').dataset.tone, 'bad');
  });
});

test('Kick asks first, Cancel sends nothing, and confirming removes the player', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => rowButton('NovaBlade', 'Kick').click());
    assert.ok(dialogEl());
    assert.match(dialogEl().textContent, /Kick NovaBlade\?/);
    assert.equal(native.sent('realm_host_kick').length, 0, 'the first click only asks');
    await act(async () => dialogButton('Cancel').click());
    assert.ok(!dialogEl());
    assert.equal(native.sent('realm_host_kick').length, 0);

    await act(async () => rowButton('NovaBlade', 'Kick').click());
    await act(async () => dialogButton('Kick').click());
    assert.deepEqual(native.sent('realm_host_kick'), [['realm_host_kick', { accountId: 'acc-nova' }]]);
    assert.ok(!dialogEl());
    assert.equal(rowFor('NovaBlade'), undefined, 'the player is gone from the list');
    assert.ok(rowFor('AshWarden'));

    native.fail.realm_host_kick = 'That player is not in the realm any more.';
    await act(async () => rowButton('AshWarden', 'Kick').click());
    await act(async () => dialogButton('Kick').click());
    assert.ok(dialogEl(), 'a refusal keeps the dialog open');
    assert.match(dialogEl().textContent, /That player is not in the realm any more\./);
    await act(async () => dialogButton('Cancel').click());
    assert.ok(!dialogEl());
  });
});

test('Ban takes an optional reason and lists the player as banned, and Unban lifts it', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    assert.match(rowFor('GrimTester').textContent, /Reason: Griefing in Ramsgate/);

    await act(async () => rowButton('AshWarden', 'Ban').click());
    assert.match(dialogEl().textContent, /Ban AshWarden\?/);
    assert.match(dialogEl().textContent, /cannot join your realm until you unban them/);
    assert.equal(native.sent('realm_host_ban').length, 0, 'the first click only asks');
    await act(async () => typeInto(dialogEl().querySelector('input'), '  Spamming chat  '));
    await act(async () => dialogButton('Ban').click());
    assert.deepEqual(native.sent('realm_host_ban'), [['realm_host_ban', { accountId: 'acc-ash', reason: 'Spamming chat' }]]);
    assert.ok(!dialogEl());
    assert.match(rowFor('AshWarden').textContent, /Reason: Spamming chat/);
    assert.ok(rowButton('AshWarden', 'Unban'), 'the player moved from the players to the ban list');
    assert.equal(rowButton('AshWarden', 'Kick'), undefined);

    await act(async () => rowButton('NovaBlade', 'Ban').click());
    await act(async () => dialogButton('Ban').click());
    assert.deepEqual(native.sent('realm_host_ban')[1], ['realm_host_ban', { accountId: 'acc-nova', reason: null }], 'no reason is sent as null');
    assert.match(rowFor('NovaBlade').textContent, /No reason given/);
    assert.match(realmText(), /Nobody is in your realm right now\./);

    // [2026-10-14] Unban asks first, like kick and ban, so a refusal has a dialog to stay open in.
    await act(async () => rowButton('GrimTester', 'Unban').click());
    assert.equal(native.sent('realm_host_unban').length, 0, 'the first click only asks');
    assert.match(dialogEl().textContent, /Unban GrimTester\?/);
    await act(async () => dialogButton('Cancel').click());
    assert.ok(!dialogEl());
    assert.equal(native.sent('realm_host_unban').length, 0, 'cancel sends nothing');
    await act(async () => rowButton('GrimTester', 'Unban').click());
    await act(async () => dialogButton('Unban').click());
    assert.deepEqual(native.sent('realm_host_unban'), [['realm_host_unban', { accountId: 'acc-grim' }]]);
    assert.equal(rowFor('GrimTester'), undefined);
    for (const name of ['AshWarden', 'NovaBlade']) {
      await act(async () => rowButton(name, 'Unban').click());
      await act(async () => dialogButton('Unban').click());
    }
    assert.match(realmText(), /No one is banned\./);
    assert.equal(native.sent('realm_host_unban').length, 3);
  });
});

test('Stop realm asks first, says who will be disconnected, and stops on confirm', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => button('Stop realm').click());
    assert.match(dialogEl().textContent, /Stop your realm\?/);
    assert.match(dialogEl().textContent, /2 players will be disconnected/);
    assert.equal(native.sent('realm_host_stop').length, 0, 'the first click only asks');
    await act(async () => dialogButton('Keep running').click());
    assert.ok(!dialogEl());
    assert.equal(native.sent('realm_host_stop').length, 0);

    await act(async () => button('Stop realm').click());
    await act(async () => dialogButton('Stop realm').click());
    assert.equal(native.sent('realm_host_stop').length, 1);
    assert.ok(!dialogEl());
    assert.match(realmText(), /Stopping…/);
    assert.equal(button('Stopping…').disabled, true);

    native.status = realmStatus();
    await tick(5000);
    assert.match(realmText(), /Stopped/);
    assert.ok(button('Start realm'));
    assert.doesNotMatch(realmText(), /NovaBlade/);
  });
});

test('the host\'s own row has no Kick or Ban', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native, { self: 'acc-nova' }));
    assert.match(rowFor('NovaBlade').textContent, /You/);
    assert.equal(rowButton('NovaBlade', 'Kick'), undefined);
    assert.equal(rowButton('NovaBlade', 'Ban'), undefined);
    assert.ok(rowButton('AshWarden', 'Kick'));
    assert.ok(rowButton('AshWarden', 'Ban'));
  });
});

test('the status is read every 5 s while the panel is visible, and not while it is hidden or gone', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    const reads = () => native.sent('realm_host_status').length;
    assert.equal(reads(), 1, 'one read as soon as the panel shows');
    await tick(4999);
    assert.equal(reads(), 1);
    await tick(1);
    assert.equal(reads(), 2);
    await tick(10_000);
    assert.equal(reads(), 4);

    const visibility = (value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      return act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
    };
    await visibility('hidden');
    await tick(30_000);
    assert.equal(reads(), 4, 'no reads while the window is hidden');
    await visibility('visible');
    assert.equal(reads(), 5, 'coming back reads at once');
    await tick(5000);
    assert.equal(reads(), 6);

    await act(async () => root.unmount());
    root = undefined;
    await tick(30_000);
    assert.equal(reads(), 6, 'leaving the page stops the polling');
  });
});

test('a status read that began before an action finished cannot replace the action\'s answer', async () => {
  const native = fakeNative(realmStatus());
  const late = deferred();
  let holdNext = false;
  const answer = native.invoke;
  native.invoke = (command, args) => {
    if (command === 'realm_host_status' && holdNext) {
      holdNext = false;
      native.calls.push([command, args]);
      return late.promise;
    }
    return answer(command, args);
  };
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    holdNext = true;
    await tick(5000);
    await act(async () => button('Start realm').click());
    assert.match(realmText(), /Starting…/);
    await act(async () => late.resolve(realmStatus()));
    assert.match(realmText(), /Starting…/, 'the old "stopped" read arrived late and was dropped');
    assert.doesNotMatch(realmText(), /Stopped/);
  });
});

test('the panel is absent for a local server and reads nothing', async () => {
  const native = fakeNative(onlineStatus());
  await withMockTimers(async () => {
    await mount(realmPanel(native, { server: { ready: true, selected: { ...localEntry, selected: true, acknowledged: true } } }));
    assert.equal(document.querySelector('.rh'), null);
    assert.equal(document.body.textContent, '');
    await tick(30_000);
    assert.deepEqual(native.calls, [], 'no status read, no command of any kind');
  });
});

test('the panel shows for the official server and for Paradox realms, once the server list is known', async () => {
  const cases = [
    [{ ready: true, selected: officialEntry }, true],
    [{ ready: true, selected: { ...officialEntry, id: 's-2', kind: 'paradox_realm', name: 'Ember Hold', realmName: 'ember-hold' } }, true],
    [{ ready: true, selected: null }, false],
    [{ ready: false, selected: null }, false],
    [{ ready: true, selected: { ...localEntry, selected: true } }, false],
  ];
  await withMockTimers(async () => {
    for (const [server, shown] of cases) {
      const native = fakeNative(realmStatus());
      await unmountNow();
      await mount(realmPanel(native, { server }));
      assert.equal(document.querySelector('.rh') != null, shown, JSON.stringify(server.selected?.kind ?? server));
      assert.equal(native.calls.length > 0, shown, 'it reads the status only when shown');
    }
  });
});

// [2026-10-14] The Servers page: the add form first, the server list below it. The optional panels are not here; they
// are on the Host realm page (below).
test('Servers & realms puts the add form above the server list and shows no optional panel', async () => {
  const Panel = ({ style }) => React.createElement('section', { id: 'optional-panel', 'data-i': String(style['--i']) }, 'Panel body');
  await mount(serversTab({}, serverCtx, [Panel]));
  assert.equal(document.getElementById('optional-panel'), null, 'the optional panels belong to the Host realm page');
  assert.equal(document.querySelector('h1').textContent, 'Servers & realms');
  const list = document.querySelector('[aria-label="Your servers"]');
  const add = document.querySelector('[aria-label="Add a server"]');
  assert.ok(add.compareDocumentPosition(list) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the server list follows the add form');
  assert.ok(Number(add.style.getPropertyValue('--i')) < Number(list.style.getPropertyValue('--i')));
});

// [2026-10-14] The Host realm page: the header, then every optional panel, in order.
test('the Host realm page shows the optional module panels under its header', async () => {
  const { HostRealmTab } = load('src/screens/dashboard/HostRealmTab.tsx', {
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../lib/optionalPanels': { OPTIONAL_PANELS: [({ style }) => React.createElement('section', { id: 'panel-a', 'data-i': String(style['--i']) }, 'A'), ({ style }) => React.createElement('section', { id: 'panel-b', 'data-i': String(style['--i']) }, 'B')] },
  });
  await mount(HostRealmTab);
  assert.equal(document.querySelector('h1').textContent, 'Host realm');
  const a = document.getElementById('panel-a');
  const b = document.getElementById('panel-b');
  assert.ok(a && b);
  assert.ok(Number(a.dataset.i) < Number(b.dataset.i), 'the panels enter in order');
  assert.ok(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('the Host realm page renders no panel when none is present (a public build)', async () => {
  const { HostRealmTab } = load('src/screens/dashboard/HostRealmTab.tsx', {
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../lib/optionalPanels': { OPTIONAL_PANELS: [] },
  });
  await mount(HostRealmTab);
  assert.equal(document.querySelectorAll('section.glass').length, 0);
  assert.match(document.body.textContent, /Host realm/);
});

// [2026-10-14] The trust warning: the same words in the join popup, the host panel and the add form (for a realm).
test('the realm trust warning is said wherever a realm is joined, hosted or added', async () => {
  const warned = /Only join realms and invite players you trust/;
  await mount(realmTrustNote.RealmTrustNote);
  assert.match(document.body.textContent, warned);
  assert.match(document.body.textContent, /tell the realm's host/);
  await unmountNow();
  const realmForm = addServerForm({ addServer: async () => [] }, serverCtx);
  await mount(realmForm, {});
  assert.match(document.body.textContent, warned, 'a realm is the default kind of the add form');
  await unmountNow();
  const localForm = addServerForm({ addServer: async () => [] }, serverCtx);
  await mount(localForm, {});
  await act(async () => button('Local server').click());
  assert.doesNotMatch(document.body.textContent, warned, 'a local server has its own warning, not this one');
});

test('realm host helpers name places, validate limits and read memory', () => {
  const model = realmModel;
  assert.equal(model.describeWhere({ kind: 'HUB', huntId: null }), 'Ramsgate');
  assert.equal(model.describeWhere({ kind: 'TRAINING', huntId: null }), 'Training');
  assert.equal(model.describeWhere({ kind: 'HUNT', huntId: 'IslandA' }), 'Hunt IslandA');
  assert.equal(model.describeWhere({ kind: 'HUNT', huntId: null }), 'Hunt');
  assert.equal(model.describeRoute('DIRECT'), 'Direct');
  assert.equal(model.describeRoute('UNKNOWN'), null);
  assert.equal(model.describeRoute(null), null);

  const valid = (players, servers, afk) => model.validateLimits({ maxPlayers: players, maxServers: servers, afkSeconds: afk });
  assert.deepEqual(valid('64', '8', '0').limits, { maxPlayers: 64, maxServers: 8, afkSeconds: 0 });
  assert.deepEqual(valid('1', '1', '7200').limits, { maxPlayers: 1, maxServers: 1, afkSeconds: 7200 });
  assert.deepEqual(valid(' 12 ', '3', '').limits, { maxPlayers: 12, maxServers: 3, afkSeconds: null });
  assert.equal(valid('65', '3', '').limits, null);
  assert.equal(valid('12', '0', '').limits, null);
  assert.equal(valid('12', '3', '7201').limits, null);
  assert.deepEqual(Object.keys(valid('x', 'y', 'z').errors).sort(), ['afkSeconds', 'maxPlayers', 'maxServers']);

  assert.equal(model.formatSeconds(45), '45 s');
  assert.equal(model.formatSeconds(90), '1 min 30 s');
  assert.equal(model.formatSeconds(1200), '20 min');
  assert.equal(model.formatSeconds(5400), '1 h 30 min');
  assert.equal(model.formatMiB(512), '512 MB');
  assert.equal(model.formatMiB(1024), '1 GB');
  assert.equal(model.formatMiB(6300), '6.2 GB');
  assert.equal(model.memoryTone(900), 'bad');
  assert.equal(model.memoryTone(2000), 'warn');
  assert.equal(model.memoryTone(3072), 'ok');
  assert.equal(model.prettify('HOST_READY'), 'Host ready');
  assert.equal(model.plural(1, 'player'), '1 player');
  assert.equal(model.plural(2, 'player'), '2 players');
  assert.equal(model.fraction(5, 0), 0);
  assert.equal(model.fraction(5, 3), 1);
  assert.equal(model.fraction(-1, 3), 0);
  assert.ok(Math.abs(model.fraction(2, 3) - 2 / 3) < 1e-9);
});

// ---- [2026-10-14 realms] The host of a realm, its ownership warning, the realm notices, and adding from the sign-in card ----

const DIRECTORY_KEY = 'KEY-0123456789abcdefghijklmnop';
const NEW_KEY = 'KEY-NEWHOST0123456789abcd';
const fingerprintOf = (key) => (key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-8)}`);
// What the realm directory answers for ember-hold, and the same name after it changed hands.
const tempest = { name: 'ember-hold', hostName: 'Tempest', hostPublicKey: DIRECTORY_KEY, fingerprint: fingerprintOf(DIRECTORY_KEY), online: true, serving: true, ownershipChanged: false };
const ashen = { ...tempest, hostName: 'Ashen Guild', hostPublicKey: NEW_KEY, fingerprint: fingerprintOf(NEW_KEY), ownershipChanged: true };
const emberRealm = {
  id: 's-realm', kind: 'paradox_realm', name: 'Ember Hold', realmName: 'ember-hold', hostPublicKey: null, selected: true,
  removable: true, located: true, usesOfficialFeed: true, acknowledged: true, warningRemembered: false,
  gameExePath: 'D:\\Games\\Ember\\Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe',
};
const agreedRealm = { ...emberRealm, hostPublicKey: DIRECTORY_KEY };

// The provider as the app mounts it. `log.trust` is the hook's value after the last render.
function trustHarness(api = {}, selected = undefined) {
  const log = { stored: [], synced: [], handlers: [], trust: null };
  const realm = load('src/servers/RealmTrust.tsx', {
    './serverNames': serverNames,
    '../api/tauri': {
      realmLookup: async () => tempest,
      setRealmHostKey: async (serverId, key) => { log.stored.push([serverId, key]); return [officialServer]; },
      onRealmNotice: async (handler) => { log.handlers.push(handler); return () => {}; },
      ...api,
    },
    '../components/Button': { Button: RealButton },
    '../components/Modal': { Modal: RealModal },
    '../components/RealmTrustNote': realmTrustNote,
    './ServerContext': { useServer: () => ({ sync: (list) => log.synced.push(list), selected }) },
  });
  function Probe() {
    log.trust = realm.useRealmTrust();
    return null;
  }
  const App = () => React.createElement(realm.RealmTrustProvider, null, React.createElement(Probe));
  return { log, App };
}

test('adding a realm asks to join its host, and Join stores the key the popup showed', async () => {
  const h = trustHarness();
  await mount(h.App);
  let decision;
  await act(async () => { decision = h.log.trust.ensureHost(emberRealm); });
  assert.match(dialogEl().textContent, /Join realm ember-hold hosted by Tempest\?/);
  assert.match(dialogEl().textContent, new RegExp(fingerprintOf(DIRECTORY_KEY)));
  assert.match(dialogEl().textContent, /Only join realms and invite players you trust/, 'the join popup carries the trust warning');
  await act(async () => dialogButton('Join realm').click());
  assert.deepEqual(h.log.stored, [['s-realm', DIRECTORY_KEY]]);
  assert.equal(await decision, true);
  assert.ok(!dialogEl());
  assert.equal(h.log.synced.length, 1, 'the refreshed list is handed to the shared server state');
});

test('a realm whose host has no display name is still asked about, by its name', async () => {
  const h = trustHarness({ realmLookup: async () => ({ ...tempest, hostName: null }) });
  await mount(h.App);
  let decision;
  await act(async () => { decision = h.log.trust.ensureHost(emberRealm); });
  assert.match(dialogEl().textContent, /Join realm ember-hold\? Its host has not given a name\./);
  await act(async () => dialogButton('Cancel').click());
  assert.equal(await decision, false);
});

test('Cancel in the join popup stores nothing, and the Play or add that asked does not go on', async () => {
  const h = trustHarness();
  await mount(h.App);
  let decision;
  await act(async () => { decision = h.log.trust.ensureHost(emberRealm); });
  await act(async () => dialogButton('Cancel').click());
  assert.equal(await decision, false);
  assert.deepEqual(h.log.stored, []);
  assert.ok(!dialogEl());
});

test('a realm whose host is already agreed is not looked up or asked about again', async () => {
  let looked = 0;
  const h = trustHarness({ realmLookup: async () => { looked++; return tempest; } });
  await mount(h.App);
  let agreed;
  await act(async () => { agreed = h.log.trust.ensureHost(agreedRealm); });
  assert.equal(await agreed, true);
  assert.equal(looked, 0);
  assert.ok(!dialogEl());
});

test('without an official sign-in the directory cannot be asked, and the readable reason reaches the caller', async () => {
  const h = trustHarness({ realmLookup: async () => { throw 'Sign in to Mystic Paradox to look up this realm.'; } });
  await mount(h.App);
  let failure;
  await act(async () => { failure = h.log.trust.ensureHost(emberRealm).catch((error) => error); });
  assert.equal(await failure, 'Sign in to Mystic Paradox to look up this realm.');
  assert.ok(!dialogEl(), 'no popup for a realm nobody could look up');
  assert.deepEqual(h.log.stored, []);
});

test('a realm whose name now belongs to another host warns, and Trust the new host stores the new key', async () => {
  const h = trustHarness({ realmLookup: async () => ashen });
  await mount(h.App);
  let decision;
  await act(async () => { decision = h.log.trust.trustNewHost(agreedRealm); });
  assert.match(dialogEl().textContent, /This realm has a new host/);
  assert.match(dialogEl().textContent, /The realm ember-hold now belongs to a different host, Ashen Guild\./);
  await act(async () => dialogButton('Trust the new host').click());
  assert.deepEqual(h.log.stored, [['s-realm', NEW_KEY]]);
  assert.equal(await decision, true);
});

test('Cancel in the warning keeps the old host and resolves false', async () => {
  const h = trustHarness({ realmLookup: async () => ashen });
  await mount(h.App);
  let decision;
  await act(async () => { decision = h.log.trust.trustNewHost(agreedRealm); });
  await act(async () => dialogButton('Cancel').click());
  assert.equal(await decision, false);
  assert.deepEqual(h.log.stored, [], 'the earlier key is kept');
});

test('a warning the directory no longer confirms is explained, with no popup', async () => {
  const h = trustHarness({ realmLookup: async () => tempest });
  await mount(h.App);
  let failure;
  await act(async () => { failure = h.log.trust.trustNewHost(agreedRealm).catch((error) => error); });
  assert.match((await failure).message, /did not change\. Press Play again\./);
  assert.ok(!dialogEl());
});

test('a realm notice reaches the app, is kept until dismissed, and keeps its reason', async () => {
  const h = trustHarness();
  await mount(h.App);
  await act(async () => h.log.handlers.forEach((handler) => handler({ reason: 'BANNED', message: 'You were banned from this realm.' })));
  assert.equal(h.log.trust.notice.reason, 'BANNED');
  assert.equal(h.log.trust.notice.message, 'You were banned from this realm.');
  await act(async () => h.log.trust.dismissNotice());
  assert.equal(h.log.trust.notice, null);
});

test('Home shows a realm notice in a dismissible banner, muted when the host only went offline', async () => {
  let dismissed = 0;
  const trust = { ...noTrust(), notice: { reason: 'HOST_OFFLINE', message: 'The realm host went offline.' }, dismissNotice: () => { dismissed++; } };
  await mount(home({ secureLaunch: async () => {} }, undefined, undefined, { trust, selected: agreedRealm }));
  const banner = document.querySelector('.banner');
  assert.match(banner.textContent, /The realm host went offline\./);
  assert.equal(banner.dataset.tone, 'muted');
  await act(async () => button('Dismiss').click());
  assert.equal(dismissed, 1);
});

test('a removal or a ban on Home is a danger banner', async () => {
  const trust = { ...noTrust(), notice: { reason: 'KICKED', message: 'You were removed from the realm.' } };
  await mount(home({ secureLaunch: async () => {} }, undefined, undefined, { trust, selected: agreedRealm }));
  assert.equal(document.querySelector('.banner').dataset.tone, 'danger');
  assert.match(document.querySelector('.banner').textContent, /You were removed from the realm\./);
});

test('Play into a realm with no agreed host asks first, and starts nothing when the player cancels', async () => {
  const asked = [];
  let launches = 0;
  const trust = { ...noTrust(), ensureHost: async (server) => { asked.push(server.id); return false; } };
  await mount(home({ secureLaunch: async () => { launches++; } }, undefined, undefined, { trust, selected: emberRealm }));
  await act(async () => button('Play').click());
  assert.deepEqual(asked, ['s-realm']);
  assert.equal(launches, 0);
  assert.ok(button('Play'), 'Play is offered again');
  assert.ok(!document.querySelector('.launch-error'), 'cancelling is not an error');
});

test('Play into a realm starts once its host is agreed', async () => {
  let launches = 0;
  await mount(home({ secureLaunch: async () => { launches++; } }, undefined, undefined, { trust: noTrust(), selected: agreedRealm }));
  await act(async () => button('Play').click());
  assert.equal(launches, 1);
  assert.ok(button('Check status'));
});

test('Play refused because the realm changed hands asks the player, and trusting the new host plays again', async () => {
  const asked = [];
  let launches = 0;
  const trust = { ...noTrust(), trustNewHost: async (server) => { asked.push(server.id); return true; } };
  await mount(home({
    secureLaunch: async () => { launches++; if (launches === 1) throw 'REALM_OWNER_CHANGED'; },
  }, undefined, undefined, { trust, selected: agreedRealm }));
  await act(async () => button('Play').click());
  assert.deepEqual(asked, ['s-realm']);
  assert.equal(launches, 2);
  assert.ok(button('Check status'), 'the game started on the second attempt');
  assert.doesNotMatch(document.body.textContent, /REALM_OWNER_CHANGED/);
});

test('cancelling the ownership warning starts nothing and shows no error', async () => {
  let launches = 0;
  const trust = { ...noTrust(), trustNewHost: async () => false };
  await mount(home({ secureLaunch: async () => { launches++; throw 'REALM_OWNER_CHANGED'; } }, undefined, undefined, { trust, selected: agreedRealm }));
  await act(async () => button('Play').click());
  assert.equal(launches, 1);
  assert.ok(button('Play'), 'Play is offered again');
  assert.ok(!document.querySelector('.launch-error'));
});

test('a realm Play refused for want of an agreed host reads as a sentence, never as the token', async () => {
  let launches = 0;
  await mount(home({ secureLaunch: async () => { launches++; throw 'REALM_HOST_KEY_REQUIRED'; } }, undefined, undefined, { trust: noTrust(), selected: agreedRealm }));
  await act(async () => button('Play').click());
  assert.equal(launches, 1);
  assert.match(document.querySelector('.launch-error').textContent, /Confirm this realm's host before you play\./);
  assert.doesNotMatch(document.body.textContent, /REALM_HOST_KEY_REQUIRED/);
});

test('Servers: adding a realm asks for its host; without a sign-in the note says the host is confirmed at the first Play', async () => {
  const asked = [];
  const trust = { ...noTrust(), ensureHost: async (server) => { asked.push(server.id); throw new Error('Sign in to Mystic Paradox to look up this realm.'); } };
  await mount(serversTab({ addServer: async () => [officialServer, emberRealm] }, serverCtx, [], trust));
  await act(async () => typeInto(field('Realm name'), 'ember-hold'));
  await act(async () => button('Add server').click());
  assert.deepEqual(asked, ['s-realm']);
  assert.ok(document.querySelector('.server-row[data-kind="paradox_realm"]'), 'the list shows the realm that was added');
  // [2026-10-14] A realm is named by its realm name in every message.
  assert.match(document.body.textContent, /Added ember-hold\. You will be asked to confirm its host the first time you play\./);
});

test('Servers: a realm added and agreed to shows no host note', async () => {
  await mount(serversTab({ addServer: async () => [officialServer, emberRealm] }, serverCtx, [], noTrust()));
  await act(async () => typeInto(field('Realm name'), 'ember-hold'));
  await act(async () => button('Add server').click());
  assert.doesNotMatch(document.body.textContent, /confirm its host/);
});

// The sign-in card's switcher, with the shared add form under it.
function switcherContext(servers, extra = {}) {
  const selected = servers.find((server) => server.selected) ?? servers[0];
  return { servers, selected, select: async () => { throw new Error('a selection was not expected'); }, openWarning() {}, sync() {}, ...extra };
}
function serverSwitcher(api = {}, context = switcherContext([officialServer]), trust = noTrust()) {
  return load('src/components/ServerSwitcher.tsx', {
    '../servers/officialPlay': officialPlayLib,
    '../servers/ServerContext': { useServer: () => context },
    '../servers/AddServerForm': { AddServerForm: addServerForm(api, context, trust) },
    '../servers/serverNames': serverNames,
    './Dropdown': dropdownLib,
    './LocalServerWarning': { LocalServerBadge },
    './icons': icons,
  }).ServerSwitcher;
}
// The launcher's dropdown: the closed control is the combobox; a choice is a row of the open list (its data-value).
const switcherSelect = () => document.getElementById('server-switch-select');
async function chooseInSwitcher(value) {
  await act(async () => switcherSelect().click());
  await act(async () => document.querySelector(`[role="option"][data-value="${value}"]`).click());
}

test('the sign-in card offers Add a server... even when only the official server exists', async () => {
  await mount(serverSwitcher());
  assert.ok(switcherSelect(), 'the switcher is shown with one server');
  assert.equal(switcherSelect().getAttribute('role'), 'combobox');
  assert.match(switcherSelect().textContent, /Mystic Paradox/, 'the closed control shows the chosen server');
  await act(async () => switcherSelect().click());
  assert.ok([...document.querySelectorAll('[role="option"]')].some((option) => option.textContent === 'Add a server...'));
});

test('Add a server... on the sign-in card saves a local server and closes the form; nothing else is sent', async () => {
  const calls = [];
  const api = {
    addServer: async (request) => { calls.push(['addServer', request]); return [officialServer, { ...localServer, id: 's-2', name: 'Friends' }]; },
    acknowledgeLocalServer: async () => { calls.push(['acknowledge']); return []; },
    selectServer: async () => { calls.push(['select']); return []; },
  };
  await mount(serverSwitcher(api));
  await chooseInSwitcher('__add__');
  assert.ok(field('Name'), 'the add form opens under the switcher');
  await act(async () => button('Local server').click());
  await act(async () => typeInto(field('Name'), 'Friends'));
  await act(async () => typeInto(field('Server address'), 'https://friends.example.com'));
  await act(async () => button('Add server').click());
  assert.deepEqual(calls, [['addServer', { kind: 'local', name: 'Friends', backendUrl: 'https://friends.example.com' }]]);
  assert.ok(!field('Name'), 'the form closes once the server is saved');
  assert.match(document.body.textContent, /Added Friends\. Choose it in Server to use it\./);
});

test('Cancel on the sign-in card closes the add form without adding anything', async () => {
  const calls = [];
  await mount(serverSwitcher({ addServer: async (request) => { calls.push(request); return []; } }));
  await chooseInSwitcher('__add__');
  await act(async () => button('Cancel').click());
  assert.ok(!field('Name'));
  assert.deepEqual(calls, []);
});

test('a realm added on the sign-in card is stored at once; its host is confirmed at the first Play', async () => {
  const asked = [];
  const requests = [];
  const trust = { ...noTrust(), ensureHost: async (server) => { asked.push(server.id); throw new Error('Sign in to Mystic Paradox to look up this realm.'); } };
  await mount(serverSwitcher({
    addServer: async (request) => { requests.push(request); return [officialServer, emberRealm]; },
  }, switcherContext([officialServer]), trust));
  await chooseInSwitcher('__add__');
  await act(async () => typeInto(field('Realm name'), 'ember-hold'));
  await act(async () => button('Add server').click());
  assert.deepEqual(requests, [{ kind: 'paradox_realm', name: '', realmName: 'ember-hold' }]);
  assert.deepEqual(asked, ['s-realm']);
  assert.match(document.querySelector('.note').textContent, /Added ember-hold\. Choose it in Server to use it\./);
});

test('a refused kick keeps its dialog open and says why inside it; a kick that works closes it', async () => {
  const native = fakeNative(onlineStatus());
  native.refuse.realm_host_kick = 'The player could not be removed: the hub did not answer.';
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => rowButton('NovaBlade', 'Kick').click());
    await act(async () => dialogButton('Kick').click());
    assert.ok(dialogEl(), 'the dialog stays open on a refusal');
    assert.match(dialogEl().textContent, /The player could not be removed: the hub did not answer\./);
    assert.match(realmText(), /The player could not be removed/, 'the panel shows the refusal too');
    assert.equal(document.querySelector('.rh-notice').dataset.tone, 'bad');
    assert.equal(document.querySelector('.rh-notice').dataset.kind, 'error');
    assert.ok(rowFor('NovaBlade'), 'nobody was removed');
    native.refuse.realm_host_kick = null;
    await act(async () => dialogButton('Kick').click());
    assert.ok(!dialogEl(), 'a kick that works closes the dialog');
    assert.ok(!rowFor('NovaBlade'));
  });
});

test('a refused ban keeps its dialog open with the reason, and the player is not banned', async () => {
  const native = fakeNative(onlineStatus());
  native.refuse.realm_host_ban = 'The ban reason is too long.';
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    await act(async () => rowButton('AshWarden', 'Ban').click());
    await act(async () => dialogButton('Ban').click());
    assert.match(dialogEl().textContent, /The ban reason is too long\./);
    assert.ok(rowFor('AshWarden'), 'still in the realm');
    assert.ok(!rowButton('AshWarden', 'Unban'), 'not on the ban list');
  });
});

test('an informational notice is announced as status, not drawn as an error', async () => {
  const native = fakeNative(onlineStatus({ notice: 'The player and AFK limits apply when the hub next starts.', noticeKind: 'info' }));
  await withMockTimers(async () => {
    await mount(realmPanel(native));
    const notice = document.querySelector('.rh-notice');
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(notice.dataset.kind, 'info');
    assert.notEqual(notice.dataset.tone, 'bad');
  });
});

// ---- [2026-10-14] Terms of Use, consent and account deletion ----------------------------------------------------

const checkboxOf = (label) => [...document.querySelectorAll('label')].find((item) => item.textContent.startsWith(label))?.querySelector('input[type="checkbox"]');
const escapeKey = () => act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const titleOfDialog = () => document.querySelector('[role="dialog"] .modal-title')?.textContent;

test('the two documents in src/legal fill every placeholder from legalMeta', () => {
  const terms = legalText.fillLegalPlaceholders(fs.readFileSync(path.resolve(__dirname, '..', 'src/legal/terms.md'), 'utf8'));
  const privacy = legalText.fillLegalPlaceholders(fs.readFileSync(path.resolve(__dirname, '..', 'src/legal/privacy.md'), 'utf8'));
  for (const text of [terms, privacy]) {
    assert.equal(text.includes('{{'), false, 'no placeholder is left');
    assert.ok(text.includes(legalMeta.LEGAL.contactEmail));
    assert.ok(text.includes(`${legalMeta.LEGAL.minimumAge}`), 'the minimum age is stated');
  }
  assert.ok(terms.includes(`Version ${legalMeta.LEGAL.termsVersion}`));
  assert.ok(privacy.includes(`Version ${legalMeta.LEGAL.privacyVersion}`));
});

test('the document renderer shows headings, lists, bold, code and links, and keeps the list items whole', async () => {
  const source = ['# Title', '', '## 1. Part', '', 'A **bold** word, `code`, https://example.com/terms and privacy@mysticfox.dev.', '',
    '- one', '  continued', '- two', '', '1. first', '2. second'].join(NL);
  const nodes = legalMarkdown.renderLegalMarkdown(source, () => {});
  await mount(() => React.createElement('div', { id: 'doc' }, nodes));
  const doc = document.getElementById('doc');
  assert.equal(doc.querySelector('h3').textContent, 'Title');
  assert.equal(doc.querySelector('h4').textContent, '1. Part');
  assert.equal(doc.querySelector('strong').textContent, 'bold');
  assert.equal(doc.querySelector('code').textContent, 'code');
  assert.deepEqual([...doc.querySelectorAll('a')].map((link) => link.getAttribute('href')), ['https://example.com/terms', 'mailto:privacy@mysticfox.dev']);
  assert.deepEqual([...doc.querySelectorAll('ul > li')].map((item) => item.textContent), ['one continued', 'two']);
  assert.deepEqual([...doc.querySelectorAll('ol > li')].map((item) => item.textContent), ['first', 'second']);
});

test('a document cannot inject markup: its text stays text, and only web or mail addresses become links', async () => {
  const hostile = ['<img src=x onerror="alert(1)">', '', '[click](javascript:alert(1)) and javascript:alert(1) <b>bold</b>'].join(NL);
  const nodes = legalMarkdown.renderLegalMarkdown(hostile);
  await mount(() => React.createElement('div', { id: 'doc' }, nodes));
  const doc = document.getElementById('doc');
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelector('b'), null);
  assert.equal(doc.querySelectorAll('a').length, 0);
  assert.ok(doc.textContent.includes('<img src=x'));
});

test('Escape closes only the innermost dialog, so a document opened from a dialog closes by itself', async () => {
  const outer = [], inner = [];
  // The document is opened later, from a button in the dialog, as it is in the launcher.
  const Stack = ({ showInner }) => React.createElement(ModalReal, { title: 'Consent', onClose: () => outer.push('outer') },
    showInner ? React.createElement(ModalReal, { title: 'Terms', onClose: () => inner.push('inner') }, 'Text') : null);
  await mount(Stack, { showInner: false });
  await act(async () => root.render(React.createElement(Stack, { showInner: true })));
  await escapeKey();
  assert.deepEqual(inner, ['inner']);
  assert.deepEqual(outer, []);
  await act(async () => root.render(React.createElement(Stack, { showInner: false })));
  await escapeKey();
  assert.deepEqual(outer, ['outer']);
});

function registerScreen(serverState, sent) {
  return load('src/screens/RegisterScreen.tsx', {
    '../auth/authRules': authRules,
    '../servers/serverNames': serverNames,
    '../auth/AuthContext': { useAuth: () => ({ register: async (...args) => { sent.push(args); } }), describeAuthError: plainError },
    '../components/TextField': { TextField: TextFieldPlain, RevealToggle: () => null },
    '../components/Button': { Button: plainButton },
    '../components/Banner': { Banner: ({ children }) => React.createElement('div', { role: 'alert' }, children) },
    '../components/AuthLayout': {
      AuthLayout: ({ children }) => React.createElement('div', null, children),
      AuthCard: ({ title, subtitle, children }) => React.createElement('section', null, React.createElement('h1', null, title), React.createElement('p', null, subtitle), children),
    },
    '../components/UsernameField': { UsernameField: () => React.createElement('div'), useUsernameField: () => ({ value: 'Slayer', validate: () => null }) },
    '../components/ServerSwitcher': { ServerSwitcher: () => null },
    '../components/LegalConsentChecks': { LegalConsentChecks },
    '../components/LegalDocument': LegalDocument,
    '../legal/legalMeta': legalMeta,
    '../servers/ServerContext': { useServer: () => serverState },
  }).RegisterScreen;
}
const officialUserServer = { selected: undefined, officialNetwork: true };
const localUserServer = { selected: { name: 'My server' }, officialNetwork: false };

test('registration waits for the age and the documents, then sends the current versions with the account', async () => {
  const sent = [];
  await mount(registerScreen(officialUserServer, sent), { onBackToLogin() {} });
  assert.ok(document.querySelector('.legal-checks'), 'the official server asks for both boxes');
  await act(async () => {
    typeInto(field('Email'), 'slayer@example.com');
    typeInto(field('Password'), 'a long password');
    typeInto(field('Confirm password'), 'a long password');
  });
  assert.equal(button('Create account').disabled, true);
  await act(async () => checkboxOf('I am 16').click());
  assert.equal(button('Create account').disabled, true, 'the age alone is not enough');
  await act(async () => checkboxOf('I agree').click());
  assert.equal(button('Create account').disabled, false);
  await act(async () => button('Create account').click());
  // [2026-10-15] No name is asked for or sent on the official server: the account names itself after the code.
  assert.deepEqual(sent[0].slice(0, 3), ['slayer@example.com', 'a long password', { termsVersion: legalMeta.LEGAL.termsVersion, privacyVersion: legalMeta.LEGAL.privacyVersion, ageConfirmed: true }]);
  assert.equal(sent[0][3], undefined, 'the official sign-up sends no name');
});

test('the document names in the registration boxes open the documents and do not tick the box', async () => {
  await mount(registerScreen(officialUserServer, []), { onBackToLogin() {} });
  const termsName = [...document.querySelectorAll('.legal-checks button')].find((item) => item.textContent === 'Terms of Use');
  await act(async () => termsName.click());
  assert.equal(titleOfDialog(), 'Terms of Use');
  assert.ok(document.querySelector('.legal-doc').textContent.includes('Version 2026-10-14'));
  assert.equal(checkboxOf('I agree').checked, false, 'a document name does not tick the box');
  await escapeKey();
  assert.equal(document.querySelector('[role="dialog"]'), null, 'Escape closes the viewer and keeps the form');
  assert.ok(button('Create account'));
});

test('a local server registers as before: no document boxes, and nothing about the documents is sent', async () => {
  const sent = [];
  await mount(registerScreen(localUserServer, sent), { onBackToLogin() {} });
  assert.equal(document.querySelector('.legal-checks'), null);
  await act(async () => {
    typeInto(field('Email'), 'friend@example.com');
    typeInto(field('Password'), 'a long password');
    typeInto(field('Confirm password'), 'a long password');
  });
  await act(async () => button('Create account').click());
  assert.equal(sent[0][2], undefined, 'the local server gets no consent');
  assert.equal(sent[0][3], 'Slayer', 'a local server takes the name on its own form');
});

test('the official register call carries the consent, and a local one does not', async () => {
  const harness = authHarness(officialServerState, { native_register: () => Promise.resolve({ account: localAccount, verificationRequired: false }) });
  await mount(harness.App);
  const consent = { termsVersion: '2026-10-14', privacyVersion: '2026-10-14', ageConfirmed: true };
  await act(async () => harness.context.register('slayer@example.com', 'a long password', consent));
  // [2026-10-15] The official account names itself after sign-in: no displayName is sent.
  assert.deepEqual(harness.calls.at(-1), ['native_register', { serverId: 'official', email: 'slayer@example.com', password: 'a long password', consent }]);
});

function accountRulesHarness(api, serverState = officialServerState) {
  const calls = [];
  const state = { auth: { status: 'signedIn', serverId: 'official', account: { ...account, userId: 'a' } }, server: serverState };
  const record = (name) => (...args) => { calls.push([name, ...args]); return api[name] ? api[name](...args) : Promise.resolve(null); };
  const { AccountRulesProvider, useAccountRules } = load('src/auth/AccountRules.tsx', {
    './AuthContext': { useAuth: () => state.auth, describeAuthError: plainError },
    '../servers/ServerContext': { useServer: () => state.server },
    '../api/tauri': {
      getConsentStatus: record('getConsentStatus'),
      acceptConsent: record('acceptConsent'),
      getDeletionStatus: record('getDeletionStatus'),
      requestAccountDeletion: record('requestAccountDeletion'),
      cancelAccountDeletion: record('cancelAccountDeletion'),
    },
  });
  let rules = null;
  function Probe() { rules = useAccountRules(); return null; }
  return {
    calls,
    state,
    App: () => React.createElement(AccountRulesProvider, null, React.createElement(Probe)),
    get rules() { return rules; },
  };
}
const noDeletion = async () => ({ supported: true, holdDays: 30, request: null });

test('the consent answer decides the gate: documents not yet accepted open it, and an acceptance opens the app', async () => {
  let current = { ...acceptedConsent, accepted: null, upToDate: false };
  const harness = accountRulesHarness({
    getConsentStatus: async () => current,
    acceptConsent: async () => { current = acceptedConsent; return acceptedConsent; },
    getDeletionStatus: noDeletion,
  });
  await mount(harness.App);
  assert.equal(harness.rules.gate, 'accept');
  await act(async () => harness.rules.acceptConsent('2026-10-14', '2026-10-14'));
  assert.equal(harness.rules.gate, 'open');
  assert.deepEqual(harness.calls.find(([name]) => name === 'acceptConsent'), ['acceptConsent', '2026-10-14', '2026-10-14', 'official']);
});

test('a backend without consent routes is never gated, and says it has no deletion route', async () => {
  const unsupported = accountRulesHarness({
    getConsentStatus: async () => ({ supported: false, required: null, accepted: null, upToDate: true }),
    getDeletionStatus: async () => ({ supported: false, holdDays: 30, request: null }),
  });
  await mount(unsupported.App);
  assert.equal(unsupported.rules.gate, 'open');
  assert.equal(unsupported.rules.deletion.supported, false);
});

test('a local server is not asked about the documents or the deletion at all', async () => {
  const local = accountRulesHarness({}, localServerState);
  await mount(local.App);
  assert.equal(local.rules.gate, 'open');
  assert.deepEqual(local.calls, []);
});

test('while the answer is read the gate says so, and a failed read offers a retry that asks once more', async () => {
  let attempts = 0, release = null;
  const harness = accountRulesHarness({
    getConsentStatus: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject("Couldn't reach the Mystic Paradox account server.");
      return new Promise((resolve) => { release = resolve; });
    },
    getDeletionStatus: noDeletion,
  });
  await mount(harness.App);
  assert.equal(harness.rules.gate, 'failed');
  assert.match(harness.rules.consentError, /Couldn't reach/);
  await act(async () => harness.rules.retryConsent());
  assert.equal(harness.rules.gate, 'checking');
  await act(async () => release(acceptedConsent));
  assert.equal(harness.rules.gate, 'open');
  assert.equal(attempts, 2);
});

test('an answer for one account never gates another: the new account waits for its own answer', async () => {
  let calls = 0, releaseSecond = null;
  const harness = accountRulesHarness({
    getConsentStatus: async () => {
      calls += 1;
      if (calls === 1) return { ...acceptedConsent, accepted: null, upToDate: false };
      return new Promise((resolve) => { releaseSecond = resolve; });
    },
    getDeletionStatus: noDeletion,
  });
  await mount(harness.App);
  assert.equal(harness.rules.gate, 'accept');
  harness.state.auth = { status: 'signedIn', serverId: 'official', account: { ...account, userId: 'b' } };
  await act(async () => root.render(React.createElement(harness.App)));
  assert.equal(harness.rules.gate, 'checking', 'the first account answer does not gate the second account');
  await act(async () => releaseSecond(acceptedConsent));
  assert.equal(harness.rules.gate, 'open');
});

test('a refused restore keeps the deactivation', async () => {
  const harness = accountRulesHarness({
    getConsentStatus: async () => acceptedConsent,
    getDeletionStatus: async () => ({ supported: true, holdDays: 30, request: { requestedAt: '2026-10-04T09:00:00.000Z', scheduledFor: deactivatedUntil } }),
    cancelAccountDeletion: async () => { throw 'This account can no longer be restored.'; },
  });
  await mount(harness.App);
  assert.equal(harness.rules.deactivatedUntil, deactivatedUntil);
  assert.equal(harness.rules.deletionChecking, false);
  let refused = null;
  await act(async () => { try { await harness.rules.restoreAccount(); } catch (error) { refused = error; } });
  assert.equal(refused, 'This account can no longer be restored.');
  assert.equal(harness.rules.deactivatedUntil, deactivatedUntil, 'a refused restore changes nothing');
});

function consentGate(rules, logouts = []) {
  return load('src/screens/ConsentScreen.tsx', {
    '../auth/AuthContext': { useAuth: () => ({ logout: async () => { logouts.push('logout'); } }), describeAuthError: plainError },
    '../auth/AccountRules': { useAccountRules: () => rules },
    '../components/AuthLayout': {
      AuthLayout: ({ children }) => React.createElement('div', null, children),
      AuthCard: ({ title, subtitle, children }) => React.createElement('section', null, React.createElement('h1', null, title), React.createElement('p', null, subtitle), children),
    },
    '../components/Banner': { Banner: ({ children }) => React.createElement('div', { role: 'alert' }, children) },
    '../components/Button': { Button: plainButton },
    '../components/Modal': ModalModule,
    '../components/LegalConsentChecks': { LegalConsentChecks },
    '../components/LegalDocument': LegalDocument,
    '../legal/legalMeta': legalMeta,
  }).ConsentScreen;
}
const pendingConsent = { ...accountRulesDefault(), gate: 'accept', consent: { ...acceptedConsent, accepted: null, upToDate: false } };

test('the consent gate is blocking: both boxes, then the current versions are accepted; Sign out leaves', async () => {
  const accepted = [], logouts = [];
  await mount(consentGate({ ...pendingConsent, acceptConsent: async (terms, privacy) => { accepted.push([terms, privacy]); } }, logouts));
  assert.equal(titleOfDialog(), 'Read and accept to continue');
  assert.equal(button('Accept and continue').disabled, true);
  await act(async () => checkboxOf('I am 16').click());
  assert.equal(button('Accept and continue').disabled, true);
  await act(async () => checkboxOf('I agree').click());
  assert.equal(button('Accept and continue').disabled, false);
  await act(async () => button('Accept and continue').click());
  assert.deepEqual(accepted, [[legalMeta.LEGAL.termsVersion, legalMeta.LEGAL.privacyVersion]]);
  await escapeKey();
  assert.ok(document.querySelector('[role="dialog"]'), 'Escape does not get past a blocking gate');
  await act(async () => button('Sign out').click());
  assert.deepEqual(logouts, ['logout']);
});

test('an outdated launcher is told to update, and the gate stays up', async () => {
  const rules = { ...pendingConsent, acceptConsent: async () => { throw 'Update the launcher to read and accept the current Terms of Use and Privacy Policy, then try again.'; } };
  await mount(consentGate(rules));
  await act(async () => checkboxOf('I am 16').click());
  await act(async () => checkboxOf('I agree').click());
  await act(async () => button('Accept and continue').click());
  assert.match(document.querySelector('[role="dialog"] [role="alert"]').textContent, /Update the launcher/);
  assert.ok(document.querySelector('[role="dialog"]'));
});

function accountTab(rules, serverState = officialServerState) {
  return load('src/screens/dashboard/AccountTab.tsx', {
    '../../auth/AuthContext': {
      useAuth: () => ({ account, logout: async () => {}, accountCheckedAt: 1700000000000, accountRefreshing: false, accountRefreshError: null, refreshAccount: async () => null }),
      describeAuthError: plainError,
    },
    '../../auth/AccountRules': { useAccountRules: () => rules },
    '../../servers/ServerContext': { useServer: () => serverState },
    '../../lib/sessions': sessionsLib,
    '../../lib/accountDeletion': accountDeletionLib,
    '../../components/icons': icons,
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../components/Button': { Button: plainButton },
    '../../components/DeactivationBanner': { DeactivationBanner },
    '../../components/DeleteAccountDialog': { DeleteAccountDialog },
    '../../components/Banner': { Banner },
    '../../components/LegalDocument': LegalDocument,
    '../../legal/legalMeta': legalMeta,
  }).AccountTab;
}

test('Account shows the terms accepted; deleting needs the username typed and states the 30-day rule', async () => {
  const deleted = [];
  const rules = {
    ...accountRulesDefault(), consent: acceptedConsent,
    deletion: { supported: true, holdDays: 30, request: null },
    requestDeletion: async (typed) => { deleted.push(typed); },
  };
  await mount(accountTab(rules));
  assert.ok(document.body.textContent.includes('Accepted Terms of Use 2026-10-14 and Privacy Policy 2026-10-14 on 1 September 2026.'));
  await act(async () => button('Delete account…').click());
  const dialogText = document.querySelector('[role="dialog"]').textContent;
  assert.ok(dialogText.includes('It is permanently deleted after 30 days.'));
  assert.ok(dialogText.includes('Within those 30 days you can sign in and choose Restore'));
  assert.ok(dialogText.includes('cannot be recovered after deletion'));
  assert.equal(button('Delete account').disabled, true);
  await act(async () => typeInto(field('Type Slayer to confirm'), 'Other'));
  assert.equal(button('Delete account').disabled, true);
  await act(async () => typeInto(field('Type Slayer to confirm'), 'slayer'));
  assert.equal(button('Delete account').disabled, false, 'the username is matched without regard to case');
  await act(async () => button('Delete account').click());
  assert.deepEqual(deleted, ['slayer']);
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('a deactivated account shows the deletion day on Account, offers Restore instead of deletion, and restores', async () => {
  const restored = [];
  const rules = {
    ...accountRulesDefault(), consent: acceptedConsent, deactivatedUntil,
    deletion: { supported: true, holdDays: 30, request: { requestedAt: '2026-10-04T09:00:00.000Z', scheduledFor: deactivatedUntil } },
    restoreAccount: async () => { restored.push(true); },
  };
  await mount(accountTab(rules));
  assert.ok(document.body.textContent.includes(deactivatedSentence));
  assert.ok(document.body.textContent.includes('Deletion scheduled'));
  assert.equal(button('Delete account…'), undefined, 'a deactivated account offers no second deletion');
  await act(async () => button('Restore account').click());
  assert.deepEqual(restored, [true]);
});

test('a local server account is not Mystic Paradox\'s: no terms or deletion are offered for it', async () => {
  await mount(accountTab(accountRulesDefault(), localServerState));
  assert.ok(document.body.textContent.includes('An account on'));
  assert.equal(button('Delete account…'), undefined);
  assert.equal(document.querySelector('[aria-label="Terms and privacy"]'), null);
});

test('a deactivated account sees the deletion day and Restore on Home, and Play says why and starts nothing', async () => {
  let launches = 0, restored = 0;
  const rules = {
    ...accountRulesDefault(), deactivatedUntil,
    restoreAccount: async () => { restored += 1; },
  };
  await mount(home({ secureLaunch: async () => { launches += 1; } }, undefined, undefined, { rules }));
  assert.ok(document.body.textContent.includes(deactivatedSentence));
  const play = button('Unavailable');
  assert.ok(play, 'Play says why instead of starting');
  assert.equal(play.disabled, true);
  await act(async () => button('Restore account').click());
  assert.equal(restored, 1);
  assert.equal(launches, 0);
});

test('a Play refused for deactivation shows the same sentence and reads the deletion state again', async () => {
  let reloads = 0;
  const rules = { ...accountRulesDefault(), reloadDeletion: async () => { reloads += 1; return null; } };
  await mount(home({ secureLaunch: async () => { throw deactivatedSentence; } }, undefined, undefined, { rules }));
  await act(async () => button('Play').click());
  assert.equal(document.querySelector('.launch-error').textContent, deactivatedSentence);
  assert.equal(reloads, 1);
});

test('while the deletion state is being read Play waits, instead of starting a game that may be deactivated', async () => {
  let launches = 0;
  const rules = { ...accountRulesDefault(), deletionChecking: true };
  await mount(home({ secureLaunch: async () => { launches += 1; } }, undefined, undefined, { rules }));
  assert.equal(button('Unavailable').disabled, true);
  assert.ok(document.body.textContent.includes('Checking your account'));
  assert.equal(launches, 0);
});

test('the sign-in card opens the Terms of Use and the Privacy Policy in the viewer, and Escape closes it', async () => {
  await mount(loginScreen(officialUserServer), { onCreateAccount() {} });
  await act(async () => button('Privacy Policy').click());
  assert.equal(titleOfDialog(), 'Privacy Policy');
  assert.ok(document.querySelector('.legal-doc').textContent.includes('Contact privacy@mysticfox.dev'));
  await escapeKey();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.ok(button('Sign in'), 'the sign-in card is still there');
});

test('About links the Terms of Use and the Privacy Policy, read in the launcher', async () => {
  const about = load('src/screens/dashboard/AboutTab.tsx', {
    '@tauri-apps/api/app': { getVersion: async () => '0.1.58' },
    '@tauri-apps/plugin-opener': { openUrl: async () => {} },
    '../../components/AetherMark': { AetherMark: () => null },
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../components/icons': icons,
    '../../services/ServicesContext': { useServices: () => services },
    '../../lib/sessions': sessionsLib,
    '../../components/LegalDocument': LegalDocument,
    '../../components/PublicBuildCheck': { PublicBuildCheck: () => null },
    '../../legal/legalMeta': legalMeta,
  }).AboutTab;
  await mount(about);
  const row = [...document.querySelectorAll('button.link-row')].find((item) => item.textContent.startsWith('Terms of Use'));
  assert.ok(row, 'the Terms of Use row is there');
  await act(async () => row.click());
  assert.equal(titleOfDialog(), 'Terms of Use');
  await escapeKey();
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

// [2026-10-15] About -> "Check against GitHub" (components/PublicBuildCheck.tsx).
test('the build check runs once at startup, is kept for the session, and the button checks again', async () => {
  let calls = 0;
  const report = {
    repository: 'pranav158/Mystic-Paradox',
    launcherVersion: '0.1.65',
    files: [
      { name: 'launcher.exe', label: 'Launcher', path: 'C:\\L\\launcher.exe', installedSha256: '1f'.repeat(32), publishedSha256: 'd3'.repeat(32), release: 'launcher-v0.1.65', status: 'differs', note: 'Not the launcher.exe of the public release launcher-v0.1.65.' },
      { name: 'winmm.dll', label: 'Runtime loader', path: null, installedSha256: '23'.repeat(32), publishedSha256: '23'.repeat(32), release: 'runtime-extras-v0.2.137', status: 'match', note: 'Identical.' },
      { name: 'MysticParadox.dll', label: 'Runtime', installedSha256: 'c4'.repeat(32), status: 'operatorBuild', note: 'Built by the operator.' },
    ],
  };
  const buildCheck = load('src/components/PublicBuildCheck.tsx', {
    '../api/tauri': { checkPublicBuilds: async () => { calls += 1; return report; } },
    '../api/updates': { verifyInstalledRuntime: async () => ({ verified: true, version: '0.2.136' }) },
    '../policy/PolicyContext': { usePolicy: () => ({ policy: { channel: 'stable' } }) },
    './Button': { Button: plainButton },
  });
  // [2026-10-15] The launcher asks GitHub once at startup; About shows that result and does not ask again by itself.
  buildCheck.startPublicBuildCheckAtStartup();
  await act(async () => {});
  assert.equal(calls, 1, 'the check runs at startup, without a button press');
  await mount(buildCheck.PublicBuildCheck);
  await act(async () => {});
  assert.equal(calls, 1, 'About shows the result kept for this session');
  assert.ok(document.body.textContent.includes('The launcher checks at startup'));
  const rows = [...document.querySelectorAll('.build-check-row')];
  assert.deepEqual(rows.map((row) => row.dataset.status), ['differs', 'match', 'operatorBuild']);
  assert.ok(rows[0].textContent.includes('Differs'));
  assert.ok(rows[0].textContent.includes('Published'), 'a difference shows the published hash too');
  assert.ok(!rows[1].textContent.includes('Published'), 'a match shows one hash');
  assert.ok(document.body.textContent.includes('gh attestation verify "C:\\L\\launcher.exe" --repo pranav158/Mystic-Paradox'));
  assert.ok(button('Check again'), 'the button offers a second check');
  // The runtime row shows the signed-release check (Verified), not the grey operator-build chip.
  assert.ok(rows[2].textContent.includes('Verified'));
  assert.equal(rows[2].textContent.includes('Operator build'), false);
  await act(async () => button('Check again').click());
  await act(async () => {});
  assert.equal(calls, 2, 'the button runs the check again');
});

// ---- [2026-10-14] The launcher's dropdown, and a realm named by its realm name --------------------------------------

test('a realm is named by its realm name, with the player\'s own name under it only when it differs', () => {
  const { serverNaming, statusNaming } = serverNames;
  assert.deepEqual(serverNaming({ kind: 'paradox_realm', name: 'Mystic', realmName: 'mysticfox' }), { primary: 'mysticfox', secondary: 'Mystic' });
  assert.deepEqual(serverNaming({ kind: 'paradox_realm', name: 'MysticFox', realmName: 'mysticfox' }), { primary: 'mysticfox', secondary: null }, 'the same name in other capitals is not a second line');
  assert.deepEqual(serverNaming({ kind: 'paradox_realm', name: '  ', realmName: 'ember-hold' }), { primary: 'ember-hold', secondary: null });
  assert.deepEqual(serverNaming({ kind: 'local', name: 'My server', realmName: null }), { primary: 'My server', secondary: null });
  assert.deepEqual(serverNaming({ kind: 'official', name: 'Mystic Paradox' }), { primary: 'Mystic Paradox', secondary: null });
  const mystic = { id: 's-2', kind: 'paradox_realm', name: 'Mystic', realmName: 'mysticfox' };
  assert.deepEqual(statusNaming({ serverId: 's-2', serverName: 'Mystic' }, mystic), { primary: 'mysticfox', secondary: 'Mystic' });
  assert.deepEqual(statusNaming({ serverId: 's-9', serverName: 'Mystic' }, mystic), { primary: 'Mystic', secondary: null }, 'another server\'s status keeps its own name');
  assert.equal(statusNaming(null, mystic), null);
  assert.equal(statusNaming({ serverId: 's-2', serverName: ' ' }, null), null);
});

const ddControl = () => document.getElementById('picker');
const ddListbox = () => document.querySelector('[role="listbox"]');
const ddRows = () => [...document.querySelectorAll('[role="option"]')];
const ddActiveRow = () => document.getElementById(ddControl().getAttribute('aria-activedescendant'));
const pressKey = (element, key) => act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const pickerOptions = [
  { value: 'official', label: 'Mystic Paradox', tag: { text: 'Official', tone: 'official' } },
  { value: 's-realm', label: 'ember-hold', detail: 'Ember Hold', tag: { text: 'Realm', tone: 'realm' } },
  { value: 's-local', label: 'My server', tag: { text: 'Local', tone: 'local' } },
];
const pickerActions = [{ value: 'add', label: 'Add a server...' }];
// The dropdown as the sign-in card uses it, with its choices recorded. The control has the id `picker`.
function picker(log, { disabled = false } = {}) {
  const Dropdown = dropdownLib.Dropdown;
  return function Picker() {
    const [value, setValue] = React.useState('official');
    return React.createElement(Dropdown, {
      id: 'picker',
      label: 'Server',
      value,
      options: pickerOptions,
      actions: pickerActions,
      disabled,
      onChange: (next) => { log.changes.push(next); setValue(next); },
      onAction: (next) => { log.actions.push(next); },
    });
  };
}

test('the dropdown is a combobox that names its state, shows the chosen option with its tag, and has no list while shut', async () => {
  await mount(picker({ changes: [], actions: [] }));
  const box = ddControl();
  assert.equal(box.getAttribute('role'), 'combobox');
  assert.equal(box.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(box.getAttribute('aria-expanded'), 'false');
  assert.equal(box.getAttribute('aria-label'), 'Server');
  assert.equal(box.getAttribute('aria-controls'), null, 'nothing to control while the list is shut');
  assert.match(box.querySelector('.dropdown-main').textContent, /Mystic Paradox/);
  assert.equal(box.querySelector('.dropdown-tag').textContent, 'Official');
  assert.equal(ddListbox(), null, 'the list is not in the page until it opens');
});

test('a click opens the list on the body: each option with its detail and tag, the action row, and the chosen one marked', async () => {
  await mount(picker({ changes: [], actions: [] }));
  await act(async () => ddControl().click());
  assert.equal(ddControl().getAttribute('aria-expanded'), 'true');
  assert.equal(ddControl().getAttribute('aria-controls'), ddListbox().id);
  assert.equal(ddListbox().getAttribute('role'), 'listbox');
  assert.equal(ddListbox().parentElement, document.body, 'the list is a portal, so no card that clips its overflow can cut it off');
  const rows = ddRows();
  assert.equal(rows.length, 4);
  assert.equal(rows[0].getAttribute('aria-selected'), 'true');
  assert.equal(rows[1].getAttribute('aria-selected'), 'false');
  assert.equal(rows[1].querySelector('.dropdown-main').textContent, 'ember-hold');
  assert.equal(rows[1].querySelector('.dropdown-detail').textContent, 'Ember Hold');
  assert.equal(rows[1].querySelector('.dropdown-tag').textContent, 'Realm');
  assert.equal(rows[2].querySelector('.dropdown-tag').textContent, 'Local', 'a local server carries the red Local tag');
  assert.equal(rows[3].textContent, 'Add a server...');
  assert.equal(rows[3].getAttribute('aria-selected'), 'false', 'an action is not a choice');
});

test('the keyboard opens on the chosen row, the arrows, Home and End move the highlight, and Enter chooses and shuts the list', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  ddControl().focus();
  await pressKey(ddControl(), 'Enter');
  assert.equal(ddControl().getAttribute('aria-expanded'), 'true');
  assert.equal(ddControl().getAttribute('aria-activedescendant'), ddRows()[0].id, 'opens on the chosen row');
  await pressKey(ddControl(), 'ArrowDown');
  assert.equal(ddActiveRow(), ddRows()[1]);
  await pressKey(ddControl(), 'End');
  assert.equal(ddActiveRow().textContent, 'Add a server...');
  await pressKey(ddControl(), 'Home');
  assert.equal(ddActiveRow(), ddRows()[0]);
  await pressKey(ddControl(), 'ArrowDown');
  await pressKey(ddControl(), 'ArrowDown');
  assert.match(ddActiveRow().textContent, /My server/);
  await pressKey(ddControl(), 'ArrowDown');
  await pressKey(ddControl(), 'ArrowDown');
  assert.equal(ddActiveRow().textContent, 'Add a server...', 'the arrows stop at the last row');
  await pressKey(ddControl(), 'ArrowUp');
  assert.match(ddActiveRow().textContent, /My server/);
  await pressKey(ddControl(), 'Enter');
  assert.deepEqual(log.changes, ['s-local']);
  assert.deepEqual(log.actions, []);
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  assert.equal(ddListbox(), null);
  assert.equal(document.activeElement, ddControl(), 'focus stays on the control');
  assert.match(ddControl().querySelector('.dropdown-main').textContent, /My server/);
});

test('Escape and Tab shut the list without choosing, Space opens it, and the arrows stop at the first row', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  ddControl().focus();
  await pressKey(ddControl(), ' ');
  assert.equal(ddControl().getAttribute('aria-expanded'), 'true', 'Space opens the list');
  await pressKey(ddControl(), 'ArrowUp');
  assert.equal(ddActiveRow(), ddRows()[0], 'Up on the first row stays there');
  await pressKey(ddControl(), 'ArrowDown');
  await pressKey(ddControl(), 'Escape');
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, ddControl(), 'Escape returns focus to the control');
  await pressKey(ddControl(), 'Enter');
  await pressKey(ddControl(), 'Tab');
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(log.changes, [], 'neither Escape nor Tab chooses');
});

test('a letter jumps to the next option that starts with it, and the same letter again cycles to the next match', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  ddControl().focus();
  await pressKey(ddControl(), 'Enter');
  await pressKey(ddControl(), 'm');
  assert.match(ddActiveRow().textContent, /My server/, 'the next option after the chosen one that starts with m');
  await pressKey(ddControl(), 'm');
  assert.match(ddActiveRow().textContent, /Mystic Paradox/, 'the same letter again goes to the next match');
  assert.deepEqual(log.changes, [], 'moving the highlight chooses nothing');
});

test('a letter typed on the shut control chooses the next option that starts with it, as a native select does', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  ddControl().focus();
  await pressKey(ddControl(), 'e');
  assert.deepEqual(log.changes, ['s-realm']);
  assert.match(ddControl().querySelector('.dropdown-main').textContent, /ember-hold/);
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
});

test('the action row runs onAction and leaves the chosen option alone', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  await act(async () => ddControl().click());
  await act(async () => ddRows()[3].click());
  assert.deepEqual(log.actions, ['add']);
  assert.deepEqual(log.changes, []);
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  assert.match(ddControl().querySelector('.dropdown-main').textContent, /Mystic Paradox/);
});

test('a click chooses its row; a click outside, or the window losing focus, shuts the list without choosing', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  await act(async () => ddControl().click());
  await act(async () => ddRows()[1].click());
  assert.deepEqual(log.changes, ['s-realm']);
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  await act(async () => ddControl().click());
  assert.equal(ddControl().getAttribute('aria-expanded'), 'true');
  await act(async () => document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false', 'a click outside shuts it');
  await act(async () => ddControl().click());
  await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')));
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false', 'the window losing focus shuts it');
  assert.deepEqual(log.changes, ['s-realm'], 'nothing else was chosen');
});

test('the list opens above the control when there is no room below, and stays inside the window', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log));
  dom.window.innerHeight = 400;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 200 });
  ddControl().getBoundingClientRect = () => ({ top: 350, bottom: 386, left: 20, right: 320, width: 300, height: 36 });
  await act(async () => ddControl().click());
  const up = ddListbox();
  assert.equal(up.dataset.placement, 'up');
  assert.equal(up.style.bottom, '56px', 'its bottom edge sits 6 px above the control');
  assert.equal(up.style.top, '');
  assert.equal(up.style.maxHeight, '320px');
  assert.equal(up.style.width, '300px');
  await pressKey(ddControl(), 'Escape');
  ddControl().getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 20, right: 320, width: 300, height: 36 });
  await act(async () => ddControl().click());
  assert.equal(ddListbox().dataset.placement, 'down');
  assert.equal(ddListbox().style.top, '142px', 'it opens under the control when there is room');
  assert.equal(ddListbox().style.maxHeight, '248px', 'and is no taller than the room below');
});

test('a disabled dropdown does not open from the mouse or the keyboard', async () => {
  const log = { changes: [], actions: [] };
  await mount(picker(log, { disabled: true }));
  assert.equal(ddControl().getAttribute('aria-disabled'), 'true');
  await act(async () => ddControl().click());
  await pressKey(ddControl(), 'Enter');
  assert.equal(ddControl().getAttribute('aria-expanded'), 'false');
  assert.equal(ddListbox(), null);
  assert.deepEqual(log.changes, []);
});

test('the sign-in card names a realm by its realm name, with the player\'s name under it, and tags every server', async () => {
  const mystic = { ...realmServer, id: 's-2', name: 'Mystic', realmName: 'mysticfox', selected: true };
  await mount(serverSwitcher({}, switcherContext([{ ...officialServer, selected: false }, mystic, localServer])));
  const box = switcherSelect();
  assert.equal(box.querySelector('.dropdown-main').textContent, 'mysticfox');
  assert.equal(box.querySelector('.dropdown-detail').textContent, 'Mystic');
  assert.equal(box.querySelector('.dropdown-tag').textContent, 'Realm');
  await act(async () => box.click());
  const realmRow = document.querySelector('[role="option"][data-value="s-2"]');
  assert.equal(realmRow.querySelector('.dropdown-main').textContent, 'mysticfox');
  assert.equal(realmRow.querySelector('.dropdown-detail').textContent, 'Mystic');
  assert.equal(document.querySelector('[role="option"][data-value="s-1"] .dropdown-tag').textContent, 'Local');
  assert.doesNotMatch(document.body.textContent, /\(local\)|\(realm\)/, 'the old suffixes are gone');
});

test('the sign-in card\'s switcher works from the keyboard: a server is chosen, and Add a server... opens the form', async () => {
  const chosen = [];
  const context = switcherContext([officialServer, localServer], { select: async (serverId) => { chosen.push(serverId); } });
  await mount(serverSwitcher({}, context));
  switcherSelect().focus();
  await pressKey(switcherSelect(), 'Enter');
  await pressKey(switcherSelect(), 'ArrowDown');
  await pressKey(switcherSelect(), 'Enter');
  assert.deepEqual(chosen, ['s-1']);
  await pressKey(switcherSelect(), 'Enter');
  await pressKey(switcherSelect(), 'End');
  await pressKey(switcherSelect(), 'Enter');
  assert.ok(field('Name'), 'the add form opens under the switcher');
});

test('choosing a server with the keyboard keeps focus on the server dropdown, not on the email field', async () => {
  // The real sign-in card, switcher and dropdown. What AppShell does is faked: a server change restores that server's
  // session, which shows a status card in place of the sign-in card until the restore is answered.
  const state = { servers: [officialServer, realmServer], status: 'signedOut', restore: null, bump() {} };
  const serverState = () => {
    const selected = state.servers.find((server) => server.selected);
    return {
      servers: state.servers,
      selected,
      officialNetwork: selected.kind !== 'local',
      select: async (serverId) => {
        state.servers = state.servers.map((server) => ({ ...server, selected: server.id === serverId }));
        state.status = 'checking';
        state.restore = deferred();
        state.bump();
        await state.restore.promise;
        state.status = 'signedOut';
        state.bump();
      },
      openWarning() {},
    };
  };
  const switcher = load('src/components/ServerSwitcher.tsx', {
    '../servers/officialPlay': officialPlayLib,
    '../servers/ServerContext': { useServer: serverState },
    '../servers/AddServerForm': { AddServerForm: () => null },
    '../servers/serverNames': serverNames,
    './Dropdown': dropdownLib,
    './LocalServerWarning': { LocalServerBadge },
    './icons': icons,
  });
  const textFields = load('src/components/TextField.tsx', {});
  const LoginScreen = load('src/screens/LoginScreen.tsx', {
    '../servers/serverNames': serverNames,
    '../auth/AuthContext': { useAuth: () => ({ login: async () => {}, startDiscordLogin: async () => {}, authError: null }), describeAuthError: String },
    '../components/TextField': textFields,
    '../components/Button': { Button: plainButton },
    '../components/Banner': { Banner: ({ children }) => React.createElement('div', null, children) },
    '../components/AuthLayout': {
      AuthLayout: ({ children }) => React.createElement('div', null, children),
      AuthCard: ({ title, subtitle, children }) => React.createElement('section', null, React.createElement('h1', null, title), React.createElement('p', null, subtitle), children),
    },
    '../components/icons': icons,
    '../components/ServerSwitcher': switcher,
    '../components/LegalDocument': LegalDocument,
    '../servers/ServerContext': { useServer: serverState },
  }).LoginScreen;
  function Shell() {
    const [, setTick] = React.useState(0);
    state.bump = () => setTick((tick) => tick + 1);
    if (state.status === 'checking') return React.createElement('p', { role: 'status' }, 'Restoring your session');
    return React.createElement(LoginScreen, { onCreateAccount() {} });
  }
  const signInEmail = () => document.querySelector('input[type="email"]');
  const switchTrigger = () => document.getElementById('server-switch-select');

  await mount(Shell);
  // Element comparisons use assert.ok: a failing assert.equal or deepEqual would inspect the DOM in its message, without bound.
  assert.ok(document.activeElement === signInEmail(), 'arriving on the sign-in card still puts the cursor in the email field');

  switchTrigger().focus();
  await pressKey(switchTrigger(), 'Enter');
  await pressKey(switchTrigger(), 'ArrowDown');
  await pressKey(switchTrigger(), 'Enter');
  assert.equal(state.status, 'checking', 'the choice starts the restore');
  assert.ok(signInEmail() === null, 'the sign-in card is away while the restore runs');

  // Every focus that lands on an email field while the card comes back, including one that is taken again later.
  const emailFocuses = [];
  const recordEmailFocus = (event) => {
    if (event.target instanceof dom.window.HTMLInputElement && event.target.type === 'email') emailFocuses.push(event.target);
  };
  document.addEventListener('focus', recordEmailFocus, true);
  await act(async () => state.restore.resolve());
  document.removeEventListener('focus', recordEmailFocus, true);
  assert.ok(signInEmail(), 'the sign-in card is back');
  assert.match(switchTrigger().querySelector('.dropdown-main').textContent, /ember-hold/, 'the chosen server is shown');
  assert.ok(document.activeElement === switchTrigger(), 'focus stays on the server dropdown after the choice');
  assert.ok(document.activeElement !== signInEmail(), 'the email field does not take the focus');
  assert.ok(emailFocuses.length === 0, `no focus moved to the email field while the card came back (${emailFocuses.length} times)`);
});

test('Home names a realm by its realm name, and shows the player\'s own name under it only when it differs', async () => {
  const mystic = { ...realmServer, id: 's-2', name: 'Mystic', realmName: 'mysticfox', selected: true };
  const status = { ...install, serverId: 's-2', serverKind: 'paradox_realm', serverName: 'Mystic', runtimeManaged: true };
  await mount(home({ getInstallStatus: async () => status }, undefined, undefined, { selected: mystic }));
  const identity = document.querySelector('.play-server');
  assert.equal(identity.querySelector('.play-server-name').textContent, 'mysticfox');
  assert.equal(identity.querySelector('.play-server-name').title, 'mysticfox');
  assert.equal(identity.querySelector('.play-server-detail').textContent, 'Mystic');
  await unmountNow();
  const same = { ...mystic, name: 'MysticFox' };
  await mount(home({ getInstallStatus: async () => ({ ...status, serverName: 'MysticFox' }) }, undefined, undefined, { selected: same }));
  assert.equal(document.querySelector('.play-server-name').textContent, 'mysticfox');
  assert.equal(document.querySelector('.play-server-detail'), null, 'the same name in other capitals is not a second line');
});

test('a realm notice on Home names the realm by its realm name', async () => {
  const trust = { ...noTrust(), notice: { reason: 'KICKED', message: 'You were removed from the realm.', realm: 'mysticfox' } };
  await mount(home({ secureLaunch: async () => {} }, undefined, undefined, { trust, selected: agreedRealm }));
  assert.match(document.querySelector('.banner').textContent, /^mysticfox: You were removed from the realm\./);
});

test('a realm notice records the realm the player was in, by its realm name, and none outside a realm', async () => {
  const inRealm = trustHarness({}, emberRealm);
  await mount(inRealm.App);
  await act(async () => inRealm.log.handlers.forEach((handler) => handler({ reason: 'BANNED', message: 'You were banned from this realm.' })));
  assert.equal(inRealm.log.trust.notice.realm, 'ember-hold');
  assert.equal(inRealm.log.trust.notice.reason, 'BANNED');
  const outside = trustHarness({}, officialServer);
  await mount(outside.App);
  await act(async () => outside.log.handlers.forEach((handler) => handler({ reason: 'KICKED', message: 'You were removed from the realm.' })));
  assert.equal(outside.log.trust.notice.realm, null);
});

test('the Servers page names a realm by its realm name, with the player\'s own name under it', async () => {
  const mystic = { ...realmServer, name: 'Mystic', realmName: 'mysticfox' };
  await mount(serversTab({ listServers: async () => [officialServer, mystic] }));
  const row = document.querySelector('.server-row[data-kind="paradox_realm"]');
  assert.equal(row.querySelector('.server-name').textContent, 'mysticfox');
  assert.equal(row.querySelector('.server-alias').textContent, 'Mystic');
});

test('Library names a realm by its realm name on the Installed line', async () => {
  const mystic = { ...realmServer, id: 's-2', name: 'Mystic', realmName: 'mysticfox', selected: true };
  const { LibraryTab } = load('src/screens/dashboard/LibraryTab.tsx', {
    '../../servers/ServerContext': { useServer: () => ({ selected: mystic }) },
    '../../servers/serverNames': serverNames,
    '../../api/tauri': {
      getInstallStatus: async () => ({ ...install, serverId: 's-2', serverKind: 'paradox_realm', serverName: 'Mystic', runtimeManaged: true }),
      pickInstallPath: async () => install,
      installRuntimeUpdate: async () => {},
      checkRuntimeUpdate: async () => ({ available: false, version: '0.2.80' }),
    },
    '../../policy/PolicyContext': { usePolicy: () => ({ policy, refreshPolicy: async () => policy }) },
    '../../lib/sanitize': { sanitizeError: (error) => error },
    '../../lib/sessions': sessionsLib,
    '../../components/icons': icons,
    '../../components/ArtBackdrop': { ArtBackdrop: () => null, heroArt: 'art.webp' },
  });
  await mount(LibraryTab);
  assert.match(document.body.textContent, /Installed · mysticfox/);
});

// ---- [2026-10-15] launcher 0.1.67: email codes, password resets, Discord linking, the official play switch ----------

test('the official server is unavailable only when its own status says so, and the Home badge names the state', () => {
  const { officialUnavailable, officialUnavailableNote, serverUnavailable, serverStatusBadge, OFFICIAL_UNAVAILABLE_NOTE } = officialPlayLib;
  assert.equal(officialUnavailable(null), false, 'no status read is not unavailable');
  assert.equal(officialUnavailable({ available: true }), false);
  assert.equal(officialUnavailable({ available: false }), true);
  assert.equal(officialUnavailableNote({ available: false, message: '  Back at 18:00.  ' }), 'Back at 18:00.');
  assert.equal(officialUnavailableNote({ available: false }), OFFICIAL_UNAVAILABLE_NOTE);
  assert.equal(OFFICIAL_UNAVAILABLE_NOTE, 'The official server is currently unavailable. Join or host a realm.');
  assert.equal(serverUnavailable({ kind: 'paradox_realm' }, { available: false }), false, 'a realm is not the official server');
  assert.equal(serverUnavailable({ kind: 'official' }, { available: false }), true);
  assert.deepEqual(serverStatusBadge({ kind: 'official', health: 'online', officialPlay: { available: false } }), { text: 'Unavailable', tone: 'bad' });
  assert.deepEqual(serverStatusBadge({ kind: 'official', health: 'degraded', officialPlay: null }), { text: 'Degraded', tone: 'warn' });
  assert.deepEqual(serverStatusBadge({ kind: 'paradox_realm', health: 'unreachable', officialPlay: null }), { text: 'Unavailable', tone: 'bad' });
  assert.deepEqual(serverStatusBadge({ kind: 'official', health: 'online', officialPlay: { available: true } }), { text: 'Online', tone: 'good' });
  assert.equal(serverStatusBadge({ kind: 'official', health: 'checking', officialPlay: null }), null);
});

test('a refusal carries its code: the email screens read the code, other refusals keep their words', () => {
  const { authErrorCode, stripAuthCode, codeDigits, isCodeComplete, passwordProblem, discordLinkErrorText, AUTH_CODE_COPY } = authRules;
  assert.equal(authErrorCode('AUTH_CODE_INVALID: That code is wrong.'), 'AUTH_CODE_INVALID');
  assert.equal(authErrorCode(new Error('AUTH_EMAIL_UNVERIFIED: Check your email.')), 'AUTH_EMAIL_UNVERIFIED');
  assert.equal(authErrorCode('The email or password is incorrect.'), null);
  assert.equal(stripAuthCode('AUTH_RATE_LIMITED: Too many attempts.'), 'Too many attempts.');
  assert.equal(codeDigits(' 12-34 5x6789 '), '123456');
  assert.equal(isCodeComplete('12345'), false);
  assert.equal(isCodeComplete('123456'), true);
  assert.equal(passwordProblem('short', 'short'), 'Password must be at least 8 characters.');
  assert.equal(passwordProblem('a long password', 'a long passwore'), "Passwords don't match.");
  assert.equal(passwordProblem('a long password', 'a long password'), null);
  assert.equal(AUTH_CODE_COPY.AUTH_CODE_INVALID, 'That code is wrong or has expired. Check the latest email or resend the code.');
  assert.equal(discordLinkErrorText('AUTH_DISCORD_ALREADY_LINKED'), 'That Discord account is already linked to another Mystic Paradox account.');
  assert.equal(discordLinkErrorText('AUTH_DISCORD_ACCOUNT_HAS_LINK'), 'This account already has a Discord account linked.');
  assert.equal(discordLinkErrorText('AUTH_DISCORD_CANCELLED'), "Discord linking didn't complete. Please try again.");
});

test('a sign-in refused as unverified opens the code screen, a wrong code stays there, and the right one signs in', async () => {
  const verifications = [];
  const harness = authHarness(officialServerState, {
    native_login: () => Promise.reject('AUTH_EMAIL_UNVERIFIED: Check your email for the 6-digit code.'),
    native_verify_email: (args) => {
      verifications.push(args);
      return args.code === '123456'
        ? Promise.resolve({ approvalRequired: false, account })
        : Promise.reject('AUTH_CODE_INVALID: That code is wrong or has expired. Check the latest email or resend the code.');
    },
  });
  await mount(harness.App);
  await act(async () => harness.context.login('slayer@example.com', 'a long password'));
  assert.equal(harness.context.status, 'awaitingEmailCode');
  assert.equal(harness.context.codeEmail, 'slayer@example.com');

  let failure = null;
  await act(async () => {
    try {
      await harness.context.verifyEmailCode('000000');
    } catch (error) {
      failure = error;
    }
  });
  assert.match(failure, /^AUTH_CODE_INVALID: /);
  assert.equal(harness.context.status, 'awaitingEmailCode', 'a wrong code keeps the code screen');

  await act(async () => harness.context.verifyEmailCode('123456'));
  assert.deepEqual(verifications.at(-1), { serverId: 'official', email: 'slayer@example.com', password: 'a long password', code: '123456' });
  assert.equal(harness.context.status, 'signedIn');
  assert.equal(harness.context.codeEmail, null, 'the password is not kept once signed in');
});

test('a sign-up on the official server sends no name, then the code, and the set-username step follows', async () => {
  const harness = authHarness(officialServerState, {
    native_register: () => Promise.resolve({ account: { ...account, approvalStatus: 'pending' }, verificationRequired: true }),
    native_verify_email: () => Promise.resolve({ approvalRequired: false, account: { ...account, needsUsername: true } }),
  });
  await mount(harness.App);
  const consent = { termsVersion: '2026-10-14', privacyVersion: '2026-10-14', ageConfirmed: true };
  await act(async () => harness.context.register('new@example.com', 'a long password', consent));
  assert.equal(harness.context.status, 'awaitingEmailCode');
  const registration = harness.calls.find(([command]) => command === 'native_register');
  assert.equal('displayName' in registration[1], false, 'no displayName is sent');
  await act(async () => harness.context.verifyEmailCode('123456'));
  assert.equal(harness.context.status, 'awaitingUsername', 'the existing set-username step shows next');
});

test('an account the server holds for approval after its code keeps no session and shows the approval screen', async () => {
  const harness = authHarness(officialServerState, {
    native_register: () => Promise.resolve({ account: { ...account, approvalStatus: 'pending' }, verificationRequired: true }),
    native_verify_email: () => Promise.resolve({ approvalRequired: true, account: { ...account, approvalStatus: 'pending' } }),
  });
  await mount(harness.App);
  await act(async () => harness.context.register('new@example.com', 'a long password', undefined, undefined));
  await act(async () => harness.context.verifyEmailCode('123456'));
  assert.equal(harness.context.status, 'pendingApproval');
  assert.equal(harness.context.account.approvalStatus, 'pending');
  assert.equal(harness.calls.some(([command]) => command === 'native_refresh_account'), false, 'no session is read');
});

test('forgot password sends a code, and the reset with that code signs the account in', async () => {
  const harness = authHarness(officialServerState, {
    native_forgot_password: () => Promise.resolve(),
    native_reset_password: () => Promise.resolve({ approvalRequired: false, account }),
  });
  await mount(harness.App);
  await act(async () => harness.context.startPasswordReset());
  assert.equal(harness.context.status, 'passwordReset');
  await act(async () => harness.context.sendPasswordResetCode('slayer@example.com'));
  assert.deepEqual(harness.calls.at(-1), ['native_forgot_password', { serverId: 'official', email: 'slayer@example.com' }]);
  await act(async () => harness.context.completePasswordReset('slayer@example.com', '123456', 'brand new pass'));
  assert.deepEqual(harness.calls.at(-1), ['native_reset_password', { serverId: 'official', email: 'slayer@example.com', code: '123456', newPassword: 'brand new pass' }]);
  assert.equal(harness.context.status, 'signedIn');
});

test('a Discord link ends by deep link: link/done refreshes the account, link/error reads its code, and a sign-in never creates an account', async () => {
  const harness = authHarness(officialServerState, {
    native_refresh_account: () => Promise.resolve({ ...account, discord: { linked: true, username: 'MysticFox' } }),
  });
  await mount(harness.App);
  await act(async () => harness.listeners.get('discord-link-done')());
  assert.equal(harness.context.discordLinkNotice.text, 'Discord linked.');
  assert.equal(harness.context.account.discord.username, 'MysticFox', 'the account is read again');

  await act(async () => harness.listeners.get('discord-link-error')({ payload: 'AUTH_DISCORD_ALREADY_LINKED' }));
  assert.equal(harness.context.discordLinkNotice.tone, 'error');
  assert.equal(harness.context.discordLinkNotice.text, 'That Discord account is already linked to another Mystic Paradox account.');

  await act(async () => harness.listeners.get('discord-auth-error')({ payload: 'AUTH_DISCORD_NOT_LINKED' }));
  assert.equal(harness.context.status, 'signedOut');
  assert.equal(harness.context.authError, 'Your Discord isn\'t linked to a Mystic Paradox account. Register with your email, then link Discord on the Account page.');
});

// The code screens and the reset flow, loaded for real. describeAuthError is the real one from AuthContext.
const authContextModule = load('src/auth/AuthContext.tsx', {
  '@tauri-apps/api/core': { invoke: async () => {} },
  '@tauri-apps/api/event': { listen: async () => () => {} },
  '../api/client': { LauncherApiError: class extends Error {} },
  '../servers/ServerContext': { useServer: () => officialServerState },
  './authRules': authRules,
});
const screenAuthLayout = {
  AuthLayout: ({ children }) => React.createElement('div', null, children),
  AuthCard: ({ title, subtitle, children }) => React.createElement('section', null, React.createElement('h1', null, title), React.createElement('p', null, subtitle), children),
};
const alertBanner = ({ children, tone }) => React.createElement('div', { role: tone === 'success' ? 'status' : 'alert' }, children);
function emailCodeScreen(auth) {
  return load('src/screens/EmailCodeScreen.tsx', {
    '../auth/AuthContext': { useAuth: () => auth, describeAuthError: authContextModule.describeAuthError },
    '../components/TextField': { TextField: TextFieldPlain, RevealToggle: () => null },
    '../components/Button': { Button: plainButton },
    '../components/Banner': { Banner: alertBanner },
    '../components/AuthLayout': screenAuthLayout,
    '../auth/authRules': authRules,
    '../auth/useResendCooldown': load('src/auth/useResendCooldown.ts', {}),
  }).EmailCodeScreen;
}
function passwordResetScreen(auth) {
  return load('src/screens/PasswordResetScreen.tsx', {
    '../auth/AuthContext': { useAuth: () => auth, describeAuthError: authContextModule.describeAuthError },
    '../components/TextField': { TextField: TextFieldPlain, RevealToggle: () => null },
    '../components/Button': { Button: plainButton },
    '../components/Banner': { Banner: alertBanner },
    '../components/AuthLayout': screenAuthLayout,
    '../auth/authRules': authRules,
    '../auth/useResendCooldown': load('src/auth/useResendCooldown.ts', {}),
  }).PasswordResetScreen;
}

test('the code screen takes six digits, waits a minute before a new code, and shows a wrong code as its copy', async () => {
  const verified = [];
  const auth = {
    codeEmail: 'slayer@example.com',
    verifyEmailCode: async (code) => {
      verified.push(code);
      if (code !== '123456') throw 'AUTH_CODE_INVALID: That code is wrong or has expired. Check the latest email or resend the code.';
    },
    resendEmailCode: async () => {},
  };
  let back = 0;
  const EmailCodeScreen = emailCodeScreen(auth);
  await mount(EmailCodeScreen, { onBack() { back += 1; } });
  assert.equal(document.querySelector('h1').textContent, 'Check your email');
  assert.ok(document.body.textContent.includes('Enter the 6-digit code we sent to slayer@example.com.'));
  assert.equal(button('Resend code in 60 s').disabled, true, 'the first code was just sent, so the wait starts now');

  await act(async () => typeInto(field('6-digit code'), 'ab12-34 56'));
  assert.equal(field('6-digit code').value, '123456', 'digits only, and paste works');
  await act(async () => button('Verify').click());
  assert.deepEqual(verified, ['123456']);

  await act(async () => typeInto(field('6-digit code'), '000000'));
  await act(async () => button('Verify').click());
  assert.equal(document.querySelector('[role="alert"]').textContent, 'That code is wrong or has expired. Check the latest email or resend the code.');

  await act(async () => typeInto(field('6-digit code'), '12'));
  await act(async () => button('Verify').click());
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Enter the 6-digit code we sent.');
  assert.equal(verified.length, 2, 'an incomplete code is not sent');

  await act(async () => button('Back to sign in').click());
  assert.equal(back, 1);
});

test('forgot password asks for the email, then the code and a new password under the registration rule', async () => {
  const sent = [];
  const completed = [];
  const auth = {
    sendPasswordResetCode: async (email) => { sent.push(email); },
    completePasswordReset: async (...args) => { completed.push(args); },
    backToSignIn() {},
  };
  await mount(passwordResetScreen(auth));
  assert.equal(document.querySelector('h1').textContent, 'Reset your password');
  await act(async () => typeInto(field('Email'), 'not-an-email'));
  await act(async () => button('Send code').click());
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Enter a valid email address.');
  assert.equal(sent.length, 0);

  await act(async () => typeInto(field('Email'), 'slayer@example.com'));
  await act(async () => button('Send code').click());
  assert.deepEqual(sent, ['slayer@example.com']);
  assert.equal(document.querySelector('h1').textContent, 'Set a new password');

  await act(async () => typeInto(field('6-digit code'), '123456'));
  await act(async () => typeInto(field('New password'), 'short'));
  await act(async () => typeInto(field('Confirm new password'), 'short'));
  await act(async () => button('Set password').click());
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Password must be at least 8 characters.');

  await act(async () => typeInto(field('New password'), 'brand new pass'));
  await act(async () => typeInto(field('Confirm new password'), 'brand new pass!'));
  await act(async () => button('Set password').click());
  assert.equal(document.querySelector('[role="alert"]').textContent, "Passwords don't match.");
  assert.equal(completed.length, 0);

  await act(async () => typeInto(field('Confirm new password'), 'brand new pass'));
  await act(async () => button('Set password').click());
  assert.deepEqual(completed[0], ['slayer@example.com', '123456', 'brand new pass']);
});

test('the sign-in card offers Forgot password? on the official server only', async () => {
  await mount(loginScreen(officialServerState), { onCreateAccount() {} });
  assert.ok(button('Forgot password?'));
  await unmountNow();
  await mount(loginScreen(localServerState), { onCreateAccount() {} });
  assert.equal(button('Forgot password?'), undefined, 'a local server keeps its own accounts');
});

test('Home: an unavailable official server waits for Play with its note, shows the red badge, the version and the new copy', async () => {
  await mount(home({ getInstallStatus: async () => install }, undefined, undefined, { officialPlay: { available: false, message: 'Maintenance until 18:00.' } }));
  await act(async () => {});
  assert.equal(button('Unavailable').disabled, true, 'Play is disabled while the official server is off');
  assert.ok(document.body.textContent.includes('Maintenance until 18:00.'));
  const badge = document.querySelector('[data-testid="server-status"]');
  assert.equal(badge.textContent, 'Unavailable');
  assert.ok(badge.classList.contains('bad'));
  assert.equal(document.querySelectorAll('[data-testid="server-status"]').length, 1, 'one badge, not two');
  assert.ok(document.body.textContent.includes('Launcher v0.1.67'));
  assert.ok(document.body.textContent.includes('The Shattered Isles await.\nGear up, Slayer. Your next hunt begins.'));
});

test('Home: a healthy official server shows Online and Play, with no note', async () => {
  await mount(home({ getInstallStatus: async () => install }, undefined, undefined, { officialPlay: { available: true } }));
  await act(async () => {});
  const badge = document.querySelector('[data-testid="server-status"]');
  assert.equal(badge.textContent, 'Online');
  assert.ok(badge.classList.contains('good'));
  assert.ok(button('Play'), 'Play is enabled');
  assert.equal(document.body.textContent.includes('currently unavailable'), false);
});

test('Servers: the official server shows a red "Currently unavailable" chip beside its Official one', async () => {
  await mount(serversTab({ listServers: async () => [officialServer, localServer] }, { ...serverCtx, officialPlay: { available: false } }));
  await act(async () => {});
  const chips = [...document.querySelectorAll('.chip')].map((chip) => chip.textContent);
  assert.ok(chips.includes('Official'));
  assert.ok(chips.includes('Currently unavailable'));
  assert.ok(document.querySelector('.chip.bad').textContent === 'Currently unavailable');
});

test('the server switcher names the official server Unavailable, in the danger tone, while its play switch is off', async () => {
  await mount(serverSwitcher({}, switcherContext([officialServer], { officialPlay: { available: false } })));
  const tag = document.querySelector('.dropdown-tag');
  assert.equal(tag.textContent, 'Unavailable');
  assert.ok(tag.classList.contains('tone-danger'));
});

test('the server list reads the official play switch whichever server is selected', async () => {
  const { ServerProvider, useServer } = realServerContext({
    listServers: async () => [officialServer, localServer],
    getOfficialPlay: async () => ({ available: false, message: 'Maintenance until 18:00.' }),
  });
  let state = null;
  function Probe() { state = useServer(); return null; }
  await mount(() => React.createElement(ServerProvider, null, React.createElement(Probe)));
  await act(async () => {});
  assert.deepEqual(state.officialPlay, { available: false, message: 'Maintenance until 18:00.' });
});

function accountTabWith(auth, rules = accountRulesDefault()) {
  return load('src/screens/dashboard/AccountTab.tsx', {
    '../../auth/AuthContext': {
      useAuth: () => ({ account, logout: async () => {}, accountCheckedAt: 1700000000000, accountRefreshing: false, accountRefreshError: null, refreshAccount: async () => null, ...auth }),
      describeAuthError: plainError,
    },
    '../../auth/AccountRules': { useAccountRules: () => rules },
    '../../servers/ServerContext': { useServer: () => officialServerState },
    '../../lib/sessions': sessionsLib,
    '../../lib/accountDeletion': accountDeletionLib,
    '../../components/icons': icons,
    '../../components/ArtBackdrop': { ArtBackdrop: () => null },
    '../../components/Button': { Button: plainButton },
    '../../components/Banner': { Banner },
    '../../components/DeactivationBanner': { DeactivationBanner },
    '../../components/DeleteAccountDialog': { DeleteAccountDialog },
    '../../components/LegalDocument': LegalDocument,
    '../../legal/legalMeta': legalMeta,
  }).AccountTab;
}

test('Settings: a linked Discord shows its name and Unlink, an unlinked one offers Link Discord, a missing status offers nothing', async () => {
  const calls = [];
  await mount(accountTabWith({ account: { ...account, discord: { linked: true, username: 'MysticFox' } }, unlinkDiscord: async () => { calls.push('unlink'); } }));
  assert.ok(document.body.textContent.includes('Linked as MysticFox.'));
  await act(async () => button('Unlink').click());
  assert.deepEqual(calls, ['unlink']);
  await unmountNow();

  await mount(accountTabWith({ account: { ...account, discord: { linked: false } }, linkDiscord: async () => { calls.push('link'); } }));
  assert.ok(document.body.textContent.includes('Not linked.'));
  await act(async () => button('Link Discord').click());
  assert.deepEqual(calls, ['unlink', 'link']);
  assert.ok(document.body.textContent.includes('Finish linking in the browser window that opened.'));
  await unmountNow();

  await mount(accountTabWith({ account }));
  assert.ok(document.body.textContent.includes('does not show the Discord link yet'));
  assert.equal(button('Unlink'), undefined);
  assert.equal(button('Link Discord'), undefined);
});

test('Settings: the result of a Discord link is shown under the row', async () => {
  await mount(accountTabWith({ account: { ...account, discord: { linked: true, username: 'MysticFox' } }, discordLinkNotice: { tone: 'error', text: 'Discord linking didn\'t complete. Please try again.' } }));
  assert.ok(document.body.textContent.includes('Discord linking didn\'t complete. Please try again.'));
});
