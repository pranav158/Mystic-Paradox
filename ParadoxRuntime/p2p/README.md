# Player-hosted (P2P) module - private

This folder is private: the public sync (`scripts/public-export/sync.mjs`) leaves every `p2p/` folder out,
and without it the project builds `P2PHooksStub.cpp` (see `../BUILD.md`). The Hunt Guard evidence producer is the
separate anti-cheat module in `../anticheat/`, reached only through `AntiCheatHooks.h`; without that folder this
module builds `AntiCheatHooksStub.cpp` and produces no evidence.

After a runtime build that P2P testing will use, regenerate the Guard manifest for `MysticParadox.dll`, rebuild
the launcher with the `p2p` feature, stage a fresh candidate and run solo/duo acceptance. Old
`MystPaxInternalServer.dll` candidate hashes and signatures do not validate the renamed artifact.
