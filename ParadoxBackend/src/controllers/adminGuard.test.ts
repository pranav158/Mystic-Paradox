/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { LauncherGuardSessionRecord, LauncherGuardSignals, UsePersistenceForTest } from "../persistence";
import { OpenTestRealm } from "../persistence/sqlite/testSupport";
import { GetGuardSession, ListGuardFindings, ListGuardSessions } from "./adminGuard";

// [2026-10-14] The admin Guard endpoints, called through their handlers on a SQLite realm. The challenge and public key must never
// appear in a response.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

const Signals: LauncherGuardSignals = {
    gameProcessId: 4242, gameStartedAt: "2026-10-13T11:59:00.000Z", moduleCount: 188, moduleSetDigest: "d".repeat(64), privateExecutableBytes: 0,
    writableExecutableBytes: 0, unexpectedModuleCount: 1, protectedPageMismatchCount: 0, debuggerPresent: false,
    unexpectedModules: [{ fileName: "Overlay.dll", signer: "unsigned", sha256: "f".repeat(64), size: 9 }]
};

function Guard(id: string, overrides: Partial<LauncherGuardSessionRecord> = {}): LauncherGuardSessionRecord {
    return {
        guardSessionId: id, accountId: "acc-1", role: "client", publicKeyBase64: "PUBLIC-KEY-MATERIAL", manifestId: "m1", manifestSequence: 61,
        channel: "stable", launcherVersion: "0.1.60", challenge: "SECRET-CHALLENGE", lastSequence: 0, status: "CHALLENGED", riskScore: 0,
        createdAt: "2026-10-13T11:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z", ...overrides
    };
}

function At(seconds: number): string {
    return new Date(Date.parse("2026-10-13T12:00:00.000Z") + seconds * 1000).toISOString();
}

interface Recorded { statusCode: number; body: any }

async function Call(handler: (req: any, res: any) => Promise<void>, req: { query?: Record<string, unknown>; params?: Record<string, string> }): Promise<Recorded> {
    const Result: Recorded = { statusCode: 200, body: undefined };
    const res = {
        status(code: number) { Result.statusCode = code; return this; },
        json(body: unknown) { Result.body = body; return this; }
    };
    await handler({ query: req.query ?? {}, params: req.params ?? {} }, res);
    return Result;
}

function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    UsePersistenceForTest({ repos: Opened.repos, uow: Opened.uow });
    return Opened;
}

test("list: refuses a status outside the five, a minRisk outside 0-100 or not a whole number, with 400 GUARD_QUERY_INVALID", async () => {
    Realm("admin-guard-validation");
    for (const query of [{ status: "BANNED" }, { minRisk: "101" }, { minRisk: "-1" }, { minRisk: "2.5" }, { minRisk: "many" }]) {
        const Response = await Call(ListGuardSessions, { query });
        assert.equal(Response.statusCode, 400, JSON.stringify(query));
        assert.equal(Response.body.error.code, "GUARD_QUERY_INVALID", JSON.stringify(query));
    }
});

test("list: newest first, paged, with the reasons and without the challenge, the public key or the history", async () => {
    const { repos } = Realm("admin-guard-list");
    await repos.launcherGuard.create(Guard("old", { createdAt: "2026-10-13T11:00:00.000Z" }));
    await repos.launcherGuard.create(Guard("new", { createdAt: "2026-10-13T11:30:00.000Z", challenge: "ch-0", role: "host" }));
    assert.ok(await repos.launcherGuard.advance({
        guardSessionId: "new", accountId: "acc-1", expectedChallenge: "ch-0", sequence: 1, nextChallenge: "SECRET-NEXT", status: "DEGRADED",
        riskScore: 55, heartbeatAt: At(1), expiresAt: "2026-10-13T14:00:00.000Z", signals: Signals,
        reasons: ["UNEXPECTED_MODULES:1"], historyEntry: { at: At(1), status: "DEGRADED", riskScore: 55, reasons: ["UNEXPECTED_MODULES:1"] }
    }));

    const First = await Call(ListGuardSessions, { query: { page: "1", limit: "1" } });
    assert.equal(First.statusCode, 200);
    assert.equal(First.body.total, 2);
    assert.equal(First.body.page, 1);
    assert.equal(First.body.limit, 1);
    const Row = First.body.sessions[0];
    assert.equal(Row.guardSessionId, "new");
    assert.equal(Row.status, "DEGRADED");
    assert.equal(Row.riskScore, 55);
    assert.deepEqual(Row.reasons, ["UNEXPECTED_MODULES:1"]);
    assert.equal(Row.role, "host");
    assert.deepEqual(Row.lastSignals.unexpectedModules, Signals.unexpectedModules);
    assert.equal("history" in Row, false);
    assert.equal("challenge" in Row, false);
    assert.equal("publicKeyBase64" in Row, false);

    const Second = await Call(ListGuardSessions, { query: { page: "2", limit: "1" } });
    assert.deepEqual(Second.body.sessions.map((session: any) => session.guardSessionId), ["old"]);
    assert.deepEqual(Second.body.sessions[0].reasons, [], "no heartbeat yet: no reasons");

    const Risky = await Call(ListGuardSessions, { query: { minRisk: "50", status: "DEGRADED" } });
    assert.deepEqual(Risky.body.sessions.map((session: any) => session.guardSessionId), ["new"]);
    assert.equal(Risky.body.total, 1);
    assert.equal(JSON.stringify(First.body).includes("SECRET-CHALLENGE"), false);
    assert.equal(JSON.stringify(First.body).includes("PUBLIC-KEY-MATERIAL"), false);
});

