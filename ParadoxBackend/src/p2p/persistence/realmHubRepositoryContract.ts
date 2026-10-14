import assert from "node:assert/strict";
import test from "node:test";
import { RealmHubPresenceRecord, RealmHubRepository } from "./contracts/RealmHubRepository";

// [2026-10-13 realms S1] The behaviour every RealmHubRepository must have, written once and run against the in-memory double
// (realmHubRepository.test.ts, always) and against MongoDB (mongo/realmHubMongo.integration.test.ts, opt-in on an isolated
// database). The racing cases matter most for MongoDB: two requests for the same entry must not both create the row, and a
// late report of an old connection must not end a newer one.

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
export const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export interface RealmHubRepositoryHarness {
    repo: RealmHubRepository;
    /** Empties the collection before each case. */
    reset(): Promise<void>;
}

const HUB = "hub-session-1";
const REALM = "realm-1";

function Entry(accountId: string, overrides: Partial<Parameters<RealmHubRepository["requestEntry"]>[0]> = {}) {
    return {
        sessionId: HUB, generation: 1, realmId: REALM, accountId, peerId: `peer-${accountId}`, candidateId: `cand-${accountId}-1`,
        now: at(0), expiresAt: at(90_000), ...overrides
    };
}

/** A capacity-checked batch of entries for the hub (requestEntries). */
function Batch(accountIds: string[], maxPeers: number, overrides: Partial<Parameters<RealmHubRepository["requestEntries"]>[0]> = {}) {
    return {
        sessionId: HUB, generation: 1, realmId: REALM, maxPeers, now: at(0), expiresAt: at(90_000),
        entries: accountIds.map((accountId) => ({ accountId, peerId: `peer-${accountId}`, candidateId: `cand-${accountId}-1` })),
        ...overrides
    };
}

