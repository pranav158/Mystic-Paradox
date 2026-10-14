import assert from "node:assert/strict";
import test from "node:test";
import { DeriveIcePeerId, ParseIcePeerReport } from "./transportPeerIds";
import { PeerIdOf } from "../controllers/p2pIce";

test("ICE peer ids are stable per account, distinct, non-zero and below 2^63", () => {
    const first = DeriveIcePeerId("4f6a2d1e-0000-4000-8000-000000000001");
    assert.equal(first, DeriveIcePeerId("4f6a2d1e-0000-4000-8000-000000000001"));
    assert.notEqual(first, DeriveIcePeerId("4f6a2d1e-0000-4000-8000-000000000002"));
    assert.match(first, /^[1-9][0-9]{0,18}$/);
    assert.ok(BigInt(first) > 0n && BigInt(first) < (1n << 63n));
});

test("a transport module's own id is any non-zero unsigned 64-bit decimal", () => {
    assert.equal(ParseIcePeerReport("18446744073709551615"), "18446744073709551615");
    assert.equal(ParseIcePeerReport("18446744073709551616"), undefined);
    assert.equal(ParseIcePeerReport("0"), undefined);
    assert.equal(ParseIcePeerReport("12x"), undefined);
    assert.equal(ParseIcePeerReport(42), undefined);
});

test("transport-config names each participant by the peer id frozen in the hunt", () => {
    const hunt: any = {
        hostAccountId: "host", hostSteamId: "111",
        roster: [{ accountId: "host", steamId: "111" }, { accountId: "join", steamId: "222" }]
    };
    assert.equal(PeerIdOf(hunt, "host"), "111");
    assert.equal(PeerIdOf(hunt, "join"), "222");
    assert.equal(PeerIdOf(hunt, "stranger"), "");
});
