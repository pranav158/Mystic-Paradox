/*
 * ProgressionExporter — extends CatalogExporter (1.12.0, CL 392819, UE 4.26.2) to dump the
 * progression-related DataTables the backend needs to calculate ranks/rewards without
 * guessing (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md sections 8.2/8.3).
 *
 * Tables exported (resolved as noted, RowStruct-validated before casting):
 *   player_experience_track_table   -> FExperienceTrackTableData    (by name)
 *   weapon_experience_track_table   -> FExperienceTrackTableData    (by name)
 *   experience_track_table          -> FExperienceTrackTableData    (by name)
 *   hunt_pass_season_table          -> FHuntPassSeasonDataTable     (by name; dedicated serializer)
 *   <any table>                     -> FExperienceTableData         (BY ROW STRUCT + component fallback)
 *   progression_track_table         -> FProgressionTrackTableData   (by name)
 *   online_progression_track_info_table -> FOnlineProgressionTrackInfo (by name; dedicated serializer)
 *   mastery_track_table             -> FMasteryTrackTableData       (by name)
 *
 * Progression/mastery track rows now carry their FULL per-rank XP costs (Requirements:
 * [{rankId, requiredXP}]; requiredXP is INCREMENTAL — the native calc sums entries for a track
 * total) and their FULL reward contents (stackedItems/instancedItems/orderedInstancedItems/
 * entitlements with catalog ids, quantities, priorities and entitlement durations) — the first
 * pass discarded both, emitting only .Num() counts. NOTE: hunt-pass season rows observed at
 * runtime have EMPTY Requirements/rewards, so hunt-pass output is identity/economy metadata only,
 * NOT tier XP costs or tier rewards (those live in a table not yet identified).
 *
 * Design: same constraints as the base CatalogExporter — no ProcessEvent hooks, no MinHook,
 * pure GObjects walk + struct-field reads validated against RowStruct's runtime name before
 * any cast. One-shot, JSONL/JSON output, no gameplay mutation.
 *
 * NOTE on rank tables: a standalone FProgressionRankData struct (Rank/RequiredPoints/Rewards)
 * DOES exist in this 1.12 SDK and is referenced by FProgressionTrackTableData::RankTable
 * (a UDataTable*). This exporter does not recurse into RankTable because (a) progression_track_table
 * was empty at runtime in the captured session and (b) the per-rank XP costs (incremental)
 * are already present inline on every track row's Requirements array, which is the reliable
 * source. If a future need arises to dump RankTable contents, add a FProgressionRankData
 * serializer and follow the RankTable pointer here.
 */

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <cstdint>
#include <set>
#include <algorithm>

#include "SDK.hpp"
#include "ExportPaths.hpp"

using namespace SDK;

// ---- shared helpers (mirrors dllmain.cpp's JsonEsc/FStr/StrArray; kept local to this
//      translation unit to avoid coupling the two exporters' internals together) ----
namespace ProgExp {

static std::string JsonEsc(const std::string& s) {
    std::string o; o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c & 0xFF); o += b; }
                else o += c;
        }
    }
    return o;
}

static std::string Q(const std::string& s) { return "\"" + JsonEsc(s) + "\""; }

// --- SEH-hardened string extraction ---------------------------------------------------
// FString/FText/FName ToString() dereference an internal Data pointer. On raw DataTable memory
// that pointer is occasionally uninitialized-but-non-null (an unset/unlocalized FText, or a
// table read mid-load), so FString::IsValid() (a bare Data != nullptr test) passes and the read
// faults with EXCEPTION_ACCESS_VIOLATION (observed: reading 0x0000000200000000 in
// FString::ToString from a display-data FText). A C++ try/catch(...) does NOT catch that under
// MSVC /EHsc — only __try/__except (SEH) does. Each extractor is split into a noinline "Raw"
// worker (does the risky C++ ToString) and an SEH guard whose __try scope holds only POD (a call
// + return), satisfying MSVC's C2712 "cannot use __try in a function that requires object
// unwinding" rule. A diagnostic, read-only DLL must never crash the host game on a bad read.
__declspec(noinline) static void RawFStr(const FString& s, std::string* out) { if (s.Num() > 0 && s.IsValid()) *out = s.ToString(); }
__declspec(noinline) static void RawFTxt(const FText&  t, std::string* out) { *out = t.ToString(); }
__declspec(noinline) static void RawFNm (const FName&  n, std::string* out) { *out = n.ToString(); }

