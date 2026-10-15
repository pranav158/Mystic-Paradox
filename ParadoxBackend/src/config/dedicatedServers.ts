/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] DEPLOYSERVER_URL names the DeployServer, which starts the dedicated hub and hunt servers. Unset or blank means this
// server has none: the VPS runs the backend only, and every hunt and hub is player-hosted (realms). Nothing may then ask for a
// dedicated server, which would fetch an address such as http://undefined/.

/** Whether a DeployServer is configured: DEPLOYSERVER_URL holds something other than blank or whitespace. */
export function DedicatedServersConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
    return (environment.DEPLOYSERVER_URL ?? "").trim().length > 0;
}
