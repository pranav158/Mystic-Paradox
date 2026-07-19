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

import { app } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";
import { EnsureServerRuntimeUpdated } from "./runtimeUpdater";

const PORT = process.env.PORT;

async function Main(): Promise<void> {
  try {
    await EnsureServerRuntimeUpdated();
  } catch (error) {
    if (/^(1|true|yes|on)$/i.test(process.env.SERVER_RUNTIME_UPDATE_REQUIRED?.trim() ?? "")) throw error;
    logger.warn({ error }, "Server runtime update failed; continuing with the installed DLL");
  }

  app.listen(PORT, () => {
    void Startup().catch((error) => logger.error({ error }, "Persistent gameserver startup failed"));
    setInterval(RunWatchdog, 60 * 1000);
    logger.info(`Mystic Paradox DeployServer on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });
}

void Main().catch((error) => {
  logger.fatal({ error }, "DeployServer startup failed");
  process.exitCode = 1;
});
