/*
 * MasteryExporter - read-only export of the mastery card table and the achievements table.
 *
 * WHY THIS EXISTS
 * ---------------
 * The game server reports mastery and achievement progress to the backend as objective ids
 * (POST /progression/:userId -> objectives[].objective_id). The backend had no list of the ids the game can
 * really send, so it could only check their prefix. Both tables carry them:
 *
 *   mastery_card_table   (RowStruct Archon.MasteryCardTableData, 258 rows on 1.14.7)
 *       one row per mastery card (a Behemoth or one weapon/Behemoth pairing): CardType, GameObjectId,
 *       RewardTracks (MasteryTrack_PlayerLevel + the card's own track), BaseXPBarOnlineObjectiveId,
 *       PrestigeXPBarOnlineObjectiveId and Objectives[] = FMasteryObjectiveData
 *       { UniqueOnlineObjectiveId, CompoundObjectiveId, Objective.Amount, ... }
 *   achievements_table   (RowStruct Archon.AchievementTableData, 46 rows on 1.14.7)
 *       one row per achievement: TrackedObjectives[] = FTrackedObjectiveData { UniqueOnlineObjectiveId, Objective }
 *
 * Both are found by ROW STRUCT match across every loaded DataTable (the approach of SlayersPathExporter), so the
 * asset names do not matter.
 *
 * OUTPUT
 * ------
 *   <OutDir>\mastery_1_14_7\mastery_objectives.json
 * in exactly the shape of ParadoxBackend\game-data\mastery_objectives.json (copy it there to refresh the backend):
 *   { "schema": 1, "source": "...", "objectiveIds": [...sorted, unique...],
 *     "cards": [{ "cardId", "track", "objectives": [{ "id", "target", "type", "compoundId"?, "rank"?, ... }],
 *                 "type", "gameObjectId", "baseXpObjectiveId", "prestigeXpObjectiveId" }],
 *     "achievements": [{ "id", "objectives": [...] }] }
 *   objectiveIds = every UniqueOnlineObjectiveId of both tables plus the cards' XP-bar objective ids (the game
 *   reports those as objectives too). "target" is Objective.Amount; "rank"/"progressTrack" are the rank an
 *   *ProgressTo*-type objective waits for (Amount is 1 there); "type" is the ObjectiveData_* class without its prefix.
 *   Rows are written sorted by row name.
 *
 * FLAG
 * ----
 *   EXPORT_MASTERY=1   in export_flags.txt  (see ExportFlags.md)
 *
 * SAFETY
 * ------
 * Pure GObjects/RowMap read: FName, FString, POD and one UClass name per objective. No ProcessEvent, no hooks, no
 * writes into game memory, and NO FText (DisplayName / MasteryPopupText are FText - ToString() on one crashes the
 * process, see SlayersPathExporter.cpp). Every name read from live memory is SEH guarded.
 *
 * LOAD REQUIREMENT
 * ----------------
 * Only LOADED tables are visible. If catalog_export_status.txt says "no tables found with RowStruct=...", open the
 * Mastery board (and the achievements list) once and inject again. Not yet injected on 1.14.7; the same data was
 * extracted statically from the paks (Archon_25 / Archon_24) and the two outputs should agree on objectiveIds.
 */

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <set>
#include <map>
#include <fstream>
#include <algorithm>
#include <cstdint>

#include "SDK.hpp"
#include "ExportPaths.hpp"

using namespace SDK;

namespace MasteryExp {

static std::string JsonEsc(const std::string& s) {
    std::string o; o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char b[8]; sprintf_s(b, "\\u%04x", c & 0xFF); o += b;
                } else {
                    o += c;
                }
        }
    }
    return o;
}
static std::string Q(const std::string& s) { return "\"" + JsonEsc(s) + "\""; }

