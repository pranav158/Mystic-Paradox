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

## Lessons so far

- A stale address rarely fails where it is called. Calling into the middle of an instruction in the
  new executable produces crashes far from the cause, often in unrelated engine code. Read crash
  registers against the call that could have produced them before blaming the engine.
- Constant "wild" pointer values that move with ASLR are image addresses, which points to a stale
  call target rather than heap corruption.
- The patches that made 1.12.0 boot as a dedicated server do not transfer as-is; the 1.14.7 boot path
  has to be followed again.
