/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Behaviour of the anti-cheat hooks (AntiCheatHooks.h) without the anti-cheat module. The project compiles
// this file only when the ..\anticheat\ sources are absent: no evidence is produced, so a player-hosted
// hunt runs unmonitored and earns no rewards.

#include "AntiCheatHooks.h"

bool AntiCheatHooks::Present() { return false; }
void AntiCheatHooks::Initialize(bool, const std::string&) {}
bool AntiCheatHooks::StartWorker() { return true; }
void AntiCheatHooks::ObserveServerEvent(const std::string&, void*) {}
