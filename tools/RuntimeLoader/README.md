# Paradox Runtime Loader

A small winmm.dll proxy that forwards multimedia calls to the real Windows system library and
loads the newest available runtime copy from the game directory during process startup. The
canonical name is MysticParadox.dll; MystPaxInternalServer.dll remains a temporary migration alias.

## Build

    cd tools\RuntimeLoader
    cargo build --release

Output: target\release\winmm.dll.

Toolchain: `rust-toolchain.toml` pins `nightly-2026-03-09` (rustc 1.96.0-nightly, commit 2d76d9bc7, the owner's PC).
rustup installs it on the first build here; `RUSTUP_TOOLCHAIN=nightly` in the environment uses the locally installed nightly for
one command. The MSVC linker (Visual Studio Build Tools, C++ workload) is needed. CI: `cargo build --release --locked` on a
Windows runner with that toolchain. The output is not byte-reproducible (link timestamp), and a rebuild does not reproduce the
shipped winmm.dll (`25E4FCC9`): releases keep the shipped file until a rebuilt one is published on purpose (launch plan P6.2).

Place winmm.dll and MysticParadox.dll beside Dauntless-Win64-Shipping.exe. During the rename
transition the launcher keeps MysticParadox.dll and MystPaxInternalServer.dll synchronized, and
the loader selects the most recently updated copy. The loader can optionally read
mystic_loader.ini; when present, list one additional project-owned DLL path per line. These entries
never replace either runtime alias. Relative paths resolve from the game directory.

Do not list untrusted DLLs. Every configured library executes inside the game process.

## Origin and license

This loader is derived from
https://github.com/denuvosanctuary/coldloader-proxy and remains available under
the Apache License 2.0. See LICENSE in this directory. Mystic Paradox does not require or ship
coldloader.dll.