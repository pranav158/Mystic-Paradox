/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Mints 10-minute Cloudflare TURN credentials with the key in ParadoxBackend/.env (P2P_CLOUDFLARE_TURN_KEY_ID,
// P2P_CLOUDFLARE_TURN_API_TOKEN) and writes them for `ParadoxTransportTest ice --relay-file <file>`. It also reports
// whether Cloudflare accepts the customIdentifier tag on generate-ice-servers, which the backend's relay quota needs.
// Prints no secret. Usage: node tools/mint-relay-test-file.cjs <output file>
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(ROOT, "ParadoxBackend", ".env");
const API = "https://rtc.live.cloudflare.com/v1/turn/keys";

function ReadEnv(file, keys) {
    const values = {};
    if (!fs.existsSync(file)) return values;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        if (!keys.includes(key)) continue;
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}

async function Generate(keyId, token, body) {
    const response = await fetch(`${API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
    });
    let json;
    try { json = await response.json(); } catch { json = undefined; }
    return { status: response.status, json };
}

async function Main() {
    const output = process.argv[2];
    if (!output) {
        console.error("usage: node tools/mint-relay-test-file.cjs <output file>");
        process.exit(2);
    }
    const env = ReadEnv(ENV_FILE, ["P2P_CLOUDFLARE_TURN_KEY_ID", "P2P_CLOUDFLARE_TURN_API_TOKEN"]);
    const keyId = env.P2P_CLOUDFLARE_TURN_KEY_ID;
    const token = env.P2P_CLOUDFLARE_TURN_API_TOKEN;
    if (!keyId || !token) {
        console.error("P2P_CLOUDFLARE_TURN_KEY_ID and P2P_CLOUDFLARE_TURN_API_TOKEN are not set in ParadoxBackend/.env " +
            "(Cloudflare dashboard -> Realtime -> TURN).");
        process.exit(2);
    }
    let result = await Generate(keyId, token, { ttl: 600, customIdentifier: "paradox-selftest" });
    let tagged = true;
    if (result.status === 400) {
        tagged = false;
        result = await Generate(keyId, token, { ttl: 600 });
    }
    if (result.status < 200 || result.status >= 300) {
        console.error(`Cloudflare answered HTTP ${result.status}; check the key id and token.`);
        process.exit(3);
    }
    const raw = result.json?.iceServers;
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const urls = entries.flatMap((entry) => (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]))
        .filter((url) => typeof url === "string" && !/:53(\?|$)/.test(url));
    const turn = entries.find((entry) => typeof entry?.username === "string" && typeof entry?.credential === "string");
    const stunUrls = urls.filter((url) => url.startsWith("stun:"));
    const turnUrls = urls.filter((url) => /^turn:[^?]+(\?transport=udp)?$/.test(url));
    if (!turn || turnUrls.length === 0) {
        console.error("Cloudflare's answer carried no UDP relay with credentials.");
        process.exit(3);
    }
    const text = [
        `ice_stun_urls=${stunUrls.join(",")}`,
        `ice_turn_urls=${turnUrls.join(",")}`,
        `turn_username=${turn.username}`,
        `turn_credential=${turn.credential}`,
        ""
    ].join("\n");
    fs.writeFileSync(output, text, { mode: 0o600 });
    console.log(`Wrote relay test file (10-minute credentials, ${turnUrls.length} UDP relay URLs). ` +
        `customIdentifier on generate-ice-servers: ${tagged ? "accepted" : "REFUSED (per-account quota cannot be measured)"}.`);
}

Main().catch((error) => {
    console.error(`Relay credential request failed: ${error?.name ?? "error"}`);
    process.exit(3);
});
