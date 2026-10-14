/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
    GUARD_FINDING_ACCOUNT_LIMIT,
    GUARD_HISTORY_LIMIT,
    LauncherGuardSessionRecord,
    LauncherGuardSignals
} from "../contracts/LauncherGuardRepository";
import { LauncherAccountRecord } from "../contracts/LauncherAccountRepository";
import { GUARD_FINDING_RETENTION_DAYS, GUARD_SESSION_RETENTION_DAYS, RetentionDateAfter } from "../../legal/retentionPolicy";
import { SqliteDatabase } from "./database";
import { OpenTestRealm, TestConfig } from "./testSupport";
import { Tables } from "./tables";

// [2026-10-14] Launcher Guard storage on the SQLite provider (the MongoDB provider has the same contract; it is not run here: no
// database). Covers the heartbeat history, the admin listings, the bounded module findings, the account-deletion cascade, the TTL purge
// and the schema backfill for an existing database.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const Signals: LauncherGuardSignals = {
    gameProcessId: 4242, gameStartedAt: "2026-10-13T11:59:00.000Z", moduleCount: 188, moduleSetDigest: "d", privateExecutableBytes: 0,
    writableExecutableBytes: 0, unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
};

function Guard(id: string, overrides: Partial<LauncherGuardSessionRecord> = {}): LauncherGuardSessionRecord {
    return {
        guardSessionId: id, accountId: "acc-1", role: "client", publicKeyBase64: "PUBKEY-DO-NOT-LEAK", manifestId: "m1", manifestSequence: 61,
        channel: "stable", launcherVersion: "0.1.60", challenge: "CHALLENGE-DO-NOT-LEAK", lastSequence: 0, status: "CHALLENGED", riskScore: 0,
        createdAt: "2026-10-13T11:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z", ...overrides
    };
}

function At(seconds: number): string {
    return new Date(Date.parse("2026-10-13T12:00:00.000Z") + seconds * 1000).toISOString();
}

function Heartbeat(id: string, sequence: number, reasons: string[], riskScore: number, status: "HEALTHY" | "DEGRADED" = "HEALTHY") {
    const heartbeatAt = At(sequence);
    return {
        guardSessionId: id, accountId: "acc-1", expectedChallenge: `ch-${sequence - 1}`, sequence, nextChallenge: `ch-${sequence}`,
        status, riskScore, heartbeatAt, expiresAt: "2026-10-13T14:00:00.000Z", signals: Signals, reasons,
        historyEntry: { at: heartbeatAt, status, riskScore, reasons }
    };
}

test("history: the session keeps the last 20 heartbeats, newest first, and the latest reasons and expiry", async () => {
    const { repos } = Realm("guard-history");
    await repos.launcherGuard.create(Guard("g1", { challenge: "ch-0" }));
    for (let Sequence = 1; Sequence <= GUARD_HISTORY_LIMIT + 2; Sequence += 1) {
        const Reasons = [`UNEXPECTED_MODULES:${Sequence}`];
        assert.ok(await repos.launcherGuard.advance(Heartbeat("g1", Sequence, Reasons, Sequence)), `heartbeat ${Sequence}`);
    }
    const Found = (await repos.launcherGuard.find("g1"))!;
    assert.equal(Found.history?.length, GUARD_HISTORY_LIMIT);
    assert.equal(Found.history?.[0]?.riskScore, GUARD_HISTORY_LIMIT + 2, "newest first");
    assert.equal(Found.history?.[GUARD_HISTORY_LIMIT - 1]?.riskScore, 3, "the two oldest are gone");
    assert.deepEqual(Found.history?.[0]?.reasons, [`UNEXPECTED_MODULES:${GUARD_HISTORY_LIMIT + 2}`]);
    assert.deepEqual(Found.reasons, [`UNEXPECTED_MODULES:${GUARD_HISTORY_LIMIT + 2}`], "the latest reasons are on the session");
    assert.equal(Found.lastHeartbeatAt, At(GUARD_HISTORY_LIMIT + 2));
    // The storage-only expiry is 90 days after the last heartbeat (the purge reads it; MongoDB's TTL index reads the same value).
    const Ttl = (Found as unknown as { ttlAt: string }).ttlAt;
    assert.equal(Ttl, RetentionDateAfter(At(GUARD_HISTORY_LIMIT + 2), GUARD_SESSION_RETENTION_DAYS).toISOString());
});

test("history: a heartbeat the chain refuses leaves the history alone", async () => {
    const { repos } = Realm("guard-history-refused");
    await repos.launcherGuard.create(Guard("g1", { challenge: "ch-0" }));
    assert.ok(await repos.launcherGuard.advance(Heartbeat("g1", 1, ["DEBUGGER"], 50)));
    assert.equal(await repos.launcherGuard.advance({ ...Heartbeat("g1", 1, ["X"], 0), expectedChallenge: "ch-0" }), undefined, "a replay");
    assert.deepEqual((await repos.launcherGuard.find("g1"))?.history?.map((entry) => entry.reasons), [["DEBUGGER"]]);
});

