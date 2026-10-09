/*
 * Generates the minimal inventory-storage policy bundled by Metagame (1.12 until 2026-10-08, now 1.14.7).
 * It extracts only catalog ids already referenced by TypeScript and JSON files under src;
 * the full extracted catalog remains outside the application repository.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const MetagameRoot = path.resolve(ScriptDir, "..");
const ProjectRoot = path.resolve(MetagameRoot, "..");
const SourceRoot = path.join(MetagameRoot, "src");
const CatalogOverride = process.env.MYSTICPARADOX_CATALOG_PATH ?? process.env.MYSTICPARADOX_CATALOG_1_12_PATH;
const CatalogPath = CatalogOverride
    ? path.resolve(CatalogOverride)
    : path.join(ProjectRoot, "Items_Analysis", "catalog_1_14_7.jsonl");
const OutputName = "inventory_storage_policy.json";
const OutputPath = path.join(MetagameRoot, "game-data", OutputName);

type CatalogRow = {
    itemId: string;
    isStackable?: boolean;
    maxQuantity?: number;
    tags?: string[];
};

function WalkSourceFiles(directory: string): string[] {
    const Out: string[] = [];
    for (const Entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const FullPath = path.join(directory, Entry.name);
        if (Entry.isDirectory()) {
            Out.push(...WalkSourceFiles(FullPath));
        } else if (/\.(ts|json)$/i.test(Entry.name) && Entry.name !== OutputName) {
            Out.push(FullPath);
        }
    }
    return Out;
}

if (!fs.existsSync(CatalogPath)) {
    throw new Error(`Catalog dump not found: ${CatalogPath}`);
}

const CatalogText = fs.readFileSync(CatalogPath, "utf8");
const Catalog = new Map<string, CatalogRow>();
for (const Line of CatalogText.split(/\r?\n/)) {
    if (!Line.trim()) continue;
    const Row = JSON.parse(Line) as CatalogRow;
    if (typeof Row.itemId === "string" && Row.itemId.length > 0) Catalog.set(Row.itemId, Row);
}

const SourceFiles = WalkSourceFiles(SourceRoot).sort();
const ReferencedIds = new Set<string>();
for (const SourceFile of SourceFiles) {
    const Text = fs.readFileSync(SourceFile, "utf8");
    // Catalog ids may contain hyphens (for example AC_BACK_HP06-1_00). Keep the
    // match broad, then require an exact catalog-map hit below.
    for (const Match of Text.matchAll(/[A-Z][A-Z0-9_-]{2,}/g)) {
        if (Catalog.has(Match[0])) ReferencedIds.add(Match[0]);
    }
}

const Entries: Record<string, { storage: "instanced" | "stacked"; maxQuantity: number; tags: string[] }> = {};
for (const CatalogId of [...ReferencedIds].sort()) {
    const Row = Catalog.get(CatalogId)!;
    Entries[CatalogId] = {
        storage: Row.isStackable === true ? "stacked" : "instanced",
        maxQuantity: Number.isFinite(Row.maxQuantity) ? Number(Row.maxQuantity) : 0,
        tags: Array.isArray(Row.tags) ? Row.tags.filter((Tag): Tag is string => typeof Tag === "string") : [],
    };
}

const Document = {
    schema: 1,
    targetVersion: "1.14.7",
    catalogSha256: crypto.createHash("sha256").update(CatalogText).digest("hex"),
    generatedAt: "2026-10-08",
    referencedCatalogIds: Object.keys(Entries).length,
    sourceScope: ["src/**/*.ts", "src/**/*.json"],
    entries: Entries,
};

fs.writeFileSync(OutputPath, JSON.stringify(Document, null, 2) + "\n", "utf8");
console.log(`Wrote ${OutputPath}`);
console.log(`Referenced catalog ids: ${Document.referencedCatalogIds}`);
console.log(`Catalog SHA-256: ${Document.catalogSha256}`);