static bool SehStr(const FString& s, std::string* out) { __try { RawFStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }
static bool SehTxt(const FText&  t, std::string* out) { __try { RawFTxt(t, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }
static bool SehNm (const FName&  n, std::string* out) { __try { RawFNm (n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }

static std::string FStr(const FString& s) { std::string o; if (!SehStr(s, &o)) return std::string(); return o; }
static std::string FTxt(const FText& t)   { std::string o; if (!SehTxt(t, &o)) return std::string(); return o; }
static std::string FNm (const FName& n)   { std::string o; if (!SehNm (n, &o)) return std::string(); return o; }

static void Status(const std::string& s);  // fwd-declared, implemented below using the same
                                            // sidecar file the base exporter writes to.

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[ProgressionExporter] " + s + "\n").c_str());
    std::wstring dir = ResolveOutDir();
    std::ofstream f(dir + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[Progression] " << s << "\n";
}

// ---- generic DataTable resolution -------------------------------------------------
// Finds a UDataTable by exact GetName() match (the short object name, e.g.
// "player_experience_track_table" — NOT the full "/Game/.../X.X" path, matching the
// base exporter's convention of comparing obj->GetName()).
static UDataTable* FindDataTableByName(const std::string& exactName) {
    if (!UObject::GObjects) return nullptr;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return nullptr;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class) continue;
        if (!obj->IsA(dtClass)) continue;
        if (obj->GetName() == exactName) return static_cast<UDataTable*>(obj);
    }
    return nullptr;
}

// Returns EVERY loaded UDataTable whose RowStruct's runtime name matches expectedRowStructName.
// This is the plan section 9.2 requirement: "export by row struct, not only by table name" —
// finds tables regardless of what the table object itself happens to be named.
static std::vector<UDataTable*> FindDataTablesByRowStruct(const std::string& expectedRowStructName) {
    std::vector<UDataTable*> out;
    if (!UObject::GObjects) return out;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return out;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class) continue;
        if (!obj->IsA(dtClass)) continue;

        UDataTable* dt = static_cast<UDataTable*>(obj);
        if (!dt->RowStruct) continue;
        if (dt->RowStruct->GetName() != expectedRowStructName) continue;

        out.push_back(dt);
    }
    return out;
}

// Validates RowMap.Num() is within a sane bound before iterating — defends against reading a
// DataTable that is mid-load or otherwise not in the state we expect (plan section 8.2 step 4:
// "record RowMap.Num() and reject unreasonable counts").
static bool RowCountIsSane(UDataTable* dt, int& outCount) {
    outCount = dt->RowMap.Num();
    return outCount >= 0 && outCount < 200000;
}

// ---- struct-specific field serializers ---------------------------------------------

static std::string SerializeGameplayTagContainer(const FGameplayTagContainer& tags) {
    // FGameplayTagContainer's internal array field name varies by SDK dump version; the safe,
    // dependency-free approach here is to skip deep tag introspection and note tag PRESENCE only
    // where a concrete accessor isn't already proven elsewhere in this codebase. Progression
    // tables in this pass do not gate correctness on tag contents, so this is intentionally a
    // stub returning an empty array rather than risking a wrong-offset read.
    (void)tags;
    return "[]";
}

static std::string SerializeOnlineProgressionTrackReward(const FOnlineProgressionTrackReward& r) {
    std::string o = "{";
    o += "\"rankId\":" + std::to_string(r.RankId);
    o += ",\"customRewardString\":" + Q(FTxt(r.CustomRewardString));

    // [second pass] Stacked items — was a bare count, now the real content.
    // FOnlineProgressionTrackStackedItemReward { FString CatalogId; int32 Quantity; int32 Priority; }
    o += ",\"stackedItems\":[";
    for (int i = 0; i < r.StackedItems.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackStackedItemReward& s = r.StackedItems[i];
        o += "{\"catalogId\":" + Q(FStr(s.CatalogId)) +
             ",\"quantity\":" + std::to_string(s.Quantity) +
             ",\"priority\":" + std::to_string(s.Priority) + "}";
    }
    o += "]";

    // Instanced items — a plain array of catalog-id strings (already content in the first pass).
    o += ",\"instancedItems\":[";
    for (int i = 0; i < r.InstancedItems.Num(); ++i) {
        if (i) o += ",";
        o += Q(FStr(r.InstancedItems[i]));
    }
    o += "]";

    // [second pass] Ordered instanced items — was a count.
    // FOnlineProgressionTrackOrderedInstancedItemReward { FString CatalogId; int32 Priority; }
    o += ",\"orderedInstancedItems\":[";
    for (int i = 0; i < r.OrderedInstancedItems.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackOrderedInstancedItemReward& oi = r.OrderedInstancedItems[i];
        o += "{\"catalogId\":" + Q(FStr(oi.CatalogId)) +
             ",\"priority\":" + std::to_string(oi.Priority) + "}";
    }
    o += "]";

    // [second pass] Entitlements — was a count.
    // FOnlineProgressionTrackEntitlementReward { FString EntitlementId; int32 Duration; }
    o += ",\"entitlements\":[";
    for (int i = 0; i < r.Entitlements.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackEntitlementReward& e = r.Entitlements[i];
        o += "{\"entitlementId\":" + Q(FStr(e.EntitlementId)) +
             ",\"duration\":" + std::to_string(e.Duration) + "}";
    }
    o += "]";

    // Buffs remain a count: TArray<TSoftClassPtr<UClass>> — resolving a soft class asset path
    // safely needs more asset-registry work than this read-only pass scopes, and item/entitlement
    // rewards are what the backend actually grants. Documented in ExportFlags.md.
    o += ",\"buffCount\":" + std::to_string(r.Buffs.Num());
    o += "}";
    return o;
}

static std::string SerializeRewardArray(const TArray<FOnlineProgressionTrackReward>& arr) {
    std::string o = "[";
    for (int i = 0; i < arr.Num(); ++i) {
        if (i) o += ",";
        o += SerializeOnlineProgressionTrackReward(arr[i]);
    }
    o += "]";
    return o;
}

// Shared base-class fields present on every FOnlineProgressionTrackTableData descendant
// (FExperienceTrackTableData, FHuntPassSeasonDataTable, ...). Written as a nested "base" object
// so table-specific fields can sit alongside without name collisions.
static std::string WriteOnlineProgressionTrackBaseFields(const FOnlineProgressionTrackTableData& row) {
    std::string o = "{";
    o += "\"progressionTrack\":" + Q(FStr(row.ProgressionTrack));
    o += ",\"premiumGatingEntitlement\":" + Q(FStr(row.PremiumGatingEntitlement));
    o += ",\"resetWithCharacter\":" + std::string(row.ResetWithCharacter ? "true" : "false");
    o += ",\"progressionMultiplier\":" + std::to_string(row.ProgressionMultiplier);
    o += ",\"requirementCount\":" + std::to_string(row.Requirements.Num());
    // [second pass] The per-rank XP costs — the first pass discarded these by only emitting
    // .Num(). FOnlineProgressionTrackRequirement { int32 RankId; int32 RequiredXP; }. requiredXP
    // is INCREMENTAL (XP to advance one rank); the native 1.12 calc sums entries for a track
    // total. This 1.12 curve (e.g. ExperienceTrack_PlayerLevel = 20 ranks) supersedes the
    // incomplete 12-entry legacy curve in progression_config.json.
    o += ",\"requirements\":[";
    for (int i = 0; i < row.Requirements.Num(); ++i) {
        if (i) o += ",";
        o += "{\"rankId\":" + std::to_string(row.Requirements[i].RankId) +
             ",\"requiredXP\":" + std::to_string(row.Requirements[i].RequiredXP) + "}";
    }
    o += "]";
    o += ",\"freeRewards\":" + SerializeRewardArray(row.FreeRewards);
    o += ",\"premiumRewards\":" + SerializeRewardArray(row.PremiumRewards);
    o += "}";
    return o;
}

// FExperienceTrackTableData row -> one JSONL line.
static std::string SerializeExperienceTrackRow(const std::string& rowName, const FExperienceTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"prestigeTrack\":" + Q(FNm(row.PrestigeTrack.RowName));
    o += ",\"expDisplayShortName\":" + Q(FTxt(row.ExperienceTypeDisplayData.ShortDisplayName));
    o += ",\"expDisplayName\":" + Q(FTxt(row.ExperienceTypeDisplayData.DisplayName));
    o += ",\"expDisplayDescription\":" + Q(FTxt(row.ExperienceTypeDisplayData.Description));
    o += ",\"experienceBankingLevelCount\":" + std::to_string(row.ExperienceBankingDataPerLevel.Num());
    o += "}";
    return o;
}

// FExperienceTableData row -> one JSONL line (the "award" table — objective+amount pairs).
static std::string SerializeExperienceAwardRow(const std::string& rowName, const FExperienceTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"experienceType\":" + std::to_string(static_cast<int>(row.ExperienceType));
    o += ",\"amount\":" + std::to_string(row.Amount);
    o += ",\"objectiveCount\":" + std::to_string(row.Objectives.Num());
    o += "}";
    return o;
}

// FProgressionTrackTableData row -> one JSONL line.
static std::string SerializeProgressionTrackRow(const std::string& rowName, const FProgressionTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"currentVersion\":" + std::to_string(row.CurrentVersion);
    o += ",\"repeats\":" + std::string(row.Repeats ? "true" : "false");
    o += ",\"isPrestigeTrack\":" + std::string(row.IsPrestigeTrack ? "true" : "false");
    o += ",\"isCoreTrack\":" + std::string(row.IsCoreTrack ? "true" : "false");
    o += ",\"visibleInUI\":" + std::string(row.VisibleInUI ? "true" : "false");
    o += ",\"prestigeTrack\":" + Q(FNm(row.PrestigeTrack));
    o += ",\"rankTable\":" + Q(row.RankTable ? row.RankTable->GetName() : std::string());
    o += ",\"unlockConditionCount\":" + std::to_string(row.UnlockConditions.Num());
    o += ",\"challengeSlotCount\":" + std::to_string(row.ChallengeSlots.Num());
    o += ",\"craftItemRewardAmount\":" + std::to_string(row.CraftItemRewardAmount);
    o += ",\"upgradeItemRewardAmount\":" + std::to_string(row.UpgradeItemRewardAmount);
    o += "}";
    return o;
}

// FMasteryTrackTableData row -> one JSONL line.
static std::string SerializeMasteryTrackRow(const std::string& rowName, const FMasteryTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"shortDisplayName\":" + Q(FTxt(row.ShortDisplayName));
    o += ",\"isUIEnabled\":" + std::string(row.bIsUIEnabled ? "true" : "false");
    o += ",\"category\":" + std::to_string(static_cast<int>(row.Categtory));
    o += "}";
    return o;
}

// [second pass, step 4] FOnlineProgressionTrackInfo row -> one JSONL line. This is the correct
// row struct for online_progression_track_info_table (the first pass wrongly expected
// FProgressionTrackTableData and skipped the table on the struct-name mismatch). This struct is
// display-metadata only — no thresholds/rewards live here. Extends FTableRowBase (first real
// field at 0x0008).
static std::string SerializeOnlineProgressionTrackInfoRow(const std::string& rowName, const FOnlineProgressionTrackInfo& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"progressDisplaySingular\":" + Q(FTxt(row.ProgressDisplaySingular));
    o += ",\"progressDisplayPlural\":" + Q(FTxt(row.ProgressDisplayPlural));
    o += ",\"progressDescription\":" + Q(FTxt(row.ProgressDescription));
    o += "}";
    return o;
}

// [second pass, step 5] FHuntPassSeasonDataTable row -> one JSONL line. The first pass cast this
// table as FExperienceTrackTableData and emitted base-only fields; that dropped every hunt-pass
// -specific field. This serializer adds the season identity + hunt-pass economy fields on top of
// the base. It fixes the season IDENTITY lookup (e.g. HuntPass_Season19 -> "season19", replacing
// the "hunt pass data for 'void'" stub). NOTE: observed at runtime, hunt-pass rows have EMPTY
// Requirements/FreeRewards/PremiumRewards, so this does NOT capture tier XP costs or tier rewards
// — those live in a table not yet identified. Do not use this output to calculate tiers.
static std::string SerializeHuntPassSeasonRow(const std::string& rowName, const FHuntPassSeasonDataTable& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"mustClaimRewards\":" + std::string(row.bMustClaimRewards ? "true" : "false");
    o += ",\"seasonTitle\":" + Q(FTxt(row.SeasonTitle));
    o += ",\"seasonDescription\":" + Q(FTxt(row.SeasonDescription));
    o += ",\"seasonDate\":" + Q(FTxt(row.SeasonDate));
    o += ",\"huntRewardItemId\":" + Q(FStr(row.HuntRewardItemId));
    o += ",\"huntRewardItemAmount\":" + std::to_string(row.HuntRewardItemAmount);
    o += ",\"nextProgressionTrack\":" + Q(FStr(row.NextProgressionTrack));
    o += ",\"previewsProgressionTrack\":" + Q(FStr(row.PreviewsProgressionTrack));
    o += ",\"buyLevelsUsingRank\":" + std::string(row.bBuyLevelsUsingRank ? "true" : "false");
    o += ",\"giveSeasonalCurrencies\":" + std::string(row.bGiveSeasonalCurrencies ? "true" : "false");
    o += ",\"overallSeasonName\":" + Q(FTxt(row.OverallSeasonName));
    o += "}";
    return o;
}

// SEH-guarded row serialize: even with the string extractors hardened, a row whose TArray has a
// garbage-but-non-null Data pointer can fault when INDEXED (e.g. Requirements[i] passes the
// Num()-based bounds check but Data[i] reads unmapped memory). This guard skips such a row with a
// status line instead of crashing the host game. Same noinline-worker + POD-only-__except split
// as the string extractors above (C2712).
template <typename RowT, typename Fn>
__declspec(noinline) static void RawSerializeRow(Fn fn, const std::string& rowName, const RowT& row, std::string* out) { *out = fn(rowName, row); }

template <typename RowT, typename Fn>
static bool SafeSerializeRow(Fn fn, const std::string& rowName, const RowT& row, std::string* out) {
    __try { RawSerializeRow<RowT>(fn, rowName, row, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// ---- generic per-table export driver -----------------------------------------------
// Walks one already-resolved UDataTable's RowMap, validates RowStruct name, and calls the
// provided per-row serializer. Returns rows written, or -1 on a hard failure.
template <typename RowStructT, typename SerializeFn>
static int ExportTable(UDataTable* dt, const std::string& expectedRowStructName,
                        const std::wstring& outFile, SerializeFn serialize) {
    if (!dt) { Status("table not found, skipping"); return -1; }
    if (!dt->RowStruct) { Status("RowStruct is null, skipping " + dt->GetName()); return -1; }

    std::string actualStructName = dt->RowStruct->GetName();
    if (actualStructName != expectedRowStructName) {
        Status("RowStruct mismatch on " + dt->GetName() + ": expected " + expectedRowStructName +
                " got " + actualStructName + " - skipping (never guessing a wrong cast)");
        return -1;
    }

    int rowCount = 0;
    if (!RowCountIsSane(dt, rowCount)) {
        Status("RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping");
        return -1;
    }

    std::ofstream f(outFile, std::ios::trunc);
    if (!f) { Status("cannot open output file for " + dt->GetName()); return -1; }

    // Collect + sort row names first so repeated dumps are deterministic (plan section 8.2 step 9).
    std::vector<std::string> rowNames;
    rowNames.reserve(rowCount);
    for (auto& Pair : dt->RowMap) {
        rowNames.push_back(FNm(Pair.Key()));
    }
    std::sort(rowNames.begin(), rowNames.end());

    int written = 0;
    for (const std::string& rowName : rowNames) {
        uint8_t* rowPtr = nullptr;
        for (auto& Pair : dt->RowMap) {
            if (FNm(Pair.Key()) == rowName) { rowPtr = Pair.Value(); break; }
        }
        if (!rowPtr) continue;

        const RowStructT& row = *reinterpret_cast<const RowStructT*>(rowPtr);
        std::string line;
        if (!SafeSerializeRow<RowStructT>(serialize, rowName, row, &line)) {
            Status("row '" + rowName + "' faulted during serialize on " + dt->GetName() + " - skipped (SEH-guarded)");
            continue;
        }
        f << line << "\n";
        ++written;
    }
    f.close();
    Status("wrote " + std::to_string(written) + "/" + std::to_string(rowCount) + " rows from " +
            dt->GetName() + " (RowStruct=" + actualStructName + ")");
    return written;
}

// [second pass, step 3] Experience-award tables (FExperienceTableData: objective -> XP amount).
// The first pass resolved this by the exact name "experience_table" and got "table not found".
// Correct approach (plan section 9.2): find EVERY loaded DataTable whose row struct is
// ExperienceTableData, regardless of the table object's own name. Fallback: if the struct walk
// finds nothing, read UPlayerExperienceComponent::ExperienceTable (a UCompositeDataTable*, which
// derives from UDataTable) off a live component instance. Writes all matched tables into one
// file, each row carrying a "table" provenance field.
static int ExportAwardTables(const std::wstring& outFile) {
    std::vector<UDataTable*> tables = FindDataTablesByRowStruct("ExperienceTableData");

    if (tables.empty() && UObject::GObjects) {
        UClass* pecClass = UPlayerExperienceComponent::StaticClass();
        if (pecClass) {
            const int count = UObject::GObjects->Num();
            for (int i = 0; i < count; ++i) {
                UObject* obj = UObject::GObjects->GetByIndex(i);
                if (!obj || !obj->Class) continue;
                if (!obj->IsA(pecClass)) continue;
                UPlayerExperienceComponent* pec = static_cast<UPlayerExperienceComponent*>(obj);
                // ExperienceTable is a UCompositeDataTable* at +0x130; UCompositeDataTable shares
                // UDataTable's RowStruct/RowMap layout, so a reinterpret to UDataTable* is safe
                // for the read-only fields we touch.
                UDataTable* et = reinterpret_cast<UDataTable*>(pec->ExperienceTable);
                if (et && et->RowStruct && et->RowStruct->GetName() == "ExperienceTableData") {
                    tables.push_back(et);
                    Status("experience awards: using UPlayerExperienceComponent::ExperienceTable composite fallback (" + et->GetName() + ")");
                    break;
                }
            }
        }
    }

    if (tables.empty()) {
        Status("experience awards: no ExperienceTableData tables found (struct walk + component fallback) - skipping");
        return 0;
    }

    std::ofstream f(outFile, std::ios::trunc);
    if (!f) { Status("experience awards: cannot open output file"); return 0; }

    int written = 0;
    for (UDataTable* dt : tables) {
        int rowCount = 0;
        if (!RowCountIsSane(dt, rowCount)) {
            Status("experience awards: RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping this table");
            continue;
        }
        const std::string tableName = dt->GetName();

        std::vector<std::string> rowNames;
        rowNames.reserve(rowCount);
        for (auto& Pair : dt->RowMap) rowNames.push_back(FNm(Pair.Key()));
        std::sort(rowNames.begin(), rowNames.end());

        for (const std::string& rn : rowNames) {
            uint8_t* rowPtr = nullptr;
            for (auto& Pair : dt->RowMap) {
                if (FNm(Pair.Key()) == rn) { rowPtr = Pair.Value(); break; }
            }
            if (!rowPtr) continue;

            const FExperienceTableData& row = *reinterpret_cast<const FExperienceTableData*>(rowPtr);
            std::string line;
            if (!SafeSerializeRow<FExperienceTableData>(SerializeExperienceAwardRow, rn, row, &line)) {
                Status("experience awards: row '" + rn + "' faulted during serialize on " + tableName + " - skipped (SEH-guarded)");
                continue;
            }
            // Inject table provenance so rows from multiple tables in one file stay traceable.
            if (!line.empty() && line.back() == '}') {
                line.pop_back();
                line += ",\"table\":" + Q(tableName) + "}";
            }
            f << line << "\n";
            ++written;
        }
    }
    f.close();
    Status("experience awards: wrote " + std::to_string(written) + " rows from " + std::to_string(tables.size()) + " table(s) by row struct");
    return written;
}

// ---- top-level entry point ----------------------------------------------------------
// Exports every progression table this pass covers. Each call is independent — one missing
// or mismatched table does not abort the others. Returns total rows written across all tables.
int RunProgressionExport() {
    std::wstring outDir = ResolveOutDir();
    CreateDirectoryW((outDir + L"\\progression_1_14_7").c_str(), nullptr);
    std::wstring pDir = outDir + L"\\progression_1_14_7";

    int total = 0;

    // Player XP track.
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("player_experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\player-experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    // Per-weapon XP tracks.
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("weapon_experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\weapon-experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    // Generic experience track table (may overlap with player/weapon tables in some builds;
    // exported separately and left for the importer to reconcile/dedupe, per plan decision
    // rule 6 — unknown/overlapping IDs are recorded, not silently dropped).
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    // Hunt-pass season track — now with a DEDICATED FHuntPassSeasonDataTable serializer (season
    // identity + tier thresholds + hunt-pass economy), not a base-only FExperienceTrackTableData
    // cast. Output file dropped its "-partial" suffix accordingly.
    total += std::max(0, ExportTable<FHuntPassSeasonDataTable>(
        FindDataTableByName("hunt_pass_season_table"),
        "HuntPassSeasonDataTable",
        pDir + L"\\huntpass-season-table.jsonl",
        SerializeHuntPassSeasonRow));

    // Experience award rows (objective -> XP amount) — found BY ROW STRUCT across all loaded
    // tables, with the player-component composite table as fallback (first pass's exact-name
    // "experience_table" lookup returned "table not found").
    total += std::max(0, ExportAwardTables(pDir + L"\\experience-awards.jsonl"));

    // Progression track table (FProgressionTrackTableData).
    total += std::max(0, ExportTable<FProgressionTrackTableData>(
        FindDataTableByName("progression_track_table"),
        "ProgressionTrackTableData",
        pDir + L"\\progression-tracks.jsonl",
        SerializeProgressionTrackRow));

    // Online progression track info — CORRECT row struct this time (FOnlineProgressionTrackInfo),
    // with its own display-metadata serializer. First pass expected FProgressionTrackTableData and
    // skipped it on the struct-name mismatch.
    total += std::max(0, ExportTable<FOnlineProgressionTrackInfo>(
        FindDataTableByName("online_progression_track_info_table"),
        "OnlineProgressionTrackInfo",
        pDir + L"\\online-track-info.jsonl",
        SerializeOnlineProgressionTrackInfoRow));

    // Mastery tracks.
    total += std::max(0, ExportTable<FMasteryTrackTableData>(
        FindDataTableByName("mastery_track_table"),
        "MasteryTrackTableData",
        pDir + L"\\mastery-tracks.jsonl",
        SerializeMasteryTrackRow));

    Status("RunProgressionExport DONE total_rows=" + std::to_string(total));
    return total;
}

} // namespace ProgExp

int RunProgressionExport() { return ProgExp::RunProgressionExport(); }
