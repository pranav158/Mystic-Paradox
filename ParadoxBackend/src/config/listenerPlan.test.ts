/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M2] The listener plan of the proxy mode (MYSTICPARADOX_TLS_TERMINATED_BY_PROXY, BIND_HOST, QOS_PORT) and what
// production startup requires with and without it.

import assert from "node:assert/strict";
import test from "node:test";

import { ReadQosPort, ReadTlsTerminatedByProxy, ResolveListenerPlan } from "./listenerPlan";
import { AssertRuntimeSafety } from "./runtimeSafety";

const PRODUCTION = {
    NODE_ENV: "production",
    AUTH_MODE: "APIKEY",
    REALTIME_XMPP_DEV_CITY_MUC: "false",
    MYSTICPARADOX_SERVICE_ROLE: "api",
    MYSTICPARADOX_METRICS_TOKEN: "metrics-test-token",
    MONGODB_URI: "mongodb://guardit.example.test/?replicaSet=guardit"
};

test("with the switch off the listeners are the ones Metagame has always opened", () => {
    assert.deepEqual(ResolveListenerPlan({}), {
        tlsTerminatedByProxy: false,
        httpBindHost: undefined,
        httpsListener: true,
        realtimeListener: "HTTPS",
        qosPort: 80,
        qosProblem: undefined
    });
});

test("behind a proxy: no HTTPS listener, the WebSocket gateway on the HTTP listener, the bind address and QoS as configured", () => {
    assert.deepEqual(ResolveListenerPlan({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "on", BIND_HOST: " 127.0.0.1 ", QOS_PORT: "off" }), {
        tlsTerminatedByProxy: true,
        httpBindHost: "127.0.0.1",
        httpsListener: false,
        realtimeListener: "HTTP",
        qosPort: undefined,
        qosProblem: undefined
    });
    assert.equal(ResolveListenerPlan({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "on" }).qosPort, 80, "QoS stays on unless it is switched off");
    assert.equal(ResolveListenerPlan({ BIND_HOST: "   " }).httpBindHost, undefined, "a blank bind address is no bind address");
});

test("the proxy switch takes on/off spellings and refuses anything else (a typo must not keep the HTTPS listener quietly)", () => {
    for (const value of ["on", "ON", "1", "true", "yes", " on "]) assert.equal(ReadTlsTerminatedByProxy({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: value }), true, value);
    for (const value of ["", "off", "0", "false", "no"]) assert.equal(ReadTlsTerminatedByProxy({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: value }), false, value);
    assert.equal(ReadTlsTerminatedByProxy({}), false);
    assert.throws(() => ReadTlsTerminatedByProxy({ MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "onn" }),
        { message: "MYSTICPARADOX_TLS_TERMINATED_BY_PROXY must be on or off (got 'onn')" });
});

test("QOS_PORT: unset is 80, off starts none, a port number is that port; anything else is reported, not started", () => {
    assert.deepEqual(ReadQosPort(undefined), { port: 80, problem: undefined });
    assert.deepEqual(ReadQosPort("  "), { port: 80, problem: undefined });
    assert.deepEqual(ReadQosPort("OFF"), { port: undefined, problem: undefined });
    assert.deepEqual(ReadQosPort("8080"), { port: 8080, problem: undefined });
    assert.deepEqual(ReadQosPort("0"), { port: undefined, problem: "QOS_PORT='0' is not a port number or 'off'" });
    assert.deepEqual(ReadQosPort("70000"), { port: undefined, problem: "QOS_PORT='70000' is not a port number or 'off'" });
    assert.deepEqual(ReadQosPort("http"), { port: undefined, problem: "QOS_PORT='http' is not a port number or 'off'" });
});

test("production needs a certificate and an HTTPS port only when the HTTPS listener runs", () => {
    assert.doesNotThrow(() => AssertRuntimeSafety({ ...PRODUCTION }));
    assert.doesNotThrow(() => AssertRuntimeSafety({ ...PRODUCTION, MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "on", HTTPS_PORT: "99999" }),
        "behind a proxy the HTTPS port is not used, so it is not checked");
    assert.throws(() => AssertRuntimeSafety({ ...PRODUCTION, HTTPS_PORT: "99999" }), /HTTPS_PORT must be a valid production port/);
    assert.throws(() => AssertRuntimeSafety({ ...PRODUCTION, MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: "maybe" }),
        /MYSTICPARADOX_TLS_TERMINATED_BY_PROXY must be on or off/);
});