export function RunRealmHubRepositoryContract(label: string, harness: () => Promise<RealmHubRepositoryHarness>, options: { skip?: string | false } = {}): void {
    const Case = (name: string, body: (repo: RealmHubRepository) => Promise<void>) =>
        test(`${label}: ${name}`, { skip: options.skip ?? false }, async () => {
            const { repo, reset } = await harness();
            await reset();
            await body(repo);
        });
    const ids = (rows: RealmHubPresenceRecord[]) => rows.map((row) => row.accountId);

    Case("a first entry is PENDING with entryEpoch 1 and round-trips exactly", async (repo) => {
        const { record, outcome } = await repo.requestEntry(Entry("a"));
        assert.equal(outcome, "CREATED");
        assert.deepEqual(record, {
            sessionId: HUB, generation: 1, realmId: REALM, accountId: "a", peerId: "peer-a", state: "PENDING", candidateId: "cand-a-1",
            entryEpoch: 1, requestedAt: at(0), expiresAt: at(90_000)
        });
        assert.deepEqual(await repo.findPresence(HUB, "a"), record);
        assert.equal(await repo.findPresence(HUB, "nobody"), undefined);
        assert.equal(await repo.findPresence("other-session", "a"), undefined);
    });

    Case("a repeated request of a waiting entry reuses it and only extends its expiry", async (repo) => {
        await repo.requestEntry(Entry("a"));
        const again = await repo.requestEntry(Entry("a", { candidateId: "cand-a-2", now: at(10_000), expiresAt: at(100_000) }));
        assert.equal(again.outcome, "REUSED");
        assert.equal(again.record.candidateId, "cand-a-1", "the candidate of the attempt does not churn");
        assert.equal(again.record.entryEpoch, 1);
        assert.equal(again.record.expiresAt, at(100_000));
        const shorter = await repo.requestEntry(Entry("a", { candidateId: "cand-a-3", now: at(20_000), expiresAt: at(50_000) }));
        assert.equal(shorter.record.expiresAt, at(100_000), "an expiry is never shortened");
        await repo.markTicketed({ sessionId: HUB, generation: 1, accountId: "a", now: at(21_000), ticketExpiresAt: at(200_000) });
        const ticketed = await repo.requestEntry(Entry("a", { candidateId: "cand-a-4", now: at(22_000), expiresAt: at(120_000) }));
        assert.equal(ticketed.outcome, "REUSED");
        assert.equal(ticketed.record.state, "TICKETED", "a ticket in flight stays valid");
    });

    Case("a request after the wait ran out, or from any non-waiting state, starts a new entry", async (repo) => {
        await repo.requestEntry(Entry("a"));
        const expired = await repo.requestEntry(Entry("a", { candidateId: "cand-a-2", now: at(95_000), expiresAt: at(185_000) }));
        assert.equal(expired.outcome, "REENTERED");
        assert.equal(expired.record.entryEpoch, 2);
        assert.equal(expired.record.candidateId, "cand-a-2");
        assert.equal(expired.record.state, "PENDING");
        assert.equal(expired.record.requestedAt, at(95_000));

        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "a", admissionId: "adm-1", admittedAt: at(96_000), now: at(96_000), route: "relay" });
        await repo.markRouteReady({ sessionId: HUB, generation: 1, accountId: "a", localBridgePort: 55001, readyAt: at(97_000), now: at(97_000) });
        const reentry = await repo.requestEntry(Entry("a", { candidateId: "cand-a-3", now: at(100_000), expiresAt: at(190_000) }));
        assert.equal(reentry.outcome, "REENTERED");
        assert.equal(reentry.record.entryEpoch, 3);
        assert.equal(reentry.record.state, "PENDING");
        for (const field of ["admissionId", "admittedAt", "route", "localBridgePort", "localBridgeReadyAt", "ticketedAt", "lostAt", "leftAt", "purgeAt"]) {
            assert.equal(field in reentry.record, false, `${field} is cleared by a new entry`);
        }

        for (const lost of ["lost", "left", "removed", "expired"]) {
            const id = `acc-${lost}`;
            await repo.requestEntry(Entry(id));
            await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: id, admissionId: `adm-${lost}`, admittedAt: at(1_000), now: at(1_000) });
            if (lost === "lost") await repo.markLost({ sessionId: HUB, generation: 1, accountId: id, lostAt: at(2_000), purgeAt: at(86_400_000) });
            if (lost === "left") await repo.markLeft({ sessionId: HUB, generation: 1, accountId: id, reason: "TRAVEL", leftAt: at(2_000), purgeAt: at(86_400_000) });
            if (lost === "removed") await repo.removeAccountFromRealm({ realmId: REALM, accountId: id, at: at(2_000), purgeAt: at(86_400_000) });
            if (lost === "expired") {
                await repo.markLost({ sessionId: HUB, generation: 1, accountId: id, lostAt: at(2_000), purgeAt: at(86_400_000) });
            }
            const next = await repo.requestEntry(Entry(id, { candidateId: `c-${lost}`, now: at(3_000), expiresAt: at(93_000) }));
            assert.equal(next.outcome, "REENTERED", lost);
            assert.equal(next.record.state, "PENDING", lost);
            assert.equal(next.record.entryEpoch, 2, lost);
            assert.equal(next.record.purgeAt, undefined, `${lost}: a live row is not purged`);
        }
    });

    Case("racing requests for one entry create exactly one row", async (repo) => {
        const results = await Promise.all([1, 2, 3, 4, 5].map((n) => repo.requestEntry(Entry("race", { candidateId: `cand-${n}` }))));
        assert.equal(results.filter((result) => result.outcome === "CREATED").length, 1);
        assert.equal(new Set(results.map((result) => result.record.candidateId)).size, 1, "every caller sees the same candidate");
        assert.equal(await repo.countByState(HUB, 1, ["PENDING"]), 1);
    });

    Case("the host's row is created ADMITTED with its port, and replaced by a later call", async (repo) => {
        const host = await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        assert.equal(host.state, "ADMITTED");
        assert.equal(host.localBridgePort, 55000);
        assert.equal(host.entryEpoch, 1);
        assert.deepEqual(ids(await repo.listByState(HUB, 1, ["ADMITTED"], 10)), ["host"]);
        const again = await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55010, now: at(5_000) });
        assert.equal(again.localBridgePort, 55010);
        assert.equal(again.entryEpoch, 2);
        assert.equal((await repo.findPresence(HUB, "host"))!.localBridgePort, 55010);
        assert.equal(await repo.countByState(HUB, 1, ["ADMITTED"]), 1);
    });

    Case("a ticket is issued for a waiting, unexpired entry only, and keeps the row alive as long as the ticket lives", async (repo) => {
        await repo.requestEntry(Entry("a"));
        const base = { sessionId: HUB, generation: 1, accountId: "a" };
        assert.equal(await repo.markTicketed({ ...base, generation: 2, now: at(1_000), ticketExpiresAt: at(181_000) }), undefined);
        assert.equal(await repo.markTicketed({ ...base, accountId: "nobody", now: at(1_000), ticketExpiresAt: at(181_000) }), undefined);
        const ticketed = await repo.markTicketed({ ...base, now: at(80_000), ticketExpiresAt: at(260_000) });
        assert.equal(ticketed!.state, "TICKETED");
        assert.equal(ticketed!.ticketedAt, at(80_000));
        assert.equal(ticketed!.expiresAt, at(260_000), "the row outlives the entry's own 90 s so the ticket can still be consumed");
        const second = await repo.markTicketed({ ...base, now: at(81_000), ticketExpiresAt: at(100_000) });
        assert.equal(second!.state, "TICKETED");
        assert.equal(second!.expiresAt, at(260_000), "an expiry is never shortened");
        // Expired, then not ticketable.
        await repo.requestEntry(Entry("b"));
        assert.equal(await repo.markTicketed({ sessionId: HUB, generation: 1, accountId: "b", now: at(90_000), ticketExpiresAt: at(270_000) }), undefined);
        // An admitted member needs a fresh entry first.
        await repo.markAdmitted({ ...base, admissionId: "adm", admittedAt: at(82_000), now: at(82_000) });
        assert.equal(await repo.markTicketed({ ...base, now: at(83_000), ticketExpiresAt: at(263_000) }), undefined);
    });

    Case("admission: from PENDING or TICKETED (not expired) or again from ADMITTED; never from a lost link or an expired wait", async (repo) => {
        const base = { sessionId: HUB, generation: 1 };
        await repo.requestEntry(Entry("a"));
        await repo.requestEntry(Entry("b"));
        await repo.requestEntry(Entry("c"));
        await repo.markTicketed({ ...base, accountId: "b", now: at(1_000), ticketExpiresAt: at(181_000) });
        const a = await repo.markAdmitted({ ...base, accountId: "a", admissionId: "adm-a", admittedAt: at(2_000), now: at(2_000), route: "direct" });
        assert.equal(a!.state, "ADMITTED");
        assert.equal(a!.admissionId, "adm-a");
        assert.equal(a!.route, "direct");
        assert.equal(a!.admittedAt, at(2_000));
        const b = await repo.markAdmitted({ ...base, accountId: "b", admissionId: "adm-b", admittedAt: at(2_000), now: at(2_000) });
        assert.equal(b!.state, "ADMITTED");
        const again = await repo.markAdmitted({ ...base, accountId: "a", admissionId: "adm-a", admittedAt: at(3_000), now: at(3_000) });
        assert.equal(again!.state, "ADMITTED", "re-consuming the same ticket is idempotent");
        assert.equal(again!.admissionId, "adm-a");
        assert.equal(await repo.markAdmitted({ ...base, accountId: "c", admissionId: "adm-c", admittedAt: at(95_000), now: at(95_000) }), undefined, "the wait ran out");
        assert.equal(await repo.markAdmitted({ ...base, generation: 2, accountId: "a", admissionId: "x", admittedAt: at(4_000), now: at(4_000) }), undefined);
        assert.equal(await repo.markAdmitted({ ...base, accountId: "nobody", admissionId: "x", admittedAt: at(4_000), now: at(4_000) }), undefined);
        await repo.markLost({ ...base, accountId: "a", lostAt: at(5_000), purgeAt: at(86_400_000) });
        assert.equal(await repo.markAdmitted({ ...base, accountId: "a", admissionId: "adm-a2", admittedAt: at(6_000), now: at(6_000) }), undefined, "a lost link needs a fresh entry");
    });

    Case("a member's loopback port is recorded for a waiting or connected row only", async (repo) => {
        const base = { sessionId: HUB, generation: 1 };
        await repo.requestEntry(Entry("a"));
        const waiting = await repo.markRouteReady({ ...base, accountId: "a", localBridgePort: 56001, readyAt: at(1_000), now: at(1_000) });
        assert.equal(waiting!.localBridgePort, 56001);
        assert.equal(waiting!.localBridgeReadyAt, at(1_000));
        assert.equal(waiting!.state, "PENDING", "the route does not admit");
        await repo.markAdmitted({ ...base, accountId: "a", admissionId: "adm", admittedAt: at(2_000), now: at(2_000) });
        const connected = await repo.markRouteReady({ ...base, accountId: "a", localBridgePort: 56002, readyAt: at(3_000), now: at(3_000) });
        assert.equal(connected!.localBridgePort, 56002);
        assert.equal(await repo.markRouteReady({ ...base, accountId: "a", localBridgePort: 1, readyAt: at(1), now: at(1), generation: 2 }), undefined);
        await repo.requestEntry(Entry("late"));
        assert.equal(await repo.markRouteReady({ ...base, accountId: "late", localBridgePort: 56003, readyAt: at(95_000), now: at(95_000) }), undefined, "expired wait");
        await repo.markLost({ ...base, accountId: "a", lostAt: at(4_000), purgeAt: at(86_400_000) });
        assert.equal(await repo.markRouteReady({ ...base, accountId: "a", localBridgePort: 56004, readyAt: at(5_000), now: at(5_000) }), undefined);
    });

    Case("a lost link ends the current connection only, and its row is dated for purging", async (repo) => {
        const base = { sessionId: HUB, generation: 1, accountId: "a" };
        await repo.requestEntry(Entry("a"));
        assert.equal(await repo.markLost({ ...base, lostAt: at(1_000), purgeAt: at(604_800_000) }), undefined, "only an admitted member can be lost");
        await repo.markAdmitted({ ...base, admissionId: "adm-new", admittedAt: at(2_000), now: at(2_000) });
        assert.equal(await repo.markLost({ ...base, admissionId: "adm-old", lostAt: at(3_000), purgeAt: at(604_800_000) }), undefined,
            "a late report of an older connection does not end the newer one");
        assert.equal((await repo.findPresence(HUB, "a"))!.state, "ADMITTED");
        const lost = await repo.markLost({ ...base, admissionId: "adm-new", lostAt: at(4_000), purgeAt: at(604_800_000) });
        assert.equal(lost!.state, "LOST");
        assert.equal(lost!.lostAt, at(4_000));
        assert.equal(lost!.purgeAt, at(604_800_000), "the purge date reads back as the ISO string it was written as");
        assert.equal(await repo.markLost({ ...base, lostAt: at(5_000), purgeAt: at(604_800_000) }), undefined, "already lost");
    });

    Case("travelling into a hunt leaves the hub (LEFT with its reason)", async (repo) => {
        const base = { sessionId: HUB, generation: 1, accountId: "a" };
        await repo.requestEntry(Entry("a"));
        assert.equal(await repo.markLeft({ ...base, reason: "TRAVEL", leftAt: at(1_000), purgeAt: at(604_800_000) }), undefined);
        await repo.markAdmitted({ ...base, admissionId: "adm", admittedAt: at(2_000), now: at(2_000) });
        const left = await repo.markLeft({ ...base, reason: "TRAVEL", leftAt: at(3_000), purgeAt: at(604_800_000) });
        assert.equal(left!.state, "LEFT");
        assert.equal(left!.leftReason, "TRAVEL");
        assert.equal(left!.leftAt, at(3_000));
        assert.equal(await repo.markLeft({ ...base, reason: "TRAVEL", leftAt: at(4_000), purgeAt: at(604_800_000) }), undefined);
    });

    Case("listing and counting by state: oldest request first, bounded, scoped to the hub generation", async (repo) => {
        await repo.requestEntry(Entry("c", { now: at(3_000), expiresAt: at(93_000) }));
        await repo.requestEntry(Entry("a", { now: at(1_000), expiresAt: at(91_000) }));
        await repo.requestEntry(Entry("b", { now: at(2_000), expiresAt: at(92_000) }));
        await repo.requestEntry(Entry("elsewhere", { sessionId: "other-hub", now: at(500), expiresAt: at(90_500) }));
        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "b", admissionId: "adm", admittedAt: at(4_000), now: at(4_000) });
        assert.deepEqual(ids(await repo.listByState(HUB, 1, ["PENDING", "ADMITTED"], 10)), ["a", "b", "c"]);
        assert.deepEqual(ids(await repo.listByState(HUB, 1, ["PENDING", "ADMITTED"], 2)), ["a", "b"]);
        assert.deepEqual(ids(await repo.listByState(HUB, 1, ["ADMITTED"], 10)), ["b"]);
        assert.deepEqual(ids(await repo.listByState(HUB, 2, ["PENDING", "ADMITTED"], 10)), []);
        assert.equal(await repo.countByState(HUB, 1, ["PENDING", "TICKETED", "ADMITTED"]), 3);
        assert.equal(await repo.countByState(HUB, 1, ["LOST"]), 0);
    });

    Case("the newest live entry of an account is found across hubs; a state filter narrows it", async (repo) => {
        await repo.requestEntry(Entry("a", { sessionId: "hub-old", now: at(1_000), expiresAt: at(91_000), candidateId: "old" }));
        await repo.requestEntry(Entry("a", { sessionId: "hub-new", now: at(5_000), expiresAt: at(95_000), candidateId: "new" }));
        assert.equal((await repo.findForAccount("a"))!.candidateId, "new");
        await repo.markAdmitted({ sessionId: "hub-old", generation: 1, accountId: "a", admissionId: "adm", admittedAt: at(6_000), now: at(6_000) });
        assert.equal((await repo.findForAccount("a", ["ADMITTED"]))!.sessionId, "hub-old");
        assert.equal(await repo.findForAccount("a", ["LOST"]), undefined);
        assert.equal(await repo.findForAccount("nobody"), undefined);
        await repo.markLost({ sessionId: "hub-old", generation: 1, accountId: "a", lostAt: at(7_000), purgeAt: at(86_400_000) });
        assert.equal((await repo.findForAccount("a"))!.sessionId, "hub-new", "a lost row is not live");
    });

    Case("kick or ban removes the account's live rows from the realm and from no other", async (repo) => {
        await repo.requestEntry(Entry("a", { sessionId: "hub-1" }));
        await repo.requestEntry(Entry("a", { sessionId: "hub-2" }));
        await repo.markAdmitted({ sessionId: "hub-2", generation: 1, accountId: "a", admissionId: "adm", admittedAt: at(1_000), now: at(1_000) });
        await repo.requestEntry(Entry("a", { sessionId: "hub-3", realmId: "realm-2" }));
        await repo.requestEntry(Entry("b", { sessionId: "hub-1" }));
        await repo.requestEntry(Entry("lost", { sessionId: "hub-1" }));
        const before = await repo.removeAccountFromRealm({ realmId: REALM, accountId: "a", at: at(2_000), purgeAt: at(604_800_000) });
        assert.deepEqual(before.map((row) => [row.sessionId, row.state]).sort(), [["hub-1", "PENDING"], ["hub-2", "ADMITTED"]], "returns the rows as they were");
        const removed = await repo.findPresence("hub-2", "a");
        assert.equal(removed!.state, "REMOVED");
        assert.equal(removed!.purgeAt, at(604_800_000));
        assert.equal((await repo.findPresence("hub-3", "a"))!.state, "PENDING", "another realm's row is untouched");
        assert.equal((await repo.findPresence("hub-1", "b"))!.state, "PENDING", "another account's row is untouched");
        assert.deepEqual(await repo.removeAccountFromRealm({ realmId: REALM, accountId: "a", at: at(3_000), purgeAt: at(604_800_000) }), []);
        assert.equal((await repo.findPresence("hub-2", "a"))!.purgeAt, at(604_800_000), "a second call changes nothing");
    });

    Case("releasing a realm removes every live row of it", async (repo) => {
        await repo.requestEntry(Entry("a", { sessionId: "hub-1" }));
        await repo.requestEntry(Entry("b", { sessionId: "hub-2" }));
        await repo.markAdmitted({ sessionId: "hub-2", generation: 1, accountId: "b", admissionId: "adm", admittedAt: at(1_000), now: at(1_000) });
        await repo.requestEntry(Entry("c", { sessionId: "hub-3", realmId: "realm-2" }));
        const rows = await repo.removeRealm({ realmId: REALM, at: at(2_000), purgeAt: at(604_800_000) });
        assert.deepEqual(ids(rows).sort(), ["a", "b"]);
        assert.equal((await repo.findPresence("hub-1", "a"))!.state, "REMOVED");
        assert.equal((await repo.findPresence("hub-2", "b"))!.state, "REMOVED");
        assert.equal((await repo.findPresence("hub-3", "c"))!.state, "PENDING");
    });

    Case("a waiting entry past its expiry becomes EXPIRED; connected and not-yet-due rows stay", async (repo) => {
        await repo.requestEntry(Entry("due", { expiresAt: at(30_000) }));
        await repo.requestEntry(Entry("later", { expiresAt: at(60_000) }));
        await repo.requestEntry(Entry("ticketed", { expiresAt: at(30_000) }));
        await repo.markTicketed({ sessionId: HUB, generation: 1, accountId: "ticketed", now: at(1_000), ticketExpiresAt: at(31_000) });
        await repo.requestEntry(Entry("connected", { expiresAt: at(30_000) }));
        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "connected", admissionId: "adm", admittedAt: at(1_000), now: at(1_000) });
        await repo.requestEntry(Entry("other", { sessionId: "other-hub", expiresAt: at(30_000) }));
        const expired = await repo.expireStale({ sessionId: HUB, now: at(45_000), purgeAt: at(604_800_000) });
        assert.deepEqual(ids(expired).sort(), ["due", "ticketed"]);
        assert.equal((await repo.findPresence(HUB, "due"))!.state, "EXPIRED");
        assert.equal((await repo.findPresence(HUB, "later"))!.state, "PENDING");
        assert.equal((await repo.findPresence(HUB, "connected"))!.state, "ADMITTED");
        assert.equal((await repo.findPresence("other-hub", "other"))!.state, "PENDING", "scoped to the hub it was asked for");
        assert.deepEqual(await repo.expireStale({ sessionId: HUB, now: at(45_000), purgeAt: at(604_800_000) }), []);
        assert.deepEqual(ids(await repo.expireStale({ now: at(45_000), purgeAt: at(604_800_000) })), ["other"], "without a hub, every hub's");
    });

    Case("the end of a hub turns the generation's live rows into LOST and leaves the rest", async (repo) => {
        await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        await repo.requestEntry(Entry("waiting"));
        await repo.requestEntry(Entry("connected"));
        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "connected", admissionId: "adm", admittedAt: at(1_000), now: at(1_000) });
        await repo.requestEntry(Entry("gone"));
        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "gone", admissionId: "adm2", admittedAt: at(1_000), now: at(1_000) });
        await repo.markLeft({ sessionId: HUB, generation: 1, accountId: "gone", reason: "TRAVEL", leftAt: at(2_000), purgeAt: at(604_800_000) });
        await repo.requestEntry(Entry("elsewhere", { sessionId: "other-hub" }));
        assert.deepEqual(await repo.endSession({ sessionId: HUB, generation: 2, at: at(3_000), purgeAt: at(604_800_000) }), [], "another generation");
        const rows = await repo.endSession({ sessionId: HUB, generation: 1, at: at(3_000), purgeAt: at(604_800_000) });
        assert.deepEqual(ids(rows).sort(), ["connected", "host", "waiting"]);
        for (const id of ["connected", "host", "waiting"]) {
            const row = (await repo.findPresence(HUB, id))!;
            assert.equal(row.state, "LOST", id);
            assert.equal(row.lostAt, at(3_000), id);
            assert.equal(row.purgeAt, at(604_800_000), id);
        }
        assert.equal((await repo.findPresence(HUB, "gone"))!.state, "LEFT");
        assert.equal((await repo.findPresence("other-hub", "elsewhere"))!.state, "PENDING");
    });

    // ----- capacity (requestEntries): the seats of a hub are taken as one step -----

    Case("a batch takes its seats in one step: live rows plus the newcomers must fit maxPeers, or nobody is written", async (repo) => {
        await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        assert.equal((await repo.requestEntries(Batch(["a"], 3))).placed, true, "host and a: 2 of 3");
        assert.deepEqual(await repo.requestEntries(Batch(["b", "c"], 3)), { placed: false, reason: "FULL", live: 2, maxPeers: 3 });
        assert.equal(await repo.findPresence(HUB, "b"), undefined, "a refused batch writes no row");
        assert.equal(await repo.findPresence(HUB, "c"), undefined);
        assert.equal((await repo.requestEntries(Batch(["c"], 3))).placed, true, "one seat is left for one member");
        assert.equal(await repo.countByState(HUB, 1, ["PENDING", "TICKETED", "ADMITTED"]), 3);
    });

    Case("a placed batch reports each member's entry as requestEntry would have made it", async (repo) => {
        const first = await repo.requestEntries(Batch(["a", "b"], 4));
        assert.equal(first.placed, true);
        assert.deepEqual(first.placed ? first.entries.map((entry) => [entry.accountId, entry.outcome, entry.record.entryEpoch]) : [],
            [["a", "CREATED", 1], ["b", "CREATED", 1]]);
        const again = await repo.requestEntries(Batch(["a"], 4, { now: at(1_000), expiresAt: at(91_000) }));
        assert.ok(again.placed && again.entries[0]!.outcome === "REUSED", "a waiting entry is reused");
        assert.equal((await repo.findPresence(HUB, "a"))!.expiresAt, at(91_000));
    });

    Case("racing entries never take more seats than maxPeers, singles and batches alike", async (repo) => {
        await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        const results = await Promise.all([
            ...Array.from({ length: 12 }, (_, n) => repo.requestEntries(Batch([`single-${n}`], 5))),
            repo.requestEntries(Batch(["pair-1", "pair-2"], 5)),
            repo.requestEntries(Batch(["pair-3", "pair-4"], 5))
        ]);
        // Whatever the order, a pair is refused only when at most one seat is left and a single only when none is: the four
        // seats end up taken, and never a fifth.
        const placed = results.flatMap((result) => (result.placed ? result.entries.map((entry) => entry.accountId) : []));
        assert.equal(placed.length, 4, "the host and four members fill the five seats");
        assert.equal(new Set(placed).size, 4);
        assert.equal(await repo.countByState(HUB, 1, ["PENDING", "TICKETED", "ADMITTED"]), 5);
    });

    Case("a member already present is never refused and takes no seat, even in a full hub", async (repo) => {
        await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        assert.equal((await repo.requestEntries(Batch(["a", "b"], 3))).placed, true, "full now");
        assert.equal(await repo.requestEntries(Batch(["c"], 3)).then((result) => result.placed), false);
        const waiting = await repo.requestEntries(Batch(["a"], 3));
        assert.ok(waiting.placed && waiting.entries[0]!.outcome === "REUSED", "a waiting member asking again is placed");
        await repo.markAdmitted({ sessionId: HUB, generation: 1, accountId: "a", admissionId: "adm-a", admittedAt: at(1_000), now: at(1_000) });
        const reentry = await repo.requestEntries(Batch(["a"], 3, { now: at(2_000) }));
        assert.ok(reentry.placed && reentry.entries[0]!.outcome === "REENTERED", "an admitted member asking again re-enters");
        assert.deepEqual(await repo.requestEntries(Batch(["c"], 3, { now: at(2_000) })),
            { placed: false, reason: "FULL", live: 3, maxPeers: 3 }, "still full for a newcomer");
        assert.equal((await repo.requestEntries(Batch(["a", "b"], 1, { now: at(2_000) }))).placed, true,
            "members already present are placed even when maxPeers is lower than the hub holds");
    });

    Case("an expired waiting entry takes no seat, so its seat is free again", async (repo) => {
        await repo.admitHost({ sessionId: HUB, generation: 1, realmId: REALM, accountId: "host", peerId: "peer-host", localBridgePort: 55000, now: at(0) });
        assert.equal((await repo.requestEntries(Batch(["a"], 2, { expiresAt: at(1_000) }))).placed, true, "host and a: full");
        assert.deepEqual(await repo.requestEntries(Batch(["b"], 2, { now: at(500) })),
            { placed: false, reason: "FULL", live: 2, maxPeers: 2 }, "a is still waiting");
        assert.equal((await repo.requestEntries(Batch(["b"], 2, { now: at(5_000) }))).placed, true, "a expired at 1 s: its seat is free");
    });

    Case("a seat is counted per hub, and an account listed twice in one batch takes one seat", async (repo) => {
        assert.equal((await repo.requestEntries(Batch(["a", "b", "c"], 3, { sessionId: "other-hub" }))).placed, true);
        assert.equal((await repo.requestEntries(Batch(["d"], 1))).placed, true, "the other hub's three do not count here");
        const twice = await repo.requestEntries(Batch(["e", "e"], 2));
        assert.ok(twice.placed && twice.entries.length === 1, "one entry for the account");
        assert.equal(await repo.countByState(HUB, 1, ["PENDING"]), 2);
    });
}
