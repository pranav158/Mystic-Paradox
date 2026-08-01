# Mystic Paradox Launcher

The Windows desktop launcher for Mystic Paradox. It signs players in, verifies a supported Dauntless 1.12.0 installation, installs signed project runtime updates, and launches the game with a short-lived, single-use exchange code.

> [!IMPORTANT]
> Mystic Paradox is an unofficial community preservation project. It is not affiliated with or endorsed by Phoenix Labs, Epic Games, Forte Labs, or any Dauntless rights holder.

## What is included

- Tauri 2 native shell with a React, TypeScript, Vite, and Tailwind frontend.
- Native account authentication and Discord deep-link completion.
- Windows Credential Manager storage with a current-user DPAPI-encrypted fallback.
- Executable/runtime hashing, signed runtime downloads, and signed launcher updates.
- Per-session game log collection with user-visible upload controls.

This directory contains source and project-owned branding only. It does not contain the game client, game binaries, extracted game assets, runtime DLLs, private signing keys, or credentials.

## Supported target

| Property | Value |
|---|---|
| Operating system | Windows x64 |
| Game version | Dauntless 1.12.0 |
| Changelist | `392819` |
| Desktop stack | Tauri 2 / Rust / WebView2 |

## Prerequisites

- Node.js 20+ and npm
- Current stable Rust with the MSVC target
- Visual Studio C++ Build Tools and Windows SDK
- Microsoft Edge WebView2 Runtime
- A running compatible `ParadoxBackend` for sign-in and session issuance

## Development

From the repository root:

```powershell
cd ParadoxLauncher
Copy-Item .env.example .env
npm ci
npm run tauri dev
```

Debug native requests default to `http://127.0.0.1:3000`. The frontend status/username requests use `VITE_API_BASE_URL` from `.env`. Set `MYSTPAX_API_BASE_URL` in the build environment to override the native Rust API origin:

```powershell
$env:MYSTPAX_API_BASE_URL = "https://your-backend.example"
npm run tauri dev
```

A custom backend origin must also be allowed by `app.security.csp` in `src-tauri/tauri.conf.json`. Fork operators must replace the official update endpoints and both embedded verification public keys before publishing their own channel.

## Build and test

```powershell
npm ci
npm run build
npm test
npm run tauri build
```

The unsigned development build does not require release keys. Official updater artifacts are signed separately; see [UPDATE_CHANNEL.md](UPDATE_CHANNEL.md).


## Security model

- Passwords and refresh tokens remain in the native layer; the webview receives account metadata only.
- The desktop launcher stores refresh tokens in Credential Manager and a DPAPI-encrypted fallback.
- Runtime downloads are restricted to the configured HTTPS origin and verified by size, SHA-256, and Ed25519 signature before replacement.
- Launcher updates are verified by Tauri's updater signature.
- One-time game exchange codes are short-lived and are not printed to logs.
- Local signing material belongs only in `.secrets/`, which is ignored by both this directory and the repository root.

Report vulnerabilities according to [SECURITY.md](../SECURITY.md).

## License

Licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](../LICENSE), [NOTICE.md](../NOTICE.md), and [ADDITIONAL_TERMS.md](../ADDITIONAL_TERMS.md).
