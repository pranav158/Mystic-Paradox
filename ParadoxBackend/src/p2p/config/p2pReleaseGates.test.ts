/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CollectP2PReleaseGates, DurableP2PReleaseGates, P2PEnvReleaseGate, ReadDurableP2PReleaseGates } from "./p2pReleaseGates";

const CleanRecord = {
    guardEnforcement: "ENFORCE",
    diagnosticsProfile: "PRODUCTION",
    version: 3,
    p2pEmergencyStop: false,
    rewardRollout: { version: 1, tier0ShadowEnabled: true, tier1GrantsEnabled: false },
    coopTransport: "ICE"
};

const HuntsOn = { P2P_HUNTS_ENABLED: "true", P2P_FORCE_SDR: "true" };

test("P2P env: hunts off and the defaults are ok", () => {
    const Gate = P2PEnvReleaseGate({});
    assert.equal(Gate.name, "p2p_env_policy");
    assert.equal(Gate.ok, true);
    assert.equal(Gate.detail, "hunts=off, relay_only=off, trust_tier=0, tier1_switches=off");
});

test("P2P env: hunts on without relay-only traffic is not ok; with P2P_FORCE_SDR=true it is ok", () => {
    const Without = P2PEnvReleaseGate({ P2P_HUNTS_ENABLED: "true" });
    assert.equal(Without.ok, false);
    assert.equal(Without.detail.includes("P2P_FORCE_SDR"), true);
    assert.equal(P2PEnvReleaseGate(HuntsOn).ok, true);
});

test("P2P env: an allow-all switch with hunts on is not ok; with hunts off it is not checked", () => {
    assert.equal(P2PEnvReleaseGate({ ...HuntsOn, P2P_ALLOW_ALL_ACCOUNTS: "true" }).ok, false);
    assert.equal(P2PEnvReleaseGate({ P2P_ALLOW_ALL_ACCOUNTS: "true" }).ok, true);
});

test("P2P env: an unrecognised trust tier is not ok (the reader would silently read it as 0)", () => {
    const Gate = P2PEnvReleaseGate({ P2P_TRUST_TIER: "2" });
    assert.equal(Gate.ok, false);
    assert.equal(Gate.detail.includes("P2P_TRUST_TIER"), true);
    assert.equal(Gate.detail.includes("\"2\""), false);
});

test("P2P env: trust tier 1 needs every Tier 1 switch and both allowlists; tier 0 with a Tier 1 switch is not ok", () => {
    assert.equal(P2PEnvReleaseGate({ P2P_TRUST_TIER: "1" }).ok, false);
    const Full = {
        ...HuntsOn,
        P2P_TRUST_TIER: "1",
        P2P_TIER1_REWARDS_ENABLED: "true",
        P2P_TIER1_SHADOW_APPROVED: "true",
        P2P_TIER1_ALLOWED_ACCOUNTS: "acct-secret-1",
        P2P_TIER1_ALLOWED_HUNTS: "hunt-secret-1"
    };
    const Gate = P2PEnvReleaseGate(Full);
    assert.equal(Gate.ok, true);
    assert.equal(Gate.detail.includes("acct-secret-1"), false);
    assert.equal(Gate.detail.includes("hunt-secret-1"), false);
    assert.equal(P2PEnvReleaseGate({ ...Full, P2P_TIER1_ALLOWED_HUNTS: "" }).ok, false);
    const TierZero = P2PEnvReleaseGate({ P2P_TRUST_TIER: "0", P2P_TIER1_REWARDS_ENABLED: "true" });
    assert.equal(TierZero.ok, false);
    assert.equal(TierZero.detail.includes("Tier 1 switches"), true);
});

test("durable gates: an unreadable or missing record fails both gates", () => {
    const Unreadable = DurableP2PReleaseGates({ readable: false });
    assert.deepEqual(Unreadable.map((gate) => [gate.name, gate.ok, gate.detail]), [
        ["p2p_emergency_stop_durable", false, "unreadable"], ["tier1_reward_grants", false, "unreadable"]
    ]);
    assert.equal(DurableP2PReleaseGates({ readable: true, record: null }).every((gate) => !gate.ok), true);
});

test("durable gates: a malformed record fails closed for both gates", () => {
    const Gates = DurableP2PReleaseGates({ readable: true, record: { ...CleanRecord, guardEnforcement: "BOGUS" } });
    assert.equal(Gates.every((gate) => !gate.ok && gate.detail === "malformed"), true);
});

test("durable gates: a clean record passes; a stop or Tier 1 grants on each fail their own gate", () => {
    const Clean = DurableP2PReleaseGates({ readable: true, record: CleanRecord });
    assert.deepEqual(Clean.map((gate) => [gate.ok, gate.detail]), [
        [true, "emergency_stop=off"], [true, "tier1_grants=off"]
    ]);
    const Stopped = DurableP2PReleaseGates({ readable: true, record: { ...CleanRecord, p2pEmergencyStop: true } });
    assert.deepEqual(Stopped.map((gate) => [gate.ok, gate.detail]), [
        [false, "emergency_stop=on"], [true, "tier1_grants=off"]
    ]);
    const Granting = DurableP2PReleaseGates({ readable: true,
        record: { ...CleanRecord, rewardRollout: { version: 2, tier0ShadowEnabled: true, tier1GrantsEnabled: true } } });
    assert.deepEqual(Granting.map((gate) => [gate.ok, gate.detail]), [
        [true, "emergency_stop=off"], [false, "tier1_grants=on"]
    ]);
});

test("durable read: a throwing reader is unreadable; a clean reader passes", async () => {
    const Thrown = await ReadDurableP2PReleaseGates(async () => { throw new Error("connection refused"); });
    assert.equal(Thrown.every((gate) => !gate.ok && gate.detail === "unreadable"), true);
    const Clean = await ReadDurableP2PReleaseGates(async () => CleanRecord);
    assert.equal(Clean.every((gate) => gate.ok), true);
});

test("durable read: a reader that does not answer in time is unreadable (fail closed)", async () => {
    const Hung = await ReadDurableP2PReleaseGates(() => new Promise<never>(() => undefined), 20);
    assert.equal(Hung.every((gate) => !gate.ok && gate.detail === "unreadable"), true);
});

test("collect: the P2P module contributes three gates in order", async () => {
    const Gates = await CollectP2PReleaseGates({}, async () => CleanRecord);
    assert.deepEqual(Gates.map((gate) => gate.name), ["p2p_env_policy", "p2p_emergency_stop_durable", "tier1_reward_grants"]);
    assert.equal(Gates.every((gate) => gate.ok), true);
});
