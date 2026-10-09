# Generating game data

> [!NOTE]
> This guide describes Dauntless 1.12.0. Follow it on the
> [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag: `main` now
> carries the 1.14.7 runtime, and this guide moves to 1.14.7 with the remaining components.

Mystic Paradox does not distribute Phoenix Labs game data. Extract the required material from your
own lawful Dauntless 1.12.0 installation and generate the service payloads locally.

Synthetic *.example.json files only allow build and startup smoke tests. They are not playable.

## Final required files

Backend reads these files from ParadoxBackend/game-data by default:

- progression_config.json
- slayers_path.json
- slayers_path_definitions.json
- ladyluck_store.json

Director reads these files from ParadoxDirector/game-data by default:

- player_hunts_table.json
- matchmaker_hunts_table.json
- arena_easy_matchmaker_hunts.json
- arena_hard_matchmaker_hunts.json
- arena_elite_matchmaker_hunts.json

Override either final directory with PARADOX_GAME_DATA_DIR. Raw inputs use game-data/raw by default
and can be overridden with PARADOX_GAME_DATA_RAW_DIR.

## 1. Build and run CatalogExporter

Build tools/CatalogExporter against the complete SDK described in
[GENERATING_SDK.md](GENERATING_SDK.md).

Copy export_flags.example.txt to export_flags.txt and enable only the required modes:

| Flag | Relevant raw output |
|---|---|
| EXPORT_SLAYERS_PATH=1 | Items_Analysis/slayers_path_1_12/player_journey_nodes.jsonl |
| EXPORT_HUNTS=1 | Items_Analysis/hunts_1_12/player_hunts.jsonl and matchmaker_hunts.jsonl |
| EXPORT_PROGRESSION=1 | Progression extraction material |
| EXPORT_DROP_TABLES=1 | Drop-table/store extraction material |

Inject the exporter into your own supported game process. Flags are read once at startup, so
re-inject after changing them. Review
[tools/CatalogExporter/ExportFlags.md](../tools/CatalogExporter/ExportFlags.md) for all modes and
streaming requirements.

Some client-only tables exist only after reaching Ramsgate or opening the relevant UI. A successful
DLL injection does not guarantee that every required table was loaded.

## 2. Copy raw inputs to the services

Use these exact destinations:

| Export/capture | Destination |
|---|---|
| Items_Analysis/slayers_path_1_12/player_journey_nodes.jsonl | ParadoxBackend/game-data/raw/player_journey_nodes.jsonl |
| Compatible progression response | ParadoxBackend/game-data/raw/progression_config.source.json |
| Compatible Lady Luck store response | ParadoxBackend/game-data/raw/ladyluck_store.source.json |
| Items_Analysis/hunts_1_12/player_hunts.jsonl | ParadoxDirector/game-data/raw/player_hunts.jsonl |
| Items_Analysis/hunts_1_12/matchmaker_hunts.jsonl | ParadoxDirector/game-data/raw/matchmaker_hunts.jsonl |

Source-shape requirements:

- progression_config.source.json must be an exact compatible response object containing
  payload.paths as an array.
- ladyluck_store.source.json must be a JSON array.
- progression and drop-table exports are extraction material; the exporter does not necessarily
  assemble those two final source response shapes automatically.
- slayers_path_definitions.json currently has no checked-in one-command generator. Supply the
  matching definitions payload from your own compatible environment.

This last limitation is a real bootstrap constraint. The repository supports the schemas, loaders,
and validation path, but a fresh clone does not contain a downloadable complete playable data pack.

## 3. Validate, then generate

Generators are dry-run by default. Run them once without --apply and read their plan/errors.

Backend:

    Set-Location ParadoxBackend
    npm run generate:slayers-path
    npm run generate:progression-config
    npm run generate:ladyluck-store

Apply only after validation succeeds:

    node scripts/generate_slayers_path.cjs --apply
    node scripts/generate_progression_config.cjs --apply
    node scripts/generate_ladyluck_store.cjs --apply

Director:

    Set-Location ..\ParadoxDirector
    npm run generate:hunt-tables
    node scripts/import_hunt_tables.cjs --apply

The Director importer writes both normal hunt tables and the three arena tables.

## 4. Verify final outputs

From the repository root:

    $backendRequired = @(
      'progression_config.json',
      'slayers_path.json',
      'slayers_path_definitions.json',
      'ladyluck_store.json'
    )
    $directorRequired = @(
      'player_hunts_table.json',
      'matchmaker_hunts_table.json',
      'arena_easy_matchmaker_hunts.json',
      'arena_hard_matchmaker_hunts.json',
      'arena_elite_matchmaker_hunts.json'
    )
    $backendRequired | ForEach-Object { Test-Path (Join-Path 'ParadoxBackend\game-data' $_) }
    $directorRequired | ForEach-Object { Test-Path (Join-Path 'ParadoxDirector\game-data' $_) }

Every result must be True. Then build the services so their loaders validate the structures:

    Set-Location ParadoxBackend
    npm run build
    Set-Location ..\ParadoxDirector
    npm run build

Service startup also fails on missing or structurally invalid required data.

## Synthetic smoke-test data

To test compilation and wiring only, copy each *.example.json to its corresponding *.json name, or
run configure-selfhost.ps1 with -UseSyntheticData.

Do not describe a synthetic deployment as playable. Replace all fixtures with data generated from
the same compatible installation before testing account progression, matchmaking, or Ramsgate.

## Provenance and privacy

Keep raw captures and final extracted tables out of the public repository. They are ignored for this
reason. Before sharing logs, remove account identifiers, tokens, private paths, and captured payloads
that contain user or proprietary data.

Continue with [SELF_HOSTING.md](SELF_HOSTING.md) for runtime compilation, signed update publication,
service startup, launcher setup, and the Ramsgate acceptance test.
