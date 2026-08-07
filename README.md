# Mystic Paradox

Mystic Paradox is a community preservation project working to restore local and private-server functionality for the discontinued monster-hunting game Dauntless.

The project is based on the open-source Undaunted server and is being adapted from Dauntless 1.4.4 to Dauntless 1.12.0. It provides the backend, deployment, and runtime compatibility pieces needed to connect a supported game client to a privately operated server.

> [!IMPORTANT]
> Mystic Paradox is an unofficial, community-developed preservation project. It is not affiliated with, endorsed by, or sponsored by Phoenix Labs, Epic Games, Forte Labs, or any current or former Dauntless rights holder.

## Project status

Mystic Paradox is an alpha preservation server for Dauntless 1.12.0. The source tree now includes
a reproducible Windows self-host configuration path, the runtime loader, backend/director
authentication wiring, and regression tests for party travel. Gameplay coverage is still incomplete
and operators should expect active development rather than production-grade uptime.

Recent stability work prevents disconnected party members from holding solo travel open and blocks
remote PlayerController replication before it can disconnect another party member during travel.

## Components

- **ParadoxBackend** — account and metagame backend (login, EOS, character, inventory,
  loadout, progression, store, matchmaking, party, guild), Node/TypeScript, backed by
  MongoDB.
- **ParadoxDirector** — game-server deployment service; spawns and supervises dedicated
  gameserver processes for social spaces and hunts.
- **ParadoxRuntime** — runtime compatibility layer; injected C++ DLL (server / client mode)
  that adapts the game client and gameserver processes to the private backend and the
  updated engine. Built with MSVC + MinHook.
- **ParadoxLauncher** — Windows desktop launcher; authenticates players, verifies the
  supported client, installs signed runtime updates, and issues one-time game sessions.
- **tools/RuntimeLoader** — Apache-licensed winmm proxy source; loads the runtime at process
  startup while forwarding multimedia calls to the real Windows system library.
- **tools/CatalogExporter** — local exporter used to generate compatibility data from your
  own installation.

## Supported game version

| Property | Value |
|---|---|
| Game version | Dauntless 1.12.0 |
| Build label | `rel-1.12.0-Archon` |
| Changelist | `392819` |
| Unreal Engine | `4.26.2` |
| Platform | Windows x64 |

Other versions are not expected to work unless explicitly documented.

## What is NOT included (you must supply your own)

This repository contains **source code only**. For legal reasons it does **not**
ship, and will never ship:

- The game client or any game binaries / packaged assets.
- The generated Unreal Engine SDK (Dumper-7 output).
- **Bulk extracted game-data tables** — progression, hunt tables, store, Slayer's Path, etc.
  These are Phoenix Labs content; you generate them from your own installation.
- Any credentials, TLS certificates, or private keys.

The Node.js services (`ParadoxBackend`, `ParadoxDirector`) **compile and test without any of the
above** — synthetic `*.example.json` placeholders let them build and smoke-test. The C++ projects
(`ParadoxRuntime`, `tools/CatalogExporter`) **require a locally generated Dumper-7 SDK** from your
own compatible installation; they do not build from a fresh clone alone. Real game data must be
generated locally in all cases.

> **Scope of this claim.** This repository does not distribute the game client, packaged game
> assets, generated SDK headers, or bulk extracted game-data tables. It does necessarily contain
> interoperability information — protocol/endpoint names, catalog identifiers, class names, and
> engine hook offsets — as any compatibility layer must. Users must generate the required
> compatibility data from their own lawful installation.

### Generate the SDK yourself

