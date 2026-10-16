/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import type { LocalRealmHost } from "../servers/realmStatus";
import { realmHostStatus } from "./realmHostApi";

// [2026-10-16] This PC's realm host in the shape Home reads (src/lib/optionalRealmHost.ts finds this file; Home never
// imports it): the realm it hosts and whether it is stopped, starting, online, restarting or stopping.
export async function localRealmHost(): Promise<LocalRealmHost> {
  const status = await realmHostStatus();
  return { realmName: status.realm?.name ?? null, state: status.state };
}
