import assert from "node:assert/strict";
import test from "node:test";
import { P2PHuntSessionRecord } from "../persistence";
import { PlayerHostRuntimeAuthData } from "./hostCapabilities";
import { P2PInventoryTransactionDenialReason } from "./p2pInventoryTransactions";

const auth: PlayerHostRuntimeAuthData = {
    userId: "account-a", IsGameserver: false, IsPlayerHostRuntime: true,
    p2pSessionId: "session-a", p2pGeneration: 4, RuntimeRosterAccountIds: ["account-a"]
};
const hunt: P2PHuntSessionRecord = {
    sessionId: "session-a", generation: 4, state: "RUNNING", stateVersion: 9,
    partyId: "party-a", partyRevision: 1, huntDefinitionId: "IslandA", build: 1,
    bridgeProtocol: 1, virtualPort: 1234, hostAccountId: "account-a", hostSteamId: "steam-a",
    bridgeInstanceId: "bridge-a", createdAt: "2026-09-29T00:00:00.000Z", expiresAt: "2026-09-29T01:00:00.000Z", roster: [
        { accountId: "account-a", steamId: "steam-a", candidateId: "candidate-a", reconnectEpoch: 0, admissionState: "ADMITTED" }
    ],
    frozenLoadouts: [{ accountId: "account-a", characterId: "character-a", loadoutRevision: 1,
        activeIndex: 0, characterUpdateVersion: 1, characterDataDigest: "d", digest: "d" }]
};
const normalTransaction = {
    characterId: "character-a", transactionId: "native-loot-1",
    addInstancedItems: [{ catalogId: "PART_SAMPLE", instanceId: "part-instance" }],
    addStackedItems: [{ catalogId: "PART_STACK", quantity: 2 }],
    removeInstancedItems: [{ catalogId: "OLD_PART", instanceId: "old-instance" }],
    removeStackedItems: [{ catalogId: "OLD_STACK", quantity: 1 }],
    saveInstancedItems: [{ catalogId: "WEAPON", instanceId: "weapon-instance", itemData: "{}" }]
};

test("P2P native inventory requests bind runtime, running generation, admitted account, and frozen character", () => {
    assert.equal(P2PInventoryTransactionDenialReason({ ...auth, IsGameserver: true } as any, hunt, normalTransaction), "PLAYER_HOST_AUTH_REQUIRED");
    assert.equal(P2PInventoryTransactionDenialReason(auth, { ...hunt, generation: 3 }, normalTransaction), "HUNT_NOT_RUNNING");
    assert.equal(P2PInventoryTransactionDenialReason(auth, { ...hunt, state: "COMPLETED" }, normalTransaction), "HUNT_NOT_RUNNING");
    assert.equal(P2PInventoryTransactionDenialReason(auth, { ...hunt, roster: [{ ...hunt.roster[0], admissionState: "PENDING" }] }, normalTransaction), "PARTICIPANT_NOT_ADMITTED");
    assert.equal(P2PInventoryTransactionDenialReason(auth, hunt, { ...normalTransaction, characterId: "other-character" }), "CHARACTER_MISMATCH");
    assert.equal(P2PInventoryTransactionDenialReason(auth, hunt, { ...normalTransaction, accountId: "account-b" }), "ACCOUNT_MISMATCH");
    assert.equal(P2PInventoryTransactionDenialReason(auth, hunt, normalTransaction), undefined);
});

test("a drained hunt's native loot still saves for its admitted member; a fenced hunt's does not (2026-10-15)", () => {
    assert.equal(P2PInventoryTransactionDenialReason(auth, { ...hunt, state: "DRAINING" }, normalTransaction), undefined);
    assert.equal(P2PInventoryTransactionDenialReason(auth, { ...hunt, state: "FENCED" }, normalTransaction), "HUNT_NOT_RUNNING");
});

test("P2P native inventory requests preserve normal bundled transaction fields", () => {
    assert.equal(P2PInventoryTransactionDenialReason(auth, hunt, normalTransaction), undefined);
    assert.equal(P2PInventoryTransactionDenialReason(auth, hunt, { characterId: "character-a", transactionId: "save-only" }), undefined);
});

// [2026-10-14 realms S4] A realm hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.3): RUNNING, the account
// present in the hub (the host counts), and no frozen character. What a transaction may grant is hostGrantPolicy.ts's call.
const hub = (overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord => ({
    ...hunt, sessionKind: "REALM_HUB", hubKind: "RAMSGATE", realmId: "realm-a", roster: [], ...overrides
});
const member: PlayerHostRuntimeAuthData = { ...auth, userId: "account-b", RuntimeRosterAccountIds: ["account-a", "account-b"] };
const present = { presentAccountIds: ["account-b"] };
const hubLoot = { characterId: "character-not-frozen", transactionId: "hub-loot-1",
    addStackedItems: [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 4 }] };

test("a realm hub transaction needs a running hub, an account present in it and no frozen character", () => {
    // The host is always in its own hub, and the character is not the frozen one: nothing is compared with a roster.
    assert.equal(P2PInventoryTransactionDenialReason(auth, hub(), hubLoot, { presentAccountIds: [] }), undefined);
    assert.equal(P2PInventoryTransactionDenialReason(member, hub(), hubLoot, present), undefined);
    assert.equal(P2PInventoryTransactionDenialReason(member, hub(), { ...hubLoot, accountId: "account-b" }, present), undefined);
    assert.equal(P2PInventoryTransactionDenialReason(member, hub(), { ...hubLoot, accountId: "account-c" }, present), "ACCOUNT_MISMATCH");
    assert.equal(P2PInventoryTransactionDenialReason(member, hub(), hubLoot, { presentAccountIds: [] }), "PARTICIPANT_NOT_ADMITTED");
    assert.equal(P2PInventoryTransactionDenialReason(member, hub(), hubLoot), "PARTICIPANT_NOT_ADMITTED", "no presence view: only the host");
    assert.equal(P2PInventoryTransactionDenialReason(member, hub({ state: "SUSPECT" }), hubLoot, present), "HUNT_NOT_RUNNING");
    assert.equal(P2PInventoryTransactionDenialReason(member, hub({ generation: 3 }), hubLoot, present), "HUNT_NOT_RUNNING");
    assert.equal(P2PInventoryTransactionDenialReason({ ...member, IsGameserver: true } as any, hub(), hubLoot, present), "PLAYER_HOST_AUTH_REQUIRED");
});

test("a Training hub's save passes this check; its grants and spends are refused by the grant rule (hostGrantPolicy), not here", () => {
    const training = hub({ hubKind: "TRAINING" });
    assert.equal(P2PInventoryTransactionDenialReason(member, training, { characterId: "character-b", transactionId: "save-only" }, present), undefined);
});
