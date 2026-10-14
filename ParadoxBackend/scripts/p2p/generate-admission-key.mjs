// Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
// Licensed under the GNU Affero General Public License v3.0.
//
// SPDX-License-Identifier: AGPL-3.0-only
// Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
//
// [2026-10-15] Generates the co-op admission key set (P-256): the backend's signing key and env lines, and the public key
// file p2p-admission-public.xy that the runtime feed serves as an extra file. Moved here from the private Steam bridge folder
// so a self-hosted backend can switch co-op on.
//
//   node scripts/p2p/generate-admission-key.mjs --output <new-directory> --key-id <safe-id>

import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputArg = argument("output");
const keyId = argument("key-id");
if (!outputArg || !keyId || !/^[A-Za-z0-9._-]{1,32}$/.test(keyId)) {
  throw new Error("Usage: node scripts/p2p/generate-admission-key.mjs --output <new-directory> --key-id <safe-id>");
}

const output = resolve(outputArg);
const parent = dirname(output);
if (!existsSync(parent)) throw new Error(`The output parent does not exist: ${parent}`);
if (existsSync(output)) throw new Error(`Refusing to overwrite an existing key directory: ${output}`);

const temporary = resolve(parent, `.admission-key-${process.pid}-${Date.now()}`);
mkdirSync(temporary);
try {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Generated public key did not contain P-256 coordinates.");
  const rawPublic = Buffer.concat([
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  if (rawPublic.length !== 64) throw new Error("Generated public key coordinates were not 64 bytes.");

  writeFileSync(resolve(temporary, "admission-private.pkcs8.pem"), privatePem, { mode: 0o600 });
  writeFileSync(resolve(temporary, "admission-public.spki.pem"), publicPem);
  writeFileSync(resolve(temporary, "p2p-admission-public.xy"), rawPublic);
  const environment = [
    `P2P_ADMISSION_KEY_ID=${keyId}`,
    `P2P_ADMISSION_SIGNING_PRIVKEY_B64=${Buffer.from(privatePem).toString("base64")}`,
    `P2P_ADMISSION_VERIFY_PUBKEY_B64=${Buffer.from(publicPem).toString("base64")}`,
    "",
  ].join("\n");
  writeFileSync(resolve(temporary, "metagame-admission.env"), environment, { mode: 0o600 });
  renameSync(temporary, output);
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}

console.log(`Generated a new P-256 admission key set in: ${output}`);
console.log("Keep the private PEM and metagame-admission.env only on the backend host (add its three lines to the backend .env).");
console.log("Publish p2p-admission-public.xy with the runtime as an extra file (RUNTIME_EXTRA_FILES, Guard role ADMISSION_KEY).");
