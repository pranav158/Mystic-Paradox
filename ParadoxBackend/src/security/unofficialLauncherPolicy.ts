/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import type { LauncherBuildReport, LauncherBuildVerdict } from "../activity/activityRules";

// [2026-10-16] MYSTICPARADOX_UNOFFICIAL_LAUNCHER=observe|refuse - one narrow switch, apart from Guard's MYSTICPARADOX_GUARD_MODE (which
// governs every Guard verdict: hosting, host selection, hub start, admission and play). At Play the launcher reports its version and the
// SHA-256 of its own launcher.exe (activity/activityRules.ts ClassifyLauncherBuild): official = the hash Guard pins, outdated = an older
// official version (it updates itself), unofficial = another hash on the served version or newer, unknown = no report. With refuse, Play is
// refused for "unofficial" only (LAUNCHER_UNOFFICIAL, 403); outdated and unknown play on (launchers before 0.1.65 send no report).
// observe (the default, blank, or any other value - a typo never locks players out) refuses nothing; the UNOFFICIAL_LAUNCHER activity flag
// is raised either way. The report is the launcher's own word, so this fences off self-built and repackaged launchers, not a launcher
// modified to lie.
// Exempt even with refuse: hashes in MYSTICPARADOX_LAUNCHER_ALLOWED_HASHES (comma or space separated SHA-256, for local test builds), and
// accounts with the admin role unless MYSTICPARADOX_UNOFFICIAL_LAUNCHER_TESTERS_EXEMPT=off (the tester role was exempt too until 16 Oct;
// it now unlocks the log upload only, security/testerFeatures.ts).

export const UNOFFICIAL_LAUNCHER_ENV = "MYSTICPARADOX_UNOFFICIAL_LAUNCHER";
export const LAUNCHER_ALLOWED_HASHES_ENV = "MYSTICPARADOX_LAUNCHER_ALLOWED_HASHES";
export const UNOFFICIAL_LAUNCHER_TESTERS_EXEMPT_ENV = "MYSTICPARADOX_UNOFFICIAL_LAUNCHER_TESTERS_EXEMPT";

export const UNOFFICIAL_LAUNCHER_MESSAGE = "This launcher isn't an official Mystic Paradox build. Install the official launcher " +
    "(github.com/pranav158/Mystic-Paradox/releases) to play on Mystic Paradox.";

export type UnofficialLauncherMode = "observe" | "refuse";

export interface UnofficialLauncherPolicy {
    mode: UnofficialLauncherMode;
    /** Lower-case SHA-256 hashes that count as official too (local test builds). */
    allowedHashes: ReadonlySet<string>;
    /** Accounts with the admin role are exempt (default). The variable keeps its old name. */
    testersExempt: boolean;
    /** What was wrong with the variables, if anything (an unknown mode, malformed hashes). */
    warnings: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Pure: the policy from the environment. */
export function ReadUnofficialLauncherPolicy(environment: NodeJS.ProcessEnv = process.env): UnofficialLauncherPolicy {
    const Warnings: string[] = [];
    const RawMode = (environment[UNOFFICIAL_LAUNCHER_ENV] ?? "").trim().toLowerCase();
    let Mode: UnofficialLauncherMode = "observe";
    if (RawMode === "refuse") Mode = "refuse";
    else if (RawMode !== "" && RawMode !== "observe") {
        Warnings.push(`${UNOFFICIAL_LAUNCHER_ENV} must be observe or refuse (got ${JSON.stringify(RawMode.slice(0, 32))}); observe applies`);
    }
    const Allowed = new Set<string>();
    let Malformed = 0;
    for (const Entry of (environment[LAUNCHER_ALLOWED_HASHES_ENV] ?? "").split(/[\s,]+/)) {
        const Hash = Entry.trim().toLowerCase();
        if (Hash === "") continue;
        if (SHA256.test(Hash)) Allowed.add(Hash);
        else Malformed++;
    }
    if (Malformed > 0) Warnings.push(`${LAUNCHER_ALLOWED_HASHES_ENV}: ${Malformed} entr${Malformed === 1 ? "y is" : "ies are"} not a SHA-256 and ignored`);
    const TestersExempt = !/^(0|false|off|no)$/i.test((environment[UNOFFICIAL_LAUNCHER_TESTERS_EXEMPT_ENV] ?? "").trim());
    return { mode: Mode, allowedHashes: Allowed, testersExempt: TestersExempt, warnings: Warnings };
}

/** Pure: whether this Play is refused under `policy`. Only an "unofficial" verdict can be. */
export function UnofficialLauncherRefuses(verdict: LauncherBuildVerdict, report: LauncherBuildReport | undefined,
    roles: readonly string[], policy: UnofficialLauncherPolicy): boolean {
    if (policy.mode !== "refuse" || verdict !== "unofficial") return false;
    if (report !== undefined && policy.allowedHashes.has(report.sha256.toLowerCase())) return false;
    if (policy.testersExempt && roles.includes("admin")) return false;
    return true;
}

let LoggedPolicy = "";

/** The policy for this process's environment; logs it (and any warning) whenever it changes. */
export function CurrentUnofficialLauncherPolicy(): UnofficialLauncherPolicy {
    const Policy = ReadUnofficialLauncherPolicy();
    const Summary = `${Policy.mode} allowedHashes=${Policy.allowedHashes.size} testersExempt=${Policy.testersExempt}`;
    if (Summary !== LoggedPolicy) {
        LoggedPolicy = Summary;
        logger.info(`[UnofficialLauncher] policy ${Summary}`);
        for (const Warning of Policy.warnings) logger.warn(`[UnofficialLauncher] ${Warning}`);
    }
    return Policy;
}
