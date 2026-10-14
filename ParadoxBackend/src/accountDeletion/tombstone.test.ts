import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { BuildDeletionTombstone, EmailSha256 } from "./tombstone";

// [2026-10-14] The one record kept after an erasure (Privacy Policy section 5): a pseudonym and times, plus for a banned account the reason
// and a hash of the email. Nothing else.

const REQUESTED = "2026-09-01T10:00:00.000Z";
const DELETED = "2026-10-01T10:00:00.000Z";

test("EmailSha256 hashes the lowercased, trimmed address", () => {
    assert.equal(EmailSha256("  Slayer@Example.COM "), crypto.createHash("sha256").update("slayer@example.com").digest("hex"));
});

test("an active account's tombstone keeps only the pseudonym, the two times and wasBanned", () => {
    const Tombstone = BuildDeletionTombstone({
        account: { status: "active", email: "slayer@example.com", approvalReason: "Closed test" },
        pseudonymousId: "pseudonym-1", requestedAt: REQUESTED, deletedAt: DELETED
    });
    assert.deepEqual(Tombstone, { pseudonymousId: "pseudonym-1", requestedAt: REQUESTED, deletedAt: DELETED, wasBanned: false });
});

test("a banned account's tombstone also keeps the ban reason and the hash of its email", () => {
    const Tombstone = BuildDeletionTombstone({
        account: { status: "banned", email: "Cheater@Example.com", approvalReason: "Hunt cheating" },
        pseudonymousId: "pseudonym-2", requestedAt: REQUESTED, deletedAt: DELETED
    });
    assert.deepEqual(Tombstone, {
        pseudonymousId: "pseudonym-2", requestedAt: REQUESTED, deletedAt: DELETED, wasBanned: true,
        banReason: "Hunt cheating", emailSha256: EmailSha256("cheater@example.com")
    });
});

test("a banned account without an email keeps no email hash, and an empty reason is not kept", () => {
    const Tombstone = BuildDeletionTombstone({
        account: { status: "banned", approvalReason: "   " },
        pseudonymousId: "pseudonym-3", requestedAt: REQUESTED, deletedAt: DELETED
    });
    assert.deepEqual(Tombstone, { pseudonymousId: "pseudonym-3", requestedAt: REQUESTED, deletedAt: DELETED, wasBanned: true });
});
