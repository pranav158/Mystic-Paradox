# Generating the SDK

The runtime DLL (`ParadoxRuntime`) is built against a C++ SDK generated from your own copy of the
game. **No game-derived SDK is distributed in this repository** — you generate it locally.

## Steps

1. Build [Dumper-7](https://github.com/Encryqed/Dumper-7) and inject it into your running
   `1.12.0` game process.
2. Copy the **complete** generated `CppSDK` output into `ParadoxRuntime/`, so that you have:
   - `ParadoxRuntime/SDK/` (the per-class headers + `*_functions.cpp`)
   - `ParadoxRuntime/SDK.hpp`
   - `ParadoxRuntime/UnrealContainers.hpp`
   - `ParadoxRuntime/UtfN.hpp`
   - `ParadoxRuntime/PropertyFixup.hpp`
   - `ParadoxRuntime/NameCollisions.inl`
   - `ParadoxRuntime/Assertions.inl`
3. Copy `ParadoxRuntime/deployment_config.generated.h.example` to
   `ParadoxRuntime/deployment_config.generated.h` and set `MP_PUBLIC_HOST` to your server host.
4. Build:
   ```
   cd ParadoxRuntime
   _build.bat            REM or: msbuild MysticParadox.sln /p:Configuration=Release /p:Platform=x64
   ```
   Output: `ParadoxRuntime\x64\Release\MysticParadox.dll`.

All of the above generated files are `.gitignore`d, so they are never committed.

## CatalogExporter uses the same SDK

`tools/CatalogExporter` (used to extract game data — see `GENERATING_GAME_DATA.md`) is built
against the same generated SDK. Point its project include paths at your generated `SDK/` before
building it.
