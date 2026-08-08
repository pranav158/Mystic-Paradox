# Self-hosting Mystic Paradox

This guide describes the supported source deployment for Dauntless 1.12.0
(rel-1.12.0-Archon, changelist 392819) on Windows x64.

Mystic Paradox does not distribute the game, generated SDK headers, or extracted game data.
You must supply those from a lawful installation. The synthetic example data is only a build and
startup fixture; it does not produce a playable server.

## Deployment shape

A complete host has five project components:

| Component | Purpose | Typical location |
|---|---|---|
| ParadoxBackend | HTTPS game API, accounts, persistence, and realtime presence | Windows host or VM |
| ParadoxDirector | Starts Ramsgate, Training Dojo, and hunt servers | Same Windows machine as the game binary |
| ParadoxRuntime | Injected compatibility and authoritative-server DLL | Beside the game executable |
| tools/RuntimeLoader | winmm proxy that loads the runtime at process startup | Beside the game executable |
| ParadoxLauncher | Account login, executable verification, runtime updates, and launch | Each player PC |

MongoDB is the only external database.

## Before you begin

Install:

- Windows 10 or 11 x64
- Node.js 20 or newer and npm
- MongoDB 7 or a compatible MongoDB Atlas deployment
- Rust stable with the x86_64-pc-windows-msvc target
- Visual Studio C++ Build Tools and a Windows SDK
- Microsoft Edge WebView2 Runtime
- A valid TLS certificate and private key in PEM format
- Your own Dauntless 1.12.0 Windows installation
- A Dumper-7 SDK generated from that installation

The backend hostname must resolve to the server and its certificate must be trusted by every player
machine. The runtime redirects game service requests to this hostname. Production and remote
deployments therefore use HTTPS on port 443.

## 1. Clone and configure

From an ordinary PowerShell prompt at the repository root:

    powershell -ExecutionPolicy Bypass -File scripts\configure-selfhost.ps1 -PublicHost paradox.example.net -GameServerBinaryPath D:\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe -TlsCertificatePath D:\MysticParadox\certs\fullchain.pem -TlsPrivateKeyPath D:\MysticParadox\certs\privkey.pem -GameServerPublicAddress 203.0.113.20

The script:

- creates ignored ParadoxBackend and ParadoxDirector environment files;
- generates a new 4096-bit RSA JWT key pair;
- generates a gameserver API key and configures both services with the same value;
- hashes the supplied executable into the launch allow-list;
- writes the ignored runtime deployment header;
- creates an Ed25519 runtime-update signing key under ParadoxLauncher\.secrets;
- creates ignored launcher build settings under .selfhost.

It refuses to replace existing environment files unless Force is supplied. Never commit the
generated environment files, .selfhost directory, certificate private key, or .secrets directory.

For a compilation-only smoke test, add UseSyntheticData. Replace the synthetic files with real
generated data before attempting gameplay.

## 2. Generate the SDK and game data

Follow GENERATING_SDK.md, then GENERATING_GAME_DATA.md.

The runtime needs the complete Dumper-7 CppSDK output in ParadoxRuntime. The backend and director
need their generated JSON files under their game-data directories. Startup fails when required
files are absent or structurally invalid.

## 3. Install and validate the Node services

    cd ParadoxBackend
    npm ci
    npm test
    npm run build

    cd ..\ParadoxDirector
    npm ci
    npm run build

The backend reads GAMESERVER_API_KEYS from its environment, hashes each key before persistence, and
accepts the matching raw METAGAME_API_KEY used by the director. No manual MongoDB key insertion is
required.

## 4. Build the runtime and loader

Build the runtime:

    cd ParadoxRuntime
    .\_build.bat

The x64 Release output is MysticParadox.dll.

Build the loader:

    cd ..\tools\RuntimeLoader
    cargo build --release

Copy these two files beside Dauntless-Win64-Shipping.exe:

- ParadoxRuntime\x64\Release\MysticParadox.dll
- tools\RuntimeLoader\target\release\winmm.dll

The loader forwards calls to the real Windows winmm library and loads only
MysticParadox.dll by default. Do not add untrusted DLLs to mystic_loader.ini.

## 5. Start the services

Start MongoDB first. Then use separate PowerShell windows:

    cd ParadoxBackend
    npm start

    cd ParadoxDirector
    npm start

