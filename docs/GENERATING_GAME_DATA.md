# Generating game data

This project does **not** distribute Phoenix Labs game data (progression, hunt tables, store,
Slayer's Path, etc.). You extract it from your **own lawful game installation** and generate the
runtime files locally. The server loads them from a `game-data/` directory at startup.

- Backend needs: `progression_config.json`, `slayers_path.json`, `slayers_path_definitions.json`,
  `ladyluck_store.json` (in `ParadoxBackend/game-data/`).
- Director needs: `player_hunts_table.json`, `matchmaker_hunts_table.json`,
  `arena_{easy,hard,elite}_matchmaker_hunts.json` (in `ParadoxDirector/game-data/`).

Override the location with `PARADOX_GAME_DATA_DIR`. Raw exporter output goes in `game-data/raw/`
(override with `PARADOX_GAME_DATA_RAW_DIR`).

## 1. Extract raw data with CatalogExporter

Build `tools/CatalogExporter` (see `GENERATING_SDK.md` for the SDK it needs), set the flags you
need in `export_flags.txt` (copy from `export_flags.example.txt`), and inject it into your own
game process. Relevant flags:

| Flag | Produces (raw) | Feeds |
|---|---|---|
| `EXPORT_HUNTS=1` | `player_hunts.jsonl`, `matchmaker_hunts.jsonl` | hunt/matchmaker/arena tables |
| `EXPORT_SLAYERS_PATH=1` | `player_journey_nodes.jsonl` | Slayer's Path graph + definitions |
| `EXPORT_PROGRESSION=1` | progression export | progression config |
| `EXPORT_DROP_TABLES=1` | drop-table export | Lady Luck's store |

> Some flags are client-only and require the relevant menu to be open so the tables have streamed
> in — see `tools/CatalogExporter/ExportFlags.md`.

Copy the produced files into the matching service's `game-data/raw/` directory.

## 2. Generate the runtime files

**Director (hunt tables):**
```
cd ParadoxDirector
npm run generate:hunt-tables            # dry run
node scripts/import_hunt_tables.cjs --apply
```

**Backend:**
```
cd ParadoxBackend
node scripts/generate_slayers_path.cjs --apply           # needs game-data/raw/player_journey_nodes.jsonl
node scripts/generate_progression_config.cjs --apply     # needs game-data/raw/progression_config.source.json
node scripts/generate_ladyluck_store.cjs --apply         # needs game-data/raw/ladyluck_store.source.json
```

All generators are **dry-run by default** and print a plan; pass `--apply` to write. They write
into `game-data/` (git-ignored).

## 3. Smoke test without real data

Every required file ships a synthetic `*.example.json` placeholder. Copy them to the real name to
let the services boot with fictional data (see each `game-data/README.md`). This is for
compilation/plumbing checks only — it is **not** playable content.

## Provenance note

The published schemas, loaders, and generator scripts match what the hosted server consumes. Only
the raw *values* are user-supplied from your own installation. Do not host a build using different
private data while pointing users at a materially different generation path.
