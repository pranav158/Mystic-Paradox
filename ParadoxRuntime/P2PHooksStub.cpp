/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Dedicated-only behaviour of the optional player-hosted server hooks (P2PHooks.h). The project
// compiles this file only when the p2p\ sources are absent: no auth mode is claimed, so every server
// runs as a DeployServer gameserver and the remaining hooks never change anything.

#include "P2PHooks.h"

bool P2PHooks::ClaimAuthMode(const std::string&) { return false; }
void P2PHooks::ReadLaunch(int, wchar_t**) {}
void P2PHooks::InstallServerHooks() {}
std::string P2PHooks::DescribeRole() { return {}; }
bool P2PHooks::StartServer() { return true; }
bool P2PHooks::PrepareListen(std::wstring&) { return true; }
bool P2PHooks::ReportsReadiness() { return false; }
bool P2PHooks::ReportReady(int) { return true; }
bool P2PHooks::TickShutdown() { return false; }
void P2PHooks::OnListenFailed() {}
void P2PHooks::RequestHeader(std::wstring&, std::wstring&) {}
void P2PHooks::ObserveServerEvent(const std::string&, void*) {}
