import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] ?? ".secrets/mystic-runtime-update");
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.private.pem`, privateKey, { mode: 0o600 });
writeFileSync(`${output}.public.pem`, publicKey);
const rawPublicKey = createPublicKey(publicKey).export({ type: "spki", format: "der" }).subarray(-32);
writeFileSync(`${output}.public.raw.b64`, rawPublicKey.toString("base64"));
console.log(`Runtime signing key written to ${output}.private.pem`);
console.log(`Public key written to ${output}.public.pem`);
console.log(`Raw public key written to ${output}.public.raw.b64`);