test("listSessions: newest first by creation, filtered by status and minimum risk, paged, without the history", async () => {
    const { repos } = Realm("guard-list");
    await repos.launcherGuard.create(Guard("old", { createdAt: "2026-10-13T11:00:00.000Z", status: "HEALTHY", riskScore: 0 }));
    await repos.launcherGuard.create(Guard("new", { createdAt: "2026-10-13T11:30:00.000Z", status: "DEGRADED", riskScore: 60, role: "host" }));
    await repos.launcherGuard.create(Guard("mid", { createdAt: "2026-10-13T11:10:00.000Z", status: "HEALTHY", riskScore: 50, challenge: "ch-0" }));
    assert.ok(await repos.launcherGuard.advance(Heartbeat("mid", 1, ["MODULE_SET_CHANGED"], 50)));

    const All = await repos.launcherGuard.listSessions({}, 0, 2);
    assert.equal(All.total, 3);
    assert.deepEqual(All.records.map((record) => record.guardSessionId), ["new", "mid"]);
    assert.deepEqual((await repos.launcherGuard.listSessions({}, 2, 2)).records.map((record) => record.guardSessionId), ["old"]);
    assert.equal(All.records.every((record) => record.history === undefined), true, "the list leaves the history out");

    const Healthy = await repos.launcherGuard.listSessions({ status: "HEALTHY" }, 0, 10);
    assert.deepEqual(Healthy.records.map((record) => record.guardSessionId), ["mid", "old"]);
    const Risky = await repos.launcherGuard.listSessions({ minRisk: 50 }, 0, 10);
    assert.equal(Risky.total, 2);
    assert.deepEqual(Risky.records.map((record) => record.guardSessionId), ["new", "mid"]);
    const None = await repos.launcherGuard.listSessions({ status: "REVOKED" }, 0, 10);
    assert.deepEqual(None, { records: [], total: 0 });
});

test("findings: one row per file name and hash; sessionCount counts the sightings new to a session; accounts are exact", async () => {
    const { repos } = Realm("guard-findings");
    const Hash = "a".repeat(64);
    const Other = "b".repeat(64);
    const Sighting = (accountId: string, newInSession: boolean, fileName = "evil.dll", sha256 = Hash) => ({
        fileName, sha256, signer: "unsigned", size: 1024, accountId, seenAt: At(5), newInSession
    });
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-1", true));
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-2", false));
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-1", true));
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-3", true, "evil.dll", Other));
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-4", true, "helper.dll", Other));
    await repos.launcherGuard.recordFindingSighting(Sighting("acc-5", true, "helper.dll", Other));

    const Listing = await repos.launcherGuard.listFindings({}, 0, 10);
    assert.equal(Listing.total, 3, "evil.dll under two hashes and helper.dll: three findings");
    assert.deepEqual(Listing.records.map((finding) => `${finding.fileName}/${finding.sha256.slice(0, 1)}`),
        ["helper.dll/b", "evil.dll/a", "evil.dll/b"], "most seen first");
    const Evil = Listing.records.find((finding) => finding.fileName === "evil.dll" && finding.sha256 === Hash)!;
    assert.equal(Evil.sessionCount, 2, "acc-1 twice in new sessions counts twice; acc-2 (not new) does not count");
    assert.equal(Evil.accountCount, 2, "acc-1 and acc-2, once each");
    assert.equal(Evil.firstSeenAt, At(5));
    assert.equal(Evil.signer, "unsigned");
    assert.equal(Listing.records.some((finding) => "accountIds" in finding || "_id" in finding || "ttlAt" in finding), false,
        "the account list and storage fields stay out of the listing");
});

test("findings: the account list stops at GUARD_FINDING_ACCOUNT_LIMIT, and accountCount with it", async () => {
    const { repos, db } = Realm("guard-findings-cap");
    for (let Index = 0; Index < GUARD_FINDING_ACCOUNT_LIMIT + 3; Index += 1) {
        await repos.launcherGuard.recordFindingSighting({
            fileName: "cap.dll", sha256: "c".repeat(64), signer: "Acme", size: 1, accountId: `acc-${Index}`, seenAt: At(1), newInSession: false
        });
    }
    const Row = await db.read(undefined, (c) => Tables.guardFindings.findOne(c, "json_extract(doc, '$.fileName') = ?", ["cap.dll"]));
    assert.equal((Row as { accountIds: string[] }).accountIds.length, GUARD_FINDING_ACCOUNT_LIMIT);
    assert.equal((Row as { accountCount: number }).accountCount, GUARD_FINDING_ACCOUNT_LIMIT);
    assert.equal((await repos.launcherGuard.listFindings({}, 0, 1)).records[0]?.sessionCount, 0);
});

