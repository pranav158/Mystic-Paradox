import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IssueAdmissionTicket } from "../../build/p2p/security/admissionTickets.js";

const bridge = process.argv[2];
if (!bridge || !fs.statSync(bridge, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Pass the built MysticSteamBridge.exe path as the first argument.");
}

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
process.env.P2P_ADMISSION_SIGNING_PRIVKEY_B64 = Buffer.from(
    pair.privateKey.export({ type: "pkcs8", format: "pem" })
).toString("base64");
process.env.P2P_ADMISSION_VERIFY_PUBKEY_B64 = Buffer.from(
    pair.publicKey.export({ type: "spki", format: "pem" })
).toString("base64");
process.env.P2P_ADMISSION_KEY_ID = "interop-key-1";

const jwk = pair.publicKey.export({ format: "jwk" });
const rawPublic = Buffer.concat([Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
if (rawPublic.length !== 64) throw new Error("Unexpected P-256 public key length.");

const issued = IssueAdmissionTicket({
    accountId: "interop-account",
    joinerSteamId: "76561198000000001",
    hostSteamId: "76561198000000002",
    sessionId: "01234567-89ab-4def-8123-456789abcdef",
    generation: 3,
    partyId: "party_interop==",
    partyRevision: 4,
    huntDefinitionId: "hunt/interop-island",
    build: 392819,
    bridgeProtocol: 1,
    virtualPort: 1
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mystic-ticket-interop-"));
const publicPath = path.join(temporary, "public.xy");
const ticketPath = path.join(temporary, "ticket.txt");
try {
    fs.writeFileSync(publicPath, rawPublic, { mode: 0o600 });
    fs.writeFileSync(ticketPath, issued.token, { mode: 0o600 });
    const result = spawnSync(bridge, ["ticket-selftest", publicPath, ticketPath], {
        encoding: "utf8",
        windowsHide: true
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status !== 0) throw new Error(`Bridge ticket interop failed with exit ${result.status}.`);
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
