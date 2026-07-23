

#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <cstdint>

#include "SDK.hpp"
#include "ExportFlags.hpp"

using namespace SDK;





extern int RunProgressionExport();
extern int RunCombatExport();
extern int RunSkinsExport(bool resolveViaStringTable);
extern int RunSlayersPathExport();
extern int RunHuntExport();
extern int RunTableInventoryExport();
extern int RunDropTableExport();




static const wchar_t* kOutDirCandidates[] = {
    L".\\Items_Analysis",
};

static std::wstring ResolveOutDir() {
    for (const wchar_t* c : kOutDirCandidates) {
        DWORD a = GetFileAttributesW(c);
        if (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) return c;
    }
    
    CreateDirectoryW(kOutDirCandidates[0], nullptr);
    return kOutDirCandidates[0];
}

static void Status(const std::string& s) {
    OutputDebugStringA(("[CatalogExporter] " + s + "\n").c_str());
    std::wstring dir = ResolveOutDir();
    std::ofstream f(dir + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << s << "\n";
}


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


static std::string FStr(const FString& s) {
    if (s.Num() <= 0 || !s.IsValid()) return std::string();
    return s.ToString();
}

static std::string FNm(const FName& n) {
    return n.ToString();
}


static std::string StrArray(const TArray<FString>& arr) {
    std::string o = "[";
    for (int i = 0; i < arr.Num(); ++i) {
        if (i) o += ",";
        o += "\"" + JsonEsc(FStr(arr[i])) + "\"";
    }
    o += "]";
    return o;
}







static std::string QuantityArray(const TArray<FPlayFabCatalogItemQuantity>& arr) {
    std::string o = "[";
    for (int i = 0; i < arr.Num(); ++i) {
        if (i) o += ",";
        const FPlayFabCatalogItemQuantity& q = arr[i];
        o += "{\"itemId\":\"" + JsonEsc(FStr(q.Item)) + "\",\"quantity\":" + std::to_string(q.Amount) + "}";
    }
    o += "]";
    return o;
}

static const char* WeaponPartTypeName(EWeaponPartType type) {
    switch (type) {
        case EWeaponPartType::Weapon_Part_Default: return "default";
        case EWeaponPartType::Weapon_Part_DP_Barrel: return "dp_barrel";
        case EWeaponPartType::Weapon_Part_DP_Receiver: return "dp_receiver";
        case EWeaponPartType::Weapon_Part_DP_Grip: return "dp_grip";
        case EWeaponPartType::Weapon_Part_DP_Mod: return "dp_mod";
        case EWeaponPartType::Weapon_Part_DP_Prism: return "dp_prism";
        case EWeaponPartType::Weapon_Part_DP_Legendary: return "dp_legendary";
        case EWeaponPartType::Weapon_Part_EB_Special: return "eb_special";
        case EWeaponPartType::Weapon_Part_EB_Passive: return "eb_passive";
        case EWeaponPartType::Weapon_Part_EB_Legendary: return "eb_legendary";
        case EWeaponPartType::Weapon_Part_IH_Special: return "ih_special";
        case EWeaponPartType::Weapon_Part_IH_Passive: return "ih_passive";
        case EWeaponPartType::Weapon_Part_IH_Legendary: return "ih_legendary";
        case EWeaponPartType::Weapon_Part_GA_Special: return "ga_special";
        case EWeaponPartType::Weapon_Part_GA_Passive: return "ga_passive";
        case EWeaponPartType::Weapon_Part_GA_Legendary: return "ga_legendary";
        case EWeaponPartType::Weapon_Part_CB_Special: return "cb_special";
        case EWeaponPartType::Weapon_Part_CB_Passive: return "cb_passive";
        case EWeaponPartType::Weapon_Part_CB_Legendary: return "cb_legendary";
        case EWeaponPartType::Weapon_Part_MS_Special: return "ms_special";
        case EWeaponPartType::Weapon_Part_MS_Passive: return "ms_passive";
        case EWeaponPartType::Weapon_Part_MS_Legendary: return "ms_legendary";
        case EWeaponPartType::Weapon_Part_AC_Special: return "ac_special";
        case EWeaponPartType::Weapon_Part_AC_Passive: return "ac_passive";
        case EWeaponPartType::Weapon_Part_AC_Legendary: return "ac_legendary";
        case EWeaponPartType::Weapon_Part_Soul: return "soul";
        case EWeaponPartType::Item_Part_Lantern_Capacitor: return "lantern_capacitor";
        case EWeaponPartType::Item_Part_Lantern_Cell: return "lantern_cell";
        default: return "unknown";
    }
}




static const char* CellTypeName(ECellType type) {
    switch (type) {
        case ECellType::None: return "none";
        case ECellType::CellType_Generic: return "generic";
        case ECellType::CellType_Weapon_Generic: return "weapon_generic";
        case ECellType::CellType_Weapon_Axe: return "weapon_axe";
        case ECellType::CellType_Weapon_Sword: return "weapon_sword";
        case ECellType::CellType_Weapon_Hammer: return "weapon_hammer";
        case ECellType::CellType_Weapon_CBlades: return "weapon_cblades";
        case ECellType::CellType_Weapon_Spear: return "weapon_spear";
        case ECellType::CellType_Armour_Generic: return "armour_generic";
        case ECellType::CellType_Armour_Head: return "armour_head";
        case ECellType::CellType_Armour_Chest: return "armour_chest";
        case ECellType::CellType_Armour_Arms: return "armour_arms";
        case ECellType::CellType_Armour_Legs: return "armour_legs";
        case ECellType::CellType_Lantern_Generic: return "lantern_generic";
        case ECellType::CellType_Lantern_Ability: return "lantern_ability";
        case ECellType::CellType_Defence: return "defence";
        case ECellType::CellType_Power: return "power";
        case ECellType::CellType_Mobility: return "mobility";
        case ECellType::CellType_Technique: return "technique";
        case ECellType::CellType_Utility: return "utility";
        case ECellType::CellType_Gun_Receiver: return "gun_receiver";
        case ECellType::CellType_Gun_Grip: return "gun_grip";
        case ECellType::CellType_Gun_Barrel: return "gun_barrel";
        case ECellType::CellType_Gun_Passive: return "gun_passive";
        case ECellType::CellType_Any: return "any";
        case ECellType::CellType_Legendary_Ability: return "legendary_ability";
        case ECellType::Max: return "max_sentinel";
        default: return "UNNAMED";  
    }
}









static int DumpLiveCellSlots(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;

    std::ofstream f(outDir + L"\\live_cell_slots_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("cells: cannot open live_cell_slots_1_12.jsonl"); return -1; }

    UClass* containerClass = UArchonInventoryItem_CellContainer::StaticClass();
    if (!containerClass) { Status("cells: UArchonInventoryItem_CellContainer class unavailable"); return -1; }

    int written = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || obj->IsDefaultObject() || !obj->IsA(containerClass)) continue;

        auto* item = static_cast<UArchonInventoryItem_CellContainer*>(obj);
        const std::string itemId = FStr(item->ItemId);
        if (itemId.empty()) continue;

        const TArray<FCellSlot> slots = item->GetCellSlots();
        const TArray<FPermanentCell> permanent = item->GetPermanentCells();
        const TArray<FAppliedCellEffectCounter> effects = item->GetAllPermanentCellEffects();

        std::string line = "{";
        line += "\"itemId\":\"" + JsonEsc(itemId) + "\"";
        line += ",\"instanceId\":\"" + JsonEsc(FStr(item->ItemInstanceID)) + "\"";
        line += ",\"objectClass\":\"" + JsonEsc(obj->Class ? obj->Class->GetName() : std::string()) + "\"";

        line += ",\"cellSlots\":[";
        for (int s = 0; s < slots.Num(); ++s) {
            if (s) line += ",";
            const FCellSlot& slot = slots[s];
            line += "{\"slotIndex\":" + std::to_string(slot.SlotIndex);
            line += ",\"cellType\":" + std::to_string(static_cast<int>(slot.CellType));
            line += ",\"cellTypeName\":\"" + std::string(CellTypeName(slot.CellType)) + "\"";
            line += ",\"cellRarity\":" + std::to_string(static_cast<int>(slot.CellRarity));
            line += "}";
        }
        line += "]";

        line += ",\"permanentCells\":[";
        for (int p = 0; p < permanent.Num(); ++p) {
            if (p) line += ",";
            const FPermanentCell& pc = permanent[p];
            line += "{\"permanentSlotIndex\":" + std::to_string(pc.PermanentSlotIndex);
            line += ",\"cellRowName\":\"" + JsonEsc(pc.PermanentCell.RowName.ToString()) + "\"";
            line += ",\"cellTableName\":\"" + JsonEsc(pc.PermanentCell.DataTable ? pc.PermanentCell.DataTable->GetName() : std::string()) + "\"";
            line += "}";
        }
        line += "]";

        line += ",\"permanentCellEffects\":[";
        for (int e = 0; e < effects.Num(); ++e) {
            if (e) line += ",";
            const FAppliedCellEffectCounter& ec = effects[e];
            line += "{\"cellEffectId\":\"" + JsonEsc(FNm(ec.CellEffectID)) + "\"";
            line += ",\"cellEffectRowName\":\"" + JsonEsc(ec.CellEffect.RowName.ToString()) + "\"";
            line += ",\"magnitude\":" + std::to_string(ec.Magnitude);
            line += ",\"rank\":" + std::to_string(ec.Rank);
            line += "}";
        }
        line += "]}";

        f << line << "\n";
        ++written;
    }

    f.close();
    Status("cells: wrote " + std::to_string(written) + " live cell containers -> live_cell_slots_1_12.jsonl");
    return written;
}


