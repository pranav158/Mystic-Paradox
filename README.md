# Mystic Paradox

Mystic Paradox is a community preservation project working to restore local and private-server functionality for the discontinued monster-hunting game Dauntless.

The project is based on the open-source Undaunted server and is being adapted from Dauntless 1.4.4 to Dauntless 1.12.0. It provides the backend, deployment, launcher, and runtime compatibility pieces needed to connect a supported game client to a privately operated server.

> [!IMPORTANT]
> Mystic Paradox is an unofficial, community-developed preservation project. It is not affiliated with, endorsed by, or sponsored by Phoenix Labs, Epic Games, Forte Labs, or any current or former Dauntless rights holder.

## Project status

Mystic Paradox is under active development and is not yet production-ready. Work is currently focused on porting the server from 1.4.4 to 1.12.0, updating the runtime and networking layers for Unreal Engine 4.26.2, and reconciling the backend with the 1.12.0 client.

Features may be incomplete, unstable, or changed without notice.

## Components

- **Account & metagame backend** — accounts, authentication, characters, inventory, progression, loadouts, store, party, and matchmaking.
- **Game-server deployment service** — starts and manages game-server processes for social spaces and hunts.
- **Runtime compatibility layer** — adapts the game client and game-server processes to the private backend and the updated engine.
- **Launcher and client tools** — prepare and start a supported client with the required local configuration.

## Supported game version

| Property | Value |
|---|---|
| Game version | Dauntless 1.12.0 |
| Build label | `rel-1.12.0-Archon` |
| Changelist | `392819` |
| Unreal Engine | `4.26.2` |
| Platform | Windows x64 |

Other versions are not expected to work unless explicitly documented.

## Self-hosting

No support is provided for self-hosting at this time. You may deploy the project yourself, but the maintainers do not provide installation, configuration, or troubleshooting assistance, and the deployment process is still evolving. This does not restrict any rights granted under the AGPLv3.

## Building

Detailed build instructions will be added as the 1.12.0 port stabilizes. The project targets a Windows x64 environment and is built with:

- C++ and Visual Studio — native compatibility layer and traffic interceptor (WinDivert).
- Node.js and TypeScript — backend and deployment services.
- MongoDB, or another configured persistence provider.


## Contributions

Contributions are welcome via GitHub issues and pull requests. Please describe the scope of your change, keep unrelated changes separate, and do not submit proprietary game files, leaked source, or secrets. Contributions to covered components are distributed under the project's AGPLv3 license. Acceptance is not guaranteed.

## Responsible development

This project is intended for preservation, interoperability research, education, and privately operated community play. Do not use it to access systems without authorization, interfere with official or third-party services, impersonate an official Dauntless service, or mislead users about its unofficial status. Operators are responsible for complying with the laws applicable in their jurisdiction.

## License

Licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`). See [LICENSE.md](LICENSE.md) for the full text.

If you operate a modified version that users interact with over a network, you are responsible for satisfying the source-availability requirements of the AGPLv3.

## No warranty

This software is provided without any warranty, to the extent permitted by applicable law. Use it at your own risk.

## Credits and upstream

Mystic Paradox is based on **Undaunted**, originally developed by **gwog / Gregory Morford**:

- Upstream: [SyST3MDeV/Undaunted](https://github.com/SyST3MDeV/Undaunted) (AGPLv3)
- Mystic Paradox: [pranav158/MysticParadox](https://github.com/pranav158/MysticParadox)

Mystic Paradox contains substantial independent modifications for Dauntless 1.12.0. It is a separate community project and is not an official continuation of Undaunted.
