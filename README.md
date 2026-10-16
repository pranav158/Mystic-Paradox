<p align="center">
  <img src="docs/assets/banner.webp" alt="Mystic Paradox — open-source Dauntless server project" width="100%">
</p>

<h1 align="center">Mystic Paradox</h1>

<p align="center">
  <b>Open-source private server for Dauntless</b> — backend, game-server orchestration, launcher and runtime
  compatibility layer, so you can run the game on a server of your own.
</p>

<br>

> [!WARNING]
> **🔒 The launcher on the [Releases](https://github.com/pranav158/Mystic-Paradox/releases) page is a closed beta test.**
>
> It connects to the official Mystic Paradox server, which is open to invited testers only. A new account stays
> **pending until it is approved**, and a pending account cannot sign in or play.
>
> **To request access, [join our Discord server](https://discord.gg/e3HuAZGdU3) and ask there.**
> Please create **one** account and wait for it: creating more accounts does not get you approved any sooner.

<br>

<p align="center"><a href="https://discord.gg/e3HuAZGdU3"><b>Join our Discord Server</b></a></p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-blue"></a>
  <a href="docs/DAUNTLESS_1_14_7_PORT.md"><img alt="Dauntless: 1.14.7" src="https://img.shields.io/badge/Dauntless-1.14.7-orange"></a>
  <a href="https://github.com/pranav158/Mystic-Paradox/releases"><img alt="Launcher: closed beta" src="https://img.shields.io/badge/launcher-closed%20beta-red"></a>
  <a href="https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0"><img alt="Dauntless 1.12.0: legacy tag" src="https://img.shields.io/badge/Dauntless%201.12.0-legacy%20tag-lightgrey"></a>
  <img alt="Platform: Windows x64" src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey">
  <a href="https://discord.gg/e3HuAZGdU3"><img alt="Discord: join the server" src="https://img.shields.io/badge/Discord-join%20the%20server-5865F2?logo=discord&logoColor=white"></a>
</p>

<p align="center">
  <a href="#-get-started">Get started</a> ·
  <a href="#-documentation">Docs</a> ·
  <a href="docs/FAQ.md">FAQ</a> ·
  <a href="#-community-and-help">Community</a> ·
  <a href="docs/DAUNTLESS_1_14_7_PORT.md">1.14.7 progress</a>
</p>

> [!IMPORTANT]
> Unofficial and community-developed. Not affiliated with, endorsed by, or sponsored by Phoenix Labs,
> Epic Games, Forte Labs, or any current or former Dauntless rights holder. This repository ships
> **source code only** — no game files, SDK or game data.

## 📊 Status

| Game version | State |
|---|---|
| **Dauntless 1.14.7** (CL `647472`) | 🧪 **Closed beta** on the official server; `main` targets 1.14.7. Ramsgate, the Training Grounds, hunts, parties and saved progress (loot, XP, weapon levels, reforge, mastery, bounties) work. The official server runs everything as **Paradox realms**: hubs and hunts hosted on a player's PC, connected through Mystic Relay. A self-hosted server can also run dedicated hubs and hunts — [progress notes](docs/DAUNTLESS_1_14_7_PORT.md) · [co-op and realms](docs/SELF_HOSTING.md#co-op-hunts-and-paradox-realms) |
| **Dauntless 1.12.0** (CL `392819`) | 🗄️ Legacy alpha, no longer updated — build it from the [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag |

Expect active development, not production-grade uptime. The Gauntlet is not available yet.

> [!NOTE]
> `main` and the guides below target Dauntless 1.14.7. For a 1.12.0 setup, check out the
> `dauntless-1.12.0` tag; the self-hosting guide also covers upgrading from it.

## 🚀 Get started

**Just want to play?** The official launcher is in a closed beta: [request access on Discord](https://discord.gg/e3HuAZGdU3)
before you sign up (see the note at the top). The steps below are for running a server of your own.

1. **Read the [FAQ](docs/FAQ.md)** — what the project is, what it isn't, and where to get help.
2. **Install Dauntless 1.14.7** from Epic with your own account — [Installing Dauntless](docs/INSTALLING_DAUNTLESS.md).
3. **Generate the SDK** from your own 1.14.7 install — [Generating the SDK](docs/GENERATING_SDK.md).
4. **Generate the game data** from the same install — [Generating game data](docs/GENERATING_GAME_DATA.md).
5. **Deploy and play** — [Self-hosting](docs/SELF_HOSTING.md) walks from source to Ramsgate:
   prerequisites, DNS/TLS, services, launcher and the first acceptance test.

## 📚 Documentation

| Guide | What's inside |
|---|---|
| 🎮 [Installing Dauntless](docs/INSTALLING_DAUNTLESS.md) | Getting the 1.14.7 client from Epic with your own account and Legendary |
| 🏠 [Self-hosting](docs/SELF_HOSTING.md) | Full deployment: prerequisites, configuration helper, ports, validation, troubleshooting |
| 🧩 [Generating the SDK](docs/GENERATING_SDK.md) | Dumping the Unreal SDK with Dumper-7 and building the C++ projects |
| 📦 [Generating game data](docs/GENERATING_GAME_DATA.md) | Exporting the catalogue and tables from your install |
| 🔭 [1.14.7 port](docs/DAUNTLESS_1_14_7_PORT.md) | Progress, findings and open issues for the final game release |
| ❓ [FAQ](docs/FAQ.md) | Common questions, support and contact |
| ⚖️ [Scope and legal](docs/SCOPE_AND_LEGAL.md) | What isn't included, responsible use, license details |
| 🔒 [Security](SECURITY.md) | Safe configuration and how to report a vulnerability |
| 🖥️ [Launcher](ParadoxLauncher/README.md) · [Update channel](ParadoxLauncher/UPDATE_CHANNEL.md) | Building, signing and publishing the launcher and runtime |

## 🗂️ Repository layout

| Folder | What it is |
|---|---|
| [`ParadoxBackend`](ParadoxBackend) | Account and metagame backend (login, characters, inventory, progression, store, party, co-op hunts, Paradox realms…) — Node/TypeScript + MongoDB (or SQLite for a local realm) |
| [`ParadoxDirector`](ParadoxDirector) | Starts and supervises the dedicated game servers for hubs and hunts |
| [`ParadoxRuntime`](ParadoxRuntime) | C++ DLL injected into the client and servers to adapt them to the private backend (MSVC + MinHook) |
| [`ParadoxLauncher`](ParadoxLauncher) | Windows launcher: sign-in, servers and realms, install checks, signed runtime updates, game sessions, realm hosting (Tauri) |
| [`ParadoxTransport`](ParadoxTransport) | Co-op transport module: ICE connections with STUN/TURN relays (libjuice) for player-hosted hubs and hunts; Mystic Relay on the official servers |
| [`shared/hunt-manifest`](shared/hunt-manifest) | Hunt manifest resolution shared by the backend and the Director |
| [`tools/RuntimeLoader`](tools/RuntimeLoader) | `winmm.dll` proxy that loads the runtime at startup |
| [`tools/CatalogExporter`](tools/CatalogExporter) | Exports compatibility data from your own installation |

## 💬 Community and help

- 🐛 **Bugs, feature requests and testing feedback:** open a [GitHub issue](../../issues). Include the
  component, commit, configuration with secrets removed, reproduction steps and logs.
- 💬 **Discord:** [join our server](https://discord.gg/e3HuAZGdU3) for beta access, announcements and
  help. You can also add the maintainer, **`uwumystic`**; please include a short note with your friend
  request explaining why you're reaching out, so project requests don't get lost among unrelated ones.
- 🔒 **Security problems:** report them privately — see [SECURITY.md](SECURITY.md).

Pull requests are welcome. Never submit game files, leaked source or secrets. Project support is not
provided on Reddit.

## 📜 License and credits

[AGPL-3.0-only](LICENSE), with additional terms in [ADDITIONAL_TERMS.md](ADDITIONAL_TERMS.md) — details in
[Scope and legal](docs/SCOPE_AND_LEGAL.md).

- Based on **[Undaunted](https://github.com/SyST3MDeV/Undaunted)** by gwog / Gregory Morford (AGPLv3).
- **Mystic Paradox** is a separate community project with substantial independent changes, maintained
  by **Mystic / Pranav Karande**.
- Development assistance: [Claude](https://www.anthropic.com/claude) (Anthropic).

Full provenance in [NOTICE.md](NOTICE.md).

<p align="center"><sub>Made by the community, for the Slayers who aren't ready to say goodbye. 🗡️</sub></p>