test("detail: 404 for an unknown session; the session and its heartbeats, newest first, without the secrets", async () => {
    const { repos } = Realm("admin-guard-detail");
    // Each heartbeat answers with the next challenge of this chain (the secrets the responses must not show).
    const Chain = ["ch-0", "SECRET-1", "SECRET-2", "SECRET-3"];
    await repos.launcherGuard.create(Guard("g1", { challenge: Chain[0] }));
    for (let Sequence = 1; Sequence <= 3; Sequence += 1) {
        assert.ok(await repos.launcherGuard.advance({
            guardSessionId: "g1", accountId: "acc-1", expectedChallenge: Chain[Sequence - 1]!, sequence: Sequence, nextChallenge: Chain[Sequence]!,
            status: "HEALTHY", riskScore: Sequence * 10, heartbeatAt: At(Sequence), expiresAt: "2026-10-13T14:00:00.000Z", signals: Signals,
            reasons: [`PAGE_MISMATCH:${Sequence}`], historyEntry: { at: At(Sequence), status: "HEALTHY", riskScore: Sequence * 10, reasons: [`PAGE_MISMATCH:${Sequence}`] }
        }));
    }

    const Missing = await Call(GetGuardSession, { params: { guardSessionId: "nope" } });
    assert.equal(Missing.statusCode, 404);
    assert.equal(Missing.body.error.code, "GUARD_SESSION_NOT_FOUND");

    const Found = await Call(GetGuardSession, { params: { guardSessionId: "g1" } });
    assert.equal(Found.statusCode, 200);
    assert.equal(Found.body.session.guardSessionId, "g1");
    assert.equal(Found.body.session.riskScore, 30);
    assert.deepEqual(Found.body.history.map((entry: any) => entry.riskScore), [30, 20, 10], "newest first");
    assert.deepEqual(Found.body.history[0].reasons, ["PAGE_MISMATCH:3"]);
    assert.equal("challenge" in Found.body.session, false);
    assert.equal(JSON.stringify(Found.body).includes("SECRET-"), false, "the chain's challenges stay in the store");
    assert.equal(JSON.stringify(Found.body).includes("PUBLIC-KEY-MATERIAL"), false);
});

test("findings: most seen first, the signer is a case-insensitive substring, the account list stays out", async () => {
    const { repos } = Realm("admin-guard-findings");
    const Sighting = (fileName: string, sha256: string, signer: string, accountId: string, newInSession = true) => ({
        fileName, sha256, signer, size: 3, accountId, seenAt: At(4), newInSession
    });
    await repos.launcherGuard.recordFindingSighting(Sighting("rare.dll", "1".repeat(64), "NVIDIA Corporation", "acc-1"));
    await repos.launcherGuard.recordFindingSighting(Sighting("common.dll", "2".repeat(64), "Discord Inc.", "acc-1"));
    await repos.launcherGuard.recordFindingSighting(Sighting("common.dll", "2".repeat(64), "Discord Inc.", "acc-2"));
    await repos.launcherGuard.recordFindingSighting(Sighting("common.dll", "2".repeat(64), "Discord Inc.", "acc-3"));

    const All = await Call(ListGuardFindings, { query: {} });
    assert.equal(All.statusCode, 200);
    assert.deepEqual(All.body.findings.map((finding: any) => finding.fileName), ["common.dll", "rare.dll"]);
    assert.equal(All.body.findings[0].sessionCount, 3);
    assert.equal(All.body.findings[0].accountCount, 3);
    assert.equal("accountIds" in All.body.findings[0], false);

    const Filtered = await Call(ListGuardFindings, { query: { signer: "nvidia" } });
    assert.deepEqual(Filtered.body.findings.map((finding: any) => finding.fileName), ["rare.dll"]);
    assert.equal(Filtered.body.total, 1);
});
