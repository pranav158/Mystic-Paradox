/*
 * StoreRuntimeExporter - read-only capture of the loaded 1.12 store view-model state.
 *
 * PURPOSE
 * -------
 * Store SKU responses are remote service data. The local catalog and StoreItemsTable cannot recover
 * the original Reward Cache offer list, prices or rotation. Once Mystic Paradox serves a repro offer,
 * however, the real 1.12 client parses it into UStoreViewModel/UStoreItemViewModel objects. This pass
 * captures that parsed state plus the client-authored category/tag configuration and StoreItemsTable
 * image rows, so a repro answers the remaining contract questions without guessing.
 *
 * READ-ONLY / SAFETY
 * ------------------
 * No hooks, no ProcessEvent, no UObject mutation. It walks GObjects and reads fields whose layouts
 * are present in the generated 1.12 SDK. Risky FString/FText/FName and row reads are SEH-guarded.
 *
 * LOAD REQUIREMENT
 * ----------------
 * Reach Ramsgate, open Journal -> Challenges -> Reward Cache, wait for the tile/list to settle, then
 * inject. Only loaded view-models and tables are visible.
 */

#define NOMINMAX
#include <windows.h>
#include <string>
#include <fstream>
#include <vector>
#include <algorithm>
#include <cstdint>

#if __has_include("SDK.hpp")
#include "SDK.hpp"
#else
#include "../../ParadoxRuntime/SDK.hpp"
#endif
#include "ExportPaths.hpp"

using namespace SDK;

