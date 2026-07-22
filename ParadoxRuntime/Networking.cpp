/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "networking.h"

#include <fstream>
#include <iostream>
#include <string>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;

    static uintptr_t BaseAddress = 0x0;
    static int LastPort = 0; 

    static bool IsReadablePointer(const void* Ptr, size_t Size = sizeof(void*)) {
        if (!Ptr || ((uintptr_t)Ptr & 0x7) != 0) {
            return false;
        }

        MEMORY_BASIC_INFORMATION Info{};
        if (!VirtualQuery(Ptr, &Info, sizeof(Info))) {
            return false;
        }

        if (Info.State != MEM_COMMIT || (Info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) {
            return false;
        }

        uintptr_t Start = reinterpret_cast<uintptr_t>(Ptr);
        uintptr_t End = Start + Size;
        uintptr_t RegionEnd = reinterpret_cast<uintptr_t>(Info.BaseAddress) + Info.RegionSize;
        return End >= Start && End <= RegionEnd;
    }

    static bool IsSanePointerArray(void* Data, int32_t Num, int32_t Max, int32_t Limit) {
        if (Num < 0 || Max < 0 || Num > Max || Num > Limit) {
            return false;
        }

        if (Num == 0) {
            return true;
        }

        return IsReadablePointer(Data, static_cast<size_t>(Num) * sizeof(void*));
    }

    
    
    
    
    
    
    static const char* NetLogDir() {
        static char Dir[MAX_PATH] = { 0 };
        static bool Ready = false;
        if (!Ready) {
            char ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameA(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                int slash = -1;
                for (DWORD i = 0; i < n; ++i) { if (ExePath[i] == '\\' || ExePath[i] == '/') { slash = (int)i; } }
                if (slash >= 0) {
                    for (int i = 0; i <= slash; ++i) { Dir[i] = ExePath[i]; }
                    Dir[slash + 1] = '\0';
                }
            }
            Ready = true;
        }
        return Dir;
    }

    static void NetLog(int Port, const std::string& Msg) {
        char Path[MAX_PATH];
        
        
        sprintf_s(Path, "%smysticparadox_dll_port%d.log", NetLogDir(), Port);

        std::ofstream File(Path, std::ios::app);
        if (File.is_open()) {
            File << Msg << "\n";
            File.flush();
        }
    }

    
    
    
    
    
    
    
    
    static bool NativeReplicationOnly() {
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 0;
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"NATIVE_REPLICATION_ONLY.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
            }
        }
        return Cached == 1;
    }

    
    
    
    
    
    static bool ReverseConnectionOrder() {
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 0;
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"REVERSE_CONNECTION_ORDER.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
            }
        }
        return Cached == 1;
    }

    
    
    
    
    
    
    static bool HybridReplication() {
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 0;
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"HYBRID_REPLICATION.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
            }
        }
        return Cached == 1;
    }

    
    
    
    
    
    
    
    
    static bool LevelVisibilityGate() {
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 0;
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"LEVEL_VISIBILITY_GATE.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
            }
        }
        return Cached == 1;
    }

    
    
    
    
    
    
    
    static bool NativeGraphOnly() {
        
        
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 1;   
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"EMERGENCY_LEGACY_REPLICATION.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 0; }
            }
        }
        return Cached == 1;
    }

    
    
    static bool RepGraphDiagNet() {
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 0;
            wchar_t ExePath[MAX_PATH];
            DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
            if (n > 0 && n < MAX_PATH) {
                for (int i = (int)n - 1; i >= 0; --i) {
                    if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
                }
                std::wstring FlagPath = std::wstring(ExePath) + L"REPGRAPH_DIAG.flag";
                if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
            }
        }
        return Cached == 1;
    }

    
    
    
    
    
    
    
    
    
    
    

    static std::vector<std::pair<AActor*, bool>> BuildConsiderList(UWorld* World, UNetDriver* Driver) {
        std::vector<std::pair<AActor*, bool>> Actors;

        
        
        
        ULevel* PersistentLevel = (World && IsReadablePointer(World, 0x38)) ? *reinterpret_cast<ULevel**>((uintptr_t)World + 0x30) : nullptr;

        for (ULevel* Level : World->Levels) {
            bool bPersistent = (Level == PersistentLevel);
            for (AActor* Actor : Level->Actors) {
                if (!Actor)
                    continue;

                if (Actor->RemoteRole == ENetRole::ROLE_None)
                    continue;

                if (Actor->bActorIsBeingDestroyed)
                    continue;

                
                
                
                
                if (!reinterpret_cast<UWorld * (*)(AActor*)>(*(void**)((uintptr_t)Actor->VTable + 0x158))(Actor)) {
                    continue;
                }

                reinterpret_cast<void(*)(AActor*, UNetDriver*)>(BaseAddress + 0x0394B400)(Actor, Driver);

                Actors.push_back({ Actor, bPersistent });
            }
        }

        

        return Actors;
    }

    static UActorChannel* GetActorChannelForConnectionAndActor(UNetConnection* Connection, AActor* Actor) {
        if (!IsReadablePointer(Connection, 0x80)) {
            return nullptr;
        }

        UChannel** Channels = *reinterpret_cast<UChannel***>((uintptr_t)Connection + 0x70);
        int32_t ChannelCount = *reinterpret_cast<int32_t*>((uintptr_t)Connection + 0x78);
        int32_t ChannelMax = *reinterpret_cast<int32_t*>((uintptr_t)Connection + 0x7C);

        if (!IsSanePointerArray(Channels, ChannelCount, ChannelMax, 4096)) {
            NetLog(LastPort, "[GetActorChannel] Invalid OpenChannels array; skipping");
            return nullptr;
        }

        for (int32_t i = 0; i < ChannelCount; ++i) {
            UChannel* Channel = Channels[i];
            if (!IsReadablePointer(Channel, 0x78)) {
                continue;
            }

            if (Channel->Class == UActorChannel::StaticClass() && ((UActorChannel*)Channel)->Actor == Actor) {
                return ((UActorChannel*)Channel);
            }
        }

        return nullptr;
    }

    int BootstrapActorChannel(AActor* Actor, UNetConnection* Connection) {
        if (!Actor || !Connection || !IsReadablePointer(Actor, 0x100)
            || !IsReadablePointer(Connection, 0x140)) {
            return 0;
        }

        UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor);
        const bool ExistingChannel = ActorChannel != nullptr;

        static FName ActorChannelName = FName();
        static bool ActorChannelNameInitialized = false;
        if (!ActorChannelNameInitialized) {
            ActorChannelName = UKismetStringLibrary::Conv_StringToName(L"Actor");
            ActorChannelNameInitialized = true;
        }

        if (!ActorChannel) {
            
            ActorChannel = reinterpret_cast<UActorChannel * (*)(UNetConnection*, FName*, unsigned int, int)>(
                BaseAddress + 0x03D47AC0)(Connection, &ActorChannelName, 1 << 1, -1);
            if (ActorChannel) {
                reinterpret_cast<void(*)(UActorChannel*, AActor*, unsigned int)>(
                    BaseAddress + 0x03B80890)(ActorChannel, Actor, 0);
            }
        }

        if (!ActorChannel || ActorChannel->Actor != Actor) {
            NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
                + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
                + std::to_string(reinterpret_cast<uintptr_t>(Connection))
                + " result=CREATE_FAILED");
            return 0;
        }

        const bool WroteData = reinterpret_cast<bool(*)(UActorChannel*)>(
            BaseAddress + 0x03B7B470)(ActorChannel);
        NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
            + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
            + std::to_string(reinterpret_cast<uintptr_t>(Connection)) + " channel="
            + std::to_string(reinterpret_cast<uintptr_t>(ActorChannel)) + " result="
            + (ExistingChannel ? std::string("EXISTING") : std::string("CREATED"))
            + " wroteData=" + std::to_string(WroteData ? 1 : 0));
        return WroteData ? (ExistingChannel ? 3 : 2) : 1;
    }

    static FWorldContext* ResolveWorldContextFromWorld(UEngine* Engine, UWorld* World) {
        if (!Engine || !World) {
            return nullptr;
        }

        FWorldContext** WorldList = *reinterpret_cast<FWorldContext***>((uintptr_t)Engine + 0xC38);
        int32_t WorldListCount = *reinterpret_cast<int32_t*>((uintptr_t)Engine + 0xC40);

        for (int32_t i = 0; i < WorldListCount; ++i) {
            FWorldContext* Context = WorldList[i];
            if (!Context) {
                continue;
            }

            UWorld* ContextWorld = *reinterpret_cast<UWorld**>((uintptr_t)Context + 0x280);
            if (ContextWorld == World) {
                return Context;
            }
        }

        return nullptr;
    }

    static UNetDriver* ResolveNamedNetDriver(FWorldContext* Context, const FName& DriverName) {
        if (!Context) {
            return nullptr;
        }

        auto ActiveNetDrivers = *reinterpret_cast<uint8_t**>((uintptr_t)Context + 0x220);
        int32_t ActiveNetDriverCount = *reinterpret_cast<int32_t*>((uintptr_t)Context + 0x228);
        int32_t ActiveNetDriverMax = *reinterpret_cast<int32_t*>((uintptr_t)Context + 0x22C);

        if (ActiveNetDriverCount < 0 || ActiveNetDriverCount > ActiveNetDriverMax || ActiveNetDriverMax > 128) {
            NetLog(LastPort, "[ResolveNamedNetDriver] Invalid ActiveNetDrivers array metadata");
            return nullptr;
        }

        if (ActiveNetDriverCount > 0 && !IsReadablePointer(ActiveNetDrivers, static_cast<size_t>(ActiveNetDriverCount) * 0x10)) {
            NetLog(LastPort, "[ResolveNamedNetDriver] ActiveNetDrivers data is not readable");
            return nullptr;
        }

        for (int32_t i = 0; i < ActiveNetDriverCount; ++i) {
            UNetDriver* Candidate = *reinterpret_cast<UNetDriver**>(ActiveNetDrivers + (static_cast<size_t>(i) * 0x10));
            if (!IsReadablePointer(Candidate, 0x2B0)) {
                continue;
            }

            if (!Candidate->IsA(SDK::UNetDriver::StaticClass())) {
                continue;
            }

            if (Candidate->NetDriverName == DriverName) {
                return Candidate;
            }
        }

        return nullptr;
    }

    static UNetDriver* FindNamedNetDriverInGObjects(const FName& DriverName) {
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj || Obj->IsDefaultObject()) {
                continue;
            }

            if (Obj->IsA(SDK::UNetDriver::StaticClass()))
            {
                UNetDriver* Candidate = (UNetDriver*)Obj;
                if (!IsReadablePointer(Candidate, 0x2B0)) {
                    continue;
                }

                if (Candidate->NetDriverName == DriverName) {
                    return Candidate;
                }
            }
        }

        return nullptr;
    }

    void Listen(UEngine* Engine, int Port) {
        std::cout << "[Networking::Listen] Entry" << std::endl;
        NetLog(Port, "[Networking::Listen] Entry");
        LastPort = Port;
        BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        std::cout << "[Networking::Listen] Creating NetDriver..." << std::endl;
        NetLog(Port, "[Networking::Listen] Creating NetDriver...");

        UWorld* World = UWorld::GetWorld();
        FWorldContext* WorldContext = ResolveWorldContextFromWorld(Engine, World);
        if (!WorldContext) {
            std::cout << "[Networking::Listen] ERROR: FWorldContext not found!" << std::endl;
            NetLog(Port, "[Networking::Listen] ERROR: FWorldContext not found");
            return;
        }

        using CreateNamedNetDriverFn = bool (*)(UEngine*, FWorldContext*, FName, FName);
        bool Created = reinterpret_cast<CreateNamedNetDriverFn>(BaseAddress + 0x04033D20)(
            Engine,
            WorldContext,
            GameNetDriver,
            GameNetDriver
        );
        std::cout << "Net driver create: " << Created << std::endl;
        NetLog(Port, std::string("[Networking::Listen] CreateNamedNetDriver returned ") + (Created ? "true" : "false"));

        NetDriver = ResolveNamedNetDriver(WorldContext, GameNetDriver);
        if (!NetDriver) {
            std::cout << "[Networking::Listen] ActiveNetDrivers lookup failed; searching GObjects for named NetDriver..." << std::endl;
            NetLog(Port, "[Networking::Listen] ActiveNetDrivers lookup failed; searching GObjects for named NetDriver");
            NetDriver = FindNamedNetDriverInGObjects(GameNetDriver);
        }

        if (!NetDriver) {
            std::cout << "[Networking::Listen] ERROR: named NetDriver not found!" << std::endl;
            NetLog(Port, "[Networking::Listen] ERROR: named NetDriver not found");
            return;
        }

        std::cout << "[Networking::Listen] NetDriver found: " << NetDriver << std::endl;
        NetLog(Port, "[Networking::Listen] NetDriver found at 0x" + std::to_string((uintptr_t)NetDriver));
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        std::cout << "[Networking::Listen] Setting World directly (offset 0x140)..." << std::endl;
        NetLog(Port, "[Networking::Listen] Setting World");

        
        
        NetDriver->World = UWorld::GetWorld();

        std::cout << "[Networking::Listen] Creating URL..." << std::endl;
        FURL url = FURL();

        url.Port = Port;

        FString empy = FString();

        std::cout << "[Networking::Listen] Calling Listen..." << std::endl;
        NetLog(Port, "[Networking::Listen] Calling Listen...");
        bool ListenStatus = (*(reinterpret_cast<bool(**)(UNetDriver*, void*, FURL*, bool, FString*)>(*(__int64*)NetDriver + 0x290)))(NetDriver, reinterpret_cast<void*>((uintptr_t)UWorld::GetWorld() + 0x28), &url, false, &empy);
        std::cout << "Listen Status: " << ListenStatus << std::endl;
        NetLog(Port, std::string("[Networking::Listen] Listen returned ") + (ListenStatus ? "true" : "false"));

        std::string ListenError = empy.ToString();
        if (!ListenError.empty()) {
            NetLog(Port, "[Networking::Listen] Error: " + ListenError);
        }

        if (!ListenStatus) {
            NetLog(Port, "[Networking::Listen] ERROR: InitListen returned false");
            return;
        }

        
        NetDriver->World = UWorld::GetWorld();
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        
        
        std::cout << "[Networking::Listen] Complete!" << std::endl;
        NetLog(Port, "[Networking::Listen] Complete");

        
        
        char LaunchId[128]{};
        const DWORD LaunchIdLength = GetEnvironmentVariableA("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", LaunchId, sizeof(LaunchId));
        if (LaunchIdLength > 0 && LaunchIdLength < sizeof(LaunchId)) {
            std::cout << "MYSTICPARADOX_GAMESERVER_READY launchId=" << LaunchId << " port=" << Port << std::endl;
            NetLog(Port, std::string("[Networking::Listen] Ready marker emitted launchId=") + LaunchId);
        }
    }

    void TickNetworking() {
        UWorld* World = UWorld::GetWorld();
        if (!World || !IsReadablePointer(NetDriver, 0x2B0)) {
            NetLog(LastPort, "[TickNetworking] Invalid World or NetDriver; skipping");
            return;
        }

        
        NetDriver->World = World;
        NetDriver->ServerConnection = nullptr;

        static FName name = FName();
        static bool nameInit = false;

        if (!nameInit) {
            nameInit = true;
            name = UKismetStringLibrary::Conv_StringToName(L"Actor");
        }

        static FName gameNetDriverName = FName();
        static bool gameNetDriverNameInit = false;

        if (!gameNetDriverNameInit) {
            gameNetDriverNameInit = true;
            gameNetDriverName = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        }

        NetDriver->NetDriverName = gameNetDriverName;

        
        
        
        
        
        {
            static uint64_t s_graphDumpMs = 0;
            static int s_lastLiveConns = -2;
            int liveConns = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x98), 4))
                            ? *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x98) : -1;
            uint64_t gnow = static_cast<uint64_t>(GetTickCount64());
            bool connEdge = (liveConns != s_lastLiveConns);
            if (RepGraphDiagNet() && (connEdge || (gnow - s_graphDumpMs > 2000))) {
                s_graphDumpMs = gnow;
                s_lastLiveConns = liveConns;
                void* graph = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                              ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
                void* ndWorld = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x148), 8))
                                ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x140) : nullptr;
                
                
                
                void* replGate = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x110), 8))
                                 ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x108) : nullptr;
                if (graph && IsReadablePointer(graph, 0xB8)) {
                    void* gClass = *reinterpret_cast<void**>((uintptr_t)graph + 0x10);
                    std::string gcn = (gClass && IsReadablePointer(gClass, 0x20)) ? reinterpret_cast<UObject*>(gClass)->GetName() : "(null)";
                    void* gDriver    = *reinterpret_cast<void**>((uintptr_t)graph + 0x30);
                    void* connMgrCls = *reinterpret_cast<void**>((uintptr_t)graph + 0x28);
                    int globalNodes  = *reinterpret_cast<int*>((uintptr_t)graph + 0xA0);
                    int prepNodes    = *reinterpret_cast<int*>((uintptr_t)graph + 0xB0);
                    int connMgrs     = *reinterpret_cast<int*>((uintptr_t)graph + 0x40);
                    int pendConns    = *reinterpret_cast<int*>((uintptr_t)graph + 0x50);
                    std::string sub = "";
                    if (IsReadablePointer(graph, 0x4C8)) {   
                        void* gridNode = *reinterpret_cast<void**>((uintptr_t)graph + 0x498);
                        void* alwaysRel = *reinterpret_cast<void**>((uintptr_t)graph + 0x4A0);
                        int arfc       = *reinterpret_cast<int*>((uintptr_t)graph + 0x4B0);
                        int actorsNoC  = *reinterpret_cast<int*>((uintptr_t)graph + 0x4C0);
                        sub = " GridNode=" + std::to_string((uintptr_t)gridNode)
                            + " AlwaysRelevantNode=" + std::to_string((uintptr_t)alwaysRel)
                            + " ARFCList=" + std::to_string(arfc)
                            + " ActorsNoConn=" + std::to_string(actorsNoC);
                    }
                    NetLog(LastPort, std::string("[GraphState]") + (connEdge ? " (CONN-EDGE)" : "")
                        + " driver=" + std::to_string((uintptr_t)graph) + " (" + gcn + ")"
                        + " graph.NetDriver=" + std::to_string((uintptr_t)gDriver)
                        + " ConnMgrClass=" + std::to_string((uintptr_t)connMgrCls)
                        + " GlobalGraphNodes=" + std::to_string(globalNodes)
                        + " PrepareNodes=" + std::to_string(prepNodes)
                        + " ConnMgrs=" + std::to_string(connMgrs)
                        + " PendingConns=" + std::to_string(pendConns)
                        + sub
                        + " | NetDriver.World=" + std::to_string((uintptr_t)ndWorld)
                        + " ClientConns=" + std::to_string(liveConns)
                        + " replGate(+0x108)=" + std::to_string((uintptr_t)replGate));

                    
                    
                    
                    
                    
                    
                    
                    if (IsReadablePointer(graph, 0x4C8)) {
                        void** awncData = *reinterpret_cast<void***>((uintptr_t)graph + 0x4B8);
                        int awncNum = *reinterpret_cast<int*>((uintptr_t)graph + 0x4C0);
                        if (awncData && awncNum > 0 && awncNum < 4096) {
                            int cap = awncNum < 8 ? awncNum : 8;
                            for (int i = 0; i < cap; ++i) {
                                if (!IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(awncData) + (size_t)i * 8), 8)) break;
                                AActor* a = reinterpret_cast<AActor*>(awncData[i]);
                                if (!a || !IsReadablePointer(a, 0x420)) continue;
                                std::string acn = a->Class ? a->Class->GetName() : "(null-cls)";
                                std::string afn = a->GetFullName();
                                void* conn = nullptr;
                                std::string chain;
                                AActor* cur = a;
                                for (int d = 0; d < 5 && cur && IsReadablePointer(cur, 0x420); ++d) {
                                    if (cur->IsA(APlayerController::StaticClass())) {
                                        conn = *reinterpret_cast<void**>((uintptr_t)cur + 0x418);
                                        chain += "->PC";
                                        break;
                                    }
                                    AActor* own = *reinterpret_cast<AActor**>((uintptr_t)cur + 0xE0);
                                    chain += (own && IsReadablePointer(own, 0x20) && own->Class) ? ("->" + own->Class->GetName()) : "->(null)";
                                    cur = own;
                                }
                                NetLog(LastPort, "[ActorsNoConn #" + std::to_string(i) + "/" + std::to_string(awncNum) + "] "
                                    + acn + " (" + afn + ") ownerChain=" + chain
                                    + " resolvedConn=" + std::to_string((uintptr_t)conn));
                            }
                        }
                    }
                } else {
                    NetLog(LastPort, std::string("[GraphState]") + (connEdge ? " (CONN-EDGE)" : "")
                        + " ReplicationDriver=" + std::to_string((uintptr_t)graph) + " (null/unreadable)"
                        + " | NetDriver.World=" + std::to_string((uintptr_t)ndWorld)
                        + " ClientConns=" + std::to_string(liveConns));
                }
            }
        }

        
        
        
        
        
        if (NativeGraphOnly()) {
            static bool s_loggedGraphOnly = false;
            if (!s_loggedGraphOnly) {
                s_loggedGraphOnly = true;
                NetLog(LastPort, "[NATIVE_GRAPH_ONLY] manual counters + actor-replication loop skipped "
                    "(driver/world maintenance only; native ArchonReplicationGraph + TickFlush own replication)");
            }
            return;
        }

        ++ * (uint32_t*)((uintptr_t)NetDriver + 0x2AC);

        
        
        
        
        
        
        {
            uint32_t* repFrame = reinterpret_cast<uint32_t*>((uintptr_t)NetDriver + 0x418);
            if (++(*repFrame) == 0) *repFrame = 1;
        }

        
        
        
        
        if (NativeReplicationOnly()) {
            static bool s_loggedNativeOnly = false;
            if (!s_loggedNativeOnly) {
                s_loggedNativeOnly = true;
                NetLog(LastPort, "[NATIVE_REPLICATION_ONLY] custom actor-replication loop skipped "
                    "(driver maintenance + counters still run; native TickDispatch/TickFlush drive replication)");
            }
            return;
        }

        
        
        
        
        
        {
            
            
            static uint64_t s_lastRepMs = 0;
            uint64_t nowT = static_cast<uint64_t>(GetTickCount64());
            if (nowT - s_lastRepMs < 50) return;   
            s_lastRepMs = nowT;
        }

        std::vector<std::pair<AActor*, bool>> Actors = BuildConsiderList(World, NetDriver);

        UNetConnection** Connections = *reinterpret_cast<UNetConnection***>((uintptr_t)NetDriver + 0x90);
        int32_t ConnectionCount = *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x98);
        int32_t ConnectionMax = *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x9C);

        if (!IsSanePointerArray(Connections, ConnectionCount, ConnectionMax, 1024)) {
            NetLog(LastPort, "[TickNetworking] Invalid ClientConnections array; skipping");
            return;
        }

        
        const bool ReverseConns = ReverseConnectionOrder();
        { static bool s_loggedRepOrder = false; if (!s_loggedRepOrder) { s_loggedRepOrder = true; NetLog(LastPort, std::string("[RepOrder] reverse=") + (ReverseConns ? "1" : "0")); } }
        for (int32_t ci = 0; ci < ConnectionCount; ++ci) {
            int32_t ConnectionIndex = ReverseConns ? (ConnectionCount - 1 - ci) : ci;
            UNetConnection* Connection = Connections[ConnectionIndex];
            if (!IsReadablePointer(Connection, 0x140)) {
                continue;
            }

            if (!Connection->OwningActor || *(uint32_t*)((uintptr_t)Connection + 0x134) != 3)
                continue;

            
            bool doRepActorLog = false;
            {
                static uint64_t s_repActorLogMs[16] = { 0 };
                uint64_t rn = static_cast<uint64_t>(GetTickCount64());
                int slotIdx = (ConnectionIndex >= 0 && ConnectionIndex < 16) ? ConnectionIndex : 0;
                if (rn - s_repActorLogMs[slotIdx] > 1000) { s_repActorLogMs[slotIdx] = rn; doRepActorLog = true; }
            }

            
            static std::atomic<uint64_t> s_lastLoopLogMs{0};
            uint64_t nowMs = static_cast<uint64_t>(GetTickCount64());
            bool doLoopLog = (nowMs - s_lastLoopLogMs.load(std::memory_order_relaxed)) > 1000;
            if (doLoopLog) s_lastLoopLogMs.store(nowMs, std::memory_order_relaxed);

            if (doLoopLog) {
                NetLog(LastPort, "[TickNetLoop] conn=" + std::to_string((uintptr_t)Connection)
                    + " owningActor=" + std::to_string((uintptr_t)Connection->OwningActor)
                    + " actors.size=" + std::to_string(Actors.size()));
            }

            int actorsProcessed = 0;
            int channelsFound = 0;
            int channelsCreated = 0;
            int channelsFailed = 0;
            int channelsWithActor = 0;

            for (auto& _considerEntry : Actors) {
                AActor* Actor = _considerEntry.first;
                bool bActorPersistent = _considerEntry.second;
                actorsProcessed++;

                
                
                
                
                
                if (LevelVisibilityGate() && !bActorPersistent && Actor->Class) {
                    std::string _cn = Actor->Class->GetName();
                    bool _critical = Actor->IsA(APlayerController::StaticClass()) || Actor->IsA(APawn::StaticClass())
                        || _cn.find("inventory") != std::string::npos || _cn.find("loadout") != std::string::npos;
                    if (!_critical) {
                        static std::atomic<int> s_skipLog{ 0 };
                        if (s_skipLog.fetch_add(1, std::memory_order_relaxed) < 80) {
                            NetLog(LastPort, "[RepSkipInvisible] connIdx=" + std::to_string(ConnectionIndex)
                                + " conn=" + std::to_string((uintptr_t)Connection)
                                + " class=" + _cn + " actor=" + Actor->GetFullName());
                        }
                        continue;
                    }
                }

                
                
                
                if (HybridReplication() && (Actor->IsA(APlayerController::StaticClass()) || Actor->IsA(APawn::StaticClass()))) {
                    continue;
                }
                if ((Actor->IsA(APlayerController::StaticClass()))) {
                    if (Actor != Connection->OwningActor) {
                        continue;
                    }
                    else {
                        
                        Connection->ViewTarget = ((APlayerController*)Actor)->GetViewTarget();

                        if (!Connection->ViewTarget)
                            std::cout << "NULL VIEWTARGET BAD THINGS WILL HAPPEN" << std::endl;

                        reinterpret_cast<void(*)(APlayerController*)>(BaseAddress + 0x03E9ABF0)((APlayerController*)Actor);
                    }
                }

                

                UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor);
                if (ActorChannel) channelsFound++;

                bool bJustCreated = false;
                if (!ActorChannel) {
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    ActorChannel = reinterpret_cast<UActorChannel * (*)(UNetConnection*, FName*, unsigned int, int)>(BaseAddress + 0x03D47AC0)(Connection, &name, 1 << 1, -1);
                    if (ActorChannel) { channelsCreated++; bJustCreated = true; }
                    else channelsFailed++;

                    if (ActorChannel) {
                        reinterpret_cast<void(*)(UActorChannel*, AActor*, unsigned int)>(BaseAddress + 0x03B80890)(ActorChannel, Actor, 0);
                    }
                }

                if (ActorChannel && ActorChannel->Actor) {
                    channelsWithActor++;
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    if (Actor->Class && Actor->Class->GetName() == "bp_archon_loadout_C") {
                        static std::atomic<uint64_t> s_loLast{ 0 };
                        uint64_t lm = static_cast<uint64_t>(GetTickCount64());
                        if (lm - s_loLast.load(std::memory_order_relaxed) > 1000) {
                            s_loLast.store(lm, std::memory_order_relaxed);
                            void* netConn = nullptr;
                            uintptr_t vt = *reinterpret_cast<uintptr_t*>(Actor);
                            if (IsReadablePointer(reinterpret_cast<void*>(vt + 0x4C0), 8))
                                netConn = reinterpret_cast<void*(*)(void*)>(*reinterpret_cast<void**>(vt + 0x4C0))(Actor);
                            void* chanConn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(ActorChannel) + 0x28);
                            NetLog(LastPort, "[LoadoutRepFlags] loadout=" + Actor->GetName()
                                + " GetNetConn(+4C0)=" + std::to_string(reinterpret_cast<uintptr_t>(netConn))
                                + " thisConn=" + std::to_string(reinterpret_cast<uintptr_t>(Connection))
                                + " chanConn(+28)=" + std::to_string(reinterpret_cast<uintptr_t>(chanConn))
                                + " bNetOwner=" + std::to_string(netConn == reinterpret_cast<void*>(Connection) ? 1 : 0));

                            
                            
                            
                            
                            if (IsReadablePointer(Actor, 0x688)) {
                                uintptr_t lo = reinterpret_cast<uintptr_t>(Actor);
                                NetLog(LastPort, "[LoadoutState] loadout=" + Actor->GetName()
                                    + " conn=" + std::to_string(reinterpret_cast<uintptr_t>(Connection))
                                    + " bNetOwner=" + std::to_string(netConn == reinterpret_cast<void*>(Connection) ? 1 : 0)
                                    + " slotData=" + std::to_string(*reinterpret_cast<uintptr_t*>(lo + 0x670))
                                    + " slotNum=" + std::to_string(*reinterpret_cast<int32_t*>(lo + 0x678))
                                    + " slotMax=" + std::to_string(*reinterpret_cast<int32_t*>(lo + 0x67C))
                                    + " activeIdx=" + std::to_string(*reinterpret_cast<int32_t*>(lo + 0x680)));
                            }
                        }
                    }
                    bool wroteData = reinterpret_cast<bool(*)(UActorChannel*)>(BaseAddress + 0x03B7B470)(ActorChannel);
                    
                    
                    
                    
                    
                    
                    if (bJustCreated && Actor->Class) {
                        void* ownerPtr = nullptr; std::string ownerName = "null";
                        if (IsReadablePointer(Actor, 0xE8)) {
                            ownerPtr = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Actor) + 0x00E0);
                            if (ownerPtr && IsReadablePointer(ownerPtr, 0x40)) ownerName = reinterpret_cast<AActor*>(ownerPtr)->GetName();
                        }
                        NetLog(LastPort, "[ChannelCreate] connIdx=" + std::to_string(ConnectionIndex)
                            + " conn=" + std::to_string((uintptr_t)Connection)
                            + " class=" + Actor->Class->GetName()
                            + " wroteData=" + std::to_string(wroteData ? 1 : 0)
                            + " owner=" + std::to_string((uintptr_t)ownerPtr) + "/" + ownerName
                            + " actor=" + Actor->GetFullName());
                    }
                    
                    
                    
                    
                    if (doRepActorLog && Actor->Class) {
                        std::string cn = Actor->Class->GetName();
                        if (cn.find("player_controller") != std::string::npos || cn.find("PlayerCharacter") != std::string::npos
                            || cn.find("inventory") != std::string::npos || cn.find("loadout") != std::string::npos) {
                            void* netConn = nullptr;
                            uintptr_t vt = *reinterpret_cast<uintptr_t*>(Actor);
                            if (IsReadablePointer(reinterpret_cast<void*>(vt + 0x4C0), 8))
                                netConn = reinterpret_cast<void*(*)(void*)>(*reinterpret_cast<void**>(vt + 0x4C0))(Actor);
                            NetLog(LastPort, "[RepActor] connIdx=" + std::to_string(ConnectionIndex)
                                + " conn=" + std::to_string((uintptr_t)Connection)
                                + " actor=" + Actor->GetName() + " class=" + cn
                                + " initial=" + std::to_string(bJustCreated ? 1 : 0)
                                + " owner=" + std::to_string(netConn == reinterpret_cast<void*>(Connection) ? 1 : 0)
                                + " wroteData=" + std::to_string(wroteData ? 1 : 0));
                        }
                    }
                }
            }

            if (doLoopLog) {
                NetLog(LastPort, "[TickNetLoop] processed=" + std::to_string(actorsProcessed)
                    + " existing=" + std::to_string(channelsFound)
                    + " created=" + std::to_string(channelsCreated)
                    + " failed=" + std::to_string(channelsFailed)
                    + " withActor=" + std::to_string(channelsWithActor));
            }
        }
    }
}
