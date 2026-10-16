# Dauntless 1.14.7 port — progress notes

Dauntless 1.14.7 (`rel-1.14.7-Archon`, changelist `647472`) is the final release of the game. This page
tracks the port from the 1.12.0 target. Since 9 October 2026 every component on `main` targets 1.14.7, and
the official server runs it as a **closed beta** (access on request in our
[Discord server](https://discord.gg/e3HuAZGdU3)).
A 1.12.0 setup (legacy, no longer updated) builds from the
[`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag. These notes move into
the main docs once the port is complete.

## Target

| Property | Value |
|---|---|
| Build label | `rel-1.14.7-Archon` |
| Changelist | `647472` |
| Unreal Engine | `4.26.2` (same major engine as 1.12.0) |
| Platform | Windows x64 |

## Approach

1. **Fresh SDK.** A new Dumper-7 SDK is generated from a 1.14.7 installation. Nothing generated from
   1.12.0 is reused: class layouts moved even where the engine version did not change.
2. **Re-map every hook and call target.** The runtime calls and hooks engine functions by relative
   address. Every 1.12.0 address is treated as wrong until it is shown to be a function entry in the
   1.14.7 executable with a matching signature. Addresses are carried across by matching masked
   instruction signatures between the two executables, checked in both directions.
3. **Re-check field offsets.** Struct and class offsets used by the runtime are compared between the
   1.12.0 and 1.14.7 SDKs instead of being assumed stable.
4. **Backend data from the new client.** Catalog, progression, store and hunt tables are regenerated
   from the 1.14.7 installation with `tools/CatalogExporter`; the 1.12.0 tables are not reused.

## Progress

### Social hubs: replication and client arrival (5 October 2026)

Clients could connect to a 1.14.7 hub (Ramsgate, Training Grounds) but never finished joining: they
timed out with "Loading timeout while joining the server" because they never received the game
state or their own player state.

- **Cause:** the game's replication graph queues actors that are only relevant to their owner in a
  pending list, and only its `ServerReplicateActors` entry point drains it. Nothing called that entry
  point on a 1.14.7 dedicated hub, so those actors never left the graph.
- **Fix:** the runtime drives the replication graph's `ServerReplicateActors` once per server frame.
- **Result:** clients receive the game state and player state, the possession chain completes, and
  players arrive in Ramsgate and can move, interact and travel to the Training Grounds and back.

### The hub's local player

The 1.14.7 server process starts in listen-server mode and used to spawn a local player with no network
connection. At first it was tolerated and kept away from clients: its controller, player state and pawn were
removed from the replication graph before their replication flags were cleared (the order matters; clearing
the flags first routes the removal to the wrong graph node). Since 10 October every server boots without a
viewport or local player at all, and the first player's login starts the match (see below).

### Player data

A daily-bounty component on 1.14.7 drafts automatically and needs a draft token that 1.12.0 never
required. Without it, that component never finished loading and the 60-second player-data timeout
disconnected the player. The backend now seeds the token for new accounts and repairs existing ones.

### Dedicated hunts (8 October 2026)

A full loop now works on 1.14.7 with dedicated servers: Ramsgate → a dedicated IslandA hunt →
Ramsgate. The omnicell charges, fires and deals damage, all six loadout slots show, and the servers
ran without faults for the test.

Two more stale 1.12.0 call targets were found on the way: a channel-creation call that landed inside
an unrelated spline function (the hub "spline crash"), and the omnicell charge getters, which are now
called by name instead of by address. A server-side crash in an interaction-callout widget is guarded on
servers.

### Rewards, empty hunts and clean exits (9 October 2026)

- **Hunt rewards persist.** After two kills on a dedicated hunt, the saved inventory matched the
  crafting screen, and a full re-login showed the same counts.
- **Extra character fixed.** The hub's local player used to get a pawn about a minute after the hub
  started, and a client already connected at that moment saw an extra character. The runtime had told
  the game that every controller may restart, the hub's own included; it now refuses that one.
- **Empty hunt servers shut down again.** The hunt's local player kept the game's player count at 1,
  so the 50-second empty shutdown never fired and hunt servers piled up until the server limit. The
  runtime now counts remote client connections instead.
- **Clean client exit.** Every quit ended in an access violation because the runtime still logged after
  its DLL was unloaded. Nothing logs after detach now, and the C runtime is linked statically.
- **Launcher.** The launcher verifies the 1.14.7 install and the signed runtime at Play, and its Launcher
  Guard is an observer only: it reports the signed file list, process identity and loaded-module digest and
  never ends a game. Self-hosted builds set their runtime feed and signing key at build time.
- **Client branding.** A Mystic Paradox login background, credits section and press-start text. Each
  one reverts with a `DISABLE_LOGIN_BRANDING.flag`, `DISABLE_CREDITS_BRANDING.flag` or
  `DISABLE_PRESS_START_BRANDING.flag` beside the game executable.

### No local player, saved state, travel and the first party hunt (10 October 2026)

- **No local player on servers.** Hubs and hunts boot without a viewport or local player, so the extra
  character, its second XP credit and the workarounds for it are gone. Progression components that waited
  for it are resumed once the configuration has loaded, and the Training Grounds' arrival scene no longer
  waits out an 18-second timeout.
- **State that survives a map change.** Bounty progress and claims, and cooldowns, are stored per account.
  Before, the daily bounty re-drafted on every arrival (draining the draft tokens) and a patrol reward paid out
  on every arrival. Season-challenge coins are paid once per claimed challenge.
- **Travel crash fixed.** A return to a map visited earlier could crash the client inside the engine's map
  load: a stale garbage-collector keep flag on one input component kept the previous world alive, and the
  map load reused that world. The client now releases it, so the old world is freed.
- **HUD over the arrival beam and the airship:** the cause was found (the runtime cleared the cinematic mode
  on the cinematic's own input edge) and a fix shipped.
- **First two-player party hunt on 1.14.7.**

### Experience, reforge and mastery (11 October 2026)

- **XP saves.** Kill XP for weapons, the player and the Hunt Pass is granted once per kill and saved, and
  rank-ups are confirmed. Kill XP follows the game's own tuning: none for a Behemoth far below the weapon's
  level, and a capped weapon banks XP up to its banked level.
- **Weapon reforge** works (reset, the reforge count and the banked-XP restore), and **mastery** is saved
  from the game server's reports.
- Sprouts are saved, the fountain coin toss pays once a day, and the Hunt Pass starts fresh.
- Every request now passes a per-address rate limit.

### Co-op hunts and Paradox realms (13–14 October 2026)

- **Co-op transport:** hunts can be hosted on a player's PC and joined over ICE with STUN/TURN relays
  (`ParadoxTransport`, libjuice). A solo hunt hosted this way saved its loot and ended cleanly.
- **Paradox realms:** a player hosts a whole realm — Ramsgate and its hunts — on their own PC. Two players
  played a realm over the relay alone: Ramsgate, party and solo hunts from the normal Start Hunt button, with
  loot, XP, bounties and mastery saved. A local realm can use SQLite instead of MongoDB.
- Terms and Privacy (16+), consent, account deletion with a 30-day hold, and data retention.

### Realms only on the official server (15 October 2026)

- The official server runs no dedicated servers any more: every hub and hunt is a Paradox realm hosted on a
  player's PC. New accounts there wait for approval (the closed beta).
- **Hunt end:** calling the airship at the end of a hunt used to cut the hunt server out from under the
  player. The hunt now drains and closes once everyone has left it.
- Email codes for sign-up, password reset and Discord linking; launcher notices.
- The launcher and the runtime's loader and transport are built by this repository's GitHub workflows, with
  build provenance (`gh attestation verify <file> --repo pranav158/Mystic-Paradox`); the launcher is signed
  there too. The runtime DLL itself is built by the maintainer, because it needs the game SDK.

### Realm access, the Ramsgate kick and faster Play (16 October 2026)

- **Usernames:** a username policy applies to new names.
- **Who can join a realm:** Solo, Allowlisted or Public, with invites and join requests.
- **Ramsgate kick fixed.** Players at a high player level were sent back to the login screen about a second
  after reaching Ramsgate, with no error. The realm host's starter grant (thirteen starter cosmetics) was
  refused by the backend, and the game treats a failed inventory transaction during its inventory load as a
  broken inventory and returns the player to the menu. The host may now grant exactly those items. The
  diagnosis came from new runtime traces of what queues a travel on the client and what sends a player back
  to the menu on the server.
- **Gauntlet:** its service calls now answer in the shapes the 1.14.7 client parses. The Gauntlet itself
  stays off.
- **Faster Play:** the game polled its matchmaking status every 10 seconds, so Play took 10–12 seconds; the
  backend now asks for one-second polls while matching.
- **Airship back to Ramsgate** (launcher 0.1.73, the next release): leaving a realm hunt by airship could time
  out to the login screen, because the launcher closed the hunt's connection as soon as the hub join began,
  while the game was still travelling over it. The connection now closes once the game has left the hunt.

### Still open

- The Gauntlet (only its menus answer).

## Lessons so far

- A stale address rarely fails where it is called. Calling into the middle of an instruction in the
  new executable produces crashes far from the cause, often in unrelated engine code. Read crash
  registers against the call that could have produced them before blaming the engine.
- Constant "wild" pointer values that move with ASLR are image addresses, which points to a stale
  call target rather than heap corruption.
- The patches that made 1.12.0 boot as a dedicated server do not transfer as-is; the 1.14.7 boot path
  has to be followed again.
- A refused backend write can look like a network problem. The game sends a player back to the menu
  without an error when an inventory transaction fails at the wrong moment; trace what sent them there
  instead of guessing from timing.