namespace StoreRuntime {

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

__declspec(noinline) static void RawStr(const FString& s, std::string* out) {
    if (s.Num() > 0 && s.IsValid()) *out = s.ToString();
}
__declspec(noinline) static void RawTxt(const FText& t, std::string* out) { *out = t.ToString(); }
__declspec(noinline) static void RawNm(const FName& n, std::string* out) { *out = n.ToString(); }

static bool SehStr(const FString& s, std::string* out) {
    __try { RawStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehTxt(const FText& t, std::string* out) {
    __try { RawTxt(t, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehNm(const FName& n, std::string* out) {
    __try { RawNm(n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static std::string FStr(const FString& s) { std::string o; SehStr(s, &o); return o; }
static std::string FTxt(const FText& t) { std::string o; SehTxt(t, &o); return o; }
static std::string FNm(const FName& n) { std::string o; SehNm(n, &o); return o; }

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[StoreRuntime] " + s + "\n").c_str());
    std::ofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[StoreRuntime] " << s << "\n";
}

static std::string ObjectClassName(UObject* obj) {
    return obj && obj->Class ? obj->Class->GetName() : std::string();
}

// FGameplayTag::TagName is protected but the generated SDK verifies it is the only field, at +0x0.
static const FName& GameplayTagName(const FGameplayTag& tag) {
    return *reinterpret_cast<const FName*>(&tag);
}

static std::string StringArray(const TArray<FString>& values) {
    std::string out = "[";
    for (int i = 0; i < values.Num(); ++i) {
        if (i) out += ",";
        out += Q(FStr(values[i]));
    }
    return out + "]";
}

static std::string OfferItemArray(const TArray<FOnlineStorePhoenixItem>& values) {
    std::string out = "[";
    for (int i = 0; i < values.Num(); ++i) {
        if (i) out += ",";
        out += "{\"itemId\":" + Q(FStr(values[i].ItemId))
            + ",\"amount\":" + std::to_string(values[i].Amount) + "}";
    }
    return out + "]";
}

static std::string SerializeOffer(const FOnlineStorePhoenixOffer& offer) {
    std::string out = "{";
    out += "\"skuId\":" + Q(FStr(offer.SkuId));
    out += ",\"displayName\":" + Q(FStr(offer.DisplayName));
    out += ",\"displayDescription\":" + Q(FStr(offer.DisplayDescription));
    out += ",\"displayPriority\":" + std::to_string(offer.DisplayPriority);
    out += ",\"catalogId\":" + Q(FStr(offer.CatalogId));
    out += ",\"imageUrl\":" + Q(FStr(offer.ImageURL));
    out += ",\"platPrice\":" + std::to_string(offer.PlatPrice);
    out += ",\"regularPlatPrice\":" + std::to_string(offer.RegularPlatPrice);
    out += ",\"dustPrice\":" + std::to_string(offer.DustPrice);
    out += ",\"maxAllowed\":" + std::to_string(offer.MaxAllowed);
    out += ",\"remaining\":" + std::to_string(offer.Remaining);
    out += ",\"tags\":" + StringArray(offer.Tags);
    out += ",\"grantedCatalogIds\":" + OfferItemArray(offer.GrantedCatalogIds);
    out += ",\"grantedEntitlements\":" + StringArray(offer.GrantedEntitlements);
    out += ",\"grantedProgressInTracks\":" + StringArray(offer.GrantedProgressInTracks);
    out += ",\"grantedProgress\":{\"trackId\":" + Q(FStr(offer.GrantedProgress.TrackId))
        + ",\"amount\":" + std::to_string(offer.GrantedProgress.Amount)
        + ",\"ranks\":" + std::to_string(offer.GrantedProgress.Ranks) + "}";
    out += ",\"grantedLoadoutSlots\":" + std::to_string(offer.GrantedLoadoutSlots);
    out += ",\"payWithAllCurrencies\":" + std::string(offer.bPayWithAllCurrencies ? "true" : "false");
    out += ",\"currencyCode\":" + Q(FStr(offer.CurrencyCode));
    out += ",\"currencyEnum\":" + std::to_string(static_cast<int>(offer.Currency));
    out += ",\"inUserCollection\":" + std::string(offer.bIsInUserCollection ? "true" : "false");
    out += ",\"platformOfferId\":" + Q(FStr(offer.PlatformOfferId));
    out += ",\"timeAvailabilityReason\":" + Q(FStr(offer.TimeAvailabilityReason));
    out += ",\"missingEntitlementNames\":" + StringArray(offer.MissingEntitlementNames);
    out += ",\"previewItemIds\":" + StringArray(offer.PreviewItemIds);
    return out + "}";
}

// Generated SDK offsets, Dauntless 1.12.0 CL 392819:
// UStoreViewModel::TagFilter                       +0x0170 (protected FString)
// UStoreItemViewModel::StoreItem                  +0x0650 (protected FOnlineStorePhoenixOffer)
// Direct offsets avoid the generated GetStoreItem() wrapper, which invokes ProcessEvent and is not
// safe for this worker-thread read-only exporter.
static const FString& StoreTagFilter(const UStoreViewModel* vm) {
    return *reinterpret_cast<const FString*>(reinterpret_cast<const uint8_t*>(vm) + 0x0170);
}
static const FOnlineStorePhoenixOffer& StoreOffer(const UStoreItemViewModel* vm) {
    return *reinterpret_cast<const FOnlineStorePhoenixOffer*>(reinterpret_cast<const uint8_t*>(vm) + 0x0650);
}

static std::string SerializeSubCategories(const TArray<FStoreSubCategoryViewModels>& values) {
    std::string out = "[";
    for (int i = 0; i < values.Num(); ++i) {
        if (i) out += ",";
        const FStoreSubCategoryViewModels& sub = values[i];
        out += "{\"name\":" + Q(FTxt(sub.SubCategoryName));
        out += ",\"breadcrumbCategory\":" + Q(FNm(GameplayTagName(sub.BreadcrumbCategory)));
        out += ",\"requiresEntitlement\":" + std::string(sub.RequiresEntitlement ? "true" : "false");
        out += ",\"entitlementId\":" + Q(FStr(sub.EntitlementId));
        out += ",\"skuId\":" + Q(FStr(sub.SkuId));
        out += ",\"subTagIds\":" + StringArray(sub.SubTagIds);
        out += ",\"hidePurchasedItems\":" + std::string(sub.HidePurchasedItems ? "true" : "false");
        out += ",\"shouldHideTab\":" + std::string(sub.bShouldHideTab ? "true" : "false");
        out += ",\"hideTab\":" + std::string(sub.bHideTab ? "true" : "false") + "}";
    }
    return out + "]";
}

static std::string SerializeCategories(const TArray<FStoreCategoryViewModels>& values) {
    std::string out = "[";
    for (int i = 0; i < values.Num(); ++i) {
        if (i) out += ",";
        const FStoreCategoryViewModels& category = values[i];
        out += "{\"name\":" + Q(FTxt(category.CategoryName));
        out += ",\"breadcrumbCategory\":" + Q(FNm(GameplayTagName(category.BreadcrumbCategory)));
        out += ",\"requiresEntitlement\":" + std::string(category.RequiresEntitlement ? "true" : "false");
        out += ",\"entitlementId\":" + Q(FStr(category.EntitlementId));
        out += ",\"skuId\":" + Q(FStr(category.SkuId));
        out += ",\"subcategories\":" + SerializeSubCategories(category.SubCategoryViewModels) + "}";
    }
    return out + "]";
}

__declspec(noinline) static void RawSerializeStoreViewModel(UStoreViewModel* vm, std::string* out) {
    std::string line = "{";
    line += "\"objectName\":" + Q(vm->GetName());
    line += ",\"objectClass\":" + Q(ObjectClassName(vm));
    line += ",\"defaultObject\":" + std::string(vm->IsDefaultObject() ? "true" : "false");
    line += ",\"tagFilter\":" + Q(FStr(StoreTagFilter(vm)));
    line += ",\"storeItemsTable\":" + Q(vm->StoreItemsTable ? vm->StoreItemsTable->GetName() : std::string());
    line += ",\"currencyDataTable\":" + Q(vm->CurrencyDataTable ? vm->CurrencyDataTable->GetName() : std::string());
    line += ",\"categories\":" + SerializeCategories(vm->StoreCategoryViewModels);
    line += "}";
    *out = line;
}

static bool SafeSerializeStoreViewModel(UStoreViewModel* vm, std::string* out) {
    __try { RawSerializeStoreViewModel(vm, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

__declspec(noinline) static void RawSerializeStoreItemViewModel(UStoreItemViewModel* vm, std::string* out) {
    const FOnlineStorePhoenixOffer& offer = StoreOffer(vm);
    std::string line = "{";
    line += "\"objectName\":" + Q(vm->GetName());
    line += ",\"objectClass\":" + Q(ObjectClassName(vm));
    line += ",\"defaultObject\":" + std::string(vm->IsDefaultObject() ? "true" : "false");
    line += ",\"displayName\":" + Q(FTxt(vm->DisplayName));
    line += ",\"displayDescription\":" + Q(FTxt(vm->DisplayDescription));
    line += ",\"displayItemType\":" + Q(FTxt(vm->DisplayItemType));
    line += ",\"itemPriceNumber\":" + std::to_string(vm->ItemPriceNumber);
    line += ",\"itemCurrentPriceNumber\":" + std::to_string(vm->ItemCurrentPriceNumber);
    line += ",\"storeCurrencyEnum\":" + std::to_string(static_cast<int>(vm->StoreCurrency));
    line += ",\"currencyCode\":" + Q(FStr(vm->CurrencyCode));
    line += ",\"displayPriority\":" + std::to_string(vm->DisplayPriority);
    line += ",\"purchased\":" + std::string(vm->bIsPurchased ? "true" : "false");
    line += ",\"canPurchaseAgain\":" + std::string(vm->bCanPurchaseAgain ? "true" : "false");
    line += ",\"expired\":" + std::string(vm->bIsExpired ? "true" : "false");
    line += ",\"prestigeItemElite\":" + std::string(vm->bIsPrestigeItemElite ? "true" : "false");
    line += ",\"rewardRarityLevel\":" + std::to_string(static_cast<int>(vm->RewardRarityLevel));
    line += ",\"catalogItemId\":" + Q(FStr(vm->StoreItemCatalogData.ItemId));
    line += ",\"offer\":" + SerializeOffer(offer);
    line += "}";
    *out = line;
}

static bool SafeSerializeStoreItemViewModel(UStoreItemViewModel* vm, std::string* out) {
    __try { RawSerializeStoreItemViewModel(vm, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static std::string SoftPath(const TSoftObjectPtr<UTexture2D>& value) {
    return FNm(value.ObjectID.AssetPathName);
}

__declspec(noinline) static void RawSerializeImageRow(const std::string& tableName,
                                                       const std::string& rowName,
                                                       const FStoreItemTable& row,
                                                       std::string* out) {
    *out = "{\"table\":" + Q(tableName)
         + ",\"rowName\":" + Q(rowName)
         + ",\"featureImage\":" + Q(SoftPath(row.FeatureImage))
         + ",\"standardImage\":" + Q(SoftPath(row.StandardImage)) + "}";
}

static bool SafeSerializeImageRow(const std::string& tableName,
                                  const std::string& rowName,
                                  const FStoreItemTable& row,
                                  std::string* out) {
    __try { RawSerializeImageRow(tableName, rowName, row, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static int DumpImageRows(std::ofstream& out) {
    UClass* dtClass = UDataTable::StaticClass();
    if (!UObject::GObjects || !dtClass) return 0;

    int written = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class || !obj->IsA(dtClass)) continue;
        UDataTable* table = static_cast<UDataTable*>(obj);
        if (!table->RowStruct || table->RowStruct->GetName() != "StoreItemTable") continue;

        const int rowCount = table->RowMap.Num();
        if (rowCount < 0 || rowCount > 200000) continue;
        const std::string tableName = table->GetName();

        std::vector<std::string> rowNames;
        rowNames.reserve(rowCount);
        for (auto& pair : table->RowMap) rowNames.push_back(FNm(pair.Key()));
        std::sort(rowNames.begin(), rowNames.end());

        for (const std::string& rowName : rowNames) {
            uint8_t* rowPtr = nullptr;
            for (auto& pair : table->RowMap) {
                if (FNm(pair.Key()) == rowName) { rowPtr = pair.Value(); break; }
            }
            if (!rowPtr) continue;

            std::string line;
            const FStoreItemTable& row = *reinterpret_cast<const FStoreItemTable*>(rowPtr);
            if (!SafeSerializeImageRow(tableName, rowName, row, &line)) {
                Status("image row '" + rowName + "' faulted in " + tableName + "; skipped");
                continue;
            }
            out << line << "\n";
            ++written;
        }
    }
    return written;
}

__declspec(noinline) static bool RawMatchesLoadedStoreTag(UObject* obj,
                                                          UClass* storeVmClass,
                                                          const std::string& requiredTag) {
    if (!obj || !obj->Class || !obj->IsA(storeVmClass)) return false;
    UStoreViewModel* vm = static_cast<UStoreViewModel*>(obj);
    if (vm->IsDefaultObject()) return false;
    return FStr(StoreTagFilter(vm)) == requiredTag;
}

static bool SafeMatchesLoadedStoreTag(UObject* obj,
                                      UClass* storeVmClass,
                                      const std::string& requiredTag) {
    __try { return RawMatchesLoadedStoreTag(obj, storeVmClass, requiredTag); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static bool HasLoadedStoreTag(const std::string& requiredTag) {
    if (!UObject::GObjects) return false;
    UClass* storeVmClass = UStoreViewModel::StaticClass();
    if (!storeVmClass) return false;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        if (SafeMatchesLoadedStoreTag(UObject::GObjects->GetByIndex(i), storeVmClass, requiredTag)) {
            return true;
        }
    }
    return false;
}

} // namespace StoreRuntime

int RunStoreRuntimeExport() {
    using namespace StoreRuntime;

    Status("starting store runtime capture; open Reward Cache before injecting");
    if (!UObject::GObjects) {
        Status("GObjects unavailable; aborting");
        return -1;
    }

    const std::wstring outDir = ResolveOutDir();
    std::ofstream viewModels(outDir + L"\\store_view_models_1_14_7.jsonl", std::ios::trunc);
    std::ofstream itemViewModels(outDir + L"\\store_item_view_models_1_14_7.jsonl", std::ios::trunc);
    std::ofstream imageRows(outDir + L"\\store_item_images_1_14_7.jsonl", std::ios::trunc);
    if (!viewModels || !itemViewModels || !imageRows) {
        Status("cannot open one or more store runtime output files");
        return -1;
    }

    UClass* storeVmClass = UStoreViewModel::StaticClass();
    UClass* itemVmClass = UStoreItemViewModel::StaticClass();
    if (!storeVmClass || !itemVmClass) {
        Status("store view-model classes unavailable; aborting");
        return -1;
    }

    int storeVmWritten = 0;
    int itemVmWritten = 0;
    int skipped = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class) continue;

        if (obj->IsA(storeVmClass)) {
            std::string line;
            if (SafeSerializeStoreViewModel(static_cast<UStoreViewModel*>(obj), &line)) {
                viewModels << line << "\n";
                ++storeVmWritten;
            } else {
                ++skipped;
            }
        }

        if (obj->IsA(itemVmClass)) {
            std::string line;
            if (SafeSerializeStoreItemViewModel(static_cast<UStoreItemViewModel*>(obj), &line)) {
                itemViewModels << line << "\n";
                ++itemVmWritten;
            } else {
                ++skipped;
            }
        }
    }

    const int imageWritten = DumpImageRows(imageRows);
    viewModels.close();
    itemViewModels.close();
    imageRows.close();

    Status("DONE storeViewModels=" + std::to_string(storeVmWritten)
        + " itemViewModels=" + std::to_string(itemVmWritten)
        + " imageRows=" + std::to_string(imageWritten)
        + " skipped=" + std::to_string(skipped));
    return storeVmWritten + itemVmWritten + imageWritten;
}

// Used by the always-injected dual-role runtime DLL when REWARD_CACHE_CAPTURE.flag is present.
// Waiting for the exact live TagFilter avoids truncating the output files during startup before the
// Reward Cache view model has been constructed. The scan is read-only and runs only on an opted-in
// client process; dedicated servers never start it.
int RunStoreRuntimeExportWhenReady(DWORD timeoutMs) {
    using namespace StoreRuntime;

    static const std::string kRequiredTag = "season_store";
    const ULONGLONG startedAt = GetTickCount64();
    Status("waiting for a non-default UStoreViewModel with tagFilter='" + kRequiredTag + "'");

    while ((GetTickCount64() - startedAt) < static_cast<ULONGLONG>(timeoutMs)) {
        if (HasLoadedStoreTag(kRequiredTag)) {
            // Give the async SKU callback and category widgets a short settling window so the export
            // contains both the store configuration and any item view models the client accepted.
            Sleep(1500);
            Status("detected live season_store view model; capturing");
            return RunStoreRuntimeExport();
        }
        Sleep(1000);
    }

    Status("timed out waiting for season_store view model; no files were truncated");
    return -2;
}
