import assert from "node:assert/strict";
import test from "node:test";
import {
    DeriveIcePairKey,
    FilterRelayOnly,
    IcePeersFor,
    IsIceActiveState,
    ParseIceSignal,
    ResolveIceRole,
    SignalRouteAllowed
} from "./iceSessionRules";

const SECRET = "s".repeat(40);
const HOST = "host-0000-account";
const JOIN_A = "join-aaaa-account";
const JOIN_B = "join-bbbb-account";
const HOME = "join-home-account";

function Hunt(): any {
    return {
        sessionId: "session-1", generation: 3, state: "RUNNING", hostAccountId: HOST, expiresAt: "2026-10-13T12:00:00.000Z",
        roster: [
            { accountId: HOST, admissionState: "ADMITTED" },
            { accountId: JOIN_A, admissionState: "ADMITTED" },
            { accountId: JOIN_B, admissionState: "LOST" },
            { accountId: HOME, admissionState: "ADMITTED", returnedToHubAt: "2026-10-13T10:00:00.000Z" }
        ]
    };
}

test("roles: the host, joiners still in the hunt, and nobody else", () => {
    assert.equal(ResolveIceRole(Hunt(), HOST), "HOST");
    assert.equal(ResolveIceRole(Hunt(), JOIN_A), "JOIN");
    assert.equal(ResolveIceRole(Hunt(), JOIN_B), "JOIN");          // lost players may rejoin
    assert.equal(ResolveIceRole(Hunt(), HOME), undefined);         // back in Ramsgate
    assert.equal(ResolveIceRole(Hunt(), "stranger-account"), undefined);
    assert.equal(IsIceActiveState("RUNNING"), true);
    assert.equal(IsIceActiveState("COMPLETED"), false);
    assert.equal(IsIceActiveState("ABORTING"), false);
});

test("a drained hunt's members keep their connections (DRAINING); its roster gains no admission from signalling (2026-10-15)", () => {
    // The members still on the drained server may rebuild their transport; admission is the ticket's (TICKETABLE_STATES).
    assert.equal(IsIceActiveState("DRAINING"), true);
    assert.equal(ResolveIceRole({ ...Hunt(), state: "DRAINING" }, JOIN_A), "JOIN");
    assert.equal(IsIceActiveState("FENCED"), false);
    assert.equal(IsIceActiveState("RECOVERING"), false);
});

test("pair keys: host and joiner get the same key, other pairs and generations differ", () => {
    const hostPeers = IcePeersFor(Hunt(), HOST, "HOST", SECRET);
    assert.deepEqual(hostPeers.map((peer) => peer.accountId), [JOIN_A, JOIN_B]);
    const joinPeers = IcePeersFor(Hunt(), JOIN_A, "JOIN", SECRET);
    assert.deepEqual(joinPeers.map((peer) => [peer.accountId, peer.role]), [[HOST, "HOST"]]);
    assert.equal(joinPeers[0].transportKey, hostPeers[0].transportKey);
    assert.notEqual(hostPeers[0].transportKey, hostPeers[1].transportKey);
    assert.notEqual(DeriveIcePairKey(SECRET, "session-1", 4, HOST, JOIN_A), hostPeers[0].transportKey);
    assert.equal(Buffer.from(hostPeers[0].transportKey, "base64url").length, 32);
});

test("signals: well-formed bodies only", () => {
    const valid = { generation: 3, toAccountId: HOST, kind: "CANDIDATE", data: "a=candidate:1 1 UDP 1 203.0.113.5 50000 typ srflx" };
    assert.deepEqual(ParseIceSignal(valid), valid);
    assert.equal(ParseIceSignal({ ...valid, kind: "OFFER" }), undefined);
    assert.equal(ParseIceSignal({ ...valid, generation: "3" }), undefined);
    assert.equal(ParseIceSignal({ ...valid, toAccountId: "../x" }), undefined);
    assert.equal(ParseIceSignal({ ...valid, data: "x".repeat(4097) }), undefined);
    assert.equal(ParseIceSignal({ ...valid, data: "café" }), undefined);
    assert.equal(ParseIceSignal({ ...valid, kind: "DESCRIPTION", data: "  " }), undefined);
    assert.deepEqual(ParseIceSignal({ generation: 3, toAccountId: HOST, kind: "GATHERING_DONE" }),
        { generation: 3, toAccountId: HOST, kind: "GATHERING_DONE", data: "" });
});

test("signals go only between the host and a joiner", () => {
    assert.equal(SignalRouteAllowed(Hunt(), HOST, JOIN_A), true);
    assert.equal(SignalRouteAllowed(Hunt(), JOIN_A, HOST), true);
    assert.equal(SignalRouteAllowed(Hunt(), JOIN_A, JOIN_B), false);
    assert.equal(SignalRouteAllowed(Hunt(), HOST, HOST), false);
    assert.equal(SignalRouteAllowed(Hunt(), HOST, HOME), false);
    assert.equal(SignalRouteAllowed(Hunt(), "stranger-account", HOST), false);
});

test("relay-only keeps relay candidates and the ICE credentials, never an address", () => {
    const description = [
        "c=IN IP4 192.168.1.20",
        "a=ice-ufrag:abcd",
        "a=ice-pwd:0123456789abcdef0123456789",
        "a=ice-options:ice2,trickle",
        "a=candidate:1 1 UDP 2122317823 192.168.1.20 50000 typ host",
        "a=candidate:2 1 UDP 1686052607 203.0.113.5 50000 typ srflx raddr 192.168.1.20 rport 50000",
        "a=candidate:3 1 UDP 41885439 104.30.1.1 3478 typ relay raddr 203.0.113.5 rport 50000",
        "a=end-of-candidates"
    ].join("\r\n");
    const kept = FilterRelayOnly("DESCRIPTION", description)!;
    assert.deepEqual(kept.split("\r\n"), [
        "a=ice-ufrag:abcd",
        "a=ice-pwd:0123456789abcdef0123456789",
        "a=ice-options:ice2,trickle",
        "a=candidate:3 1 UDP 41885439 104.30.1.1 3478 typ relay raddr 203.0.113.5 rport 50000",
        "a=end-of-candidates"
    ]);
    assert.equal(FilterRelayOnly("CANDIDATE", "a=candidate:1 1 UDP 2122317823 192.168.1.20 50000 typ host"), undefined);
    assert.equal(FilterRelayOnly("CANDIDATE", "a=candidate:3 1 UDP 41885439 104.30.1.1 3478 typ relay"),
        "a=candidate:3 1 UDP 41885439 104.30.1.1 3478 typ relay");
    assert.equal(FilterRelayOnly("DESCRIPTION", "a=candidate:3 1 UDP 1 104.30.1.1 3478 typ relay"), undefined);
    assert.equal(FilterRelayOnly("GATHERING_DONE", ""), "");
});
