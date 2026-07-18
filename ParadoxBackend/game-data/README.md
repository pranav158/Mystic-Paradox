# Backend game-data

This directory holds **locally generated** game data consumed by the backend at runtime:

- `progression_config.json` — hunt-pass / progression track rewards
- `slayers_path.json` — Slayer's Path (player journey) node graph
- `slayers_path_definitions.json` — Slayer's Path node rewards/costs
- `ladyluck_store.json` — Lady Luck's Store (Trials/Arena reward shop)

**These files are NOT distributed** — they are Phoenix Labs game data. You generate them from
your own lawful game installation. See `docs/GENERATING_GAME_DATA.md` at the repo root.

The real `*.json` files are git-ignored. Only the `*.example.json` synthetic placeholders are
committed, so the project compiles and can smoke-test without proprietary data.

## Quick smoke test (synthetic data)

```bash
cp progression_config.example.json        progression_config.json
cp slayers_path.example.json              slayers_path.json
cp slayers_path_definitions.example.json  slayers_path_definitions.json
cp ladyluck_store.example.json            ladyluck_store.json
```

## Real data

Run the generators after extracting with CatalogExporter (see `docs/GENERATING_GAME_DATA.md`):

```bash
npm run generate:progression-config
npm run generate:slayers-path
npm run generate:ladyluck-store
```

Override the directory with the `PARADOX_GAME_DATA_DIR` environment variable.
