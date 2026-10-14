/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadGameData } from "../gameData/loader";
import { BuildSlayersPathGraph, PlanHostPlayerJourney, SlayersPathNodeDefinition } from "./slayersPath";

// [2026-10-13 realms S3] The player-hosted server's Slayer's Path checks against the real graph
// (game-data/slayers_path_definitions.json + the served game-data/slayers_path.json).

const Definitions = loadGameData<Record<string, SlayersPathNodeDefinition>>("slayers_path_definitions.json");
const ServedNodeIds = Object.keys(loadGameData<any>("slayers_path.json").payload.nodes);
const Graph = BuildSlayersPathGraph(Definitions, ServedNodeIds);
const Unlocked = (...Ids: string[]) => Object.fromEntries(Ids.map((Id) => [Id, { node_id: Id, node_status: 2, objectives: [] }]));

test("the real graph is usable and every node a definition mentions is a node the game has", () => {
    assert.equal(Graph.usable, true);
    assert.ok(Graph.known.size >= 500, `expected the 509-node graph, got ${Graph.known.size}`);
    for (const NodeId of Object.keys(Definitions)) assert.ok(Graph.known.has(NodeId), `${NodeId} is defined but not known`);
    for (const NodeId of ServedNodeIds) assert.ok(Graph.known.has(NodeId), `${NodeId} is served but not known`);
    for (const [Child, Parents] of Graph.parents) {
        assert.ok(Graph.known.has(Child));
        assert.ok(Parents.length > 0);
    }
});

test("unlocking the whole graph in one save is accepted: every node is a root or reachable from one", () => {
    // Guards the data and the rule together: a cycle with no root, or a child listed under a parent that does not exist,
    // would strip real nodes for a host that really unlocked them.
    const Result = PlanHostPlayerJourney({}, Unlocked(...Graph.known), Graph);
    assert.deepEqual(Result.stripped, []);
    assert.equal(Result.unlocked.length, Graph.known.size);
});

test("a weapon special is stripped without its parent and accepted with it (Grim Onslaught)", () => {
    const Special = "WeaponTypeGA_Spc_00";
    const Parents = Graph.parents.get(Special);
    assert.ok(Parents !== undefined && Parents.length > 0, "the special must have a parent node");
    assert.deepEqual(Definitions[Special].rewards, ["PART_GA_SPECIAL_SKILLSHOT"]);

    const Alone = PlanHostPlayerJourney({}, Unlocked(Special), Graph);
    assert.deepEqual(Alone.stripped, [{ nodeId: Special, reason: "prerequisite" }]);
    assert.equal(Alone.nodes[Special].node_status, 0);

    const WithParent = PlanHostPlayerJourney(Unlocked(Parents[0]), { ...Unlocked(Parents[0]), ...Unlocked(Special) }, Graph);
    assert.deepEqual(WithParent.unlocked, [Special]);
    assert.deepEqual(WithParent.stripped, []);
});

test("the milestone chain is a chain: Slayer_00 is free, Slayer_05 needs its predecessor", () => {
    assert.equal(Graph.parents.has("Slayer_00"), false);
    assert.deepEqual(PlanHostPlayerJourney({}, Unlocked("Slayer_00"), Graph).unlocked, ["Slayer_00"]);

    const Skipped = PlanHostPlayerJourney(Unlocked("Slayer_00"), Unlocked("Slayer_00", "Slayer_05"), Graph);
    assert.deepEqual(Skipped.stripped.map((Strip) => Strip.nodeId), ["Slayer_05"]);

    const Predecessor = Graph.parents.get("Slayer_05")![0];
    const Next = PlanHostPlayerJourney(Unlocked(Predecessor), Unlocked(Predecessor, "Slayer_05"), Graph);
    assert.deepEqual(Next.unlocked, ["Slayer_05"]);
});

test("a node id the game does not have is refused, with the real graph", () => {
    const Result = PlanHostPlayerJourney({}, Unlocked("Slayer_00", "Definitely_Not_A_Node"), Graph);
    assert.deepEqual(Result.unlocked, ["Slayer_00"]);
    assert.deepEqual(Result.stripped, [{ nodeId: "Definitely_Not_A_Node", reason: "unknown-node" }]);
});
