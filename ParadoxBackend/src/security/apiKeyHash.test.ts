import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.API_KEY_HASH_SECRET = "test-only-api-key-hash-secret-0123456789abcdef";

import {
    AcceptsLegacyApiKeyHashes,
    AssertApiKeyHashSecret,
    FindApiKeyRecord,
    HashApiKey,
    LegacySha256ApiKeyHash
} from "./apiKeyHash";

test("HMAC hash matches the public format: scope, NUL, key", () => {
    const expected = crypto.createHmac("sha256", process.env.API_KEY_HASH_SECRET!)
        .update("gameserver\0example-key", "utf8").digest("hex");
    assert.equal(HashApiKey("example-key", "gameserver"), expected);
});

test("scopes are domain-separated and differ from the legacy SHA-256", () => {
    const Gameserver = HashApiKey("example-key", "gameserver");
    assert.notEqual(Gameserver, HashApiKey("example-key", "user"));
    assert.notEqual(Gameserver, LegacySha256ApiKeyHash("example-key"));
    assert.equal(LegacySha256ApiKeyHash("example-key"),
        crypto.createHash("sha256").update("example-key", "utf8").digest("hex"));
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
        { keyHash: LegacySha256ApiKeyHash("old-key"), id: "legacy" },
        { keyHash: HashApiKey("new-key", "gameserver"), id: "hmac" },
    ];
    assert.equal(FindApiKeyRecord(Records, HashApiKey("new-key", "gameserver"))?.id, "hmac");
    assert.equal(FindApiKeyRecord(Records, LegacySha256ApiKeyHash("old-key"))?.id, "legacy");
    assert.equal(FindApiKeyRecord(Records, HashApiKey("old-key", "gameserver")), undefined);
});

test("legacy hashes are accepted unless API_KEY_LEGACY_SHA256=reject", () => {
    const Saved = process.env.API_KEY_LEGACY_SHA256;
    try {
        delete process.env.API_KEY_LEGACY_SHA256;
        assert.equal(AcceptsLegacyApiKeyHashes(), true);
        process.env.API_KEY_LEGACY_SHA256 = "reject";
        assert.equal(AcceptsLegacyApiKeyHashes(), false);
    } finally {
        if (Saved === undefined) delete process.env.API_KEY_LEGACY_SHA256; else process.env.API_KEY_LEGACY_SHA256 = Saved;
    }
});
