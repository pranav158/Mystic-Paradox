# Backend game-data

This directory holds the **locally generated** game data the backend reads at runtime
(`src/gameData/loader.ts`):

| File | Contents |
|---|---|
| `progression_config.json` | Hunt pass and progression track rewards (`GET /progression/config`) |
| `slayers_path.json` | Slayer's Path (player journey) node graph |
| `slayers_path_definitions.json` | Slayer's Path node rewards and costs |
| `ladyluck_store.json` | Lady Luck's store (Trials and Arena reward shop) |
| `platinum_store.json` | Platinum store |
| `reward_cache_store.json` | Reward Cache store (seasonal coins) |
| `inventory_storage_policy.json` | Per-item inventory storage (instanced or stacked) and quantity limits |

**These files are not distributed:** they are Phoenix Labs game data. Generate them from your own lawful
game installation; see `docs/GENERATING_GAME_DATA.md` at the repository root. Only the synthetic
`*.example.json` placeholders are committed, so the project builds and can smoke-test without the real data.

Override the directory with the `PARADOX_GAME_DATA_DIR` environment variable.

## Quick smoke test (synthetic data)

```bash
for f in *.example.json; do cp "$f" "${f%.example.json}.json"; done
```

The placeholders let the backend start; they are not playable. `npm test` skips the `*.gamedata.test.ts`
files until every real file is present.

## Real data

Extract with CatalogExporter first (see `docs/GENERATING_GAME_DATA.md`); the generators read
`<repository>/Items_Analysis`. Run them in this order:

```bash
cp slayers_path.example.json slayers_path.json          # base graph the generator fills in
npm run generate:slayers-path -- --apply                # Slayer's Path nodes from the export
node scripts/generate_slayers_path_definitions.cjs --apply
npm run generate:progression-config -- --apply          # from raw/progression_config.source.json
npm run generate:ladyluck-store -- --apply              # from raw/ladyluck_store.source.json
npm run reward-cache:generate                           # from the catalog; also writes the storage policy
npm run platinum:generate                               # from the catalog and store images; also the policy
```

The `generate:*` scripts preview without `--apply`; the others write directly. `npm run
inventory:storage-policy:generate` rebuilds the storage policy alone (from the catalog, for every item
the code and the game data reference). Set `MYSTICPARADOX_CATALOG_PATH` to read another catalog.
