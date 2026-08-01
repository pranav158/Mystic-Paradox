# Security Policy

## Never commit

- Real account data or database snapshots (characters, inventory, wallets, loadouts).
  Migration/test fixtures must contain only the minimal synthetic fields needed to exercise a
  script — never a dump of real user data.
- Secrets of any kind: `.env` files, private keys, TLS certificates/passphrases, API keys,
  OAuth client secrets, TOTP secrets, and launcher/runtime signing keys or passwords.
- Phoenix Labs game data or assets (see `docs/GENERATING_GAME_DATA.md`).

These paths are enforced by `.gitignore`, but the rule is the source of truth — do not override it.

## Running safely

- Do **not** run with authentication disabled on a public host. `AUTH_MODE=NONE` +
  `ALLOW_NO_AUTH_DEV_MODE=true` auto-creates/logs in arbitrary accounts with no verification.
  These are development-only switches.
- Admin routes (`/admin/v1`) fail closed without `ADMIN_TOTP_SECRET` and an origin allow-list.
- Update-push routes fail closed without an explicit IP allow-list.
- The server terminates TLS directly — supply your own certificate and keep its passphrase in
  `.env` only.

## Reporting a vulnerability

Please open a private report to the maintainer rather than a public issue for anything that could
expose player data or credentials.
