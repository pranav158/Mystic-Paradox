import assert from "node:assert/strict";
import { InMemoryRealmPresenceRepository, InMemoryRealmsRepository } from "./persistence/InMemoryRealmsRepository";
import { LauncherApiError } from "./realmErrors";
import { CreateRealmsService, RealmsServiceDeps } from "./realmsService";
import { RealmEvent } from "./realmTypes";

// Shared set-up of the realms tests that need the hub-design features (presence, hosting, events). Not a test file itself:
// scripts/run-tests.cjs only runs *.test.ts. The older tests (realmsService.test.ts) keep their own Setup.

export const T0 = Date.parse("2026-10-13T12:00:00.000Z");
export const KEY_A = "KEY-A-0123456789abcdef";
export const KEY_B = "KEY-B-0123456789abcdef";
export const NAMES = new Map([["host-1", "Hosty"], ["host-2", "Hosty Two"], ["friend-1", "Friendly"], ["friend-2", "Pal"]]);

export function SetupRealms(overrides: Partial<RealmsServiceDeps> = {}) {
    const clock = { now: T0 };
    const repo = new InMemoryRealmsRepository();
    const presence = new InMemoryRealmPresenceRepository();
    const events: RealmEvent[] = [];
    let realmCounter = 0;
    let codeCounter = 0;
    const service = CreateRealmsService({
        repository: repo,
        presence,
        events: async (event) => { events.push(event); },
        displayNames: async (ids) => new Map(ids.filter((id) => NAMES.has(id)).map((id) => [id, NAMES.get(id)!])),
        now: () => clock.now,
        isRateLimited: () => false,
        generateRealmId: () => `realm-${++realmCounter}`,
        generateInviteCode: () => `ABCDEFGH${"JKLMNPQRST"[Math.floor(codeCounter / 10) % 10]}${"KLMNPQRSTU"[codeCounter++ % 10]}`,
        ...overrides
    });
    const create = async (accountId: string, name: string, extra: Record<string, unknown> = {}) =>
        (await service.createRealm(accountId, { name, hostPublicKey: KEY_A, joinPolicy: "INVITE_ONLY", listed: false, ...extra })).realm;
    /** The host is online and its hub is running: the realm can be entered. */
    const serve = async (hostAccountId: string, realmId: string) => {
        await service.heartbeat(hostAccountId, {});
        await service.setHosting(realmId, { hubState: "RUNNING", hubSessionId: `hub-${realmId}` });
    };
    return { clock, repo, presence, events, service, create, serve };
}

export async function Rejects(promise: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(promise, (error: unknown) => error instanceof LauncherApiError && error.code === code, `expected ${code}`);
}