test("findings: the signer filter is a case-insensitive substring, and its wildcards are literal", async () => {
    const { repos } = Realm("guard-findings-signer");
    const Sighting = (fileName: string, signer: string) => ({
        fileName, sha256: fileName.padEnd(64, "0"), signer, size: 1, accountId: "acc-1", seenAt: At(1), newInSession: true
    });
    await repos.launcherGuard.recordFindingSighting(Sighting("ms.dll", "Microsoft Windows"));
    await repos.launcherGuard.recordFindingSighting(Sighting("nv.dll", "NVIDIA Corporation"));
    await repos.launcherGuard.recordFindingSighting(Sighting("pct.dll", "100% Legit_Soft"));
    await repos.launcherGuard.recordFindingSighting(Sighting("odd.dll", "100x Legit Soft"));

    assert.deepEqual((await repos.launcherGuard.listFindings({ signer: "microsoft" }, 0, 10)).records.map((finding) => finding.fileName), ["ms.dll"]);
    assert.equal((await repos.launcherGuard.listFindings({ signer: "100%" }, 0, 10)).total, 1, "the % is literal");
    assert.equal((await repos.launcherGuard.listFindings({ signer: "Legit_" }, 0, 10)).total, 1, "the _ is literal");
    assert.equal((await repos.launcherGuard.listFindings({ signer: "nothing-like-this" }, 0, 10)).total, 0);
});

test("deleting an account removes its Guard sessions and its place in every finding", async () => {
    const { repos } = Realm("guard-deletion");
    const Account: LauncherAccountRecord = {
        userId: "victim", email: "victim@example.test", displayNameNormalized: "victim", displayName: "Victim", passwordHash: "x",
        status: "active", approvalStatus: "approved", roles: ["player"], createdAt: "2026-10-01T00:00:00.000Z", usernameSet: true
    };
    await repos.launcherAccounts.create(Account);
    await repos.launcherGuard.create(Guard("victim-guard", { accountId: "victim" }));
    await repos.launcherGuard.create(Guard("bystander-guard", { accountId: "bystander" }));
    const Sighting = (accountId: string) => ({
        fileName: "shared.dll", sha256: "d".repeat(64), signer: "unsigned", size: 2, accountId, seenAt: At(2), newInSession: true
    });
    await repos.launcherGuard.recordFindingSighting(Sighting("victim"));
    await repos.launcherGuard.recordFindingSighting(Sighting("bystander"));

    await repos.admin.deletePlayerData("victim", {
        id: "tombstone-guard", actorUserId: "admin", targetUserId: "victim", action: "PLAYER_DELETE", ip: "127.0.0.1", requestId: "r",
        createdAt: "2026-10-13T12:00:00.000Z"
    });
    assert.equal(await repos.launcherGuard.find("victim-guard"), undefined, "the account's session is gone");
    assert.ok(await repos.launcherGuard.find("bystander-guard"), "another account's session stays");
    const [Finding] = (await repos.launcherGuard.listFindings({}, 0, 10)).records;
    assert.equal(Finding?.accountCount, 1, "the finding stays, with the bystander only");
    assert.equal(Finding?.sessionCount, 2);
});

test("purge: Guard sessions and findings past their 90 days are removed by purgeExpired", async () => {
    const { repos, db } = Realm("guard-purge");
    await repos.launcherGuard.create(Guard("stale", { createdAt: "2026-01-01T00:00:00.000Z" }));
    await repos.launcherGuard.create(Guard("fresh", { createdAt: "2026-10-13T11:00:00.000Z" }));
    await repos.launcherGuard.recordFindingSighting({
        fileName: "old.dll", sha256: "e".repeat(64), signer: "unsigned", size: 1, accountId: "acc-1", seenAt: "2026-01-01T00:00:00.000Z", newInSession: true
    });
    const Removed = await db.purgeExpired("2026-10-01T00:00:00.000Z");
    assert.equal(Removed.launcherGuardSessions, 1);
    assert.equal(Removed.guardFindings, 1);
    assert.equal(await repos.launcherGuard.find("stale"), undefined);
    assert.ok(await repos.launcherGuard.find("fresh"));
    assert.ok(GUARD_FINDING_RETENTION_DAYS > 0);
});

test("schema: a database that already has its version gets the guardFindings table created when it is opened again", async () => {
    const { db, databasePath } = Realm("guard-schema");
    await db.write(undefined, (c) => { c.exec("DROP TABLE guardFindings"); });
    // Opening runs ApplySchema: the version is current, so only the missing table is created (no version change).
    const Reopened = SqliteDatabase.open(TestConfig(databasePath));
    try {
        const Count = await Reopened.read(undefined, (c) => Tables.guardFindings.count(c));
        assert.equal(Count, 0, "the table is back and empty");
    } finally {
        await Reopened.close();
    }
});
