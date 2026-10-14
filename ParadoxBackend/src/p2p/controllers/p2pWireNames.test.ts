import assert from "node:assert/strict";
import test from "node:test";
import { ParseArtifacts } from "./p2pHostLifecycle";
import { WireArtifacts } from "./p2pLauncher";

const HASH = (digit: string) => digit.repeat(64);

test("host presence artifacts are read under the neutral co-op names and the older names", () => {
    const common = { gameExe: HASH("a"), internalServer: HASH("b"), winmmProxy: HASH("c"), admissionPublicKey: HASH("f") };
    const expected = { ...common, steamBridge: HASH("d"), steamRuntime: HASH("e") };
    assert.deepEqual(ParseArtifacts({ ...common, transportModule: HASH("d"), transportRuntime: HASH("e") }), expected);
    assert.deepEqual(ParseArtifacts({ ...common, steamBridge: HASH("d"), steamRuntime: HASH("e") }), expected);
    assert.equal(ParseArtifacts({ ...common, transportModule: HASH("d") }), undefined);
});

test("bootstrap artifacts carry the neutral co-op names next to the older ones", () => {
    const wire = WireArtifacts({ gameExe: HASH("a"), internalServer: HASH("b"), winmmProxy: HASH("c"),
        steamBridge: HASH("d"), steamRuntime: HASH("e"), admissionPublicKey: HASH("f") });
    assert.equal(wire.transportModule, HASH("d"));
    assert.equal(wire.transportRuntime, HASH("e"));
    assert.equal(wire.steamBridge, HASH("d"));
});
