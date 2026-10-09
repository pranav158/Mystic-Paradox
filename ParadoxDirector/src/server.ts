/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { app, SetPersistentHubsReady } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";
import { EnsureServerRuntimeUpdated } from "./runtimeUpdater";

const PORT = process.env.PORT;

async function Main(): Promise<void> {
  // [2026-10-08] The MYSTPAX_ environment prefix was renamed to MYSTICPARADOX_. Spawned gameservers
  // inherit this environment, so a stale key would silently switch a runtime feature off.
  const LegacyKeys = Object.keys(process.env).filter((Key) => Key.startsWith("MYSTPAX_"));
  if (LegacyKeys.length > 0) {
    throw new Error(`Rename these environment keys to the MYSTICPARADOX_ prefix: ${LegacyKeys.sort().join(", ")}`);
  }
  try {
    await EnsureServerRuntimeUpdated();
  } catch (error) {
    if (/^(1|true|yes|on)$/i.test(process.env.SERVER_RUNTIME_UPDATE_REQUIRED?.trim() ?? "")) throw error;
    logger.warn({ error }, "Server runtime update failed; continuing with the installed DLL");
  }

  app.listen(PORT, () => {
    void Startup().then(
      () => SetPersistentHubsReady(true),
      (error) => logger.error({ error }, "Persistent gameserver startup failed"),
    );
    // [2026-10-05] Never let a watchdog pass reject into the void: a bare setInterval turns an
    // unhandled rejection into process death (Node >=15), which is how a flapping training hub used to
    // take down matchmaking for the healthy Ramsgate hub.
    setInterval(() => { void RunWatchdog().catch((error) => logger.error({ error }, "Gameserver watchdog pass failed")); }, 60 * 1000);
    logger.info(`Mystic Paradox DeployServer on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });
}

void Main().catch((error) => {
  logger.fatal({ error }, "DeployServer startup failed");
  process.exitCode = 1;
});