// Every string/name conversion from raw table memory is SEH guarded (same discipline as HuntExporter): a census must
// skip a malformed or mid-load row, not take down the game process.
__declspec(noinline) static void RawFStr(const FString& s, std::string* out) {
    if (s.Num() > 0 && s.IsValid()) *out = s.ToString();
}
__declspec(noinline) static void RawFNm(const FName& n, std::string* out) { *out = n.ToString(); }
__declspec(noinline) static void RawClassName(UClass* c, std::string* out) { *out = c->GetName(); }
static bool SehStr(const FString& s, std::string* out) {
    __try { RawFStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehNm(const FName& n, std::string* out) {
    __try { RawFNm(n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehClassName(UClass* c, std::string* out) {
    __try { RawClassName(c, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static std::string FStr(const FString& s) { std::string o; SehStr(s, &o); return o; }
static std::string FNm(const FName& n) { std::string o; SehNm(n, &o); return o; }

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[MasteryExporter] " + s + "\n").c_str());
    std::ofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[Mastery] " << s << "\n";
}

static std::vector<UDataTable*> FindDataTablesByRowStruct(const std::string& expectedRowStructName) {
    std::vector<UDataTable*> out;
    if (!UObject::GObjects) return out;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return out;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class || !obj->IsA(dtClass)) continue;
        UDataTable* dt = static_cast<UDataTable*>(obj);
        if (dt->RowStruct && dt->RowStruct->GetName() == expectedRowStructName) out.push_back(dt);
    }
    return out;
}

static bool RowCountIsSane(UDataTable* dt, int& outCount) {
    outCount = dt->RowMap.Num();
    return outCount >= 0 && outCount < 200000;
}

// Bounds for arrays read from live memory; a count outside them means the row is not what we think it is.
static const int kMaxObjectivesPerRow = 2000;
static const int kMaxTracksPerCard = 64;

// --- serializers -----------------------------------------------------------------------------

// One objective, the shape shared by both tables. `compound` is FMasteryObjectiveData::CompoundObjectiveId (empty for
// achievements). Returns false (and writes nothing) when the id cannot be read.
static bool SerializeObjective(const FTrackedObjectiveData& t, const FName* compound,
                               std::string* out, std::string* idOut) {
    const std::string id = FStr(t.UniqueOnlineObjectiveId);
    if (id.empty()) return false;
    *idOut = id;

    const FGameplayObjective& ob = t.Objective;
    std::string o = "{\"id\":" + Q(id);
    o += ",\"target\":" + std::to_string(ob.Amount);

    UClass* cls = ob.ObjectiveDataClass;
    std::string type;
    if (cls && SehClassName(cls, &type)) {
        static const std::string kPrefix = "ObjectiveData_";
        if (type.compare(0, kPrefix.size(), kPrefix) == 0) type = type.substr(kPrefix.size());
        if (!type.empty()) o += ",\"type\":" + Q(type);
    }

    if (compound) {
        const std::string c = FNm(*compound);
        if (!c.empty() && c != "None") o += ",\"compoundId\":" + Q(c);
    }

    if (ob.ProgressRank > 0) {
        o += ",\"rank\":" + std::to_string(ob.ProgressRank);
        const std::string trk = FNm(ob.ProgressTrack);
        if (!trk.empty() && trk != "None") o += ",\"progressTrack\":" + Q(trk);
    }
    o += "}";
    *out = o;
    return true;
}

struct CardRow { std::string name; const FMasteryCardTableData* row; };
struct AchRow  { std::string name; const FAchievementTableData* row; };

template <typename RowT, typename RecT>
static int CollectRows(const char* rowStruct, std::vector<RecT>* out, std::vector<std::string>* tableNames) {
    std::vector<UDataTable*> tables = FindDataTablesByRowStruct(rowStruct);
    if (tables.empty()) {
        Status(std::string("no tables found with RowStruct=") + rowStruct +
               " (not loaded yet? open the Mastery board / achievements once, then re-run)");
        return 0;
    }
    std::set<std::string> seen;
    int total = 0;
    for (UDataTable* dt : tables) {
        int rowCount = 0;
        if (!RowCountIsSane(dt, rowCount)) {
            Status("RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping");
            continue;
        }
        const std::string tableName = dt->GetName();
        tableNames->push_back(tableName);
        int written = 0;
        for (auto& Pair : dt->RowMap) {
            uint8_t* rowPtr = Pair.Value();
            if (!rowPtr) continue;
            const std::string rowName = FNm(Pair.Key());
            if (rowName.empty()) continue;
            if (!seen.insert(rowName).second) {
                Status("duplicate row name " + rowName + " in " + tableName + " - keeping the first");
                continue;
            }
            RecT rec; rec.name = rowName; rec.row = reinterpret_cast<const RowT*>(rowPtr);
            out->push_back(rec);
            ++written;
        }
        Status("read " + std::to_string(written) + "/" + std::to_string(rowCount) + " rows from " + tableName +
               " (RowStruct=" + rowStruct + ")");
        total += written;
    }
    std::sort(out->begin(), out->end(), [](const RecT& a, const RecT& b) { return a.name < b.name; });
    return total;
}

static std::string Today() {
    SYSTEMTIME st; GetSystemTime(&st);
    char buf[16]; sprintf_s(buf, "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
    return buf;
}

} // namespace MasteryExp

int RunMasteryExport() {
    using namespace MasteryExp;

    Status("starting read-only mastery_card_table / achievements_table export");
    if (!UObject::GObjects) { Status("GObjects unavailable; aborting"); return -1; }

    std::vector<CardRow> cardRows;
    std::vector<AchRow> achRows;
    std::vector<std::string> tableNames;
    CollectRows<FMasteryCardTableData>("MasteryCardTableData", &cardRows, &tableNames);
    CollectRows<FAchievementTableData>("AchievementTableData", &achRows, &tableNames);

    if (cardRows.empty() && achRows.empty()) {
        Status("neither table is loaded; nothing written");
        return 0;
    }

    std::set<std::string> objectiveIds;
    int skippedObjectives = 0, skippedRows = 0;

    // cards
    std::vector<std::string> cardJson;
    for (const CardRow& c : cardRows) {
        const FMasteryCardTableData& row = *c.row;
        const int nObj = row.Objectives.Num();
        const int nTrk = row.RewardTracks.Num();
        if (nObj < 0 || nObj > kMaxObjectivesPerRow || nTrk < 0 || nTrk > kMaxTracksPerCard) {
            Status("implausible array sizes on card " + c.name + " (objectives=" + std::to_string(nObj) +
                   " tracks=" + std::to_string(nTrk) + "); skipping row");
            ++skippedRows;
            continue;
        }

        // The card's own track: the reward track that is not the shared player-level one.
        std::string track;
        for (int i = 0; i < nTrk; ++i) {
            const std::string t = FNm(row.RewardTracks[i].RowName);
            if (!t.empty() && t != "None" && t != "MasteryTrack_PlayerLevel") { track = t; break; }
        }

        std::string s = "    {\n      \"cardId\": " + Q(c.name) + ", \"track\": " + (track.empty() ? "null" : Q(track)) + ",\n";
        s += "      \"objectives\": [";
        bool first = true;
        for (int i = 0; i < nObj; ++i) {
            const FMasteryObjectiveData& m = row.Objectives[i];
            std::string o, id;
            if (!SerializeObjective(m, &m.CompoundObjectiveId, &o, &id)) { ++skippedObjectives; continue; }
            objectiveIds.insert(id);
            s += std::string(first ? "\n        " : ",\n        ") + o;
            first = false;
        }
        s += first ? "],\n" : "\n      ],\n";

        std::vector<std::string> extras;
        const unsigned type = static_cast<unsigned>(row.CardType);
        if (type == static_cast<unsigned>(EMasteryCardType::Weapon)) extras.push_back("\"type\": \"Weapon\"");
        else if (type == static_cast<unsigned>(EMasteryCardType::Behemoth)) extras.push_back("\"type\": \"Behemoth\"");
        else extras.push_back("\"type\": null");
        const std::string gameObject = FStr(row.GameObjectId);
        if (!gameObject.empty()) extras.push_back("\"gameObjectId\": " + Q(gameObject));
        const std::string baseXp = FStr(row.BaseXPBarOnlineObjectiveId);
        if (!baseXp.empty() && baseXp != "None") { objectiveIds.insert(baseXp); extras.push_back("\"baseXpObjectiveId\": " + Q(baseXp)); }
        const std::string prestigeXp = FStr(row.PrestigeXPBarOnlineObjectiveId);
        if (!prestigeXp.empty() && prestigeXp != "None") { objectiveIds.insert(prestigeXp); extras.push_back("\"prestigeXpObjectiveId\": " + Q(prestigeXp)); }
        s += "      ";
        for (size_t i = 0; i < extras.size(); ++i) s += (i ? ", " : "") + extras[i];
        s += "\n    }";
        cardJson.push_back(s);
    }

    // achievements
    std::vector<std::string> achJson;
    for (const AchRow& a : achRows) {
        const FAchievementTableData& row = *a.row;
        const int nObj = row.TrackedObjectives.Num();
        if (nObj < 0 || nObj > kMaxObjectivesPerRow) {
            Status("implausible TrackedObjectives size on achievement " + a.name + " (" + std::to_string(nObj) + "); skipping row");
            ++skippedRows;
            continue;
        }
        std::string s = "    {\n      \"id\": " + Q(a.name) + ",\n      \"objectives\": [";
        bool first = true;
        for (int i = 0; i < nObj; ++i) {
            std::string o, id;
            if (!SerializeObjective(row.TrackedObjectives[i], nullptr, &o, &id)) { ++skippedObjectives; continue; }
            objectiveIds.insert(id);
            s += std::string(first ? "\n        " : ",\n        ") + o;
            first = false;
        }
        s += first ? "]\n    }" : "\n      ]\n    }";
        achJson.push_back(s);
    }

    std::string tablesText;
    for (size_t i = 0; i < tableNames.size(); ++i) tablesText += (i ? ", " : "") + tableNames[i];

    std::string out = "{\n  \"schema\": 1,\n";
    out += "  \"source\": " + Q("Dauntless 1.14.7 CL 647472: mastery_card_table, achievements_table (CatalogExporter live export of " +
                                tablesText + "), extracted " + Today()) + ",\n";
    out += "  \"objectiveIds\": [";
    {
        bool first = true;
        for (const std::string& id : objectiveIds) {   // std::set: sorted, unique
            out += std::string(first ? "\n    " : ",\n    ") + Q(id);
            first = false;
        }
        out += first ? "],\n" : "\n  ],\n";
    }
    out += "  \"cards\": [";
    for (size_t i = 0; i < cardJson.size(); ++i) out += std::string(i ? ",\n" : "\n") + cardJson[i];
    out += cardJson.empty() ? "],\n" : "\n  ],\n";
    out += "  \"achievements\": [";
    for (size_t i = 0; i < achJson.size(); ++i) out += std::string(i ? ",\n" : "\n") + achJson[i];
    out += achJson.empty() ? "]\n" : "\n  ]\n";
    out += "}\n";

    const std::wstring dir = ResolveOutDir() + L"\\mastery_1_14_7";
    CreateDirectoryW(dir.c_str(), nullptr);
    std::ofstream f(dir + L"\\mastery_objectives.json", std::ios::binary | std::ios::trunc);
    if (!f) { Status("cannot open mastery_1_14_7\\mastery_objectives.json"); return -1; }
    f.write(out.data(), static_cast<std::streamsize>(out.size()));
    f.close();

    Status("DONE cards=" + std::to_string(cardJson.size()) + " achievements=" + std::to_string(achJson.size()) +
           " objectiveIds=" + std::to_string(objectiveIds.size()) + " skippedRows=" + std::to_string(skippedRows) +
           " skippedObjectives=" + std::to_string(skippedObjectives));
    return static_cast<int>(cardJson.size() + achJson.size());
}
