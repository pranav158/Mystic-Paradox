# CatalogExporter — export flags & progression/combat export modes

This extends the original catalog-only `CatalogExporter` DLL with three more export modes
(progression, combat, skins) plus a flag system to pick which modes run on a given injection,
without recompiling. All modes still run inside the **same DLL** — per project decision this pass
does not split into separate `ProgressionDataExporter`/`CombatDataExporter` binaries the way
`Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md` section 8.1 originally sketched;
everything lives in `CatalogExporter/` and is gated by flags instead.

## Why flags instead of argv

An injected DLL has no command line — `DllMain` gets no arguments. The flags system reads a
plain-text sidecar file instead, checked once at injection time on a worker thread (same
pattern as the original one-shot catalog dump).

## The flags file

`CatalogExporter/export_flags.txt`, one `KEY=VALUE` per line, `VALUE` is `0` or `1`:

```
EXPORT_CATALOG=1
EXPORT_PROGRESSION=0
EXPORT_COMBAT=0
EXPORT_SKINS=0
```

Search order (first match wins):
1. `.\export_flags.txt` (absolute — works no matter what
   the injected process's CWD is)
2. `.\export_flags.txt` (relative to the injected process's CWD)

**If the file is missing entirely**, the exporter defaults to `EXPORT_CATALOG=1` and everything
else `=0` — this is the exact original pre-flags behavior, so any existing injection workflow
that predates this change keeps working unmodified.

**Once the file exists**, it is authoritative for all four keys — a key simply absent from an
existing file is treated as `0`, not "keep the default". This avoids a half-defaulted, confusing
state where someone edits the file to add `EXPORT_PROGRESSION=1` and is surprised catalog export
silently kept running too (or stopped) based on an implicit default they didn't set.

To run all four in one injection:

```
EXPORT_CATALOG=1
EXPORT_PROGRESSION=1
EXPORT_COMBAT=1
EXPORT_SKINS=1
```

Edit the file, then inject (or re-inject) the DLL — there is no live reload; the flags are read
once at `DllMain`/thread-start time.

## What each mode produces

All output goes under `Items_Analysis/` (same root the original catalog exporter used), so
existing tooling that reads catalog output is unaffected.

### `EXPORT_CATALOG` (original, unchanged)

- `Items_Analysis/catalog_1_12.jsonl` — general catalog (`UArchonCatalog::GetAllItems`)
- `Items_Analysis/equipment_1_12.jsonl` — equipment catalog (GObjects walk)

### `EXPORT_PROGRESSION` (new)

Writes to `Items_Analysis/progression_1_12/`:

| File | Source table | Row struct |
|---|---|---|
| `player-experience-tracks.jsonl` | `player_experience_track_table` | `FExperienceTrackTableData` |
| `weapon-experience-tracks.jsonl` | `weapon_experience_track_table` | `FExperienceTrackTableData` |
| `experience-tracks.jsonl` | `experience_track_table` | `FExperienceTrackTableData` |
| `huntpass-season-table.jsonl` | `hunt_pass_season_table` | `FHuntPassSeasonDataTable` (dedicated serializer) |
| `experience-awards.jsonl` | *any table with this row struct* | `FExperienceTableData` (**by row struct** + component fallback) |
| `progression-tracks.jsonl` | `progression_track_table` | `FProgressionTrackTableData` |
| `online-track-info.jsonl` | `online_progression_track_info_table` | `FOnlineProgressionTrackInfo` (dedicated serializer) |
| `mastery-tracks.jsonl` | `mastery_track_table` | `FMasteryTrackTableData` |

Name-resolved tables are looked up by **exact object name** (`UObject::GetName()`), then their
`RowStruct` is checked against the expected struct name before any row is cast — a mismatch skips
that table with a status-line explanation rather than risking a wrong-offset read.
`experience-awards.jsonl` instead searches **by row struct** across all loaded tables (see below).
Row order is sorted alphabetically by row name so repeated dumps are byte-comparable.

**Second-pass output shape (what every track row now carries):**

- `base.requirements`: `[{ "rankId": N, "requiredXP": N }, ...]` — the **per-rank XP costs**.
  `requiredXP` is **incremental** (XP to advance one rank), NOT a cumulative threshold: the native
  1.12 calc sums the entries for a track total (e.g. `ExperienceTrack_PlayerLevel` ranks 2..20 sum
  to **141,020** total XP; rank 2 alone costs 2,000, so 250 total XP is still rank 1).
  `FOnlineProgressionTrackRequirement` is `{ int32 RankId; int32 RequiredXP; }`. The first pass
  emitted only `requirementCount` (`.Num()`) and discarded these. This 1.12 curve
  (`ExperienceTrack_PlayerLevel` = 20 ranks) **supersedes the incomplete 12-entry legacy curve** in
  `ParadoxBackend/src/vendor/progression_config.json`
  (`0,100,100,2800,2000,2500,2500,2500,3500,3500,3500,5000`) — do not reuse the legacy values.
- `base.freeRewards` / `base.premiumRewards`: full reward **contents**, not counts. Each reward:
  - `stackedItems`: `[{ catalogId, quantity, priority }]`
  - `instancedItems`: `[catalogId, ...]`
  - `orderedInstancedItems`: `[{ catalogId, priority }]`
  - `entitlements`: `[{ entitlementId, duration }]`
  - `buffCount`: still a count (buffs are `TSoftClassPtr<UClass>`; resolving soft class asset paths
    is out of scope for this read-only pass — item/entitlement rewards are what the backend grants).

**Experience-award resolution**: `experience-awards.jsonl` finds **every** loaded `UDataTable` whose
`RowStruct` is `ExperienceTableData` (the first pass's exact-name `experience_table` lookup returned
"table not found"). If the struct walk finds nothing, it falls back to reading
`UPlayerExperienceComponent::ExperienceTable` (a `UCompositeDataTable*` at `+0x130`) off a live
component instance. Each emitted row carries a `"table"` provenance field.

**Rank-table note (corrected)**: a standalone `FProgressionRankData` struct
(`Rank`/`RequiredPoints`/`Rewards`) **does** exist in this 1.12 SDK, referenced by
`FProgressionTrackTableData::RankTable` (a `UDataTable*`). The exporter does not recurse into
`RankTable` because `progression_track_table` was empty at runtime in the captured session, and the
per-rank XP costs are already present inline on every track row's `requirements` array. To dump `RankTable` contents in future, add a `FProgressionRankData` serializer and follow
the pointer. (An earlier revision of this doc incorrectly claimed no such struct existed.)

**Hunt-pass metadata export**: `hunt_pass_season_table`'s row struct is `FHuntPassSeasonDataTable`,
which extends `FOnlineProgressionTrackTableData`. It now has a **dedicated serializer** emitting the
base fields **plus** hunt-pass identity/economy fields: `seasonTitle`, `seasonDescription`,
`seasonDate`, `mustClaimRewards`, `huntRewardItemId`, `huntRewardItemAmount`, `nextProgressionTrack`,
`previewsProgressionTrack`, `buyLevelsUsingRank`, `giveSeasonalCurrencies`, `overallSeasonName`.
(The first pass cast it as `FExperienceTrackTableData` and emitted base fields only.)

**Scope of the hunt-pass export (verified against a real Ramsgate run):** this fixes the season
*identity* lookup — `HuntPass_Season19` is present and maps to `progressionTrack: "season19"`, so
the backend can stop returning "hunt pass data for 'void'". It does **NOT** provide hunt-pass tier
XP costs or tier rewards: in the captured run every hunt-pass row (Season19 included) had
`requirements: []`, `freeRewards: []`, `premiumRewards: []`, and `huntRewardItemAmount: 0`. So the
per-tier XP curve and reward contents are **not** in this table — they live elsewhere (a separate
table/asset not yet identified). Do not assume this export can calculate tiers or grant hunt-pass
rewards.

### `EXPORT_COMBAT` (new)

Writes to `Items_Analysis/combat_1_12/`:

| File | Row struct | Search method |
|---|---|---|
| `damage-tables.jsonl` | `FDamageTableData` | **by row struct**, across every loaded `UDataTable`, not by table name |
| `weapon-power-tables.jsonl` | `FWeaponPowerTableData` | same |

This deliberately searches **by row struct**, not by table object name, per plan section 9.2:
weapon-specific and Behemoth-specific damage tables often don't have "DamageTable" anywhere in
their own name. Every `UDataTable` in `GObjects` is checked; any whose `RowStruct->GetName()`
matches gets fully exported. Each output row carries a `"table"` field so provenance back to the
source `UDataTable` is never lost even though rows from multiple tables land in one file.

Not included in this pass (left for a later, dedicated combat-data pass — plan Phase 11):
curve exports (`player_to_behemoth_damage_curve_cr20` etc.), the ability/GameplayEffect
dependency graph, omnicell/lantern/mod/cell manifests. Those need additional struct/asset
reference work this pass didn't scope.

### `EXPORT_SKINS` (new)

Writes `Items_Analysis/weapon_skins_1_12.jsonl` — every weapon transmog/skin item across all 7
weapon types, filtered from the same `UArchonCatalog::GetAllItems()` source `EXPORT_CATALOG`'s
general dump reads (skins are ordinary `FArchonCatalogItem` rows, not a separate struct/table —
this mode just narrows the ~7000-row general catalog down to the subset that matters for skin
auditing). An item counts as a weapon skin iff its `tags` include `"transmog"` **and** one of the
seven weapon-family tags below (confirmed against real 1.12 displayNames):

| Family tag | Weapon | `WeaponType_*` tag | Example |
|---|---|---|---|
| `gaxe` | Axe | `WeaponType_GAXE` | "Archonite Axe" |
| `eblade` | Sword | `WeaponType_EBLADE` | "Archonite Sword" |
| `ihammer` | Hammer | `WeaponType_IHAMMER` | "Archonite Hammer" |
| `cblades` | ChainBlades | `WeaponType_CBLADES` | — |
| `dp` | Repeaters | `WeaponType_DP` | "Archonite Repeaters" |
| `mspear` | Spear | `WeaponType_MSPEAR` | "Archonite Spear"/"...Pike" |
| `ac` | Strikers | `WeaponType_AC` | "Archonite Strikers" |

Each output row carries the resolved `"weapon"` field (one of the 7 names above) plus the same
`itemId`/`itemClass`/`displayName`/`description`/`tags`/`customData`/`virtualCurrencyPrices` shape
`EXPORT_CATALOG`'s general dump already uses, so a skin's Store Platinum price (if any) is
included. Note some skins in the 1.12 build have `displayName`/`description` still showing
`<MISSING STRING TABLE ENTRY>` (their localization string wasn't loaded at capture time) — the
row is still written with its real `itemId`/`tags`/`customData` so it isn't silently dropped,
just unresolved by name.

### `EXPORT_SLAYERS_PATH` (new)

Writes `Items_Analysis/slayers_path_1_12/player_journey_nodes.jsonl` — the **full Slayer's Path
(Player Journey Map) node definition table**: costs, grants and graph edges.

**Why this mode exists.** The metagame serves `src/data/slayers_path.json`, which is a flat graph of
`{ node_id, node_status: 0, objectives: [] }` × 317 — **no costs, no rewards, no prerequisites**.
That is why the backend cannot implement an atomic unlock (`validate → deduct → persist → grant`):
it has no idea a node costs `100 CURRENCY_PJM_WEAPON + 7500 CURRENCY_NOTES`, or that it grants
`PART_GA_SPECIAL_SKILLSHOT`. The client holds all of it locally (it renders exact costs and effect
text), so this mode lifts it out.

**Source.** Everything is in one reflected DataTable row struct, `Archon.PlayerJourneyNodeData`,
found by **row-struct match** across every loaded DataTable (same approach as `EXPORT_COMBAT`, so it
works regardless of the table's asset name). The DataTable **row name is the `node_id`**, and it
matches the ids already in `slayers_path.json` (e.g. `Aetherdrive_Tonic`) — so the export joins to
the existing served graph on row name, no remapping needed.

| Field | Offset | Meaning |
|---|---|---|
| `ChildNodes` | `0x00B0` | graph edges (parent → children); invert for prerequisites |
| `CurrencyCosts` | `0x0130` | **the consume** — `FArchonCurrencyCost { Currency(rowName), Amount }` |
| `ExperienceCosts` | `0x0150` | XP-type costs |
| `Rewards` | `0x0200` | **the grants** — `FGameplayReward { ItemId, Amount, EntitlementId, bAutoEquip, … }` |
| `bAutoUnlockIfParentUnlocked` | `0x0238` | free-unlock cascade |

Each output row is one node:

```json
{"nodeId":"...","table":"...","nodeType":0,"nodeLevel":1,
 "childNodes":["..."],"autoUnlockIfParentUnlocked":false,
 "currencyCosts":[{"currency":"CURRENCY_PJM_WEAPON","amount":100}],
 "experienceCosts":[{"experienceType":0,"amount":0}],
 "rewards":[{"itemId":"PART_GA_SPECIAL_SKILLSHOT","amount":1,"autoEquip":false,...}],
 "activationEventId":"...","questIds":[],"gameplayAttributeValues":{}}
```

> **No display strings, on purpose.** `DisplayName`/`Description`/`UnlockDescription`/`RewardName`
> are `FText`, which is a shared-ref to `FTextData` — **not** an `FString`. Calling `ToString()` on
> them crashes the game with `EXCEPTION_ACCESS_VIOLATION` inside `UC::FString::ToString()`, and a
> `catch (...)` does not save you (an AV is an SEH exception; that needs `/EHa`). v1 of this
> exporter did exactly that and instant-crashed on inject. Everything emitted here is `FName` or
> POD, which is safe to read directly. If you want human-readable names for granted items, join
> `rewards[].itemId` against `EXPORT_CATALOG`'s general dump, which already resolves displayNames.

> **Important:** the node DataTable must be **loaded in memory** when the export runs. Open the
> Slayer's Path screen once before/while exporting. If it hasn't been loaded you'll get
> `no tables found with RowStruct=PlayerJourneyNodeData` in `catalog_export_status.txt` — that is a
> "not loaded yet" result, not a missing-struct result. Re-open the screen and re-run.

### `EXPORT_CELLS` (new, 2026-07-21 — Omnicell investigation)

Writes `Items_Analysis/live_cell_slots_1_12.jsonl` — live `GetCellSlots()` /
`GetPermanentCells()` / `GetAllPermanentCellEffects()` for **every owned
weapon, armour piece and lantern** (walks `UArchonInventoryItem_CellContainer`,
the shared base class, in one pass rather than guessing which slot type an
Omnicell lives on).

**Why this mode exists.** Reported bug: an Omnicell can be crafted and shows
as equipped in one screen, but isn't reflected elsewhere and can't be used.
Backend has zero Omnicell-specific code anywhere (`itemData` and the loadout
blob are both opaque JSON to the server), so the question is purely "what does
the live client actually hold." The SDK confirms `EUIMoveAttackType::
OmnicellAbility = 13` exists as a distinct move-list category (an activatable
ability, not a passive cell buff) — but the `ECellType` enum captured in this
SDK dump only names values `0`–`25` (`Max=26`), with nothing named "Omni".
This mode surfaces the **raw numeric** `cellType` on every occupied slot
regardless of whether it maps to a named enum value, so if Omnicells turn out
to reuse `CellType_Legendary_Ability`(25), an unnamed/out-of-range value, or
land in `permanentCells`/`permanentCellEffects` instead of `cellSlots`
entirely, the data shows it directly instead of another guess.

Same safety class as `EXPORT_WEAPON_SLOTS` — `GetCellSlots()` etc. are direct
member function calls already declared in the SDK, not `ProcessEvent`-only
`BlueprintCallable`s, so this is a pure read with no engine-dispatch risk.

**To use it:** have the character with the crafted/equipped Omnicell as the
active local player, set `EXPORT_CELLS=1` in `export_flags.txt`, inject, then
read `Items_Analysis/live_cell_slots_1_12.jsonl`. Each line is one owned
weapon/armour/lantern with its `itemId`, `instanceId`, `objectClass`, and the
three raw arrays above. Cross-reference the Omnicell's `itemId` (e.g.
`CELL_OMNISURGE_*`) against which container it shows up under and at what
`cellType`/`slotIndex`/`permanentSlotIndex`.

Output shape:

```json
{"itemId":"WP_GA_...","instanceId":"...","objectClass":"ArchonInventoryItem_Weapon",
 "cellSlots":[{"slotIndex":0,"cellType":25,"cellTypeName":"legendary_ability","cellRarity":3}],
 "permanentCells":[{"permanentSlotIndex":0,"cellRowName":"CELL_OMNISURGE_UC","cellTableName":"..."}],
 "permanentCellEffects":[{"cellEffectId":"...","cellEffectRowName":"...","magnitude":1.0,"rank":1}]}
```

**Complementary evidence, not a replacement:** `routes/loadout.ts` in
`ParadoxBackend` got a diagnostic capture in the same investigation pass
(`08_LOADOUT.md`, 2026-07-21) — set `MYSTICPARADOX_INV_CAPTURE=1` on the metagame
server and reproduce the same equip to see what the client actually sends
over the wire, alongside what this export shows the client holds locally.
If the two disagree (client holds it locally but never sends it, or sends it
but a later write clobbers it), that's the bug; if the client never
populates any of these three arrays for the Omnicell at all, the bug is
upstream of both — client-side/native, not our backend.

## `export_manifest.json`

Written once per injection, after every requested mode finishes, to
`Items_Analysis/export_manifest.json`:

```json
{
  "gameVersion": "1.12.0",
  "changelist": 392819,
  "engineVersion": "4.26.2",
  "exportedAt": "2026-07-13T15:04:05Z",
  "flags": { "EXPORT_CATALOG": true, "EXPORT_PROGRESSION": true, "EXPORT_COMBAT": false, "EXPORT_SKINS": true },
  "results": { "catalogGeneralItems": 812, "catalogEquipmentItems": 340, "progressionRows": 96, "combatRows": 0, "skinsRows": 66 }
}
```

This is a lightweight per-run report (which modes ran, how many rows each produced) — it is
**not** the fuller per-file-hash `ContentData/1.12.0/manifest.json` shape described in the plan's
section 4; that richer format belongs to a future importer step that consumes this exporter's
output, once the backend side actually reads these files.

## Design constraints carried over from the base exporter

- No `ProcessEvent` hooks, no MinHook — pure `GObjects` reads plus the one already-proven
  `UArchonCatalog::GetAllItems()` SDK call.
- One-shot worker thread, started from `DllMain`, waits up to ~120s for `GObjects` + the catalog
  to be populated (same wait loop the base exporter already used).
- Status lines go to `OutputDebugStringA` **and** append to
  `Items_Analysis/catalog_export_status.txt` — never the game's own diagnostic log.
- No gameplay mutation, ever. These are read-only dumps.
- `RowMap.Num()` is sanity-bounded (`0 <= n < 200000`) before iterating, defending against
  reading a table that's mid-load or otherwise not in the expected state.

## Files added this pass

```
CatalogExporter/
  ExportFlags.hpp          — flags file parser (LoadExportFlags())
  export_flags.txt         — the actual flags (tracked; defaults to catalog-only)
  ProgressionExporter.cpp  — RunProgressionExport()
  CombatExporter.cpp       — RunCombatExport()
  SkinsExporter.cpp        — RunSkinsExport()
  ExportFlags.md           — this document
```

`dllmain.cpp` was modified to load flags at thread start, call the three new entry points when
enabled, and write `export_manifest.json` at the end. `CatalogExporter.vcxproj` was updated to
compile the three new `.cpp` files.

## Build

Unchanged — `_build.bat` still just invokes MSBuild on `CatalogExporter.vcxproj`, Release|x64.

### EXPORT_HUNTS (1.12 hunt/matchmaking tables)

Writes a read-only live-table capture under Items_Analysis/hunts_1_12/:

- player_hunts.jsonl - every loaded PlayerHuntTableData row, including direct
  matchmakerHuntIDs, newer matchmakerHuntsByTag, hunt tags, escalation metadata,
  reward IDs, visibility and weapon-level requirements.
- matchmaker_hunts.jsonl - every loaded MatchmakerHuntTableData row, including
  map names/asset paths, Behemoth paths, game-mode override, modifiers, tags and player
  limits.
- hunt_export_manifest.json - table row totals and capture metadata.

For newer tag-routed entries, each tag query retains its tag dictionary and raw query token
stream. That is the native data needed to implement the 1.12 tag-query resolver; the exporter
does not guess a direct Matchmaker row.

This mode is read-only: no ProcessEvent, no hooks, no table writes, and it does not replace
ParadoxDirector/src/vendor/*.json. Inject into the 1.12 client after reaching Ramsgate and
opening the Hunt/Map UI at least once. If a table is not loaded, the status file says so; open
the relevant UI and re-inject. Review and import the resulting data before changing matchmaking
tables.
### EXPORT_TABLE_INVENTORY (DataTable census — discovery aid)

Writes a read-only census of **every loaded UDataTable** to `Items_Analysis/`:

- `table_inventory_1_12.txt` — flat, sorted, greppable `name | rowStruct | rowCount`. Read this one first.
- `table_inventory_1_12.jsonl` — same data plus each table's full object path.

**Why this exists.** Every other exporter finds its table by RowStruct name, which assumes you
already know that name. That works for `FPlayerHuntTableData` and `FMatchmakerHuntTableData`, and
breaks down immediately past them: `matchmaker_hunts_table` rows point at `map_metadata_table`
through an `FDataTableRowHandle`, but no plausibly-named row struct for it exists in
`Archon_structs.hpp`, and "trials" could be backed by `FChallengeTableData`,
`FGameActivityTableData`, or neither. Each guess otherwise costs a full inject cycle. This pass
answers the question once for the entire hunt / mission / trial / escalation graph.

The `rowStruct` column is the actionable field — it is the exact string you pass to
`FindDataTablesByRowStruct` when writing the next targeted exporter.

**It does not serialize row contents.** Reading rows requires per-struct field knowledge, and
reading a row as the wrong type is precisely how you fault a live process. This pass touches only
UObject/UDataTable header fields that are type-safe regardless of RowStruct, each behind SEH.

**Coverage caveat — this sees LOADED tables only.** A table the client has not streamed in yet is
invisible to the census. Reach Ramsgate and open the Hunt/Map, Trials and Escalation UIs at least
once before injecting, or it will under-report. If an expected table is absent, that is the fix:
open the relevant UI and re-inject, do not assume the table does not exist.

Read-only: no `ProcessEvent`, no hooks, no writes into game memory. Safe against a live process.
Runs last in the dispatch order so a fault here cannot cost you the targeted exports.