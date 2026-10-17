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
| `fountain_daily_bundle.json` | **Optional.** The Ramsgate fountain coin toss ("Daily Free Bundle", store tag `fountain_daily_free_bundle`) |
| `mastery_objectives.json` | **Optional.** Every mastery card / achievement objective id the game can report (`objectiveIds`, which also holds the card XP-bar ids), plus per-card track and completion targets. Exported from the game's `mastery_card_table` and `achievements_table` (CatalogExporter, or read from the paks) |
| `escalation_tuning.json` | **Optional.** Heroic Escalation seasons `ESC_SEASON_1..6`: XP curve, max level, the six unlock rewards and every talent's costs and tier gate; checks escalation saves from realm hosts (without it hosts keep the never-lower merge). Read from the paks (`escalation_progression`, `escalation_talents*`) |

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

## Fountain daily bundle (optional, hand-written)

`fountain_daily_bundle.json` is not generated: no live capture of the fountain's offer exists, so its
contents are the **operator's choice**. Without the file (or if it is rejected) the fountain coin toss
simply stays unavailable; nothing else changes and `npm test` does not require it.

- Exactly one offer in `{ "skus": [ ... ] }` (a `comment` field is allowed), tagged
  `fountain_daily_free_bundle`, priced `[{ "currencyId": "id_currency_platinum", "price": 0 }]` - the client
  opens the coin toss only for a 0-Platinum offer.
- Stacked items only (`"instanced": false`, and `stacked` in `inventory_storage_policy.json` - rerun
  `npm run inventory:storage-policy:generate` after choosing a new item). No entitlements, progression or
  prestige-gated currency (`CURRENCY_SEASONAL_COIN` and the other season coins). Any problem rejects the
  whole offer, with the reason in the startup log (`[Store:fountain_daily_free_bundle]`).
- One claim per player per window; the window resets at 17:00 UTC. A repeat claim in the same window only
  replays the first one, and the offer is left out of the player's listing until the reset.
- `fountain_daily_bundle.example.json` shows the shape.

## Tester max kit (`tester_max_kit.json`, optional, hand-written)

`POST /admin/v1/players/:userId/tester-max` (controllers/testerMax.ts) reads this file. Copy `tester_max_kit.example.json`
and extend it with ids confirmed in `inventory_storage_policy.json` and your own catalogue export. Without the file
the route answers 503; an invalid kit answers 422 with every problem listed. The kit never names a catalog id the policy does not know.

Sections: `progression` (XP targets), `inventory` and `currencies`. There is no Slayer's Path section: it is unlocked in game.
Player-level XP follows weapon XP in the game, so a weapon track raised to a level needs the player level at least as high; each
reached rank is confirmed. Prestige-gated currencies (such as `CURRENCY_SEASONAL_COIN`) are credited without banked prestige.
