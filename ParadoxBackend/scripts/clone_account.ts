
import crypto from "crypto";
import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import { HashPassword } from "../src/security/passwords";

const SOURCE_USER = process.env.CLONE_SOURCE_USER ?? "mysticparadox";



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
    const DisplayName = (process.argv[2] ?? "ExampleSlayer").trim();
    const Email = (process.argv[3] ?? "admin@example.com").trim().toLowerCase();
    const Password = process.argv[4] ?? crypto.randomBytes(9).toString("base64url");

    await GetPersistenceLifecycle().start();
    const Db = await GetMongoDb();

    const NewUser = crypto.randomUUID();

    
    if (await Db.collection(Collections.Accounts).findOne({ email: Email })) throw new Error(`email already in use: ${Email}`);
    if (await Db.collection(Collections.Accounts).findOne({ displayNameNormalized: DisplayName.toLowerCase() })) throw new Error(`display name taken: ${DisplayName}`);

    const SourceAccount: any = await Db.collection(Collections.Accounts).findOne({ _id: SOURCE_USER as any });
    if (!SourceAccount) throw new Error(`source account not found: ${SOURCE_USER}`);

    
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

    
    const CharMap: Record<string, string> = {};
    const SourceChars = await Db.collection(Collections.Characters).find({ userId: SOURCE_USER }).toArray();
    for (const c of SourceChars as any[]) {
        const NewCharId = crypto.randomUUID();
        CharMap[c.characterId ?? c._id] = NewCharId;
        await Db.collection(Collections.Characters).insertOne({
            ...c, _id: NewCharId as any, characterId: NewCharId, userId: NewUser
        });
    }

    
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
    console.log("password      :", Password, "  (store this — it is the launcher login)");
    console.log("cloned counts :", JSON.stringify(Counts));

    await GetPersistenceLifecycle().stop();
}

main().then(() => process.exit(0)).catch((e) => { console.error("CLONE FAILED:", e); process.exit(1); });
