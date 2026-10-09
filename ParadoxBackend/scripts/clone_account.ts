/*
 * Clone the dev/backup account (userId="mystpax") into a brand-new launcher account
 * with the SAME progress but a fresh userId + fresh characterIds + login credentials.
 *
 * NON-DESTRUCTIVE: only INSERTS new documents. The source (mystpax) is never modified,
 * so it remains playable as a backup via start-client-direct.bat (dev fallback in
 * routes/eos.ts). The new account is playable via the launcher (email + password).
 *
 * Run:  npx tsx --env-file=.env scripts/clone_account.ts "<DisplayName>" "<email>" "<password>"
 *   The password (12+ characters) is required; it is never printed.
 */
import crypto from "crypto";
import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import { HashPassword } from "../src/security/passwords";

const SOURCE_USER = process.env.CLONE_SOURCE_USER ?? "mystpax";

// Per-character and per-user collections to clone. Accounts + Characters are handled
// specially (launcher fields / characterId map); the rest are generic field+_id remaps.
const PER_CHARACTER_OR_USER_COLLECTIONS = [
    Collections.Inventories,
    Collections.Loadouts,
    Collections.Breadcrumbs,
    Collections.EncounteredContent,
    Collections.Wallets,
    Collections.ProgressionTracks,
    Collections.ProgressionObjectives,
    Collections.PlayerJourney
];

function remapId(oldId: unknown, charMap: Record<string, string>, oldUser: string, newUser: string): any {
    if (typeof oldId !== "string") return crypto.randomUUID();
    if (oldId === oldUser) return newUser;
    if (charMap[oldId]) return charMap[oldId];
    let s = oldId;
    if (s.includes(oldUser)) s = s.split(oldUser).join(newUser);
    for (const [oc, nc] of Object.entries(charMap)) if (s.includes(oc)) s = s.split(oc).join(nc);
    return s !== oldId ? s : crypto.randomUUID();
}

function remapDoc(doc: any, charMap: Record<string, string>, oldUser: string, newUser: string): any {
    const out: any = { ...doc };
    out._id = remapId(doc._id, charMap, oldUser, newUser);
    if (out.userId === oldUser) out.userId = newUser;
    if (typeof out.characterId === "string" && charMap[out.characterId]) out.characterId = charMap[out.characterId];
    return out;
}

async function main() {
    const DisplayName = (process.argv[2] ?? "MysticFox").trim();
    const Email = (process.argv[3] ?? "admin@example.com").trim().toLowerCase();
    const Password = process.argv[4] ?? "";
    if (Password.length < 12) {
        console.error('usage: clone_account.ts "<DisplayName>" "<email>" "<password, 12+ characters>"');
        process.exit(2);
    }

    await GetPersistenceLifecycle().start();
    const Db = await GetMongoDb();

    const NewUser = crypto.randomUUID();

    // Guard: don't collide with an existing launcher account.
    if (await Db.collection(Collections.Accounts).findOne({ email: Email })) throw new Error(`email already in use: ${Email}`);
    if (await Db.collection(Collections.Accounts).findOne({ displayNameNormalized: DisplayName.toLowerCase() })) throw new Error(`display name taken: ${DisplayName}`);

    const SourceAccount: any = await Db.collection(Collections.Accounts).findOne({ _id: SOURCE_USER as any });
    if (!SourceAccount) throw new Error(`source account not found: ${SOURCE_USER}`);

    // 1. New accounts doc = source game fields (name/notes) + launcher credentials.
    await Db.collection(Collections.Accounts).insertOne({
        _id: NewUser as any,
        userId: NewUser,
        name: DisplayName,
        notes: SourceAccount.notes ?? 0,
        email: Email,
        displayNameNormalized: DisplayName.toLowerCase(),
        displayName: DisplayName,
        passwordHash: await HashPassword(Password),
        status: "active",
        roles: ["player"],
        createdAt: new Date().toISOString()
    } as any);

    // 2. Characters -> fresh characterIds (build map).
    const CharMap: Record<string, string> = {};
    const SourceChars = await Db.collection(Collections.Characters).find({ userId: SOURCE_USER }).toArray();
    for (const c of SourceChars as any[]) {
        const NewCharId = crypto.randomUUID();
        CharMap[c.characterId ?? c._id] = NewCharId;
        await Db.collection(Collections.Characters).insertOne({
            ...c, _id: NewCharId as any, characterId: NewCharId, userId: NewUser
        });
    }

    // 3. Everything keyed by userId and/or characterId — generic remap.
    const Counts: Record<string, number> = { characters: SourceChars.length };
    for (const Coll of PER_CHARACTER_OR_USER_COLLECTIONS) {
        const OldCharIds = Object.keys(CharMap);
        const Docs = await Db.collection(Coll).find({
            $or: [{ userId: SOURCE_USER }, { characterId: { $in: OldCharIds } }]
        }).toArray();
        let n = 0;
        for (const d of Docs as any[]) {
            await Db.collection(Coll).insertOne(remapDoc(d, CharMap, SOURCE_USER, NewUser));
            n++;
        }
        Counts[Coll] = n;
    }

    console.log("=== CLONE COMPLETE (source untouched) ===");
    console.log("source userId :", SOURCE_USER);
    console.log("new userId    :", NewUser);
    console.log("displayName   :", DisplayName);
    console.log("email         :", Email);
    console.log("password      : (as given; not logged)");
    console.log("cloned counts :", JSON.stringify(Counts));

    await GetPersistenceLifecycle().stop();
}

main().then(() => process.exit(0)).catch((e) => { console.error("CLONE FAILED:", e); process.exit(1); });
