/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
// Signs a launcher installer for the Tauri updater without the Tauri CLI or any npm package, so the release workflow can
// sign in a job that never installs dependencies (the signing key is never in the same job as third-party build code).
// Output: the installer's .sig exactly as `tauri build` writes it - base64 of a minisign signature with a prehashed
// Ed25519 signature ("ED", BLAKE2b-512 of the file) and the trusted comment "timestamp:<unix>\tfile:<name>".
//
// Key: TAURI_SIGNING_PRIVATE_KEY (the key file's contents, as `tauri signer generate` writes it) and
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or --key-file / --password-file for a local run. Values are never printed.
// The signature is checked against the updater public key in src-tauri/tauri.conf.json before it is written.
//
// usage: node scripts/sign-launcher-update.mjs --file <installer.exe> [--out <installer.exe.sig>] [--timestamp <unix>]
//        [--key-file <path>] [--password-file <path>] [--tauri-conf <path>]
import { createHash, createPrivateKey, createPublicKey, scryptSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEYNUM_SK_BYTES = 8 + 64 + 32;

const blake2b512 = (bytes) => createHash("blake2b512").update(bytes).digest();

/** The last non-empty line of a minisign key or signature text, base64-decoded. */
function minisignPayload(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return Buffer.from(lines.at(-1) ?? "", "base64");
}

/** A Tauri key value is the key file's text, base64-encoded once more; accept the plain text too. */
function keyText(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("untrusted comment:")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment:")) throw new Error("the signing key is not a minisign secret key");
  return decoded;
}

/** libsodium's crypto_pwhash_scryptsalsa208sha256 parameter choice (pickparams), as minisign uses it. */
export function scryptParams(opslimit, memlimit) {
  let ops = opslimit < 32768n ? 32768n : opslimit;
  const r = 8n;
  let nLog2 = 1n;
  let p;
  if (ops < memlimit / 32n) {
    p = 1n;
    const maxN = ops / (r * 4n);
    for (nLog2 = 1n; nLog2 < 63n; nLog2++) if (1n << nLog2 > maxN / 2n) break;
  } else {
    const maxN = memlimit / (r * 128n);
    for (nLog2 = 1n; nLog2 < 63n; nLog2++) if (1n << nLog2 > maxN / 2n) break;
    let maxrp = ops / 4n / (1n << nLog2);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  return { N: Number(1n << nLog2), r: Number(r), p: Number(p) };
}

/** Decrypts a minisign secret key; returns { keyId, seed, publicKey }. */
export function openSecretKey(keyValue, password) {
  const raw = minisignPayload(keyText(keyValue));
  if (raw.length !== 6 + 32 + 8 + 8 + KEYNUM_SK_BYTES) throw new Error("the signing key has the wrong length");
  const sigAlg = raw.subarray(0, 2);
  const kdfAlg = raw.subarray(2, 4).toString("latin1");
  const chkAlg = raw.subarray(4, 6).toString("latin1");
  if (sigAlg.toString("latin1") !== "Ed" || chkAlg !== "B2") throw new Error("the signing key is not an Ed25519 minisign key");
  const salt = raw.subarray(6, 38);
  const opslimit = raw.readBigUInt64LE(38);
  const memlimit = raw.readBigUInt64LE(46);
  const keynum = Buffer.from(raw.subarray(54));
  if (kdfAlg === "Sc") {
    const { N, r, p } = scryptParams(opslimit, memlimit);
    const stream = scryptSync(Buffer.from(password ?? "", "utf8"), salt, KEYNUM_SK_BYTES, { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 });
    for (let i = 0; i < KEYNUM_SK_BYTES; i++) keynum[i] ^= stream[i];
  } else if (kdfAlg !== "\0\0") {
    throw new Error("the signing key uses an unknown key derivation");
  }
  const keyId = keynum.subarray(0, 8);
  const secret = keynum.subarray(8, 72);
  // The key's own checksum is BLAKE2b-256, which Node's crypto lacks. A wrong password garbles the seed and the stored public
  // half alike, so the public key derived from the seed must equal the stored one (and, in main, the updater key).
  const seed = Buffer.from(secret.subarray(0, 32));
  const publicKey = Buffer.from(secret.subarray(32, 64));
  const derived = createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
  if (!derived.equals(publicKey)) throw new Error("wrong signing key password (or a damaged key)");
  return { keyId: Buffer.from(keyId), seed, publicKey };
}

function privateKeyObject(seed) {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** The updater public key from tauri.conf.json: { keyId, key }. */
export function updaterPublicKey(tauriConfPath) {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  const raw = minisignPayload(Buffer.from(conf?.plugins?.updater?.pubkey ?? "", "base64").toString("utf8"));
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("tauri.conf.json has no minisign updater key");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** Builds the .sig text (base64, as Tauri writes it) for `file` named `fileName`. */
export function signUpdate(file, fileName, secretKey, timestamp) {
  if (/[\r\n\t]/.test(fileName)) throw new Error("the file name may not hold tabs or line breaks");
  const key = privateKeyObject(secretKey.seed);
  const signature = sign(null, blake2b512(file), key);
  const comment = `timestamp:${timestamp}\tfile:${fileName}`;
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), key);
  const text = [
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([Buffer.from("ED", "latin1"), secretKey.keyId, signature]).toString("base64"),
    `trusted comment: ${comment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
  return Buffer.from(text, "utf8").toString("base64");
}

/** Verifies a .sig (as signUpdate writes it) over `file` with { keyId, key }; returns the trusted comment. */
export function verifyUpdate(file, sigBase64, publicKey) {
  const lines = Buffer.from(sigBase64.trim(), "base64").toString("utf8").split(/\r?\n/);
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) throw new Error("not a minisign signature");
  const sig = Buffer.from(lines[1], "base64");
  if (sig.length !== 74 || sig.subarray(0, 2).toString("latin1") !== "ED") throw new Error("not a prehashed Ed25519 signature");
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) throw new Error("signed by another key than the updater key");
  const spki = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]), format: "der", type: "spki" });
  if (!verify(null, blake2b512(file), spki, sig.subarray(10))) throw new Error("the signature does not match the file");
  const comment = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment, "utf8")]), spki, Buffer.from(lines[3], "base64"))) {
    throw new Error("the signed comment does not verify");
  }
  return comment;
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

function main() {
  const filePath = option("file");
  if (!filePath) throw new Error("usage: node scripts/sign-launcher-update.mjs --file <installer.exe> [--out <file.sig>]");
  const outPath = option("out") ?? `${filePath}.sig`;
  const timestamp = option("timestamp") ?? String(Math.floor(Date.now() / 1000));
  if (!/^[0-9]{1,12}$/.test(timestamp)) throw new Error("--timestamp must be a unix time in seconds");
  const here = dirname(fileURLToPath(import.meta.url));
  const tauriConf = option("tauri-conf") ?? resolve(here, "..", "src-tauri", "tauri.conf.json");
  const keyFile = option("key-file");
  const passwordFile = option("password-file");
  const keyValue = keyFile ? readFileSync(keyFile, "utf8") : process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!keyValue) throw new Error("no signing key: set TAURI_SIGNING_PRIVATE_KEY or pass --key-file");
  const password = passwordFile ? readFileSync(passwordFile, "utf8").trim() : (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "").trim();

  const publicKey = updaterPublicKey(tauriConf);
  const secretKey = openSecretKey(keyValue, password);
  if (!secretKey.keyId.equals(publicKey.keyId) || !secretKey.publicKey.equals(publicKey.key)) {
    throw new Error("the signing key is not the updater key in tauri.conf.json");
  }
  const file = readFileSync(filePath);
  const sig = signUpdate(file, basename(filePath), secretKey, timestamp);
  const comment = verifyUpdate(file, sig, publicKey);
  writeFileSync(outPath, sig);
  const keyIdText = Buffer.from(publicKey.keyId).reverse().toString("hex").toUpperCase();
  console.log(`signed ${basename(filePath)} (${file.length} bytes) with updater key ${keyIdText}; ${comment.replace("\t", ", ")}`);
  console.log(`wrote ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`sign-launcher-update: ${error.message}`);
    process.exit(1);
  }
}