static UArchonCatalog* FindArchonCatalog() {
    if (!UObject::GObjects) return nullptr;
    const int count = UObject::GObjects->Num();
    UClass* cls = UArchonCatalog::StaticClass();
    if (!cls) return nullptr;
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj) continue;
        if (obj->IsDefaultObject()) continue;
        if (obj->IsA(cls)) return static_cast<UArchonCatalog*>(obj);
    }
    return nullptr;
}


static int DumpGeneralCatalog(const std::wstring& outDir) {
    UArchonCatalog* cat = FindArchonCatalog();
    if (!cat) { Status("general: UArchonCatalog instance NOT found yet"); return -1; }

    TArray<FArchonCatalogItem> items;
    cat->GetAllItems(&items);
    const int n = items.Num();
    Status("general: GetAllItems returned " + std::to_string(n) + " items");
    if (n <= 0) return 0;

    std::ofstream f(outDir + L"\\catalog_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("general: cannot open catalog_1_12.jsonl"); return -1; }

    int written = 0;
    for (int i = 0; i < n; ++i) {
        FArchonCatalogItem& it = items[i];
        std::string id = FStr(it.ItemId);
        if (id.empty()) continue;

        std::string line = "{";
        line += "\"itemId\":\"" + JsonEsc(id) + "\"";
        line += ",\"itemClass\":\"" + JsonEsc(it.ItemClass.AssetPathName.ToString()) + "\"";
        line += ",\"displayName\":\"" + JsonEsc(FStr(it.DisplayNameInvariant)) + "\"";
        line += ",\"description\":\"" + JsonEsc(FStr(it.DescriptionInvariant)) + "\"";
        line += ",\"tags\":" + StrArray(it.Tags);
        line += ",\"customData\":\"" + JsonEsc(FStr(it.CustomData)) + "\"";
        line += ",\"entitlements\":" + StrArray(it.Entitlements);
        line += ",\"isStackable\":" + std::string(it.IsStackable ? "true" : "false");
        line += ",\"isBundle\":" + std::string(it.IsBundle ? "true" : "false");
        line += ",\"isContainer\":" + std::string(it.IsContainer ? "true" : "false");
        line += ",\"maxQuantity\":" + std::to_string(it.MaxQuantity);
        line += ",\"containerItemContents\":" + StrArray(it.ContainerItemContents);
        line += ",\"bundledItems\":" + StrArray(it.BundledItems);
        
        
        
        
        
        line += ",\"containerItemContentsWithQuantity\":" + QuantityArray(it.ContainerItemContentsWithQuantity);
        line += ",\"containerResultTableContents\":" + StrArray(it.ContainerResultTableContents);
        line += ",\"containerResultTableContentsWithQuantity\":" + QuantityArray(it.ContainerResultTableContentsWithQuantity);
        line += ",\"bundledItemsWithQuantity\":" + QuantityArray(it.BundledItemsWithQuantity);
        line += ",\"bundledResultTables\":" + StrArray(it.BundledResultTables);
        line += ",\"bundledResultTablesWithQuantity\":" + QuantityArray(it.BundledResultTablesWithQuantity);
        line += ",\"otherItemQuantities\":" + QuantityArray(it.OtherItemQuantities);
        line += ",\"alternateItemsToGrant\":" + QuantityArray(it.AlternateItemsToGrant);
        
        line += ",\"virtualCurrencyPrices\":[";
        for (int p = 0; p < it.VirtualCurrencyPrices.Num(); ++p) {
            if (p) line += ",";
            FPlayFabCatalogCurrency& c = it.VirtualCurrencyPrices[p];
            line += "{\"currency\":" + std::to_string(static_cast<int>(c.CurrencyType)) + ",\"amount\":" + std::to_string(c.Amount) + "}";
        }
        line += "]";
        line += ",\"journeyUnlockRow\":\"" + JsonEsc(it.PlayerJourneyUnlockRow.RowName.ToString()) + "\"";
        line += "}";

        f << line << "\n";
        ++written;
    }
    f.close();
    Status("general: wrote " + std::to_string(written) + " definitions -> catalog_1_12.jsonl");
    return written;
}


static int DumpEquipmentCatalog(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;
    const int count = UObject::GObjects->Num();

    std::ofstream f(outDir + L"\\equipment_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("equipment: cannot open equipment_1_12.jsonl"); return -1; }

    int written = 0;
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj) continue;
        UClass* cls = obj->Class;
        if (!cls) continue;

        std::string clsName = cls->GetName();
        const char* type = nullptr;
        if      (clsName == "EquipmentCatalogItem_Weapon")     type = "weapon";
        else if (clsName == "EquipmentCatalogItem_Armour")     type = "armour";
        else if (clsName == "EquipmentCatalogItem_Lantern")    type = "lantern";
        else if (clsName == "EquipmentCatalogItem_PlayerRole") type = "player_role";
        else if (clsName == "EquipmentCatalogItem_WeaponPart") type = "weapon_part";
        else continue;

        if (obj->GetName().rfind("Default__", 0) == 0) continue;

        
        uintptr_t addr = reinterpret_cast<uintptr_t>(obj);
        int32_t comp = *reinterpret_cast<int32_t*>(addr + 0x28);
        int32_t num  = *reinterpret_cast<int32_t*>(addr + 0x2C);
        std::string id;
        if (comp > 0) { FName nm{ comp, static_cast<uint32_t>(num) }; id = nm.ToString(); }
        if (id.empty()) continue;

        f << "{\"itemId\":\"" << JsonEsc(id) << "\",\"type\":\"" << type << "\",\"class\":\"" << JsonEsc(clsName) << "\"}\n";
        ++written;
    }
    f.close();
    Status("equipment: wrote " + std::to_string(written) + " definitions -> equipment_1_12.jsonl");
    return written;
}





