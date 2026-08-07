# Paradox Runtime Loader

A small winmm.dll proxy that forwards multimedia calls to the real Windows system library and
loads MystPaxInternalServer.dll from the game directory during process startup.

## Build

    cd tools\RuntimeLoader
    cargo build --release

Output: target\release\winmm.dll.

Place winmm.dll and the runtime renamed to MystPaxInternalServer.dll beside
Dauntless-Win64-Shipping.exe. The loader can optionally read mystic_loader.ini; when present,
list one additional project-owned DLL path per line. These entries never replace the required
MystPaxInternalServer.dll. Relative paths resolve from the game directory.

Do not list untrusted DLLs. Every configured library executes inside the game process.

## Origin and license

This loader is derived from
https://github.com/denuvosanctuary/coldloader-proxy and remains available under
the Apache License 2.0. See LICENSE in this directory. Mystic Paradox does not require or ship
coldloader.dll.