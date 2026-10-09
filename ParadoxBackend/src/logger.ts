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
import { OperationalDiagnosticsProfile, ResolveOperationalLogLevel } from "./config/loggingPolicy.js";

// Clean (no-color) mirror of the console log, for grep-friendly debugging.
const FILE_LOG = path.resolve(process.cwd(), "../debug/metagame/metagame.log");

// [2026-07-24] The file transport below used to be gated on `process.env.NODE_ENV !== "production"`.
// Whatever launches this process on the VPS sets (or inherits) NODE_ENV=production somewhere outside
// this repo's own .env (this .env itself says NODE_ENV=development, but Node's --env-file only fills
// in variables that are NOT already present in the process environment - an externally-set
// NODE_ENV=production wins over it). The result was `transport: undefined` in practice: no file, no
// warning, nothing - debug/metagame/metagame.log simply stopped being written, silently, with no
// signal that logging had gone anywhere except "the file doesn't exist." This has been the single
// most-used diagnostic artifact all session (XMPP chat, matchmaking, inventory transactions, store
// purchases - all traced through this file). For a solo-operator private server there is no real
// multi-tenant/production reason to disable local file logging conditionally; verbosity is already
// controlled independently via LOG_LEVEL. Both transports are now unconditional.
export const logger = pino({
  level: ResolveOperationalLogLevel("PRODUCTION"),

  // AsyncLocalStorage attaches the same request ID to Metagame, DeployServer-call,
  // and database logs without threading an extra argument through every controller.
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

export function ApplyDiagnosticsLogProfile(profile: OperationalDiagnosticsProfile): void {
  const next = ResolveOperationalLogLevel(profile);
  if (logger.level === next) return;
  logger.level = next;
  logger.info(`[logging] operations diagnostics profile=${profile} level=${next}`);
}
