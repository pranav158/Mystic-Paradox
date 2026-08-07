import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 4096,
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

process.stdout.write(JSON.stringify({
  privateKeyB64: Buffer.from(privateKey, "utf8").toString("base64"),
  publicKeyB64: Buffer.from(publicKey, "utf8").toString("base64"),
}));