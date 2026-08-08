# Launcher and runtime update channels

Launcher installers and runtime DLLs use separate HTTPS-only, signed channels.

## Signing material

Create signing material only on a trusted release machine:

- `.secrets/mystic-launcher.key` and `.secrets/mystic-launcher.password` sign Tauri updater artifacts.
- `.secrets/mystic-runtime-update.private.pem` signs runtime DLL payloads.
- The corresponding public keys are embedded in `src-tauri/tauri.conf.json` and `src-tauri/src/commands/updates.rs`.

Never commit or upload private keys or signing passwords. When rotating a runtime verification key, release the launcher containing the new public key before publishing runtime payloads signed by it.

## Backend configuration

Configure `ParadoxBackend` with an update root outside the source tree:

```text
LAUNCHER_UPDATE_ROOT=D:\MysticUpdates
UPDATE_PUBLISHER_API_KEY=<publisher-only random secret>
UPDATE_PUBLIC_BASE_URL=https://your-backend.example
UPDATE_PUBLISHER_ALLOWED_IPS=203.0.113.10
```

The example IP is documentation-only. An empty publisher allow-list must deny uploads.

## Publish a runtime update

From `ParadoxLauncher`:

```powershell
node scripts/publish-runtime-update.mjs `
  --dll ..\ParadoxRuntime\x64\Release\MysticParadox.dll `
  --extra ..\tools\RuntimeLoader\target\release\winmm.dll `
  --target client `
  --version 0.4.13 `
  --changelist 392819 `
  --channel stable `
  --output D:\MysticUpdates `
  --base-url https://your-backend.example `
  --key .secrets\selfhost-runtime-update.private.pem
```

The self-host configuration helper creates `.secrets\selfhost-runtime-update.private.pem`. If you
are not using it, generate an equivalent key with `generate-runtime-key.mjs` and compile its public
key into your launcher. The `--extra` argument publishes the required loader beside the runtime;
multiple `--extra` arguments are supported.

The publisher writes a versioned artifact, `manifest.json`, and `latest.json`. Use `--target server`
for the director's dedicated-server runtime. Consumers verify target, changelist, HTTPS origin,
size, SHA-256, and Ed25519 signature before replacing a DLL.

## Publish a launcher update

Keep `package.json`, both Cargo manifests, and `src-tauri/tauri.conf.json` on the same version. Then run:

```powershell
npm run release:launcher
npm run publish:launcher -- -UpdateRoot D:\MysticUpdates -BaseUrl https://your-backend.example
```

The release script loads signing values only for the child build process. The publish script copies the signed NSIS updater artifact and writes the Tauri-compatible `latest.json`.

## Rollout order

1. Publish a launcher update first when changing verification keys or manifest protocol.
2. Deploy the backend against the completed update root.
3. Publish runtime DLLs to `stable` after the compatible launcher is available.
4. Keep immutable, versioned artifacts for rollback; never overwrite a released version.