static int DumpLiveWeaponSlots(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;

    std::ofstream f(outDir + L"\\weapon_slots_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("weapon-slots: cannot open weapon_slots_1_12.jsonl"); return -1; }

    UClass* weaponClass = UArchonInventoryItem_Weapon::StaticClass();
    if (!weaponClass) { Status("weapon-slots: UArchonInventoryItem_Weapon class unavailable"); return -1; }

    int written = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || obj->IsDefaultObject() || !obj->IsA(weaponClass)) continue;

        auto* weapon = static_cast<UArchonInventoryItem_Weapon*>(obj);
        const std::string itemId = FStr(weapon->ItemId);
        if (itemId.empty()) continue;

        const TArray<FWeaponPartSlot> slots = weapon->GetItemPartSlots();
        const TArray<FEquippedWeaponPartData> equipped = weapon->GetEquippedItemParts();

        std::string line = "{";
        line += "\"itemId\":\"" + JsonEsc(itemId) + "\"";
        line += ",\"instanceId\":\"" + JsonEsc(FStr(weapon->ItemInstanceID)) + "\"";
        line += ",\"weaponType\":" + std::to_string(static_cast<int>(weapon->WeaponType));
        line += ",\"slots\":[";
        for (int s = 0; s < slots.Num(); ++s) {
            if (s) line += ",";
            const FWeaponPartSlot& slot = slots[s];
            line += "{\"slotIndex\":" + std::to_string(slot.SlotIndex);
            line += ",\"weaponPartType\":" + std::to_string(static_cast<int>(slot.WeaponPartType));
            line += ",\"weaponPartTypeName\":\"" + std::string(WeaponPartTypeName(slot.WeaponPartType)) + "\"";
            line += ",\"defaultWeaponPartId\":\"" + JsonEsc(FStr(slot.DefaultWeaponPartID)) + "\"";
            line += ",\"catalogLocked\":" + std::string(slot.bIsLocked ? "true" : "false");
            line += ",\"hideFromUI\":" + std::string(slot.bHideFromUI ? "true" : "false");
            line += ",\"effectiveLocked\":" + std::string(weapon->IsItemPartSlotLocked(slot.WeaponPartType) ? "true" : "false");
            line += "}";
        }
        line += "]";
        line += ",\"equippedParts\":[";
        for (int e = 0; e < equipped.Num(); ++e) {
            if (e) line += ",";
            const FEquippedWeaponPartData& part = equipped[e];
            line += "{\"slotIndex\":" + std::to_string(part.SlotIndex);
            line += ",\"weaponPartType\":" + std::to_string(static_cast<int>(part.WeaponPartType));
            line += ",\"weaponPartTypeName\":\"" + std::string(WeaponPartTypeName(part.WeaponPartType)) + "\"";
            line += ",\"weaponPartId\":\"" + JsonEsc(FStr(part.WeaponPartID.ItemId)) + "\"}";
        }
        line += "]}";

        f << line << "\n";
        ++written;
    }

    f.close();
    Status("weapon-slots: wrote " + std::to_string(written) + " live weapons -> weapon_slots_1_12.jsonl");
    return written;
}



