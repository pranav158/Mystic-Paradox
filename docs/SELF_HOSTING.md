# Self-hosting Mystic Paradox: source to Ramsgate

> [!NOTE]
> This guide is for Dauntless 1.14.7, which `main` targets (alpha). For 1.12.0, follow the guide on the
> [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag. Upgrading an
> existing 1.12.0 deployment? See [Upgrading from 1.12.0](#upgrading-from-1120).

This handbook covers a complete Windows x64 deployment of Mystic Paradox for Dauntless 1.14.7,
from a clean source checkout through the first successful Ramsgate session.

Mystic Paradox is an unofficial preservation project. It does not distribute the game, generated
Unreal SDK files, or extracted game data. Use only a lawful installation that you control.

> [!IMPORTANT]
> A fresh clone can compile the Node services and exercise startup plumbing with synthetic fixtures.
> It cannot reach a playable Ramsgate without a complete SDK and complete compatible game data
> extracted from your own installation.

## Supported target

| Property | Required value |
|---|---|
| Game | Dauntless 1.14.7 |
| Build label | rel-1.14.7-Archon |
| Changelist | 647472 |
| Unreal Engine | 4.26.2 |
| Platform | Windows x64 |
| Public backend | HTTPS on TCP 443 |

Other builds are not expected to work. The launcher verifies the executable hash as well as the
changelist.

## What you are deploying

| Component | Responsibility | Runs on |
|---|---|---|
| ParadoxBackend | Accounts, persistence, game APIs, matchmaking coordination, XMPP presence, runtime manifests | Backend host |
| ParadoxDirector | Starts and supervises Ramsgate, Training Dojo, and hunt processes | Windows game-server host |
| ParadoxRuntime | MysticParadox.dll compatibility/runtime layer | Beside every game executable |
| RuntimeLoader | winmm.dll proxy that loads the runtime at process startup | Beside every game executable |
| ParadoxLauncher | Account UI, executable verification, signed runtime repair, session exchange, game launch | Every player PC |
| MongoDB | Persistent service data | Private database host |

A simple deployment can run MongoDB, Backend, Director, and dedicated game processes on one Windows
host. Players run the launcher and their own compatible client.

    Player launcher/game
        | HTTPS 443 and XMPP WebSocket
        v
    ParadoxBackend ---- private TCP 3001 ----> ParadoxDirector
        |                                      |
        v                                      v
    MongoDB TCP 27017                 Ramsgate / Dojo / hunts
                                      UDP 8780-8790 by default

Keep TCP 3000, TCP 3001, and MongoDB private. Expose TCP 443 and the configured game UDP range.

## Prerequisites

Install or prepare:

- Windows 10 or 11 x64.
- Node.js 20 or newer and npm.
- MongoDB 7 or a compatible MongoDB Atlas deployment.
- Current stable Rust with the x86_64-pc-windows-msvc target.
- Visual Studio C++ Build Tools, a Windows SDK, and the Desktop development with C++ workload.
- Microsoft Edge WebView2 Runtime for the Tauri launcher.
- A DNS name you control, such as paradox.example.net.
- A publicly trusted TLS certificate for that exact hostname.
- Your own Dauntless 1.14.7 Windows installation.
- A complete Dumper-7 CppSDK generated from that installation.
- Complete backend and director game-data payloads generated from the same build.

Official prerequisite references:

- Tauri Windows prerequisites: https://v2.tauri.app/start/prerequisites/
- Rust installation: https://www.rust-lang.org/tools/install/
- MongoDB on Windows: https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-windows/
- Let's Encrypt challenge types: https://letsencrypt.org/docs/challenge-types/

The C++ projects currently select the Visual Studio v145 toolset. If you use Visual Studio 2022,
retarget both ParadoxRuntime and tools/CatalogExporter to v143 locally before building.

## 1. Prepare DNS, TLS, and firewall rules

### DNS

Create an A or AAAA record for the public hostname and point it at the backend. Use the exact same
hostname for:

- the certificate Subject Alternative Name;
- PublicHost passed to configure-selfhost.ps1;
- MP_PUBLIC_HOST compiled into the runtime;
- launcher API and runtime origins;
- REALTIME_XMPP_ALLOWED_HOSTS.

Changing the hostname later requires rebuilding both the runtime and launcher.

### TLS certificate

ParadoxBackend terminates TLS directly on TCP 443. Supply a PEM full chain containing the leaf and
intermediate certificates, a PEM private key, and the passphrase if the key is encrypted.

For a launcher distributed to other players, use a publicly trusted certificate. The native launcher
uses reqwest with WebPKI roots. Installing only a private CA in the Windows certificate store is not
sufficient for the current launcher unless you modify and rebuild its trust configuration.

DNS-01 issuance is convenient because the application does not require public port 80. The backend
reads certificate files at startup, so restart it after renewal. Never keep the private key inside
the repository.

### Firewall and NAT

| Port | Protocol | Purpose | Exposure |
|---|---|---|---|
| 443 | TCP | Backend HTTPS and realtime WebSocket | Public |
| 3000 | TCP | Backend local HTTP | Private |
| 3001 | TCP | Backend-to-Director API | Private |
| 8780-8788 | UDP | Dynamically allocated hunts | Public |
| 8789 | UDP | Training Dojo | Public |
| 8790 | UDP | Ramsgate | Public |
| 27017 | TCP | MongoDB | Private |

Forward the UDP game range to the Director/game-server machine if it is behind NAT. Set
GameServerPublicAddress to the address players can reach. Do not expose MongoDB to the Internet.

## 2. Verify the game installation

The expected executable is normally:

    D:\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe

Keep a clean copy. The configurator records its SHA-256 in APPROVED_EXECUTABLE_SHA256; session
issuance fails closed if a player executable does not match.

    Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe'

Do not commit or redistribute the executable, PAKs, generated SDK, or extracted content.

## 3. Generate the Unreal SDK

Follow [GENERATING_SDK.md](GENERATING_SDK.md). In summary:

1. Build Dumper-7.
2. Run your own 1.14.7 client and inject Dumper-7 into that process.
3. Copy the complete CppSDK output into ParadoxRuntime.
4. Confirm generated headers and all *_functions.cpp files are present.

Expected layout:

    ParadoxRuntime\
      SDK\
        ...generated headers...
        ...generated *_functions.cpp files...
      SDK.hpp
      Assertions.inl
      NameCollisions.inl
      PropertyFixup.hpp
      UnrealContainers.hpp
      UtfN.hpp

A header-only or partial copy is not enough. tools/CatalogExporter uses the same SDK.

## 4. Generate the required game data

Follow [GENERATING_GAME_DATA.md](GENERATING_GAME_DATA.md). The final files are:

Backend, under ParadoxBackend/game-data:

- progression_config.json
- slayers_path.json
- slayers_path_definitions.json
- ladyluck_store.json
- platinum_store.json
- reward_cache_store.json
- inventory_storage_policy.json

Director, under ParadoxDirector/game-data:

- player_hunts_table.json
- matchmaker_hunts_table.json
- arena_easy_matchmaker_hunts.json
- arena_hard_matchmaker_hunts.json
- arena_elite_matchmaker_hunts.json
- arena_hard_matchmaker_hunts_new.json
- arena_elite_matchmaker_hunts_new.json

CatalogExporter, injected into your own 1.14.7 client, provides the catalog, the Slayer's Path nodes,
the hunt tables and the store images. The Director tables, the Slayer's Path files, the Reward Cache
store and the storage policy are generated from that export. Two files need a source you supply:

- progression_config.json, from a progression-config response (`payload.paths`);
- ladyluck_store.json, from a Lady Luck store response (an array of store entries).

The Platinum store is generated from the catalog and store images (step 6 of the game-data guide).

Some tables stream only after reaching Ramsgate or opening the relevant screen; the game-data guide
says which. Synthetic *.example.json files are only compilation/startup fixtures and are not
playable.

Do not continue to gameplay testing until every final file exists and the services start without a
game-data error.

## 5. Install MongoDB

For a local service, use:

    mongodb://127.0.0.1:27017

For Atlas, use its TLS connection string and restrict access to the backend host. On startup the
backend creates collections, indexes, TTL indexes, and gameserver-key records. A new installation
does not require a separate manual migration command.

Back up MongoDB before inviting players. It stores accounts, characters, inventory, loadouts,
parties, and progression.

## 6. Generate the self-host configuration

From the repository root:

    powershell -ExecutionPolicy Bypass -File scripts\configure-selfhost.ps1 -PublicHost paradox.example.net -GameServerBinaryPath 'D:\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe' -TlsCertificatePath 'D:\MysticParadoxData\certs\fullchain.pem' -TlsPrivateKeyPath 'D:\MysticParadoxData\certs\privkey.pem' -GameServerPublicAddress 203.0.113.20 -InstallDependencies

The helper requires HTTPS port 443 and at least three game ports. It creates:

- ParadoxBackend/.env
- ParadoxDirector/.env
- ParadoxLauncher/.env
- ParadoxRuntime/deployment_config.generated.h
- a fresh RSA JWT signing pair;
- a shared gameserver API key;
- a backend-only API-key hashing secret;
- the approved executable SHA-256;
- a runtime-update Ed25519 key under ParadoxLauncher/.secrets;
- .selfhost/build-env.ps1;
- .selfhost/tauri.selfhost.conf.json.

These are ignored. Confirm they remain untracked:

    git status --short --ignored

Use -UseSyntheticData only for a non-playable build/start smoke test.

> [!WARNING]
> Do not use -Force for routine updates or certificate renewal. It replaces environment files and
> may rotate credentials. Use it only when you intentionally want a new deployment identity and
> understand its effect on existing sessions and keys.

## 7. Review the generated settings

Inspect both generated .env files locally without sharing their contents.

Backend essentials:

| Setting | Expected |
|---|---|
| AUTH_MODE | LAUNCHER |
| ALLOW_NO_AUTH_DEV_MODE | false |
| TARGET_CHANGELIST | 647472 |
| MATCHMAKING_MODE | DEPLOYSERVER |
| DEPLOYSERVER_URL | 127.0.0.1:3001 unless separated |
| HTTPS_PORT | 443 |
| PARADOX_CERT_PEM_PATH | Absolute full-chain path |
| PARADOX_KEY_PEM_PATH | Absolute private-key path |
| APPROVED_EXECUTABLE_SHA256 | Exact target executable hash |
| REALTIME_XMPP_ENABLED | true |
| REALTIME_XMPP_ALLOWED_HOSTS | Exact public hostname |
| API_KEY_HASH_SECRET | Random, 32+ characters; the backend refuses to start without it. Keep it stable |
| GAMESERVER_API_KEYS | The raw gameserver key(s); when non-empty this is the complete key set |

The configurator does not set NODE_ENV. If you run the backend with NODE_ENV=production, it also
requires MYSTICPARADOX_SERVICE_ROLE=api and a MYSTICPARADOX_METRICS_TOKEN, and refuses to start
without them.

Every backend route has a per-address request budget: 600 requests a minute, and 6000 for calls
that carry the gameserver key, because all hubs and hunts on one host share its address. A client
over budget gets HTTP 429. Raise the budgets with MYSTICPARADOX_RATE_LIMIT_PER_MINUTE and
MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE (for example when many players share one address),
or turn them off with MYSTICPARADOX_RATE_LIMIT=off. The stricter limits on login, registration,
update downloads and log uploads always apply.

Director essentials:

| Setting | Expected |
|---|---|
| MY_IP | Player-reachable public or LAN address |
| PORT_RANGE_BEGIN / END | 8780 / 8790 by default |
| GAMESERVER_BINARY_PATH | Exact game-server executable |
| METAGAME_API_KEY | Same raw key generated for Backend |
| GAMESERVER_READY_TIMEOUT_MS | 30000 or a deliberate override |
| SERVER_RUNTIME_AUTO_UPDATE | false (the configurator default) |

With SERVER_RUNTIME_AUTO_UPDATE=true the Director fetches the server runtime before starting the
worlds: set SERVER_RUNTIME_MANIFEST_URL to your own backend and publish a `--target server` runtime
(step 10) first.

Set stable absolute locations as well:

    # ParadoxBackend\.env
    PARADOX_GAME_DATA_DIR=D:\MysticParadoxData\backend-game-data
    LAUNCHER_UPDATE_ROOT=D:\MysticParadoxData\updates

    # ParadoxDirector\.env
    PARADOX_GAME_DATA_DIR=D:\MysticParadoxData\director-game-data
    GAMESERVER_LOG_DIR=D:\MysticParadoxData\gameserver-logs

Copy the final data files into those directories if you override the defaults.

UPDATE_PUBLISHER_API_KEY may remain blank when artifacts are published locally with the provided
script. Blank remote-publisher settings fail closed.

## 8. Build and test the services

Backend:

    Set-Location ParadoxBackend
    npm ci
    npm run build
    npm test

Director:

    Set-Location ..\ParadoxDirector
    npm ci
    npm run build

Add `npm test` in ParadoxDirector as well. `npm test` skips the `*.gamedata.test.ts` files until every
real game-data file is present; with your generated data in place it also checks that data. The
Director does not rebuild on start: run `npm run build` there again after every update.

Do not run npm run test:bootstrap against the real database. That integration suite is destructive
and requires a separate MONGODB_TEST_DB plus an explicit opt-in.

## 9. Build MysticParadox.dll and winmm.dll

Build the runtime:

    Set-Location ..\ParadoxRuntime
    .\_build.bat

Expected output:

    ParadoxRuntime\x64\Release\MysticParadox.dll

Build the loader:

    Set-Location ..\tools\RuntimeLoader
    cargo build --release

Expected output:

    tools\RuntimeLoader\target\release\winmm.dll

Place both beside the exact game executable used by Director:

    D:\Dauntless\Archon\Binaries\Win64\
      Dauntless-Win64-Shipping.exe
      MysticParadox.dll
      winmm.dll

The loader forwards legitimate winmm exports to the Windows system library and loads
MysticParadox.dll. It falls back to a legacy MystPaxInternalServer.dll only when that copy is newer,
so delete any old copy left from a 1.12.0 install. Do not add untrusted DLLs to mystic_loader.ini.

## 10. Publish the signed client runtime

The launcher repairs the runtime from a signed manifest. Publish MysticParadox.dll and winmm.dll
into the Backend update root before installing a client:

    Set-Location ParadoxLauncher
    node scripts/publish-runtime-update.mjs --dll ..\ParadoxRuntime\x64\Release\MysticParadox.dll --extra ..\tools\RuntimeLoader\target\release\winmm.dll --target client --version 0.1.0 --changelist 647472 --channel stable --output D:\MysticParadoxData\updates --base-url https://paradox.example.net --key .secrets\selfhost-runtime-update.private.pem

Use a new semantic version whenever bytes change. Protect and back up the private signing key.
Losing it means existing launchers cannot trust a replacement without being rebuilt.

Runtime signing and Tauri launcher-update signing are separate systems.

## 11. Start Backend and verify HTTPS

Start MongoDB, then:

    Set-Location ParadoxBackend
    npm start

Check locally and publicly:

    Invoke-RestMethod http://127.0.0.1:3000/
    Invoke-RestMethod https://paradox.example.net/
    Invoke-RestMethod https://paradox.example.net/QoS
    Invoke-RestMethod https://paradox.example.net/launcher/v1/status
    Invoke-RestMethod https://paradox.example.net/launcher/v1/runtime/client/stable/windows-x86_64

Expected results:

- the root endpoint reports ok;
- QoS reports pong;
- launcher status reports online and supportedBuildChangelist 647472;
- the runtime endpoint returns the signed manifest;
- there is no TLS warning or hostname mismatch.

Do not move on while HTTPS or the runtime manifest fails.

## 12. Start Director and verify persistent worlds

Confirm MysticParadox.dll and winmm.dll are beside GAMESERVER_BINARY_PATH, then:

    Set-Location ParadoxDirector
    npm start

Director immediately starts Training Dojo and Ramsgate. Hunts use the lower portion of the range;
with defaults, Training Dojo uses 8789 and Ramsgate uses 8790.

A process existing is not enough. Wait for the exact runtime readiness marker:

    MYSTICPARADOX_GAMESERVER_READY launchId=<uuid> port=<port>

Director should then log messages equivalent to:

    training_dojo ready on <MY_IP>:8789
    ramsgate ready on <MY_IP>:8790

If Director logs a startup failure but remains listening on port 3001, the deployment is not ready.
Fix the child failure before launching a player.

Runtime logs appear beside the game executable as mysticparadox_dll_port*.log. Director-managed
process logs use GAMESERVER_LOG_DIR when configured.

## 13. Build and run the self-host launcher

The configurator generated compile-time native settings. Dot-source them in the same PowerShell
process used to invoke Tauri:

    Set-Location <repository-root>
    . .\.selfhost\build-env.ps1
    Set-Location ParadoxLauncher
    npm ci
    npm run build
    npm run test:workflow
    npm run tauri -- dev --config ..\.selfhost\tauri.selfhost.conf.json

This compiles the React/Vite assets and the native Tauri application. It binds native authentication
and runtime downloads to your HTTPS origin and verification key.

For a packaged build, replace dev with build:

    npm run tauri -- build --config ..\.selfhost\tauri.selfhost.conf.json

### Configure launcher self-updates before distribution

The checked-in Tauri configuration contains the project-maintainer updater endpoint and public key.
Do not distribute a custom self-host launcher that inherits those defaults.

Generate your own Tauri updater key:

    npm run tauri signer generate -- -w .secrets\mystic-launcher.key

Add your updater public key and HTTPS updater endpoint to an ignored Tauri overlay, then build with
that overlay and the required signing environment. See
[ParadoxLauncher/UPDATE_CHANNEL.md](../ParadoxLauncher/UPDATE_CHANNEL.md).

The release:launcher and publish:launcher scripts target the repository's normal release
configuration. Do not use them unchanged for a custom overlay. Tauri updater signatures are not
Windows Authenticode signatures and do not by themselves establish SmartScreen reputation.

## 14. First player setup

On a player PC:

1. Install or run the self-host launcher.
2. Select Create account.
3. Use a 3-16 character alphanumeric username and a password of at least 8 characters.
4. Sign in.
5. Select Locate game and choose the Archon/game folder containing
   Binaries\Win64\Dauntless-Win64-Shipping.exe.
6. Select Repair if the launcher reports a missing or stale runtime.
7. Confirm the supported executable and runtime are ready.
8. Select Play.

Play refreshes policy, validates the executable and runtime, downloads any required signed runtime,
obtains a short-lived one-time exchange code, and launches the game. Starting the executable
directly does not obtain that code and is not the supported login path.

Launcher session logs are collected under:

    %LOCALAPPDATA%\MysticParadox\Logs\Sessions\<session-id>\

Each session includes launcher.log, metadata.json, and copies of available runtime logs.

## 15. Ramsgate acceptance test

The first supported milestone is complete only when all of these are true:

- MongoDB is connected and Backend has no missing-data error.
- Public HTTPS is trusted and launcher status reports changelist 647472.
- The signed client runtime manifest downloads successfully.
- Director reports Training Dojo and Ramsgate ready.
- UDP 8790 is reachable from the player network.
- The launcher creates or signs into an account and accepts the executable hash.
- Repair installs matching winmm.dll and MysticParadox.dll.
- Play launches with a one-time exchange code.
- Character login completes.
- The player enters Ramsgate without an immediate disconnect.
- Backend, Director, game-server, and runtime logs show no auth or readiness failure.

After that, test in this order:

1. Reconnect to Ramsgate.
2. Start a solo hunt, kill a behemoth, and return to Ramsgate. The hunt server should exit about
   50 seconds after the last player leaves.
3. Sign out and back in: the hunt rewards must still be in the inventory.
4. Invite, remove, and disconnect a party member.
5. Start party island travel.
6. Enter Training Dojo.
7. Test public hunt reuse only if explicitly enabled.

Known 1.14.7 issues are listed in the [port notes](DAUNTLESS_1_14_7_PORT.md#still-open).

Use matching current Backend, Director, Runtime, and Launcher builds. The replication and
disconnected-party fixes span multiple components.

## Operations and updates

### Certificate renewal

Renew the full chain and key at the same paths, then restart Backend. Do not rerun the configurator
with -Force merely to renew a certificate.

### Runtime update

Build MysticParadox.dll and winmm.dll, publish a new semantic version with the same protected
runtime-signing key, verify the manifest endpoint, then test Repair and Play on one client.

### Backend or Director update

Back up MongoDB and ignored configuration, review source changes, run builds/tests, and restart
Backend before Director unless release notes say otherwise. The backend rebuilds a stale build on
`npm start`; the Director does not, so run `npm run build` there first.

### Backups

Back up:

- MongoDB;
- generated .env files;
- TLS key and certificate history;
- runtime and launcher signing keys;
- the approved client checksum record;
- generated game data from your own installation.

Never publish backups or attach them unredacted to issues.

## Troubleshooting

### Launcher stays offline or account creation fails

Check public DNS, certificate chain, TCP 443, /launcher/v1/status, and whether the launcher was built
after dot-sourcing .selfhost/build-env.ps1. A browser accepting a private CA does not prove the
native WebPKI launcher trusts it.

### Runtime is missing or Repair fails

Check the manifest endpoint, artifact URLs, compiled Ed25519 public key, size, SHA-256, and
signature. Confirm both files are beside the exact selected executable. Publish a new version
instead of mutating an existing artifact.

### Session request is rejected

APPROVED_EXECUTABLE_SHA256 must match the exact player executable. Recompute it deliberately after
a known-good binary change and restart Backend.

### Director runs but Ramsgate is unavailable

Look for MYSTICPARADOX_GAMESERVER_READY and the ramsgate ready log, not merely an open Director port.
Check GAMESERVER_BINARY_PATH, both DLLs, UDP forwarding, data files, GAMESERVER_LOG_DIR, and
mysticparadox_dll_port*.log.

### Gameservers receive HTTP 401

GAMESERVER_API_KEYS in Backend must contain the raw METAGAME_API_KEY used by Director.
API_KEY_HASH_SECRET is backend-only and must remain stable. Restart Backend after changing the
authoritative key list.

### TLS works locally but remote players fail

Confirm the hostname matches the certificate SAN, the full intermediate chain is served, public DNS
does not resolve to a private address, and TCP 443 is forwarded. Restart Backend after certificate
changes.

### Solo hunts wait for a disconnected member

Use matching current Backend and Runtime versions. Inspect XMPP/session state and warnings about
excluded disconnected members. The requested ISLAND party id must match the authoritative party.

### Party travel disconnects another client

Use matching runtime bytes on clients and game servers. Repair through the launcher and confirm
runtime hashes. The runtime never lets one connection receive another player's PlayerController.

### Backend or Director stops at startup

Read the first error. Common causes: API_KEY_HASH_SECRET missing or shorter than 32 characters; a
missing or invalid game-data file (the message names it); an environment key still using the old
MYSTPAX_ prefix (rename it to MYSTICPARADOX_); NODE_ENV=production without
MYSTICPARADOX_SERVICE_ROLE and MYSTICPARADOX_METRICS_TOKEN.

### Useful logs

| Log | Location |
|---|---|
| Launcher session | %LOCALAPPDATA%\MysticParadox\Logs\Sessions\<session-id> |
| Runtime | Beside game executable, mysticparadox_dll_port*.log |
| Director child processes | GAMESERVER_LOG_DIR |
| Backend and Director | Console output or service-wrapper logs |

When reporting an issue, include the commit, component versions, redacted configuration, changelist,
reproduction steps, and relevant logs. Remove tokens, account data, private infrastructure paths,
certificate material, and every private key.

## Upgrading from 1.12.0

A 1.12.0 deployment from the `dauntless-1.12.0` tag needs, in this order:

1. A 1.14.7 client and server installation, and a fresh SDK from it (step 3); nothing generated from
   1.12.0 carries over.
2. New game data from the 1.14.7 install (step 4), including the files 1.12.0 did not have.
3. TARGET_CHANGELIST=647472 and APPROVED_EXECUTABLE_SHA256 of the 1.14.7 executable in the backend
   .env; an API_KEY_HASH_SECRET if you have none, then every API key registered again under it (for
   example in GAMESERVER_API_KEYS), because key records stored as plain SHA-256 no longer match; any
   MYSTPAX_ environment key renamed to MYSTICPARADOX_, including the launcher build variables in
   .selfhost/build-env.ps1.
4. A rebuilt runtime, loader and launcher, a new runtime version published with
   `--changelist 647472`, and the new launcher on every player PC.
5. A MongoDB backup, then the one-off account-data migrations in ParadoxBackend. Each is a dry run
   that only reports; add `--apply --confirm=<token>` with the token named in the script header to
   write:

       npm run inventory:storage-migrate      # stacked vs instanced items (APPLY_INVENTORY_STORAGE_MIGRATION)
       npm run banner:instance-migrate        # banner ids to instance ids (APPLY_BANNER_INSTANCE_ID_MIGRATION)
       npm run loadout:slots-migrate          # loadout slots from Slayer's Path (APPLY_LOADOUT_SLOT_ENTITLEMENT_MIGRATION)
       npx tsx --env-file=.env scripts/migrate_reward_cache_currency.ts
                                              # 1.12 season coins to 1.14.7 Cache Coins (APPLY_REWARD_CACHE_COIN_MIGRATION)

   Arguments after an npm script go after `--`, for example
   `npm run inventory:storage-migrate -- --apply --confirm=APPLY_INVENTORY_STORAGE_MIGRATION`.

## Public-host security checklist

Before inviting users:

- Keep AUTH_MODE=LAUNCHER and ALLOW_NO_AUTH_DEV_MODE=false.
- Use a publicly trusted certificate for the exact public hostname.
- Restrict MongoDB, backend HTTP, and Director ports at the firewall.
- Keep gameserver keys, API_KEY_HASH_SECRET, JWT keys, TLS keys, and signing keys private.
- Leave publisher upload routes fail-closed unless intentionally configured.
- Set ADMIN_TOTP_SECRET and ADMIN_ALLOWED_ORIGINS before enabling admin access.
- Disable diagnostic body capture unless actively debugging.
- Load trusted DLLs only and verify the runtime manifest.
- Back up MongoDB and signing material securely.
- Publish corresponding source for network-visible modifications as required by AGPLv3.
