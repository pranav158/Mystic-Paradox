# Director game-data

This directory holds **locally generated** hunt/matchmaker tables consumed by the director at
runtime:

- `player_hunts_table.json`
- `matchmaker_hunts_table.json`
- `arena_easy_matchmaker_hunts.json`
- `arena_hard_matchmaker_hunts.json`
- `arena_elite_matchmaker_hunts.json`

**These files are NOT distributed** — they are Phoenix Labs game data. You generate them from
your own lawful game installation. See `docs/GENERATING_GAME_DATA.md` at the repo root.

The real `*.json` files are git-ignored. Only the `*.example.json` synthetic placeholders are
committed, so the project compiles and can smoke-test without proprietary data.

## Quick smoke test (synthetic data)

```bash
cp player_hunts_table.example.json          player_hunts_table.json
cp matchmaker_hunts_table.example.json      matchmaker_hunts_table.json
cp arena_easy_matchmaker_hunts.example.json arena_easy_matchmaker_hunts.json
cp arena_hard_matchmaker_hunts.example.json arena_hard_matchmaker_hunts.json
cp arena_elite_matchmaker_hunts.example.json arena_elite_matchmaker_hunts.json
```

## Real data

```bash
npm run generate:hunt-tables
```

Override the directory with the `PARADOX_GAME_DATA_DIR` environment variable.