The injected DLL (`ParadoxRuntime`) needs a C++ SDK generated from your own copy of the game.
See `docs/GENERATING_SDK.md`. In short: build [Dumper-7](https://github.com/Encryqed/Dumper-7),
inject it into your running `1.12.0` process, and copy the **complete** generated `CppSDK` output
(`SDK/`, `SDK.hpp`, `UnrealContainers.hpp`, `UtfN.hpp`, `PropertyFixup.hpp`, `NameCollisions.inl`,
`Assertions.inl`) into `ParadoxRuntime/`. Then copy `deployment_config.generated.h.example` to
`deployment_config.generated.h` and set `MP_PUBLIC_HOST`.

### Generate the game data yourself

Extract it from your own installation with `tools/CatalogExporter` and the `generate:*` scripts.
See `docs/GENERATING_GAME_DATA.md`.

## Prerequisites

- Node.js 20+ and npm
- Current stable Rust, the MSVC target, Windows SDK, and Microsoft Edge WebView2 Runtime for
  `ParadoxLauncher`
- MongoDB (local or Atlas)
- Visual Studio Build Tools 2026 (Desktop C++ workload) with the `v145` platform toolset, for the
  C++ projects (`ParadoxRuntime`, `tools/CatalogExporter`). To build with Visual Studio 2022
  instead, retarget both `.vcxproj` files to `v143` and rebuild.
- Your own game client for the target build + a Dumper-7 SDK (see above)

## Quick start

The supported source-deployment path is documented in
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). On Windows, the configuration helper generates fresh
JWT and runtime-signing keys, wires the backend and director gameserver key, hashes the approved
game executable, creates the runtime host header, and prepares a self-host launcher build:

    powershell -ExecutionPolicy Bypass -File scripts\configure-selfhost.ps1 -PublicHost paradox.example.net -GameServerBinaryPath D:\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe -TlsCertificatePath D:\certs\fullchain.pem -TlsPrivateKeyPath D:\certs\privkey.pem

It does not download or generate proprietary game content. Follow
[docs/GENERATING_SDK.md](docs/GENERATING_SDK.md) and
[docs/GENERATING_GAME_DATA.md](docs/GENERATING_GAME_DATA.md) using your own installation.

For a build-only smoke test, pass `-UseSyntheticData`. The synthetic fixtures are intentionally not
playable.

## Security notes

- **Do not run with authentication disabled on a public host.** `AUTH_MODE=NONE`
  together with `ALLOW_NO_AUTH_DEV_MODE=true` auto-creates/logs in arbitrary
  accounts with no verification. These are development-only switches; leave them
  unset in any real deployment.
- The backend server terminates TLS directly. Supply a real certificate and keep
  its passphrase out of version control (only `.env`, which is git-ignored).
- Admin routes (`/admin/v1`) fail closed without `ADMIN_TOTP_SECRET` and an origin
  allow-list. Publisher/update-push routes fail closed without an explicit IP
  allow-list.
- Never commit a populated `.env`, private keys, certificates, updater signing keys, or signing
  passwords. Launcher release material belongs only in ignored `.secrets/` directories.

## Self-hosting

Self-hosting from source is supported on Windows x64 for the documented 1.12.0 target. The project
does not provide the game, generated SDK, extracted data, certificates, or hosted infrastructure.
Start with [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md), which covers the full service order,
runtime loader, TLS/DNS requirements, launcher configuration, ports, validation, and troubleshooting.

Issue reports are welcome when they include the component, commit, configuration with secrets
removed, reproduction steps, and relevant logs.

## Contributions

Contributions are welcome via GitHub issues and pull requests. Please describe the scope of your change, keep unrelated changes separate, and do not submit proprietary game files, leaked source, or secrets. Contributions to covered components are distributed under the project's AGPLv3 license. Acceptance is not guaranteed.

## Responsible development

This project is intended for preservation, interoperability research, education, and privately operated community play. Do not use it to access systems without authorization, interfere with official or third-party services, impersonate an official Dauntless service, or mislead users about its unofficial status. Operators are responsible for complying with the laws applicable in their jurisdiction.

## License

Licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`).
See [LICENSE](LICENSE) for the full text. Additional terms under AGPLv3 Section 7 apply to the
Mystic Paradox contributions — see `ADDITIONAL_TERMS.md`. Original Undaunted copyright notices
are retained in the source-file headers as required by the AGPL.

If you operate a modified version that users interact with over a network, you are responsible for satisfying the source-availability requirements of the AGPLv3.

## No warranty

This software is provided without any warranty, to the extent permitted by applicable law. Use it at your own risk.

## Credits and upstream

Mystic Paradox is based on **Undaunted**, originally developed by **gwog / Gregory Morford**:

- Upstream: [SyST3MDeV/Undaunted](https://github.com/SyST3MDeV/Undaunted) (AGPLv3)
- Mystic Paradox: [pranav158/Mystic-Paradox](https://github.com/pranav158/Mystic-Paradox) — maintained by Pranav Karande

Mystic Paradox contains substantial independent modifications for Dauntless 1.12.0. It is a separate community project and is not an official continuation of Undaunted. See `NOTICE.md` for full provenance and attribution.
