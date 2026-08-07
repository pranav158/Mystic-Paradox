# NOTICE

This product includes software developed by multiple parties. It is licensed
as a whole under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`),
with additional terms under AGPLv3 Section 7 applying to the Mystic Paradox
contributions only (see `ADDITIONAL_TERMS.md`).

## Modification notice

Mystic Paradox is a modified version of Undaunted (AGPLv3 §5).

Development of the Mystic Paradox modifications began on 5 July 2026. This public
repository is a sanitized and reorganized source release of work developed since
5 July 2026.

- Original project: Undaunted by gwog :3 / Gregory Morford (SyST3MDeV)
- Modified work: Mystic Paradox by Pranav Karande

## Provenance and Attribution

### Original work — Undaunted
- Copyright (C) 2026 gwog :3 (SyST3MDeV)
- Upstream: https://github.com/SyST3MDeV/Undaunted
- Licensed under AGPL-3.0-only.

The original Undaunted project provided the initial private-server implementation
(reverse-engineered against the `1.4.4_shipping` build). Its copyright notices are
retained in the headers of the source files it originated, as required by the AGPL.

### Modified work — Mystic Paradox
- Copyright (C) 2026 MysticFox / Pranav Karande
- Repository: https://github.com/pranav158/Mystic-Paradox

Mystic Paradox is a modified and substantially extended derivative. Work by
Pranav Karande includes, among other things:

- Port of the backend and injected DLL from `1.4.4` to the `1.12.0` (UE 4.26.2,
  changelist 392819) build, including hook re-offsetting and protocol updates.
- MongoDB persistence layer (migration off SQLite) and repository contracts.
- In-process HTTPS redirect / TLS termination replacing the previous nginx proxy.
- Launcher authentication, Discord OAuth, and signed launcher/runtime update
  distribution.
- Realtime XMPP presence/chat services.
- Progression, inventory, store, matchmaking, party, and guild systems for 1.12.0.

### Runtime loader

`tools/RuntimeLoader` is derived from
[coldloader-proxy](https://github.com/denuvosanctuary/coldloader-proxy) and is distributed under
the Apache License 2.0. Its license is retained at `tools/RuntimeLoader/LICENSE`.

## Notes

- This repository does not distribute the game client, packaged game assets, generated SDK
  headers, or bulk extracted game-data tables. It does contain interoperability information
  (protocol/endpoint names, catalog identifiers, class names, engine hook offsets) as any
  compatibility layer must. See `README.md` and `docs/` for generating the SDK and game data
  from your own installation.
- Credentials, certificates, and private keys have been removed. Configuration is
  provided as `.env.example` templates only.
