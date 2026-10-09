"use strict";
// Read-only catalog evidence. No reward policy or inventory mutations.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const catalogPath = path.join(root, "Items_Analysis/catalog_1_14_7.jsonl");
const catalogText = fs.readFileSync(catalogPath, "utf8");
const catalog = new Map(catalogText.split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line); return [row.itemId, row];
}));
const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "../game-data/inventory_storage_policy.json"), "utf8"));
const ownershipTags = new Set(["transmog", "owned", "accessory", "dye", "bannercustomization", "emoji", "emote"]);
const sourceRows = [...catalog.values()];
const sourceStackableRows = sourceRows.filter(row => row.isStackable === true);
const sourcePositiveStackableRows = sourceStackableRows.filter(row => Number.isInteger(row.maxQuantity) && row.maxQuantity > 0);
// This is a review queue only.  It deliberately does not grant or approve anything:
// source catalog shape is not proof that the server loads the item or that the item
// is an acceptable economic reward.  The storage policy remains the grant authority.
const sourceHeuristicCandidates = sourcePositiveStackableRows
    .filter(row => row.maxQuantity !== 1)
    .filter(row => !String(row.itemId || "").toUpperCase().startsWith("CURRENCY_"))
    .filter(row => !(row.tags || []).some(tag => ownershipTags.has(String(tag).toLowerCase())))
    .filter(row => row.isBundle !== true && row.isContainer !== true);
const sourceReviewCandidates = sourceHeuristicCandidates
    .filter(row => !Object.prototype.hasOwnProperty.call(bundled.entries, row.itemId))
    .sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)))
    .map(row => ({
        itemId: row.itemId,
        displayName: row.displayName,
        maxQuantity: row.maxQuantity,
        tags: row.tags || [],
        itemClass: row.itemClass,
        isBundle: row.isBundle === true,
        isContainer: row.isContainer === true
    }));
const materialCandidates = Object.entries(bundled.entries).filter(([id, entry]) =>
    !id.startsWith("CURRENCY_") && entry.storage === "stacked" && entry.maxQuantity !== 1 &&
    !entry.tags.some(tag => ownershipTags.has(tag.toLowerCase())));
const zero = materialCandidates.filter(([, entry]) => entry.maxQuantity === 0);
const sourceMismatch = materialCandidates.filter(([id, entry]) => {
    const source = catalog.get(id);
    return !source || source.isStackable !== true || source.maxQuantity !== entry.maxQuantity;
}).map(([id]) => id);
const digest = crypto.createHash("sha256").update(catalogText).digest("hex");
console.log(JSON.stringify({
    catalogSha256: digest, bundledCatalogDigestMatches: digest === bundled.catalogSha256,
    bundledEntries: Object.keys(bundled.entries).length,
    sourceRows: sourceRows.length,
    sourceStackableRows: sourceStackableRows.length,
    sourcePositiveStackableRows: sourcePositiveStackableRows.length,
    sourceHeuristicPositiveCandidates: sourceHeuristicCandidates.length,
    sourceHeuristicCandidatesOutsideBundledPolicy: sourceReviewCandidates.length,
    sourceReviewCandidates,
    stackedNonCurrencyNonOwnership: materialCandidates.length,
    zeroQuantityEntries: zero.length,
    positiveQuantityEntries: materialCandidates.filter(([, entry]) => entry.maxQuantity > 0).length,
    sourceMismatch,
    syntheticExampleExistsInSource: catalog.has("CONTAINER_CELL_ACE"),
    examples: zero.slice(0, 8).map(([id]) => ({ id, sourceMaxQuantity: catalog.get(id)?.maxQuantity })),
    interpretation: "Source-only candidates are a review queue, not grant authorization. Storage policy presence, native/server loading evidence, quantity semantics and economy approval are still required. Zero semantics are not established by catalog data alone. No reward mapping approved."
}, null, 2));
if (sourceMismatch.length || digest !== bundled.catalogSha256) process.exitCode = 1;
