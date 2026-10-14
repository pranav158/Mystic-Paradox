import assert from "node:assert/strict";
import test from "node:test";
import { RealmPresenceRepository } from "./persistence/RealmsRepository";
import { RealmPresenceRecord } from "./realmTypes";

// [2026-10-13 hub design section 2.2] The behaviour every RealmPresenceRepository must have, written once and run against the
// in-memory double (realmPresenceRepository.test.ts, always) and against MongoDB (realmsMongo.integration.test.ts, opt-in on an
// isolated database).

const T0 = "2026-10-13T12:00:00.000Z";
const T60 = "2026-10-13T12:01:00.000Z";
const T120 = "2026-10-13T12:02:00.000Z";
const T180 = "2026-10-13T12:03:00.000Z";

function Row(accountId: string, realmId: string, overrides: Partial<RealmPresenceRecord> = {}): RealmPresenceRecord {
    return { accountId, realmId, boundAt: T0, lastSeenAt: T0, expiresAt: T120, ...overrides };
}

export interface PresenceRepositoryHarness {
    repo: RealmPresenceRepository;
    reset(): Promise<void>;
}

export function RunRealmPresenceRepositoryContract(
    label: string,
    harness: () => Promise<PresenceRepositoryHarness>,
    options: { skip?: string | false } = {}
): void {
    const Case = (name: string, body: (repo: RealmPresenceRepository) => Promise<void>) =>
        test(`${label}: ${name}`, { skip: options.skip ?? false }, async () => {
            const { repo, reset } = await harness();
            await reset();
            await body(repo);
        });

    Case("a row round-trips exactly, and a bind replaces the account's earlier row", async (repo) => {
        assert.equal(await repo.findActive("a", T0), undefined);
        await repo.bind(Row("a", "realm-1"));
        assert.deepEqual(await repo.findActive("a", T0), Row("a", "realm-1"));
        await repo.bind(Row("a", "realm-2", { boundAt: T60, lastSeenAt: T60, expiresAt: T180 }));
        assert.deepEqual(await repo.findActive("a", T60), Row("a", "realm-2", { boundAt: T60, lastSeenAt: T60, expiresAt: T180 }));
        assert.equal(await repo.findActive("b", T0), undefined);
    });

    Case("a row is active only strictly before its expiresAt", async (repo) => {
        await repo.bind(Row("a", "realm-1"));
        assert.ok(await repo.findActive("a", "2026-10-13T12:01:59.999Z"));
        assert.equal(await repo.findActive("a", T120), undefined);
        assert.equal(await repo.findActive("a", T180), undefined);
    });

    Case("a touch extends an active row and returns it; an expired or absent row is not brought back", async (repo) => {
        await repo.bind(Row("a", "realm-1"));
        const touched = await repo.touch("a", T60, T180);
        assert.deepEqual(touched, Row("a", "realm-1", { lastSeenAt: T60, expiresAt: T180 }));
        assert.deepEqual(await repo.findActive("a", T120), touched);
        assert.equal(await repo.touch("a", T180, "2026-10-13T12:05:00.000Z"), undefined, "expired at T180");
        assert.equal(await repo.findActive("a", T180), undefined);
        assert.equal(await repo.touch("nobody", T0, T120), undefined);
    });

    Case("remove deletes the row, and with a realm id only that realm's row", async (repo) => {
        await repo.bind(Row("a", "realm-1"));
        await repo.bind(Row("b", "realm-2"));
        assert.equal(await repo.remove("a", "realm-2"), false, "bound to another realm");
        assert.ok(await repo.findActive("a", T0));
        assert.equal(await repo.remove("a", "realm-1"), true);
        assert.equal(await repo.remove("a"), false);
        assert.equal(await repo.remove("b"), true);
        assert.equal(await repo.remove("nobody"), false);
    });

    Case("removeForRealm deletes every row of that realm and no other", async (repo) => {
        await repo.bind(Row("a", "realm-1"));
        await repo.bind(Row("b", "realm-1"));
        await repo.bind(Row("c", "realm-2"));
        assert.equal(await repo.removeForRealm("realm-1"), 2);
        assert.equal(await repo.removeForRealm("realm-1"), 0);
        assert.equal(await repo.findActive("a", T0), undefined);
        assert.ok(await repo.findActive("c", T0));
    });

    Case("the active rows of each realm are counted at the given time", async (repo) => {
        await repo.bind(Row("a", "realm-1"));
        await repo.bind(Row("b", "realm-1", { expiresAt: T60 }));
        await repo.bind(Row("c", "realm-2"));
        await repo.bind(Row("d", "realm-3"));
        assert.deepEqual([...(await repo.countActiveByRealm(["realm-1", "realm-2", "none"], T0))].sort(), [["realm-1", 2], ["realm-2", 1]]);
        assert.deepEqual([...(await repo.countActiveByRealm(["realm-1"], T60))], [["realm-1", 1]], "b expired at T60");
        assert.equal((await repo.countActiveByRealm([], T0)).size, 0);
        assert.equal((await repo.countActiveByRealm(["realm-1"], T120)).size, 0);
    });

    Case("racing binds for one account leave exactly one row", async (repo) => {
        await Promise.all(Array.from({ length: 8 }, (_, index) => repo.bind(Row("a", `realm-${index}`))));
        const row = await repo.findActive("a", T0);
        assert.ok(row);
        assert.equal((await repo.countActiveByRealm(Array.from({ length: 8 }, (_, index) => `realm-${index}`), T0)).size, 1);
    });
}
