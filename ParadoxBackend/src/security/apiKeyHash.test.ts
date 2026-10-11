import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.API_KEY_HASH_SECRET = "test-only-api-key-hash-secret-0123456789abcdef";

import { AssertApiKeyHashSecret, FindApiKeyRecord, HashApiKey } from "./apiKeyHash";

test("HMAC hash matches the public format: scope, NUL, key", () => {
    const expected = crypto.createHmac("sha256", process.env.API_KEY_HASH_SECRET!)
        .update("gameserver\0example-key", "utf8").digest("hex");
    assert.equal(HashApiKey("example-key", "gameserver"), expected);
});

test("scopes are domain-separated and a pre-HMAC SHA-256 record no longer matches", () => {
    const Gameserver = HashApiKey("example-key", "gameserver");
    assert.notEqual(Gameserver, HashApiKey("example-key", "user"));
    const PreHmacRecord = { keyHash: crypto.createHash("sha256").update("example-key", "utf8").digest("hex") };
    assert.equal(FindApiKeyRecord([PreHmacRecord], Gameserver), undefined);
});

test("a short or missing secret is refused", () => {
    const Saved = process.env.API_KEY_HASH_SECRET;
    try {
        process.env.API_KEY_HASH_SECRET = "too-short";
        assert.throws(() => AssertApiKeyHashSecret(), /API_KEY_HASH_SECRET/);
        delete process.env.API_KEY_HASH_SECRET;
        assert.throws(() => HashApiKey("k", "user"), /API_KEY_HASH_SECRET/);
    } finally {
        process.env.API_KEY_HASH_SECRET = Saved;
    }
});

test("FindApiKeyRecord matches exactly one stored hash and skips empty records", () => {
    const Records = [
        { keyHash: null, id: "empty" },
        { keyHash: HashApiKey("old-key", "user"), id: "user-scope" },
        { keyHash: HashApiKey("new-key", "gameserver"), id: "hmac" },
    ];
    assert.equal(FindApiKeyRecord(Records, HashApiKey("new-key", "gameserver"))?.id, "hmac");
    assert.equal(FindApiKeyRecord(Records, HashApiKey("old-key", "user"))?.id, "user-scope");
    assert.equal(FindApiKeyRecord(Records, HashApiKey("old-key", "gameserver")), undefined);
});
