import assert from "node:assert/strict";
import test from "node:test";
import { BuildP2PMonitorItems } from "./p2pInventoryAuthorization";

test("monitor items mirror accepted normalized additions and omit currency and starter sentinels", () => {
    const items = BuildP2PMonitorItems([
        { catalogId: "PART_TAIL", instanceId: "one" },
        { catalogId: "PART_TAIL", instanceId: "two" },
        { catalogId: "CURRENCY_NOTES", instanceId: "invalid-currency-instance" },
        { catalogId: "DYE_BANNER_BACKGROUND_DEFAULT", instanceId: "invalid" }
    ], [
        { catalogId: "PART_TAIL", quantity: 3 },
        { catalogId: "CURRENCY_NOTES", quantity: 500 },
        { catalogId: "DYE_BANNER_SIGIL_DEFAULT", quantity: 1 },
        { catalogId: "BAD_QUANTITY", quantity: 0 }
    ]);

    assert.deepEqual(items, [{ itemId: "PART_TAIL", quantity: 5 }]);
});
