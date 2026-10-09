# Director game-data

This directory holds the **locally generated** hunt and matchmaker tables the Director reads at runtime
(`src/gameData/loader.ts`):

- `player_hunts_table.json`
- `matchmaker_hunts_table.json`
- `arena_easy_matchmaker_hunts.json`
- `arena_hard_matchmaker_hunts.json`
- `arena_elite_matchmaker_hunts.json`
- `arena_hard_matchmaker_hunts_new.json` and `arena_elite_matchmaker_hunts_new.json` (the second Hard and
  Elite Trials tables added in 1.14.7)

**These files are not distributed:** they are Phoenix Labs game data. Generate them from your own lawful
game installation; see `docs/GENERATING_GAME_DATA.md` at the repository root. Only the synthetic
`*.example.json` placeholders are committed, so the project builds and can smoke-test without the real data.

Override the directory with the `PARADOX_GAME_DATA_DIR` environment variable.

## Quick smoke test (synthetic data)

```bash
for f in *.example.json; do cp "$f" "${f%.example.json}.json"; done
```

The placeholders let the Director start; they launch no real hunt. `npm test` skips the
`*.gamedata.test.ts` files until every real table is present.

## Real data

Export the hunt tables with CatalogExporter (`EXPORT_HUNTS=1`, written to `Items_Analysis/hunts_1_14_7`),
then import them. The importer previews by default and writes with `--apply`:

```bash
npm run generate:hunt-tables
npm run generate:hunt-tables -- --apply
```
