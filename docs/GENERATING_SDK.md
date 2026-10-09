# Generating the SDK

ParadoxRuntime and tools/CatalogExporter build against a C++ SDK generated from your own compatible
game installation. No game-derived SDK is distributed in this repository.

> [!NOTE]
> This guide is for Dauntless 1.14.7, which `main` targets. For 1.12.0, follow the guide on the
> [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag.

## Required target

Generate the SDK from exactly:

| Property | Value |
|---|---|
| Game | Dauntless 1.14.7 |
| Build label | rel-1.14.7-Archon |
| Changelist | 647472 |
| Unreal Engine | 4.26.2 |
| Platform | Windows x64 |

A dump from a different client may compile but has incompatible layouts, functions, or offsets.
Nothing generated from 1.12.0 is reusable: class layouts moved even though the engine version did not
change.

## Generate and copy the SDK

1. Build [Dumper-7](https://github.com/Encryqed/Dumper-7).
2. Start your own 1.14.7 game installation.
3. Inject Dumper-7 into that process and wait for the complete CppSDK output.
4. Copy the entire CppSDK output into ParadoxRuntime.

Expected layout:

    ParadoxRuntime\
      SDK\
        ...per-package headers...
        ...generated *_functions.cpp files...
      SDK.hpp
      Assertions.inl
      NameCollisions.inl
      PropertyFixup.hpp
      UnrealContainers.hpp
      UtfN.hpp

Do not copy only SDK.hpp or only headers. The generated implementation files under SDK are compiled
by the runtime project and must be present.

Quick checks from the repository root:

    Test-Path ParadoxRuntime\SDK.hpp
    Test-Path ParadoxRuntime\SDK
    (Get-ChildItem ParadoxRuntime\SDK -Filter '*_functions.cpp').Count

The final count must be greater than zero.

All generated SDK files are ignored. Confirm that they are not staged before committing public
source.

## Configure the deployment hostname

The self-host configurator writes ParadoxRuntime/deployment_config.generated.h. If configuring
manually, copy deployment_config.generated.h.example and set MP_PUBLIC_HOST to the exact hostname
used by DNS and the TLS certificate:

    Copy-Item ParadoxRuntime\deployment_config.generated.h.example ParadoxRuntime\deployment_config.generated.h

Never point a public build at localhost or a hostname that is absent from the certificate SAN.
Changing the hostname requires rebuilding the runtime.

## Build ParadoxRuntime

The projects select platform toolset v145 (Visual Studio with the Desktop development with C++
workload). Visual Studio 2022 users can retarget ParadoxRuntime/MysticParadox.vcxproj to v143 locally.

From a normal PowerShell or Developer Command Prompt:

    Set-Location ParadoxRuntime
    .\_build.bat

The helper finds MSBuild with vswhere, builds Release x64 and returns the real build exit code. The
equivalent command is:

    msbuild MysticParadox.sln /p:Configuration=Release /p:Platform=x64

Expected output:

    ParadoxRuntime\x64\Release\MysticParadox.dll

One DLL serves both the player client and the dedicated servers: it detects `-server` at startup. It
links the C/C++ runtime statically (/MT), because the game folder ships an older msvcp140.dll that the
loader would otherwise prefer. See [ParadoxRuntime/BUILD.md](../ParadoxRuntime/BUILD.md) for the
details and the loader build.

## Build CatalogExporter

CatalogExporter uses the same generated SDK. Confirm its include paths resolve to the complete
ParadoxRuntime SDK, then build:

    Set-Location tools\CatalogExporter
    .\_build.bat

Visual Studio 2022 users must also retarget CatalogExporter.vcxproj to v143.

By default the exporter writes to `Items_Analysis` in the injected game's working directory and reads
`export_flags.txt` from there. To send every export to your repository instead, create the ignored
file tools/CatalogExporter/ExportPaths.local.h before building:

    #define MYSTICPARADOX_EXPORT_ROOT L"D:\\MysticParadox"

Exports then land in `D:\MysticParadox\Items_Analysis`, which is where the game-data generators look,
and the flags file is read from `D:\MysticParadox\tools\CatalogExporter\export_flags.txt`.

Copy export_flags.example.txt to export_flags.txt, enable only the required modes, and inject the
resulting DLL into your own game process. The modes and what each one needs are listed in
[GENERATING_GAME_DATA.md](GENERATING_GAME_DATA.md) and
[ExportFlags.md](../tools/CatalogExporter/ExportFlags.md).

Some exports depend on tables that the client streams only after opening a menu or reaching a world.
Review the exporter status output and manifest instead of assuming a successful injection produced
every required row.

Continue with [GENERATING_GAME_DATA.md](GENERATING_GAME_DATA.md) after extraction.
