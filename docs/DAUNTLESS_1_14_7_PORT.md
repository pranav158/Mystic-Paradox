# Dauntless 1.14.7 port — progress notes

Dauntless 1.14.7 (`rel-1.14.7-Archon`, changelist `647472`) is the final release of the game. This page
tracks the port from the supported 1.12.0 target. The source in this repository still targets 1.12.0;
these notes describe the work being done separately and will move into the main docs once the port
is usable.

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

## Lessons so far

- A stale address rarely fails where it is called. Calling into the middle of an instruction in the
  new executable produces crashes far from the cause, often in unrelated engine code. Read crash
  registers against the call that could have produced them before blaming the engine.
- Constant "wild" pointer values that move with ASLR are image addresses, which points to a stale
  call target rather than heap corruption.
- The patches that made 1.12.0 boot as a dedicated server do not transfer as-is; the 1.14.7 boot path
  has to be followed again.
