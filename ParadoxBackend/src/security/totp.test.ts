import assert from "node:assert/strict";
import test from "node:test";
import { VerifyTotp } from "./totp";

test("verifies RFC 6238 SHA-1 value with six-digit truncation and adjacent window", () => {
    const Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.equal(VerifyTotp(Secret, "287082", 59_000), true);
    assert.equal(VerifyTotp(Secret, "287083", 59_000), false);
    assert.equal(VerifyTotp(Secret, "287082", 89_000), true);
});