static int DumpLiveWeaponParts(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;

    std::ofstream f(outDir + L"\\live_weapon_parts_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("weapon-parts: cannot open live_weapon_parts_1_12.jsonl"); return -1; }

    UClass* partClass = UArchonInventoryItem_WeaponPart::StaticClass();
    if (!partClass) { Status("weapon-parts: UArchonInventoryItem_WeaponPart class unavailable"); return -1; }

    int written = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || obj->IsDefaultObject() || !obj->IsA(partClass)) continue;

        auto* part = static_cast<UArchonInventoryItem_WeaponPart*>(obj);
        const std::string itemId = FStr(part->ItemId);
        if (itemId.empty()) continue;

        bool catalogRowFound = false;
        int catalogWeaponPartType = -1;
        int catalogIsUnassignable = -1;
        std::string catalogName;
        std::string catalogRowStruct;
        if (part->Catalog) {
            catalogName = part->Catalog->GetName();
            catalogRowStruct = part->Catalog->RowStruct ? part->Catalog->RowStruct->GetName() : std::string();
            const int rowCount = part->Catalog->RowMap.Num();
            if (rowCount >= 0 && rowCount < 200000) {
                for (auto& pair : part->Catalog->RowMap) {
                    if (FNm(pair.Key()) != itemId) continue;
                    auto* row = reinterpret_cast<FPlayFabWeaponPartCatalogTableData*>(pair.Value());
                    if (row) {
                        catalogRowFound = true;
                        catalogWeaponPartType = static_cast<int>(row->WeaponPartType);
                        catalogIsUnassignable = row->bIsUnassignable ? 1 : 0;
                    }
                    break;
                }
            }
        }

        f << "{\"itemId\":\"" << JsonEsc(itemId)
          << "\",\"instanceId\":\"" << JsonEsc(FStr(part->ItemInstanceID))
          << "\",\"ownerWeaponType\":" << static_cast<int>(part->OwnerWeaponType)
          << ",\"objectClass\":\"" << JsonEsc(obj->Class ? obj->Class->GetName() : std::string())
          << "\",\"catalogName\":\"" << JsonEsc(catalogName)
          << "\",\"catalogRowStruct\":\"" << JsonEsc(catalogRowStruct)
          << "\",\"catalogRowFound\":" << (catalogRowFound ? "true" : "false")
          << ",\"catalogWeaponPartType\":" << catalogWeaponPartType
          << ",\"catalogIsUnassignable\":" << catalogIsUnassignable
          << ",\"clientIsAssignable\":" << (catalogIsUnassignable == 0 ? "true" : "false")
          << "}\n";
        ++written;
    }

    f.close();
    Status("weapon-parts: wrote " + std::to_string(written) + " live parts -> live_weapon_parts_1_12.jsonl");
    return written;
}