The director starts Ramsgate and Training Dojo immediately. Do not start the director until the
runtime DLL and winmm loader are beside the configured game executable.

Useful checks:

- GET http://127.0.0.1:3000/ returns ok.
- GET https://your-hostname/ returns ok with no certificate warning.
- Backend logs show one configured gameserver API key.
- Director logs show both persistent hubs reporting ready.
- Gameserver logs contain MYSTICPARADOX_GAMESERVER_READY.

## 6. Build or run the launcher

The configuration script creates .selfhost\build-env.ps1 and a Tauri CSP overlay. Dot-source the
environment before invoking Tauri:

    . .\.selfhost\build-env.ps1
    cd ParadoxLauncher
    npm ci
    npm run tauri -- dev --config ..\.selfhost\tauri.selfhost.conf.json

For a packaged build, replace dev with build.

The compile-time settings bind native account requests and runtime downloads to your HTTPS origin.
Runtime manifests must be signed by the generated Ed25519 private key. Publish both the runtime
and loader from `ParadoxLauncher` before the first client install:

    node scripts/publish-runtime-update.mjs --dll ..\ParadoxRuntime\x64\Release\MysticParadox.dll --extra ..\tools\RuntimeLoader\target\release\winmm.dll --target client --version 0.1.0 --changelist 392819 --channel stable --output ..\ParadoxBackend\updates --base-url https://your-hostname --key .secrets\selfhost-runtime-update.private.pem

Use a new semantic version for each published artifact. See
[ParadoxLauncher\UPDATE_CHANNEL.md](../ParadoxLauncher/UPDATE_CHANNEL.md) for channel and rollout
details.

Tauri launcher updates use a separate signing system. Before distributing a packaged launcher,
replace the updater endpoint and public key in a private Tauri configuration overlay and keep the
matching private key outside the repository.

## Network and firewall

Default ports created by the configuration script:

| Port | Protocol | Purpose |
|---|---|---|
| 443 | TCP | Backend HTTPS and realtime WebSocket |
| 3000 | TCP | Local backend HTTP; keep private |
| 3001 | TCP | Backend-to-director API; keep private |
| 8780-8790 | UDP/TCP as used by the game | Hunts, Training Dojo, and Ramsgate |
| 27017 | TCP | MongoDB; keep private |

Expose only HTTPS and the required game ports. Bind MongoDB, backend HTTP, and the director API to a
trusted network or protect them with host firewall rules.

## First account and administration

The launcher registration flow creates ordinary accounts. To bootstrap an administrator after the
account exists:

    cd ParadoxBackend
    npm run admin:bootstrap -- --email=operator@example.net --username=operator

Set ADMIN_TOTP_SECRET and ADMIN_ALLOWED_ORIGINS before enabling the admin routes on a public host.

## Troubleshooting

### The launcher says the runtime is missing

Confirm both winmm.dll and MysticParadox.dll are non-empty and beside the exact executable
selected in the launcher.

### Game sessions are rejected

Re-run the configuration script after changing the game executable. APPROVED_EXECUTABLE_SHA256 must
match the exact 1.12.0 executable and the configured changelist must remain 392819.

### Gameservers receive 401 responses

GAMESERVER_API_KEYS in ParadoxBackend and METAGAME_API_KEY in ParadoxDirector must share one raw key.
The configured backend list is authoritative: restart the backend after changing it, and removed keys
will be revoked from MongoDB.

### Solo hunts wait for another player

The current backend filters disconnected XMPP members and requires an ISLAND request party id to
match the authoritative party. Confirm realtime is enabled and inspect the excluded-member warning
in backend logs.

### Party travel disconnects a client

Use the current runtime. It blocks remote PlayerController replication before channel creation and
preserves the native 64-bit replication-count ABI at the final channel boundary.

## Security checklist

Before inviting remote users:

- Use AUTH_MODE=LAUNCHER and keep ALLOW_NO_AUTH_DEV_MODE false.
- Use a publicly trusted certificate or explicitly manage trust on every client.
- Restrict MongoDB, backend HTTP, and director ports at the firewall.
- Replace all keys generated for test deployments before production.
- Keep runtime and launcher signing private keys offline or in a dedicated secret store.
- Publish source for network-visible modifications as required by the AGPL.
- Back up MongoDB and the generated environment files securely.