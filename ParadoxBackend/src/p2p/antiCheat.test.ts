import assert from "node:assert/strict";
import test from "node:test";

// Each test file runs in its own process, so the switch below fixes this file's extension to the defaults.
process.env.MYSTICPARADOX_ANTICHEAT_MODULE = "off";

test("without the anti-cheat module hunts collect no evidence and earn no rewards", async () => {
    const { GetAntiCheatExtension } = await import("./antiCheat");
    const antiCheat = GetAntiCheatExtension();
    assert.equal(antiCheat.loaded, false);
    assert.deepEqual(antiCheat.server.serviceRoles, []);
    assert.deepEqual(antiCheat.server.runtimeSafetyIssues({ MYSTICPARADOX_SERVICE_ROLE: "reward-worker" }), []);
    assert.deepEqual(antiCheat.rewards.policyStatus("hunt", "v1"), { ready: false, reason: "ANTICHEAT_MODULE_ABSENT" });

    const capability = {} as Parameters<typeof antiCheat.hunts.submitEvidence>[0];
    await assert.rejects(antiCheat.hunts.submitEvidence(capability, {}), { code: "HUNT_EVIDENCE_NOT_COLLECTED" });
    await assert.rejects(antiCheat.hunts.complete(capability, {}), { code: "HUNT_EVIDENCE_NOT_COLLECTED" });
    await assert.rejects(antiCheat.hunts.recordShadowComparison("key", {}), { code: "HUNT_EVIDENCE_NOT_COLLECTED" });
    assert.equal(await antiCheat.hunts.result("session", 1), undefined);
    assert.equal(await antiCheat.hunts.rewardReceipt("session", 1, "account"), undefined);

    assert.deepEqual(await antiCheat.operations.recentFindings(10), []);
    assert.deepEqual(await antiCheat.operations.recentReceipts(10), []);
    assert.deepEqual(await antiCheat.operations.evidenceBatches([{ sessionId: "session", generation: 1 }], 10),
        { active: [], archived: [] });
});
