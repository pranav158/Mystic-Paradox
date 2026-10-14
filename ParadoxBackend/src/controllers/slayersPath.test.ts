/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BuildSlayersPathGraph, HostJourneyPlan, PlanHostPlayerJourney, SlayersPathGraph, SlayersPathNodeDefinition } from "./slayersPath";

// [2026-10-13 realms S3] The checks on a player-hosted server's Slayer's Path save (PlanHostPlayerJourney), on a small
// synthetic graph so the file needs no game data:
//
//   A (root) -> B, C      B -> D      C -> D      D -> E      X (root)      Ghost (not a node of the game)
//
// The real graph is checked in slayersPath.gamedata.test.ts.

const Definitions: Record<string, SlayersPathNodeDefinition> = {
    A: { childNodes: ["B", "C"], currencyCosts: [{ currency: "CURRENCY_PJM_WEAPON", amount: 25 }] },
    B: { childNodes: ["D"] },
    C: { childNodes: ["D"] },
    D: { childNodes: ["E"], rewards: ["AC_SOMETHING"] },
    X: { currencyCosts: [{ currency: "CURRENCY_NOTES", amount: 10 }] },
};

// E has no definition row of its own (no cost, reward or child), like 50 nodes of the real graph; the served graph lists it.
const Graph: SlayersPathGraph = BuildSlayersPathGraph(Definitions, ["E", "A", "B", "C", "D", "X", "Loose"]);

const Node = (Id: string, Status: number, Extra: Record<string, unknown> = {}) => ({ node_id: Id, node_status: Status, objectives: [], ...Extra });
const MapOf = (...Entries: [string, number][]) => Object.fromEntries(Entries.map(([Id, Status]) => [Id, Node(Id, Status)]));
const Plan = (Stored: any, Merged: any, Graph_: SlayersPathGraph = Graph): HostJourneyPlan => PlanHostPlayerJourney(Stored, Merged, Graph_);
const Reasons = (Result: HostJourneyPlan) => Object.fromEntries(Result.stripped.map((Strip) => [Strip.nodeId, Strip.reason]));

test("the graph keeps every parent of a node, ignores empty children and knows served nodes", () => {
    const Built = BuildSlayersPathGraph({
        P1: { childNodes: ["K", "K", "None", ""] },
        P2: { childNodes: ["K", "L"] },
        Leaf: {},
    }, ["Served", ""]);
    assert.deepEqual(Built.parents.get("K"), ["P1", "P2"]);
    assert.deepEqual(Built.parents.get("L"), ["P2"]);
    assert.equal(Built.parents.has("P1"), false);
    assert.deepEqual([...Built.known].sort(), ["K", "L", "Leaf", "P1", "P2", "Served"]);
    assert.equal(Built.usable, true);
    assert.equal(BuildSlayersPathGraph({}).usable, false);
    assert.equal(BuildSlayersPathGraph(undefined as any).known.size, 0);
});

test("a root node is accepted, a child of a locked parent is stripped and keeps its stored status", () => {
    const Result = Plan(MapOf(["A", 0], ["B", 0]), {
        ...MapOf(["A", 0], ["X", 2]),
        B: Node("B", 2, { objectives: [{ id: "kills", progress: 3 }] }),
    });
    assert.deepEqual(Result.unlocked, ["X"]);
    assert.deepEqual(Reasons(Result), { B: "prerequisite" });
    assert.deepEqual(Result.nodes.B, Node("B", 0));                       // the stored entry
    assert.equal(Result.nodes.X.node_status, 2);
});

test("a stripped node the stored map did not have stays in the map, locked, with what the host sent for it", () => {
    const Result = Plan({}, { D: Node("D", 1, { objectives: [{ id: "x", progress: 2 }] }) });
    assert.deepEqual(Result.unlocked, []);
    assert.deepEqual(Result.nodes.D, { node_id: "D", node_status: 0, objectives: [{ id: "x", progress: 2 }] });
});

test("a child is accepted when a parent is already unlocked in the stored map, with either unlocked status", () => {
    assert.deepEqual(Plan(MapOf(["A", 2]), MapOf(["A", 2], ["B", 2])).unlocked, ["B"]);
    assert.deepEqual(Plan(MapOf(["A", 1]), MapOf(["A", 1], ["C", 1])).unlocked, ["C"]);   // LockedButClaimable counts
    const TwoParents = Plan(MapOf(["B", 2]), MapOf(["B", 2], ["D", 2]));                  // D has parents B and C: one is enough
    assert.deepEqual(TwoParents.unlocked, ["D"]);
    assert.deepEqual(Plan(MapOf(["C", 2]), MapOf(["C", 2], ["D", 2])).unlocked, ["D"]);
    assert.deepEqual(Plan(MapOf(["A", 2]), MapOf(["A", 2], ["D", 2])).stripped.map((Strip) => Strip.nodeId), ["D"]);   // A is not D's parent
});

test("a purchase and the children it unlocks in the same save are accepted in any key order", () => {
    const Reverse = { E: Node("E", 2), D: Node("D", 2), B: Node("B", 2), A: Node("A", 2) };
    const Result = Plan({}, Reverse);
    assert.deepEqual([...Result.unlocked].sort(), ["A", "B", "D", "E"]);
    assert.deepEqual(Result.stripped, []);
    assert.deepEqual(Object.keys(Result.nodes), ["E", "D", "B", "A"]);   // the map keeps its order
});

