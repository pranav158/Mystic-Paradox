/*
 * Small local backup envelope used only by the opt-in recovery rehearsal.
 *
 * Format: ASCII MGC1 magic, 12-byte AES-GCM nonce, 16-byte authentication tag,
 * then ciphertext. The caller owns key generation and custody; this helper never
 * writes a key to disk or prints it. Production key storage must use an approved
 * secret/KMS mechanism rather than a process argument or local rehearsal key.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(name) {
    const value = argument(name);
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
    return value;
}

function keyFromHex(value) {
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("--key-hex must contain exactly 32 bytes");
    return Buffer.from(value, "hex");
}

function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

const mode = process.argv[2];
try {
    const input = requireArgument("--input");
    const output = requireArgument("--output");
    const key = keyFromHex(requireArgument("--key-hex"));
    const source = fs.readFileSync(input);
    if (mode === "encrypt") {
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
        const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
        const tag = cipher.getAuthTag();
        fs.writeFileSync(output, Buffer.concat([Buffer.from("MGC1", "ascii"), nonce, tag, ciphertext]));
        console.log(JSON.stringify({ mode, plaintextBytes: source.length, ciphertextBytes: ciphertext.length, plaintextSha256: sha256(source), keyFingerprint: sha256(key).slice(0, 16) }));
    } else if (mode === "decrypt") {
        const envelope = fs.readFileSync(input);
        if (envelope.length < 4 + 12 + 16 || envelope.subarray(0, 4).toString("ascii") !== "MGC1") {
            throw new Error("backup envelope magic/header is invalid");
        }
        const nonce = envelope.subarray(4, 16);
        const tag = envelope.subarray(16, 32);
        const ciphertext = envelope.subarray(32);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        fs.writeFileSync(output, plaintext);
        console.log(JSON.stringify({ mode, plaintextBytes: plaintext.length, plaintextSha256: sha256(plaintext), keyFingerprint: sha256(key).slice(0, 16) }));
    } else {
        throw new Error("mode must be encrypt or decrypt");
    }
} catch (error) {
    console.error(`backup envelope ${mode || "unknown"} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
