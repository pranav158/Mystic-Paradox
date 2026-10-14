/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    BuildReleaseGatesBody, CORE_RELEASE_GATE_NAMES, CoreReleaseGates, GuardModeReleaseGate, IsLoopbackAddress,
    LegacyEnvKeysReleaseGate, RegistrationApprovalReleaseGate, TlsProxyReleaseGate
} from "./releaseGates";

test("loopback check accepts the three loopback peers and nothing else", () => {
    assert.equal(IsLoopbackAddress("127.0.0.1"), true);
    assert.equal(IsLoopbackAddress("::1"), true);
    assert.equal(IsLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(IsLoopbackAddress("203.0.113.7"), false);
    assert.equal(IsLoopbackAddress("::ffff:203.0.113.7"), false);
    assert.equal(IsLoopbackAddress("::2"), false);
    assert.equal(IsLoopbackAddress(""), false);
    assert.equal(IsLoopbackAddress(undefined), false);
});

test("aggregate ok is true only when every gate is ok and there is at least one gate", () => {
    const Ok = { name: "a", ok: true, detail: "x" };
    const Bad = { name: "b", ok: false, detail: "y" };
    assert.equal(BuildReleaseGatesBody([Ok, Ok]).ok, true);
    assert.equal(BuildReleaseGatesBody([Ok, Bad]).ok, false);
    assert.equal(BuildReleaseGatesBody([]).ok, false);
    assert.deepEqual(Object.keys(BuildReleaseGatesBody([Ok])).sort(), ["gates", "ok"]);
});

test("guard mode: unset is observe (ok); observe and enforce are ok; an unknown value is not ok", () => {
    const Unset = GuardModeReleaseGate({});
    assert.equal(Unset.ok, true);
    assert.equal(Unset.detail, "mode=observe (default)");
    assert.equal(GuardModeReleaseGate({ MYSTICPARADOX_GUARD_MODE: " Observe " }).detail, "mode=observe");
    assert.equal(GuardModeReleaseGate({ MYSTICPARADOX_GUARD_MODE: "enforce" }).detail, "mode=enforce");
    assert.equal(GuardModeReleaseGate({ MYSTICPARADOX_GUARD_MODE: "enforce" }).ok, true);
    const Bad = GuardModeReleaseGate({ MYSTICPARADOX_GUARD_MODE: "sometimes" });
    assert.equal(Bad.ok, false);
    assert.equal(Bad.name, "guard_mode");
    assert.equal(Bad.detail.includes("sometimes"), false);
});

test("registration approval: default off, required, and an unparseable value is not ok", () => {
    assert.equal(RegistrationApprovalReleaseGate({}).detail, "mode=off (default)");
    assert.equal(RegistrationApprovalReleaseGate({}).ok, true);
    assert.equal(RegistrationApprovalReleaseGate({ MYSTICPARADOX_REGISTRATION_APPROVAL: "required" }).detail, "mode=required");
    assert.equal(RegistrationApprovalReleaseGate({ MYSTICPARADOX_REGISTRATION_APPROVAL: "required" }).ok, true);
    const Bad = RegistrationApprovalReleaseGate({ MYSTICPARADOX_REGISTRATION_APPROVAL: "maybe" });
    assert.equal(Bad.ok, false);
    assert.equal(Bad.detail.includes("maybe"), false);
});

test("registration approval: the replaced legacy switch is reported but does not fail the gate", () => {
    const Gate = RegistrationApprovalReleaseGate({ MYSTICPARADOX_REGISTRATION_AUTO_APPROVE: "true" });
    assert.equal(Gate.ok, true);
    assert.equal(Gate.detail.includes("has no effect"), true);
});

test("tls proxy: off is ok; on with a loopback BIND_HOST is ok; on with another or no BIND_HOST is not ok", () => {
    assert.equal(TlsProxyReleaseGate({}).ok, true);
    assert.equal(TlsProxyReleaseGate({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "off" }).detail, "proxy mode off (in-process HTTPS)");
    const On = { MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "on" };
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "127.0.0.1" }).ok, true);
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "::1" }).ok, true);
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "localhost" }).ok, true);
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "0.0.0.0" }).ok, false);
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "203.0.113.9" }).ok, false);
    assert.equal(TlsProxyReleaseGate(On).ok, false);
    assert.equal(TlsProxyReleaseGate({ ...On, BIND_HOST: "0.0.0.0" }).detail.includes("0.0.0.0"), false);
});

test("tls proxy: an invalid switch value is not ok", () => {
    const Gate = TlsProxyReleaseGate({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "perhaps", BIND_HOST: "127.0.0.1" });
    assert.equal(Gate.ok, false);
    assert.equal(Gate.name, "tls_proxy_consistency");
});

test("legacy keys: none is ok; any MYSTPAX_ key name fails with the count and the names, never the values", () => {
    assert.equal(LegacyEnvKeysReleaseGate({ MYSTICPARADOX_GUARD_MODE: "observe" }).ok, true);
    const Secret = "super-secret-value-7731";
    const Gate = LegacyEnvKeysReleaseGate({ MYSTPAX_B: Secret, MYSTPAX_A: "x", MYSTICPARADOX_X: "y" });
    assert.equal(Gate.ok, false);
    assert.equal(Gate.detail, "2 MYSTPAX_ key(s): MYSTPAX_A, MYSTPAX_B");
    assert.equal(Gate.detail.includes(Secret), false);
});

test("the core gates come in manager order with the four core names", () => {
    const Gates = CoreReleaseGates({});
    assert.deepEqual(Gates.map((gate) => gate.name), [...CORE_RELEASE_GATE_NAMES]);
    assert.equal(BuildReleaseGatesBody(Gates).ok, true);
    assert.equal(BuildReleaseGatesBody(CoreReleaseGates({ MYSTPAX_X: "1" })).ok, false);
});
