// Tests for sign-launcher-update.mjs with a throwaway key: run with `node --test scripts/sign-launcher-update.test.mjs`.
// The release workflow runs them before it signs anything.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSecretKey, scryptParams, signUpdate, updaterPublicKey, verifyUpdate } from "./sign-launcher-update.mjs";

/** A minisign secret key file (as `tauri signer generate` writes it, base64 once more) with small scrypt limits. */
function throwawayKey(password) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12);
  const keyId = randomBytes(8);
  const salt = randomBytes(32);
  const opslimit = 32768n;
  const memlimit = 16777216n;
  // The checksum (BLAKE2b-256) is left zero: the reader checks the public half instead.
  const keynum = Buffer.concat([keyId, seed, publicKey, Buffer.alloc(32)]);
  const { N, r, p } = scryptParams(opslimit, memlimit);
  const stream = scryptSync(Buffer.from(password, "utf8"), salt, keynum.length, { N, r, p, maxmem: 256 * N * r + 16 * 1024 * 1024 });
  for (let i = 0; i < keynum.length; i++) keynum[i] ^= stream[i];
  const limits = Buffer.alloc(16);
  limits.writeBigUInt64LE(opslimit, 0);
  limits.writeBigUInt64LE(memlimit, 8);
  const raw = Buffer.concat([Buffer.from("EdScB2", "latin1"), salt, limits, keynum]);
  const text = `untrusted comment: rsign encrypted secret key\n${raw.toString("base64")}\n`;
  const pub = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, publicKey]);
  const pubText = `untrusted comment: minisign public key: ${Buffer.from(keyId).reverse().toString("hex").toUpperCase()}\n${pub.toString("base64")}\n`;
  return { keyValue: Buffer.from(text).toString("base64"), pubkey: Buffer.from(pubText).toString("base64") };
}

function confWith(pubkey) {
  const dir = mkdtempSync(join(tmpdir(), "sign-launcher-update-"));
  const path = join(dir, "tauri.conf.json");
  writeFileSync(path, JSON.stringify({ plugins: { updater: { pubkey } } }));
  return { dir, path };
}

test("scrypt parameters match libsodium's choice for minisign's limits", () => {
  assert.deepEqual(scryptParams(1048576n, 33554432n), { N: 32768, r: 8, p: 1 });
  assert.deepEqual(scryptParams(33554432n, 1073741824n), { N: 1048576, r: 8, p: 1 });
  assert.deepEqual(scryptParams(32768n, 16777216n), { N: 1024, r: 8, p: 1 });
});

test("signs a file so that the updater key verifies it, with Tauri's comment layout", () => {
  const key = throwawayKey("correct horse");
  const conf = confWith(key.pubkey);
  try {
    const secret = openSecretKey(key.keyValue, "correct horse");
    const file = randomBytes(4096);
    const sig = signUpdate(file, "MysticParadoxLauncher_9.9.9_x64-setup.exe", secret, "1792000000");
    const comment = verifyUpdate(file, sig, updaterPublicKey(conf.path));
    assert.equal(comment, "timestamp:1792000000\tfile:MysticParadoxLauncher_9.9.9_x64-setup.exe");
    const lines = Buffer.from(sig, "base64").toString("utf8").split("\n");
    assert.equal(lines[0], "untrusted comment: signature from tauri secret key");
    assert.equal(lines.at(-1), "", "the text ends with a line break, as Tauri's does");
    assert.ok(!sig.endsWith("\n"), "the .sig itself has no line break");
    const changed = Buffer.from(file);
    changed[0] ^= 1;
    assert.throws(() => verifyUpdate(changed, sig, updaterPublicKey(conf.path)), /does not match the file/);
  } finally {
    rmSync(conf.dir, { recursive: true, force: true });
  }
});

test("refuses a wrong password, another key and a name with a tab", () => {
  const key = throwawayKey("right");
  assert.throws(() => openSecretKey(key.keyValue, "wrong"), /wrong signing key password/);
  const other = throwawayKey("other");
  const conf = confWith(other.pubkey);
  try {
    const secret = openSecretKey(key.keyValue, "right");
    const sig = signUpdate(Buffer.from("x"), "a.exe", secret, "1");
    assert.throws(() => verifyUpdate(Buffer.from("x"), sig, updaterPublicKey(conf.path)), /another key/);
    assert.throws(() => signUpdate(Buffer.from("x"), "a\tb.exe", secret, "1"), /tabs or line breaks/);
  } finally {
    rmSync(conf.dir, { recursive: true, force: true });
  }
});

test("accepts the key as plain key text too", () => {
  const key = throwawayKey("pw");
  const plain = Buffer.from(key.keyValue, "base64").toString("utf8");
  assert.equal(openSecretKey(plain, "pw").keyId.length, 8);
});