static int DumpWeaponPartCatalogRows(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;

    std::ofstream f(outDir + L"\\weapon_part_catalog_rows_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("weapon-part-catalog: cannot open weapon_part_catalog_rows_1_12.jsonl"); return -1; }

    UClass* tableClass = UDataTable::StaticClass();
    int written = 0;
    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || obj->IsDefaultObject() || !tableClass || !obj->IsA(tableClass)) continue;

        auto* table = static_cast<UDataTable*>(obj);
        if (!table->RowStruct || table->RowStruct->GetName() != "PlayFabWeaponPartCatalogTableData") continue;

        const int rowCount = table->RowMap.Num();
        if (rowCount < 0 || rowCount >= 200000) continue;
        for (auto& pair : table->RowMap) {
            auto* row = reinterpret_cast<FPlayFabWeaponPartCatalogTableData*>(pair.Value());
            if (!row) continue;
            const EWeaponPartType type = row->WeaponPartType;
            f << "{\"tableName\":\"" << JsonEsc(table->GetName())
              << "\",\"rowName\":\"" << JsonEsc(FNm(pair.Key()))
              << "\",\"weaponPartType\":" << static_cast<int>(type)
              << ",\"weaponPartTypeName\":\"" << WeaponPartTypeName(type)
              << "\",\"isUnassignable\":" << (row->bIsUnassignable ? "true" : "false")
              << ",\"clientIsAssignable\":" << (row->bIsUnassignable ? "false" : "true")
              << "}\n";
            ++written;
        }
    }

    f.close();
    Status("weapon-part-catalog: wrote " + std::to_string(written) +
           " rows -> weapon_part_catalog_rows_1_12.jsonl");
    return written;
}






