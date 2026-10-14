import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_P2P_OPERATIONS_POLICY, NormalizeP2POperationsPolicyRecord, P2PPolicyFieldsValid,
    RewardRolloutWeakeningCodes } from "./p2pOperationsPolicy";

test("missing operations policy defaults to no emergency stop and Tier 1 grants off", () => {
    assert.equal(DEFAULT_P2P_OPERATIONS_POLICY.p2pEmergencyStop, false);
    assert.deepEqual(DEFAULT_P2P_OPERATIONS_POLICY.rewardRollout,
        { version: 0, tier0ShadowEnabled: true, tier1GrantsEnabled: false });
});

test("central reward rollout normalizes legacy rows and rejects malformed rollout state", () => {
    const legacy = NormalizeP2POperationsPolicyRecord({
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1
    });
    assert.deepEqual(legacy.policy.rewardRollout,
        { version: 0, tier0ShadowEnabled: true, tier1GrantsEnabled: false });

    const malformed = NormalizeP2POperationsPolicyRecord({
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1,
        rewardRollout: { version: -1, tier0ShadowEnabled: true, tier1GrantsEnabled: "yes" }
    });
    assert.equal(malformed.malformed, true);
    assert.deepEqual(malformed.policy.rewardRollout,
        { version: 0, tier0ShadowEnabled: true, tier1GrantsEnabled: false });
});

test("a malformed module field fails the shared Guard and diagnostics fields closed", () => {
    const record = {
        guardEnforcement: "OBSERVE", diagnosticsProfile: "PRODUCTION", version: 1,
        rewardRollout: { version: 1, tier0ShadowEnabled: true, tier1GrantsEnabled: "yes" }
    };
    assert.equal(P2PPolicyFieldsValid(record), false);
    assert.equal(NormalizeP2POperationsPolicyRecord(record).policy.guardEnforcement, "ENFORCE");
});

test("legacy operations rows default the P2P emergency stop to disabled", () => {
    const legacy = NormalizeP2POperationsPolicyRecord({
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1
    });
    assert.equal(legacy.malformed, false);
    assert.equal(legacy.policy.p2pEmergencyStop, false);
});

test("P2P emergency stop normalizes booleans and fails closed on malformed values", () => {
    const stopped = NormalizeP2POperationsPolicyRecord({
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1,
        p2pEmergencyStop: true
    });
    assert.equal(stopped.malformed, false);
    assert.equal(stopped.policy.p2pEmergencyStop, true);

    const malformed = NormalizeP2POperationsPolicyRecord({
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1,
        p2pEmergencyStop: "false"
    });
    assert.equal(malformed.malformed, true);
    assert.equal(malformed.policy.p2pEmergencyStop, true);
});

test("co-op transport: ICE by default and for malformed rows, the experimental Steam transport only when set", () => {
    assert.equal(DEFAULT_P2P_OPERATIONS_POLICY.coopTransport, "ICE");
    const base = { guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 1 };
    assert.equal(NormalizeP2POperationsPolicyRecord(base).policy.coopTransport, "ICE");
    const steam = NormalizeP2POperationsPolicyRecord({ ...base, coopTransport: "STEAM_EXPERIMENTAL" });
    assert.equal(steam.malformed, false);
    assert.equal(steam.policy.coopTransport, "STEAM_EXPERIMENTAL");
    assert.equal(P2PPolicyFieldsValid({ ...base, coopTransport: "steam" }), false);
    const malformed = NormalizeP2POperationsPolicyRecord({ ...base, coopTransport: "steam" });
    assert.equal(malformed.malformed, true);
    assert.equal(malformed.policy.coopTransport, "ICE");
});

test("enabling central Tier 1 grants is a break-glass weakening", () => {
    const before = { ...DEFAULT_P2P_OPERATIONS_POLICY, version: 4 };
    assert.deepEqual(RewardRolloutWeakeningCodes(before,
        { version: 1, tier0ShadowEnabled: true, tier1GrantsEnabled: true }), ["TIER1_REWARD_GRANTS_ENABLE"]);
    assert.deepEqual(RewardRolloutWeakeningCodes(before,
        { version: 1, tier0ShadowEnabled: false, tier1GrantsEnabled: false }), []);
});
