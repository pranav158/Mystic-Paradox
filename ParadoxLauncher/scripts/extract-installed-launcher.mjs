/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
// Extracts the launcher.exe an NSIS installer installs, with 7-Zip. Tauri writes a small bundle-type marker into the copy it
// packs, so the installed launcher.exe differs from target\release\launcher.exe: Guard pins, and the release publishes, the
// installed file's hash. Used by build-launcher-release.ps1, the release workflow (.github/workflows/release-launcher.yml) and
// the operator's stage tool.
//
// usage: node scripts/extract-installed-launcher.mjs --installer <setup.exe> --output <launcher.exe> [--seven-zip <7z.exe>] [--replace]
// Prints {status, installer, output, member, bytes, sha256, sevenZip} as JSON.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function executableCandidates(explicit) {
  return [
    explicit,
    process.env.SEVEN_ZIP_EXE,
    process.platform === "win32" ? "C:\\Program Files\\7-Zip\\7z.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\7-Zip\\7z.exe" : undefined,
    "7z",
    "7zz",
  ].filter((value, index, values) => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);
}

/** The bytes of `member` (default launcher.exe) inside the NSIS installer at `installerPath`. */
export function extractNsisLauncherPayload(installerPath, options = {}) {
  const installer = path.resolve(installerPath);
  const member = options.member ?? "launcher.exe";
  if (!fs.statSync(installer, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`NSIS installer is missing: ${installer}`);
  }

  const failures = [];
  for (const executable of executableCandidates(options.sevenZip)) {
    const result = spawnSync(executable, ["e", "-so", installer, member], {
      encoding: null,
      maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0 && Buffer.isBuffer(result.stdout) && result.stdout.length > 0) {
      return { bytes: result.stdout, sevenZip: executable, member };
    }
    failures.push(`${executable}: ${result.error?.message ?? result.stderr?.toString("utf8").trim() ?? `exit ${result.status}`}`);
  }
  throw new Error(`unable to extract ${member} from the NSIS installer; install 7-Zip or set SEVEN_ZIP_EXE${failures.length ? ` (${failures.join("; ")})` : ""}`);
}

function main() {
  const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const installer = argument("installer");
  const output = argument("output");
  if (!installer || !output) {
    throw new Error("usage: node scripts/extract-installed-launcher.mjs --installer <setup.exe> --output <launcher.exe> [--seven-zip <7z.exe>] [--replace]");
  }
  const extracted = extractNsisLauncherPayload(installer, { sevenZip: argument("seven-zip") });
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, extracted.bytes, { flag: process.argv.includes("--replace") ? "w" : "wx" });
  console.log(JSON.stringify({
    status: "PASS",
    installer: path.resolve(installer),
    output: outputPath,
    member: extracted.member,
    bytes: extracted.bytes.length,
    sha256: createHash("sha256").update(extracted.bytes).digest("hex"),
    sevenZip: extracted.sevenZip,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`extract-installed-launcher: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
