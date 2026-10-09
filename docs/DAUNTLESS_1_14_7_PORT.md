# Dauntless 1.14.7 port — progress notes

Dauntless 1.14.7 (`rel-1.14.7-Archon`, changelist `647472`) is the final release of the game. This page
tracks the port from the 1.12.0 target. `main` is moving to 1.14.7 one component at a time: since
9 October 2026 the runtime and tools target 1.14.7; the backend, the Director and the launcher follow.
A 1.12.0 setup builds from the [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0)
tag. These notes move into the main docs once the port is usable.

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

The 1.14.7 hub process runs in listen-server mode at map load and spawns a local player with no
network connection. The 1.12.0 patches that prevented this stop the 1.14.7 boot, so the local player
is tolerated and kept away from clients: its controller, player state and pawn are removed from the
replication graph before their replication flags are cleared (the order matters; clearing the flags
first routes the removal to the wrong graph node).

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
called by name instead of by address. A server-side crash in an interaction-callout widget, which is
built only because of the hub's local player, is guarded on servers.

### Rewards, empty hunts and clean exits (9 October 2026)

- **Hunt rewards persist.** After two kills on a dedicated hunt, the saved inventory matched the
  crafting screen, and a full re-login showed the same counts.
- **Extra character fixed.** The hub's local player used to get a pawn about a minute after the hub
  started, and a client already connected at that moment saw an extra character. The runtime had told
  the game that every controller may restart, the hub's own included; it now refuses that one, and a
  pawn that still appears is destroyed.
- **Empty hunt servers shut down again.** The hunt's local player kept the game's player count at 1,
  so the 50-second empty shutdown never fired and hunt servers piled up until the server limit. The
  runtime now counts remote client connections instead.
- **Clean client exit.** Every quit ended in an access violation because the runtime still logged after
  its DLL was unloaded. Nothing logs after detach now, and the C runtime is linked statically.
- **Client branding.** A Mystic Paradox login background, credits section and press-start text. Each
  one reverts with a `DISABLE_LOGIN_BRANDING.flag`, `DISABLE_CREDITS_BRANDING.flag` or
  `DISABLE_PRESS_START_BRANDING.flag` beside the game executable.

### Still open

- An intermittent client crash on the way back from a hunt to Ramsgate (once in four returns), inside
  the engine's map load.
- The gameplay HUD shows during the arrival beam and the airship lobby (also present on 1.12.0).

## Lessons so far

- A stale address rarely fails where it is called. Calling into the middle of an instruction in the
  new executable produces crashes far from the cause, often in unrelated engine code. Read crash
  registers against the call that could have produced them before blaming the engine.
- Constant "wild" pointer values that move with ASLR are image addresses, which points to a stale
  call target rather than heap corruption.
- The patches that made 1.12.0 boot as a dedicated server do not transfer as-is; the 1.14.7 boot path
  has to be followed again.