static int DumpLoadoutGearUI(const std::wstring& outDir) {
    if (!UObject::GObjects) return -1;

    std::ofstream f(outDir + L"\\loadout_gear_ui_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("loadout-gear-ui: cannot open loadout_gear_ui_1_12.jsonl"); return -1; }

    UClass* viewModelClass = ULoadoutGearViewModel::StaticClass();
    UClass* screenClass = ULoadoutGearScreen::StaticClass();
    int written = 0;
    const int count = UObject::GObjects->Num();

    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj) continue;

        if (viewModelClass && !obj->IsDefaultObject() && obj->IsA(viewModelClass)) {
            auto* viewModel = static_cast<ULoadoutGearViewModel*>(obj);
            const FLoadoutItemViewModel& item = viewModel->ItemViewModel;

            f << "{\"kind\":\"gearViewModel\",\"objectName\":\"" << JsonEsc(obj->GetName())
              << "\",\"objectClass\":\"" << JsonEsc(obj->Class ? obj->Class->GetName() : std::string())
              << "\",\"itemId\":\"" << JsonEsc(FStr(item.ItemId))
              << "\",\"itemInstanceId\":\"" << JsonEsc(FStr(item.ItemInstanceID))
              << "\",\"weaponType\":" << static_cast<int>(item.WeaponType)
              << ",\"itemWeaponPartType\":" << static_cast<int>(item.WeaponPartType)
              << ",\"requiredSlayerNodeId\":\"" << JsonEsc(FStr(item.RequiredSlayerNodeId))
              << "\",\"isRequiredNodeUnlocked\":" << (item.bIsRequiredNodeUnlocked ? "true" : "false")
              << ",\"partSlotCount\":" << viewModel->PartSlotViewModels.Num()
              << ",\"partCandidateCount\":" << viewModel->PartViewModels.Num()
              << ",\"partSlots\":[";

            for (int s = 0; s < viewModel->PartSlotViewModels.Num(); ++s) {
                if (s) f << ",";
                const FLoadoutGearPartSlotViewModel& slot = viewModel->PartSlotViewModels[s];
                f << "{\"arrayIndex\":" << s
                  << ",\"isLocked\":" << (slot.bIsLocked ? "true" : "false")
                  << ",\"hasPartEquipped\":" << (slot.bHasPartEquipped ? "true" : "false")
                  << ",\"rarity\":" << static_cast<int>(slot.Rarity) << "}";
            }
            f << "],\"partCandidates\":[";

            for (int p = 0; p < viewModel->PartViewModels.Num(); ++p) {
                if (p) f << ",";
                const FLoadoutItemViewModel& part = viewModel->PartViewModels[p];
                f << "{\"arrayIndex\":" << p
                  << ",\"itemId\":\"" << JsonEsc(FStr(part.ItemId))
                  << "\",\"itemInstanceId\":\"" << JsonEsc(FStr(part.ItemInstanceID))
                  << "\",\"weaponType\":" << static_cast<int>(part.WeaponType)
                  << ",\"weaponPartType\":" << static_cast<int>(part.WeaponPartType)
                  << ",\"weaponPartTypeName\":\"" << WeaponPartTypeName(part.WeaponPartType)
                  << "\",\"isEquipped\":" << (part.bIsEquipped ? "true" : "false")
                  << ",\"hasBeenCrafted\":" << (part.bHasBeenCrafted ? "true" : "false")
                  << ",\"canBeCrafted\":" << (part.bCanBeCrafted ? "true" : "false")
                  << ",\"requiredSlayerNodeId\":\"" << JsonEsc(FStr(part.RequiredSlayerNodeId))
                  << "\",\"isRequiredNodeUnlocked\":" << (part.bIsRequiredNodeUnlocked ? "true" : "false")
                  << "}";
            }
            f << "]}\n";
            ++written;
        }

        if (screenClass && !obj->IsDefaultObject() && obj->IsA(screenClass)) {
            auto* screen = static_cast<ULoadoutGearScreen*>(obj);
            f << "{\"kind\":\"screen\",\"objectName\":\"" << JsonEsc(obj->GetName())
              << "\",\"objectClass\":\"" << JsonEsc(obj->Class ? obj->Class->GetName() : std::string())
              << "\",\"hasGearViewModel\":" << (screen->GearViewModel ? "true" : "false")
              << ",\"hasPartSlotBox\":" << (screen->PartSlotBox ? "true" : "false")
              << ",\"isAssignPanelOpen\":" << (screen->bIsAssignPanelOpen ? "true" : "false")
              << "}\n";
            ++written;
        }
    }

    f.close();
    Status("loadout-gear-ui: wrote " + std::to_string(written) + " rows -> loadout_gear_ui_1_12.jsonl");
    return written;
}






