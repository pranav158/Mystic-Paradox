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
import PinoPretty from "pino-pretty";
import { GetRequestId } from "./observability/requestContext.js";
import { OperationalDiagnosticsProfile, ResolveOperationalLogLevel } from "./config/loggingPolicy.js";
import { RotateServerLogAtStart, ServerLogRetentionDays } from "./config/logFileRotation.js";

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
// [2026-10-10] ...except under the node test runner (it sets NODE_TEST_CONTEXT in every test process): `npm test` runs
// from ParadoxBackend, so FILE_LOG is the RUNNING Metagame's log, and `append: false` emptied it on every test run.
const ConsoleTarget = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname",
  },
};
// [2026-10-13] Only the server itself starts a fresh log. Any other process that loads this module - a diagnostic or
// maintenance script, a test file run outside the test runner - appends instead: with `append: false` such a process
// emptied the RUNNING server's log (twice on 13 Oct, losing the P2P hunt and stack-stop evidence) and the server kept
// writing at its old offset, leaving a file that starts with NUL bytes.
const IsServerEntry = /[\\/]server\.(js|ts)$/i.test(process.argv[1] ?? "");
const FileTarget = {
  target: "pino-pretty",
  options: {
    colorize: false,
    translateTime: "SYS:standard",
    ignore: "pid,hostname",
    destination: FILE_LOG,
    mkdir: true,
    append: !IsServerEntry,
  },
};
const UnderTestRunner = process.env.NODE_TEST_CONTEXT !== undefined;

// [2026-10-14] Privacy Policy section 5: at the start of a server run the previous log is archived when it is from an earlier UTC day or
// over 100 MB, and archives older than MYSTICPARADOX_LOG_RETENTION_DAYS (default 90) are deleted. This runs before the file transport
// below opens the log, and only in the server entry (never in tests or scripts, which append and never rotate).
if (IsServerEntry && !UnderTestRunner) {
  try {
    const Rotation = RotateServerLogAtStart(FILE_LOG, Date.now(), ServerLogRetentionDays());
    if (Rotation.rotatedTo !== undefined) process.stderr.write(`[logging] previous server log archived as ${Rotation.rotatedTo}\n`);
    if (Rotation.deleted.length > 0) process.stderr.write(`[logging] deleted ${Rotation.deleted.length} expired server log archive(s)\n`);
  } catch (error) {
    process.stderr.write(`[logging] server log rotation skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const LoggerOptions: pino.LoggerOptions = {
  level: ResolveOperationalLogLevel("PRODUCTION"),

  // AsyncLocalStorage attaches the same request ID to Metagame, DeployServer-call,
  // and database logs without threading an extra argument through every controller.
  mixin: () => {
    const requestId = GetRequestId();
    return requestId ? { requestId } : {};
  },
};

// [2026-10-14] Under the test runner the console output is formatted in this thread (pino-pretty as a synchronous stream)
// instead of a transport worker. With the worker, a test file whose tests had all passed sometimes never exited in a full
// `npm test` (realmHostingStatus.test.ts twice, five realm files once, ~0% CPU until the runner's timeout): at exit pino
// waits for the worker to flush, and the worker was blocked writing to the full stdout pipe the runner reads. The heaviest
// logging files were the ones that hung; alone they always passed.
export const logger = UnderTestRunner
  ? pino(LoggerOptions, PinoPretty({ ...ConsoleTarget.options, colorize: false, sync: true }))
  : pino({ ...LoggerOptions, transport: { targets: [ConsoleTarget, FileTarget] } });

export function ApplyDiagnosticsLogProfile(profile: OperationalDiagnosticsProfile): void {
  const next = ResolveOperationalLogLevel(profile);
  if (logger.level === next) return;
  logger.level = next;
  logger.info(`[logging] operations diagnostics profile=${profile} level=${next}`);
}