test("a broken link in a chain strips everything below it, and nothing above it", () => {
    // B is unlocked and D, E hang from it, but A (B's only parent) is locked: B, D and E all fail.
    const Result = Plan(MapOf(["A", 0]), MapOf(["A", 0], ["B", 2], ["D", 2], ["E", 2], ["X", 2]));
    assert.deepEqual(Result.unlocked, ["X"]);
    assert.deepEqual(Reasons(Result), { B: "prerequisite", D: "prerequisite", E: "prerequisite" });
    for (const Id of ["B", "D", "E"]) assert.equal(Result.nodes[Id].node_status, 0);
});

test("a node the game does not have is stripped, even though nothing lists a parent for it", () => {
    const Result = Plan({}, MapOf(["Ghost", 2], ["Loose", 2]));
    assert.deepEqual(Reasons(Result), { Ghost: "unknown-node" });
    assert.deepEqual(Result.unlocked, ["Loose"]);                       // served graph node with no edges: a root
    assert.equal(Result.nodes.Ghost.node_status, 0);
});

test("an unlocked node cannot be locked again by a host", () => {
    const Result = Plan(MapOf(["A", 2], ["X", 1]), MapOf(["A", 0], ["X", 0], ["B", 0]));
    assert.deepEqual(Result.relocked.sort(), ["A", "X"]);
    assert.equal(Result.nodes.A.node_status, 2);
    assert.equal(Result.nodes.X.node_status, 1);
    assert.deepEqual(Result.unlocked, []);
    assert.deepEqual(Result.stripped, []);
});

test("an unlocked entry whose node_id is another node is refused, because rewards are granted from node_id", () => {
    // X is a free root; the host files D's reward under it.
    const Disguised = Plan({}, { X: Node("A", 2) });
    assert.deepEqual(Reasons(Disguised), { X: "node-id-mismatch" });
    assert.equal(Disguised.nodes.X, undefined);                          // nothing stored: the stored map had no X
    assert.deepEqual(Disguised.unlocked, []);

    // Already stored and unlocked: overwriting it with a foreign node_id restores the stored entry.
    const Overwrite = Plan(MapOf(["X", 2]), { X: Node("D", 2) });
    assert.deepEqual(Reasons(Overwrite), { X: "node-id-mismatch" });
    assert.deepEqual(Overwrite.nodes.X, Node("X", 2));

    // A mismatch that was already stored (older data) is left alone: it is not this write.
    const Legacy = Plan({ X: Node("A", 2) }, { X: Node("A", 2) });
    assert.deepEqual(Legacy.stripped, []);
    assert.deepEqual(Legacy.nodes.X, Node("A", 2));

    // An entry without its own node_id is keyed by its key, as GetUnlockedNodeIds reads it.
    assert.deepEqual(Plan({}, { X: { node_status: 2, objectives: [] } }).unlocked, ["X"]);
});

test("nodes that were already unlocked, or are not unlocked, pass through unchanged and unreported", () => {
    const Stored = MapOf(["A", 2], ["B", 2], ["X", 0]);
    const Merged = { ...Stored, B: Node("B", 2, { objectives: [{ id: "more", progress: 9 }] }), E: Node("E", 0) };
    const Result = Plan(Stored, Merged);
    assert.deepEqual(Result.unlocked, []);
    assert.deepEqual(Result.stripped, []);
    assert.deepEqual(Result.relocked, []);
    assert.deepEqual(Result.nodes, Merged);
});

test("with no usable definitions every new unlock is refused and existing unlocks are kept", () => {
    const Unusable = BuildSlayersPathGraph({}, ["A", "B", "X"]);
    const Result = Plan(MapOf(["A", 2]), MapOf(["A", 2], ["X", 2]), Unusable);
    assert.deepEqual(Reasons(Result), { X: "definitions-unavailable" });
    assert.deepEqual(Result.unlocked, []);
    assert.equal(Result.nodes.A.node_status, 2);
    assert.equal(Result.nodes.X.node_status, 0);
});

test("a prototype key is an ordinary unknown node, and the result map has no polluted prototype", () => {
    const Merged = JSON.parse(`{"__proto__":{"node_id":"__proto__","node_status":2},"constructor":{"node_status":2},"A":{"node_id":"A","node_status":2}}`);
    const Result = Plan({}, Merged);
    assert.equal(Object.getPrototypeOf(Result.nodes), Object.prototype);
    assert.equal(({} as any).node_status, undefined);
    assert.deepEqual(Result.unlocked, ["A"]);
    assert.deepEqual(Reasons(Result), { ["__proto__"]: "unknown-node", constructor: "unknown-node" });   // computed: a literal __proto__ would set the prototype
    assert.equal(Object.hasOwn(Result.nodes, "__proto__"), true);
});

test("the inputs are never modified, and malformed inputs give an empty plan", () => {
    const Stored = MapOf(["A", 2]);
    const Merged = MapOf(["A", 0], ["B", 2], ["D", 2], ["X", 2]);
    const StoredBefore = JSON.stringify(Stored);
    const MergedBefore = JSON.stringify(Merged);
    Plan(Stored, Merged);
    assert.equal(JSON.stringify(Stored), StoredBefore);
    assert.equal(JSON.stringify(Merged), MergedBefore);

    for (const Bad of [undefined, null, "text", 7, []]) {
        const Result = Plan(Bad, Bad);
        assert.deepEqual(Result.nodes, {});
        assert.deepEqual([Result.unlocked, Result.stripped, Result.relocked], [[], [], []]);
    }
});

test("status 0, absent and sentinel statuses are not unlocks", () => {
    const Result = Plan({}, { B: Node("B", 0), D: Node("D", 3), E: { node_id: "E" }, X: Node("X", 255) });
    assert.deepEqual(Result.unlocked, []);
    assert.deepEqual(Result.stripped, []);
});