static void WriteManifest(const std::wstring& outDir, const ExportFlags& flags,
                           int catalogGeneral, int catalogEquipment, int liveWeaponSlots,
                           int progressionRows, int combatRows, int skinsRows,
                           int slayersPathNodes, int huntRows, int tableInventoryRows) {
    std::ofstream f(outDir + L"\\export_manifest.json", std::ios::trunc);
    if (!f) return;

    auto nowIso = []() -> std::string {
        SYSTEMTIME st; GetSystemTime(&st);
        char buf[64];
        sprintf_s(buf, "%04d-%02d-%02dT%02d:%02d:%02dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        return buf;
    };

    f << "{\n";
    f << "  \"gameVersion\": \"1.12.0\",\n";
    f << "  \"changelist\": 392819,\n";
    f << "  \"engineVersion\": \"4.26.2\",\n";
    f << "  \"exportedAt\": \"" << nowIso() << "\",\n";
    f << "  \"flags\": {\n";
    f << "    \"EXPORT_CATALOG\": " << (flags.ExportCatalog ? "true" : "false") << ",\n";
    f << "    \"EXPORT_PROGRESSION\": " << (flags.ExportProgression ? "true" : "false") << ",\n";
    f << "    \"EXPORT_COMBAT\": " << (flags.ExportCombat ? "true" : "false") << ",\n";
    f << "    \"EXPORT_SKINS\": " << (flags.ExportSkins ? "true" : "false") << ",\n";
    f << "    \"EXPORT_SKINS_RESOLVE_STRINGTABLE\": " << (flags.ExportSkinsResolveStringTable ? "true" : "false") << ",\n";
    f << "    \"EXPORT_SLAYERS_PATH\": " << (flags.ExportSlayersPath ? "true" : "false") << ",\n";
    f << "    \"EXPORT_WEAPON_SLOTS\": " << (flags.ExportWeaponSlots ? "true" : "false") << ",\n";
    f << "    \"EXPORT_HUNTS\": " << (flags.ExportHunts ? "true" : "false") << ",\n";
    f << "    \"EXPORT_TABLE_INVENTORY\": " << (flags.ExportTableInventory ? "true" : "false") << "\n";
    f << "  },\n";
    f << "  \"results\": {\n";
    f << "    \"catalogGeneralItems\": " << catalogGeneral << ",\n";
    f << "    \"catalogEquipmentItems\": " << catalogEquipment << ",\n";
    f << "    \"liveWeaponSlotItems\": " << liveWeaponSlots << ",\n";
    f << "    \"progressionRows\": " << progressionRows << ",\n";
    f << "    \"combatRows\": " << combatRows << ",\n";
    f << "    \"skinsRows\": " << skinsRows << ",\n";
    f << "    \"slayersPathNodes\": " << slayersPathNodes << ",\n";
    f << "    \"huntRows\": " << huntRows << ",\n";
    f << "    \"tableInventoryRows\": " << tableInventoryRows << "\n";
    f << "  }\n";
    f << "}\n";
}


static DWORD WINAPI ExporterThread(LPVOID) {
    ExportFlags flags = LoadExportFlags();
    Status("thread start; flags: catalog=" + std::string(flags.ExportCatalog ? "1" : "0") +
           " progression=" + std::string(flags.ExportProgression ? "1" : "0") +
           " combat=" + std::string(flags.ExportCombat ? "1" : "0") +
           " skins=" + std::string(flags.ExportSkins ? "1" : "0") +
           " skinsResolveStringTable=" + std::string(flags.ExportSkinsResolveStringTable ? "1" : "0") +
           " slayersPath=" + std::string(flags.ExportSlayersPath ? "1" : "0") +
           " weaponSlots=" + std::string(flags.ExportWeaponSlots ? "1" : "0") +
           " hunts=" + std::string(flags.ExportHunts ? "1" : "0") +
           " tableInventory=" + std::string(flags.ExportTableInventory ? "1" : "0") +
           " cells=" + std::string(flags.ExportCells ? "1" : "0") +
           " dropTables=" + std::string(flags.ExportDropTables ? "1" : "0"));
    if (flags.ExportSkinsResolveStringTable) {
        Status("*** WARNING: EXPORT_SKINS_RESOLVE_STRINGTABLE=1 — this build will call "
               "ProcessEvent off the worker thread. CLIENT-ONLY. Do not inject this build into "
               "the dedicated server. ***");
    }
    Status("waiting for GObjects + catalog...");
    std::wstring outDir = ResolveOutDir();

    
    UArchonCatalog* cat = nullptr;
    for (int tries = 0; tries < 240; ++tries) {
        if (UObject::GObjects && UObject::GObjects->Num() > 0) {
            cat = FindArchonCatalog();
            if (cat) break;
        }
        Sleep(500);
    }
    if (!cat) { Status("TIMEOUT: catalog never appeared. Reach the main menu/Ramsgate, then re-inject."); return 0; }

    int gen = 0, eq = 0, weaponSlots = 0, progRows = 0, combatRows = 0, skinsRows = 0, slayersRows = 0, huntRows = 0, tableInventoryRows = 0, dropTableRows = 0;

    if (flags.ExportCatalog) {
        gen = DumpGeneralCatalog(outDir);
        eq  = DumpEquipmentCatalog(outDir);
        Status("catalog DONE general=" + std::to_string(gen) + " equipment=" + std::to_string(eq));
    } else {
        Status("EXPORT_CATALOG=0, skipping catalog export");
    }

    if (flags.ExportWeaponSlots) {
        weaponSlots = DumpLiveWeaponSlots(outDir);
        DumpLiveWeaponParts(outDir);
        DumpWeaponPartCatalogRows(outDir);
        DumpLoadoutGearUI(outDir);
    } else {
        Status("EXPORT_WEAPON_SLOTS=0, skipping live weapon-slot export");
    }

    
    
    
    if (flags.ExportCells) {
        DumpLiveCellSlots(outDir);
    } else {
        Status("EXPORT_CELLS=0, skipping live cell-slot export");
    }

    if (flags.ExportProgression) {
        progRows = RunProgressionExport();
    } else {
        Status("EXPORT_PROGRESSION=0, skipping progression export");
    }

    if (flags.ExportCombat) {
        combatRows = RunCombatExport();
    } else {
        Status("EXPORT_COMBAT=0, skipping combat export");
    }

    if (flags.ExportSkins) {
        skinsRows = RunSkinsExport(flags.ExportSkinsResolveStringTable);
    } else {
        Status("EXPORT_SKINS=0, skipping weapon skins export");
    }

    
    
    
    
    if (flags.ExportSlayersPath) {
        slayersRows = RunSlayersPathExport();
    } else {
        Status("EXPORT_SLAYERS_PATH=0, skipping Slayer's Path node export");
    }

    if (flags.ExportHunts) {
        huntRows = RunHuntExport();
    } else {
        Status("EXPORT_HUNTS=0, skipping live hunt table export");
    }

    
    
    
    if (flags.ExportDropTables) {
        dropTableRows = RunDropTableExport();
    } else {
        Status("EXPORT_DROP_TABLES=0, skipping drop-table export");
    }

    
    
    if (flags.ExportTableInventory) {
        tableInventoryRows = RunTableInventoryExport();
    } else {
        Status("EXPORT_TABLE_INVENTORY=0, skipping DataTable census");
    }

    WriteManifest(outDir, flags, gen, eq, weaponSlots, progRows, combatRows, skinsRows, slayersRows, huntRows, tableInventoryRows);

    Status("ALL DONE general=" + std::to_string(gen) + " equipment=" + std::to_string(eq) +
           " progression=" + std::to_string(progRows) + " combat=" + std::to_string(combatRows) +
           " skins=" + std::to_string(skinsRows) + " slayers=" + std::to_string(slayersRows) +
           " hunts=" + std::to_string(huntRows) + " tables=" + std::to_string(tableInventoryRows) +
           " dropTables=" + std::to_string(dropTableRows));
    MessageBeep(MB_OK);
    return 0;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        CreateThread(nullptr, 0, ExporterThread, nullptr, 0, nullptr);
    }
    return TRUE;
}