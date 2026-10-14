/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { ExtensionHttpResponse, HostWriteKind, HostWriteRecordInput } from "../extensions/p2p";

/*
 * [2026-10-15] The gate of POST /loadout/:userId/:characterId/unlock/:n (AuthorizeLoadoutUnlock, routes/loadout.ts): a dedicated
 * gameserver keeps its authority, a player-hosted runtime is asked the hostWrites hook for LOADOUT_UNLOCK on the target, and a
 * player's own token is refused before any hook. The hooks are a recorder; the real membership rule is tested in
 * p2p/security/hostWrites.test.ts and hubAuthorization.test.ts. The logger is replaced before the route file is loaded.
 */

const Quiet = () => undefined;
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}
Fake("../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });
// The real auth middleware reads its JWT secret when it loads; the gate under test is the handler's own, not the middleware.
Fake("../middleware/HasParadoxBackendAuth", { HasParadoxBackendAuth: (_req: unknown, _res: unknown, next: () => void) => next() });

let Loadout: typeof import("./loadout");
before(() => { Loadout = require("./loadout"); });

const DENIAL: ExtensionHttpResponse = { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };

function Recorder(denial?: ExtensionHttpResponse) {
    const Calls: { kind: HostWriteKind; target: string }[] = [];
    const Records: HostWriteRecordInput[] = [];
    return {
        Calls,
        Records,
        hooks: {
            authorize: async (_req: unknown, kind: HostWriteKind, target: string) => { Calls.push({ kind, target }); return denial; },
            record: async (_req: unknown, write: HostWriteRecordInput) => { Records.push(write); },
        },
    };
}

const Params = { userId: "player-1", characterId: "character-1" };

test("a dedicated gameserver unlocks for any account, and no host hook is asked", async () => {
    const Hooks = Recorder(DENIAL);
    const Gate = await Loadout.AuthorizeLoadoutUnlock({ AuthData: { IsGameserver: true }, params: Params }, "player-1", Hooks.hooks);
    assert.equal(Gate, undefined);
    assert.deepEqual(Hooks.Calls, []);
});

test("a player's own bearer token is refused with 403 before any hook is asked", async () => {
    const Hooks = Recorder();
    const Gate = await Loadout.AuthorizeLoadoutUnlock({ AuthData: { userId: "player-1", IsGameserver: false }, params: Params }, "player-1", Hooks.hooks);
    assert.equal(Gate?.status, 403);
    assert.equal((Gate?.body as { code?: string }).code, "forbidden");
    assert.deepEqual(Hooks.Calls, []);
});

test("a player-hosted runtime is asked LOADOUT_UNLOCK for the target player, and may unlock when the hook allows it", async () => {
    const Hooks = Recorder();
    const AuthData = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "host-1" };
    const Gate = await Loadout.AuthorizeLoadoutUnlock({ AuthData, params: Params }, "player-1", Hooks.hooks);
    assert.equal(Gate, undefined);
    assert.deepEqual(Hooks.Calls, [{ kind: "LOADOUT_UNLOCK", target: "player-1" }]);
});

test("a player-hosted runtime for a player it may not write is refused with the hook's answer", async () => {
    const Hooks = Recorder(DENIAL);
    const AuthData = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "host-1" };
    const Gate = await Loadout.AuthorizeLoadoutUnlock({ AuthData, params: { userId: "stranger-1", characterId: "character-9" } }, "stranger-1", Hooks.hooks);
    assert.deepEqual(Gate, DENIAL);
    assert.deepEqual(Hooks.Calls, [{ kind: "LOADOUT_UNLOCK", target: "stranger-1" }]);
});

test("a request with no authority at all is refused", async () => {
    const Hooks = Recorder();
    const Gate = await Loadout.AuthorizeLoadoutUnlock({ AuthData: undefined, params: Params }, "player-1", Hooks.hooks);
    assert.equal(Gate?.status, 403);
    assert.deepEqual(Hooks.Calls, []);
});
