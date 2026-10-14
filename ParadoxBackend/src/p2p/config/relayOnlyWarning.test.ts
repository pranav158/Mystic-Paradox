/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RelayOnlyWarning } from "./p2pPolicy";

// [2026-10-14] The startup warning when P2P hunts run without relay-only traffic (P2P_FORCE_SDR).

test("no warning when hunts are off, whatever P2P_FORCE_SDR says", () => {
    assert.equal(RelayOnlyWarning({}), undefined);
    assert.equal(RelayOnlyWarning({ P2P_HUNTS_ENABLED: "false" }), undefined);
    assert.equal(RelayOnlyWarning({ P2P_HUNTS_ENABLED: "false", P2P_FORCE_SDR: "false" }), undefined);
});

test("no warning when hunts are on and relay-only is on (true, case and spaces ignored)", () => {
    assert.equal(RelayOnlyWarning({ P2P_HUNTS_ENABLED: "true", P2P_FORCE_SDR: "true" }), undefined);
    assert.equal(RelayOnlyWarning({ P2P_HUNTS_ENABLED: " TRUE ", P2P_FORCE_SDR: " True " }), undefined);
});

test("a warning when hunts are on and P2P_FORCE_SDR is absent or not exactly true", () => {
    for (const forced of [undefined, "", "false", "1", "yes", "on"]) {
        const environment: NodeJS.ProcessEnv = { P2P_HUNTS_ENABLED: "true" };
        if (forced !== undefined) environment.P2P_FORCE_SDR = forced;
        const Warning = RelayOnlyWarning(environment);
        assert.match(Warning ?? "", /^WARNING: P2P hunts are enabled without P2P_FORCE_SDR=true/, JSON.stringify(forced));
        assert.match(Warning ?? "", /see each other's IP address/, JSON.stringify(forced));
    }
});
