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

import path from "node:path";

import pino from "pino";
import { GetRequestId } from "./observability/requestContext.js";

// Clean (no-color) mirror of the console log, for grep-friendly debugging.
const FILE_LOG = path.resolve(process.cwd(), "../debug/deployserver/deployserver.log");

// [2026-07-24] See ParadoxBackend/src/logger.ts for the full story: this transport used to be gated
// on `process.env.NODE_ENV !== "production"`, which silently drops file logging (no fallback, no
// warning) whenever NODE_ENV ends up "production" - whether from this service's own env or something
// set externally by whatever launches it. DeployServer's own .env doesn't set NODE_ENV at all, so this
// particular file happened to still write, but the same fragile gate was one env change away from
// going dark here too. Made unconditional to match; LOG_LEVEL already controls verbosity.
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  mixin: () => {
    const requestId = GetRequestId();
    return requestId ? { requestId } : {};
  },

  transport: {
    targets: [
      {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
      {
        target: "pino-pretty",
        options: {
          colorize: false,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          destination: FILE_LOG,
          mkdir: true,
          append: false,
        },
      },
    ],
  },
});
