# Scope, legal and responsible use

Mystic Paradox is an unofficial, community-developed preservation project. It is not affiliated with,
endorsed by, or sponsored by Phoenix Labs, Epic Games, Forte Labs, or any current or former Dauntless
rights holder.

## What is not included

This repository contains **source code only**. For legal reasons it does not ship, and will never ship:

- the game client or any game binaries or packaged assets;
- the generated Unreal Engine SDK (Dumper-7 output);
- **bulk extracted game-data tables** — progression, hunt tables, store, Slayer's Path and so on. These
  are Phoenix Labs content; you generate them from your own installation;
- any credentials, TLS certificates or private keys.

The Node.js services (`ParadoxBackend`, `ParadoxDirector`) compile and test without any of the above:
synthetic `*.example.json` placeholders let them build and smoke-test. The C++ projects
(`ParadoxRuntime`, `tools/CatalogExporter`) need a locally generated Dumper-7 SDK from your own
installation and do not build from a fresh clone alone. Real game data must be generated locally in
all cases — see [Generating the SDK](GENERATING_SDK.md) and [Generating game data](GENERATING_GAME_DATA.md).

### Scope of this claim

This repository does not distribute the game client, packaged game assets, generated SDK headers or
bulk extracted game-data tables. It does necessarily contain interoperability information —
protocol and endpoint names, catalog identifiers, class names and engine hook offsets — as any
compatibility layer must. Users must generate the required compatibility data from their own lawful
installation.

## Responsible development

This project is intended for preservation, interoperability research, education and privately
operated community play. Do not use it to access systems without authorization, interfere with
official or third-party services, impersonate an official Dauntless service, or mislead users about
its unofficial status. Operators are responsible for complying with the laws that apply where they
operate.

## License

Licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`); see
[LICENSE](../LICENSE). Additional terms under AGPLv3 Section 7 apply to the Mystic Paradox
contributions — see [ADDITIONAL_TERMS.md](../ADDITIONAL_TERMS.md). Original Undaunted copyright notices
are kept in the source-file headers as the AGPL requires; full provenance is in [NOTICE.md](../NOTICE.md).

If you operate a modified version that users interact with over a network, you are responsible for
meeting the AGPLv3 source-availability requirements.

Contributions to covered components are distributed under the same license. Please describe the scope
of your change, keep unrelated changes separate, and do not submit proprietary game files, leaked
source or secrets. Acceptance is not guaranteed.

## No warranty

This software is provided without any warranty, to the extent permitted by applicable law. Use it at
your own risk.
