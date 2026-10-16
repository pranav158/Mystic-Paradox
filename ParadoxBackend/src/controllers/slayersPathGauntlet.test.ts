import assert from "node:assert/strict";
import test from "node:test";
import { MergePlayerJourneyNodes } from "./progression";
import {
    BuildSlayersPathGraph, GAUNTLET_UNLOCK_NODE, JourneyNodesShownLocked, MaskJourneyNodesForPlayer, PlanHostPlayerJourney,
    RestoreJourneyNodesShownLocked
} from "./slayersPath";

// [2026-10-16] Gauntlet stays shown but disabled until MYSTICPARADOX_GAUNTLET=on: every journey answer serves Gauntlet_Unlock Locked,
// and a save that brings the masked status back keeps the stored unlock (no re-lock, no host-write warning, nothing lost).

const node = (id: string, status: number) => ({ node_id: id, node_status: status, objectives: [] });
const GRAPH = BuildSlayersPathGraph({ "Slayer_11": { childNodes: ["Prestige.Unlock"] }, "Prestige.Unlock": { childNodes: [GAUNTLET_UNLOCK_NODE] } });

test("[2026-10-16] Gauntlet_Unlock is shown Locked unless MYSTICPARADOX_GAUNTLET=on", () => {
    assert.deepEqual(JourneyNodesShownLocked({}), [GAUNTLET_UNLOCK_NODE]);
    assert.deepEqual(JourneyNodesShownLocked({ MYSTICPARADOX_GAUNTLET: "off" }), [GAUNTLET_UNLOCK_NODE]);
    assert.deepEqual(JourneyNodesShownLocked({ MYSTICPARADOX_GAUNTLET: " ON " }), []);
});

test("[2026-10-16] the answer is a masked copy: the unlocked node reads 0, everything else and the stored map are unchanged", () => {
    const Stored = { "Prestige.Unlock": node("Prestige.Unlock", 2), [GAUNTLET_UNLOCK_NODE]: node(GAUNTLET_UNLOCK_NODE, 2) };
    const Served = MaskJourneyNodesForPlayer(Stored, [GAUNTLET_UNLOCK_NODE]);
    assert.equal(Served[GAUNTLET_UNLOCK_NODE].node_status, 0);
    assert.equal(Served[GAUNTLET_UNLOCK_NODE].node_id, GAUNTLET_UNLOCK_NODE);
    assert.equal(Served["Prestige.Unlock"].node_status, 2);
    assert.equal(Stored[GAUNTLET_UNLOCK_NODE].node_status, 2, "the stored map is not changed");
    assert.equal(Object.hasOwn(MaskJourneyNodesForPlayer({ "Prestige.Unlock": node("Prestige.Unlock", 2) }, [GAUNTLET_UNLOCK_NODE]),
        GAUNTLET_UNLOCK_NODE), false, "an absent node stays absent");
    assert.equal(MaskJourneyNodesForPlayer(Stored, [])[GAUNTLET_UNLOCK_NODE].node_status, 2, "Gauntlet on: served as stored");
});

test("[2026-10-16] a host save that brings back the masked Locked status keeps the stored unlock, with no re-lock reported", () => {
    const Stored = {
        "Slayer_11": node("Slayer_11", 2), "Prestige.Unlock": node("Prestige.Unlock", 2), [GAUNTLET_UNLOCK_NODE]: node(GAUNTLET_UNLOCK_NODE, 2)
    };
    const Sent = MaskJourneyNodesForPlayer(Stored, [GAUNTLET_UNLOCK_NODE]);
    const Merged = MergePlayerJourneyNodes(Stored, Sent, 594, 593).nodes;
    const Plan = PlanHostPlayerJourney(Stored, RestoreJourneyNodesShownLocked(Stored, Merged, [GAUNTLET_UNLOCK_NODE]), GRAPH);
    assert.equal(Plan.nodes[GAUNTLET_UNLOCK_NODE].node_status, 2);
    assert.deepEqual(Plan.relocked, []);
    assert.deepEqual(Plan.stripped, []);
    assert.deepEqual(Plan.unlocked, []);
});

test("[2026-10-16] a real unlock while Gauntlet is off is still checked and stored, and served Locked", () => {
    const Stored = { "Slayer_11": node("Slayer_11", 2), "Prestige.Unlock": node("Prestige.Unlock", 2) };
    const Sent = { ...Stored, [GAUNTLET_UNLOCK_NODE]: node(GAUNTLET_UNLOCK_NODE, 2) };
    const Merged = MergePlayerJourneyNodes(Stored, Sent, 10, 9).nodes;
    const Plan = PlanHostPlayerJourney(Stored, RestoreJourneyNodesShownLocked(Stored, Merged, [GAUNTLET_UNLOCK_NODE]), GRAPH);
    assert.deepEqual(Plan.unlocked, [GAUNTLET_UNLOCK_NODE]);
    assert.equal(MaskJourneyNodesForPlayer(Plan.nodes, [GAUNTLET_UNLOCK_NODE])[GAUNTLET_UNLOCK_NODE].node_status, 0);
    // Without its parent the host check still refuses it, as before.
    const NoParent = { "Slayer_11": node("Slayer_11", 2) };
    const Refused = PlanHostPlayerJourney(NoParent, RestoreJourneyNodesShownLocked(NoParent,
        MergePlayerJourneyNodes(NoParent, { ...NoParent, [GAUNTLET_UNLOCK_NODE]: node(GAUNTLET_UNLOCK_NODE, 2) }, 10, 9).nodes,
        [GAUNTLET_UNLOCK_NODE]), GRAPH);
    assert.equal(Refused.nodes[GAUNTLET_UNLOCK_NODE].node_status, 0);
});

test("[2026-10-16] the game-server save path (no host check): a newer save with the masked status does not overwrite the unlock", () => {
    const Stored = { "Prestige.Unlock": node("Prestige.Unlock", 2), [GAUNTLET_UNLOCK_NODE]: node(GAUNTLET_UNLOCK_NODE, 2) };
    const Sent = MaskJourneyNodesForPlayer(Stored, [GAUNTLET_UNLOCK_NODE]);
    const Merged = MergePlayerJourneyNodes(Stored, Sent, 594, 593).nodes;
    assert.equal(Merged[GAUNTLET_UNLOCK_NODE].node_status, 0, "the plain merge alone would lose it");
    assert.equal(RestoreJourneyNodesShownLocked(Stored, Merged, [GAUNTLET_UNLOCK_NODE])[GAUNTLET_UNLOCK_NODE].node_status, 2);
    // With Gauntlet on nothing is restored: the merge decides, as before.
    assert.equal(RestoreJourneyNodesShownLocked(Stored, Merged, [])[GAUNTLET_UNLOCK_NODE].node_status, 0);
});
