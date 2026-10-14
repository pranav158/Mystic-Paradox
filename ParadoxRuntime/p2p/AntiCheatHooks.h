/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <string>

// Hook points for the optional anti-cheat module of the player-hosted (P2P) server mode: the Hunt Guard
// evidence producer.
//
// The player-hosted mode is complete without it: AntiCheatHooksStub.cpp produces no evidence, so the
// backend sees an unmonitored hunt with no verdict and no rewards. When the ..\anticheat\ sources are
// present, MysticParadox.vcxproj compiles them instead of the stub. PlayerHost.cpp calls only these
// functions; it never includes anything from anticheat\.
namespace AntiCheatHooks {
    // True when the evidence producer is compiled in.
    bool Present();
    // InstallServerHooks of a player-hosted process. Enabled when the launcher opted this process in;
    // SessionKey is "<sessionId>:<generation>" of the launch it serves.
    void Initialize(bool Enabled, const std::string& SessionKey);
    // StartServer, before listen. False when the evidence worker could not start; the process then ends
    // before listen, since a hunt that was opted in but cannot be validated must not run.
    bool StartWorker();
    // Every server ProcessEvent of a player-hosted process.
    void ObserveServerEvent(const std::string& FunctionName, void* Parms);
}
