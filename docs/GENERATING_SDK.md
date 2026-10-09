# Generating the SDK

> [!NOTE]
> This guide describes Dauntless 1.12.0. Follow it on the
> [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag: `main` now
> carries the 1.14.7 runtime, and this guide moves to 1.14.7 with the remaining components.

ParadoxRuntime and tools/CatalogExporter build against a C++ SDK generated from your own compatible
game installation. No game-derived SDK is distributed in this repository.

## Required target

Generate the SDK from exactly:

| Property | Value |
|---|---|
| Game | Dauntless 1.12.0 |
| Build label | rel-1.12.0-Archon |
| Changelist | 392819 |
| Unreal Engine | 4.26.2 |
| Platform | Windows x64 |

A dump from a different client may compile but has incompatible layouts, functions, or offsets.

## Generate and copy the SDK

1. Build [Dumper-7](https://github.com/Encryqed/Dumper-7).
2. Start your own supported game installation.
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

The project currently selects platform toolset v145. Visual Studio 2022 users can retarget
ParadoxRuntime/MysticParadox.vcxproj to v143 locally.

From a normal PowerShell or Developer Command Prompt:

    Set-Location ParadoxRuntime
    .\_build.bat

The helper finds MSBuild with vswhere. The equivalent command is:

    msbuild MysticParadox.sln /p:Configuration=Release /p:Platform=x64

Expected output:

    ParadoxRuntime\x64\Release\MysticParadox.dll

MysticParadox.dll is the canonical public filename.

## Build CatalogExporter

CatalogExporter uses the same generated SDK. Confirm its include paths resolve to the complete
ParadoxRuntime SDK, then build:

    Set-Location tools\CatalogExporter
    .\_build.bat

Visual Studio 2022 users must also retarget CatalogExporter.vcxproj to v143.

Copy export_flags.example.txt to export_flags.txt beside the exporter or in the location described
by [ExportFlags.md](../tools/CatalogExporter/ExportFlags.md), enable only the required modes, and
inject the resulting DLL into your own game process.

For the playable-data path, the most relevant flags are:

- EXPORT_SLAYERS_PATH
- EXPORT_HUNTS
- EXPORT_PROGRESSION
- EXPORT_DROP_TABLES

Some exports depend on tables that the client streams only after opening a menu or reaching a world.
Review the exporter status output and manifest instead of assuming a successful injection produced
every required row.

Continue with [GENERATING_GAME_DATA.md](GENERATING_GAME_DATA.md) after extraction.
