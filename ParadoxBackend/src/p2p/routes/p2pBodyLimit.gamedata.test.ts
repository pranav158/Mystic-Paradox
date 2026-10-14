import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

function request(server: http.Server, body: string | Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const address = server.address();
    if (address == undefined || typeof address === "string") throw new Error("test server did not bind");
    const payload = typeof body === "string" ? Buffer.from(body) : body;
    return new Promise((resolve, reject) => {
        const call = http.request({ hostname: "127.0.0.1", port: address.port,
            path: "/mystic/v1/hunts/11111111-1111-4111-8111-111111111111/event-batches",
            method: "POST", headers: { "content-type": "application/json", "content-length": payload.length, ...headers } }, response => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", chunk => { text += chunk; });
            response.on("end", () => {
                try { resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) }); }
                catch (error) { reject(error); }
            });
        });
        call.on("error", reject);
        call.end(payload);
    });
}

test("P2P body parser returns bounded launcher errors before authentication", async () => {
    // The route graph imports the legacy JWT module, which intentionally requires key material
    // at module load. These are test-only placeholders; the parser rejects before auth/DB access.
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from("parser-test-private-key").toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from("parser-test-public-key").toString("base64");
    const { app } = await import("../../app");
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
        const oversized = await request(server, JSON.stringify({ payload: "x".repeat(80 * 1024) }));
        assert.equal(oversized.status, 413);
        assert.equal(oversized.json.error.code, "GUARD_BATCH_TOO_LARGE");

        const compressedOversized = await request(server,
            gzipSync(JSON.stringify({ payload: "x".repeat(80 * 1024) })),
            { "content-encoding": "gzip" });
        assert.equal(compressedOversized.status, 413);
        assert.equal(compressedOversized.json.error.code, "GUARD_BATCH_TOO_LARGE");

        const malformed = await request(server, "{not-json");
        assert.equal(malformed.status, 400);
        assert.equal(malformed.json.error.code, "GUARD_BATCH_INVALID");
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
