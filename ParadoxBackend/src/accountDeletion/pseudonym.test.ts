import assert from "node:assert/strict";
import test from "node:test";
import { HashApiKey, PseudonymousAccountId } from "../security/apiKeyHash";

// [2026-10-14] The pseudonym that replaces an erased account id (security/apiKeyHash.ts): keyed with the server secret, stable, per
// account, and never containing the id.

const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
const OTHER = "4f6a2d1e-0000-4000-8000-000000000002";

function WithSecret<T>(secret: string | undefined, action: () => T): T {
    const Saved = process.env.API_KEY_HASH_SECRET;
    if (secret === undefined) delete process.env.API_KEY_HASH_SECRET; else process.env.API_KEY_HASH_SECRET = secret;
    try {
        return action();
    } finally {
        if (Saved === undefined) delete process.env.API_KEY_HASH_SECRET; else process.env.API_KEY_HASH_SECRET = Saved;
    }
}

test("the pseudonym is a stable keyed digest per account that does not contain the account id", () => {
    WithSecret("s".repeat(40), () => {
        const Pseudonym = PseudonymousAccountId(ACCOUNT);
        assert.match(Pseudonym, /^[0-9a-f]{64}$/);
        assert.equal(PseudonymousAccountId(ACCOUNT), Pseudonym);
        assert.notEqual(PseudonymousAccountId(OTHER), Pseudonym);
        assert.equal(Pseudonym.includes(ACCOUNT), false);
        assert.notEqual(Pseudonym, HashApiKey(ACCOUNT, "user"), "domain-separated from the API key hashes");
    });
});

test("the pseudonym depends on the server secret, so a copy of the database alone cannot recompute it", () => {
    const First = WithSecret("s".repeat(40), () => PseudonymousAccountId(ACCOUNT));
    const Second = WithSecret("t".repeat(40), () => PseudonymousAccountId(ACCOUNT));
    assert.notEqual(First, Second);
});

test("the pseudonym refuses a missing or short secret", () => {
    WithSecret(undefined, () => assert.throws(() => PseudonymousAccountId(ACCOUNT), /32 characters/));
    WithSecret("short", () => assert.throws(() => PseudonymousAccountId(ACCOUNT), /32 characters/));
});
