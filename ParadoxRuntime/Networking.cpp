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
#include "P2PHooks.h"

#include <fstream>
#include <iostream>
#include <string>
#include <string_view>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;

    static uintptr_t BaseAddress = 0x0;
    static int LastPort = 0; // Set once in Listen(); lets TickNetworking() (no Port param) log to the right per-port file.
    static void NetLog(int Port, const std::string& Msg);

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

    // Log directory derived from the game .exe path (mirrors dllmain's MpLogDir) so net
    // telemetry appears on the VPS too. The previous hardcoded dev-box debug path only
    // exists on the dev box, so every NetLog write silently failed on the VPS and the
    // [TickNetLoop] actor-loop telemetry (the exact evidence needed for the 2-player join)
    // was lost. Not under loader lock (called from Listen()/TickNetworking() on MainThread),
    // so a plain function-local static is safe.
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
        // Same file as dllmain's MpLog ("<exedir>\mysticparadox_dll_port<port>.log") so [TickNetLoop]
        // and [NetTickTrace] lines interleave in one per-port log.
        sprintf_s(Path, "%smysticparadox_dll_port%d.log", NetLogDir(), Port);

        std::ofstream File(Path, std::ios::app);
        if (File.is_open()) {
            File << Msg << "\n";
            File.flush();
        }
    }

    // [A/B 2026-07-16] NATIVE_REPLICATION_ONLY.flag — reversible diagnostic switch for the
    // two-players-in-one-instance join failure. When the flag file exists next to the game .exe
    // (exe-relative, VPS-safe), TickNetworking still runs driver maintenance + both counters
    // (+0x2AC, +0x418) but SKIPS the custom BuildConsiderList -> CreateChannelByName ->
    // ReplicateActor loop, leaving replication to the engine's native TickFlush/
    // ServerReplicateActors path (driven from dllmain via SafeManualTickDispatch/TickFlush).
    // This isolates whether the hand-rolled loop is what strands the late joiner. Default OFF
    // (absent flag = current custom-loop behaviour). Read once — set the flag before launch.
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

    // [2026-07-16] REVERSE_CONNECTION_ORDER.flag — reversible per-connection-starvation test. When
    // present next to the game .exe, TickNetworking iterates client connections back-to-front. If
    // the stuck late joiner then completes and the other player becomes starved, the manual loop
    // has first-connection/shared-frame state; if the same joiner stays stuck, the defect is a
    // specific init property/RPC queued behind the first connection. Read once (set before launch).
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

    // [2026-07-16] HYBRID_REPLICATION.flag — ordering fix-test for the late-joiner actor graph. When
    // present next to the game .exe, the custom loop SKIPS PlayerController + Pawn actors, letting the
    // engine's native ServerReplicateActors (driven from dllmain's TickFlush) own the PC/pawn/ownership/
    // NetGUID ordering, while the custom loop keeps replicating only what native does not deliver here
    // (inventory/loadout/etc). Tests whether the custom loop racing the pawn ahead of the native
    // PlayerController/ownership channel is the late-join break. Read once (set before launch).
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

    // [2026-07-16] LEVEL_VISIBILITY_GATE.flag — THE missing per-connection level-visibility check. The
    // custom loop was calling CreateChannelByName->SetChannelActor->ReplicateActor directly WITHOUT the
    // check native ServerReplicateActors does, so it shipped streamed-sublevel actors (e.g.
    // ramsgate_01_katplaza WorldSettings) before the client acked those levels -> client SerializeNewActor
    // refuses them (Actor: None) and streamed-sublevel interaction breaks for P1 too. When set, the loop
    // skips non-persistent-level actors EXCEPT the ownership-critical ones we must always deliver
    // (PlayerController / Pawn / inventory / loadout); native replication handles the streamed rest with
    // its real per-connection visibility check. Read once (set before launch).
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

    // [A/B 2026-07-16] NATIVE_GRAPH_ONLY.flag — the perfectly-isolated native test. Once the real
    // ArchonReplicationGraph is installed (REPGRAPH_SELF_CONSTRUCT), the native driver + TickFlush own the
    // ENTIRE replication lifecycle — including the +0x2AC / +0x418 frame counters that NATIVE_REPLICATION_ONLY
    // still advanced manually (double-driving the graph's frame). When this flag is present, TickNetworking
    // does ONLY the minimal driver/world maintenance (World, ServerConnection, NetDriverName) and returns,
    // skipping the manual counters, BuildConsiderList, CreateChannelByName, SetChannelActor and ReplicateActor
    // entirely, so the installed graph is the sole replication path. Default OFF. Read once — set before launch.
    static bool NativeGraphOnly() {
        // PRODUCTION: native graph is the SOLE replication path (custom actor loop OFF) by default.
        // EMERGENCY_LEGACY_REPLICATION.flag reverts to the hand-written loop.
        static int Cached = -1;
        if (Cached < 0) {
            Cached = 1;   // default: native-graph-only
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

    // [2026-07-17 PRODUCTION] Per-tick RepGraph diagnostics ([GraphState]/[ActorsNoConn]) are OFF in
    // production; REPGRAPH_DIAG.flag re-enables them for development.
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

    // ===== [1.14.7 PORT STATUS] =====
    // Ghidra verification for CL 647472 (2026-10-03):
    //   CreateNamedNetDriver: RVA 0x0425FDA0 (entry; failure/duplicate strings xref here).
    //   The old 1.12 RVA 0x04033D20 is inside FUN_144033CC0 at its loop compare, not a function entry.
    //   [2026-10-08 CORRECTION] The next five are 1.12 RVAs and are NOT function entries on 1.14.7
    //   (Ghidra 1.14.7 DB): ActorConsiderSetup 0x0394B400, PC_NetUpdate 0x03E9ABF0,
    //   CreateChannelByName 0x03D47AC0 (mid-instruction in the spline query FUN_143d47a90),
    //   SetChannelActor 0x03B80890 (mid-function), ReplicateActor 0x03B7B470.
    //   1.14.7 candidates by string xref, ABI unproven: CreateChannelByName 0x03F62E90,
    //   SetChannelActor 0x03D8FB20, ReplicateActor 0x03D8A2D0. No code path calls any of them now.
    // SKIPPED (direct assignment works):
    //   SetWorld: We directly set NetDriver->World at offset 0x140 (SDK confirmed) - function call not needed
    // UNVERIFIED (runtime-check): Actor VTable+0x150 (GetWorld), NetDriver vtable+0x280 (InitListen),
    //   NetDriver+0x2AC (counter), ActorChannel+0x90 (flags). Connection+0x134 (State) CONFIRMED unchanged.
    // NetworkNotify: UWorld+0x28 (unnamed in 1.12.0 SDK; layout stable). ================

    static std::vector<std::pair<AActor*, bool>> BuildConsiderList(UWorld* World, UNetDriver* Driver) {
        std::vector<std::pair<AActor*, bool>> Actors;

        // [2026-07-16] Persistent level for the level-visibility gate (UWorld->PersistentLevel @+0x30).
        // Persistent-level actors are always visible; streamed-sublevel actors must wait for the client
        // visibility ack, so the gate in TickNetworking skips non-persistent non-critical actors.
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

                // [1.12.0 FIX 2026-07-10] Native replication uses actor vtable +0x158 as early
                // filter (likely GetWorld() or IsNetRelevantFor()). Old +0x150 was unverified
                // and inherited from 1.4.4 (UE 4.25). UE 4.25 → 4.26 shifted this slot by one
                // 8-byte vtable entry. If +0x158 was wrong, actors would be silently filtered.
                if (!reinterpret_cast<UWorld * (*)(AActor*)>(*(void**)((uintptr_t)Actor->VTable + 0x158))(Actor)) {
                    continue;
                }

                reinterpret_cast<void(*)(AActor*, UNetDriver*)>(BaseAddress + 0x0394B400)(Actor, Driver);

                Actors.push_back({ Actor, bPersistent });
            }
        }

        /*
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsDefaultObject())
                continue;

            if (Obj->IsA(SDK::AActor::StaticClass()))
            {
                AActor* Actor = (AActor*)Obj;

                if (Actor->RemoteRole == ENetRole::ROLE_None)
                    continue;

                if (Actor->bActorIsBeingDestroyed)
                    continue;

                if (!reinterpret_cast<UWorld * (*)(AActor*)>(*(void**)((uintptr_t)Actor->VTable + 0x158))(Actor)) {
                    continue;
                }
                
                reinterpret_cast<void(*)(AActor*, UNetDriver*)>(BaseAddress + 0x0394B400)(Actor, Driver);

                Actors.push_back(Actor);
            }
        }
        */

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

    // See the comment on the declaration in Networking.h. Pure read: walks the same OpenChannels
    // array GetActorChannelForConnectionAndActor uses and reports the ChIndex, never creating,
    // closing or touching a channel. UChannel::ChIndex sits at +0x20 on this build (the slot
    // between Connection@0x28 and the class pointer, confirmed against the OpenChannels walk).
    // [2026-07-25] Returns 1 when an open actor channel exists for this pair, -1 when it does not,
    // -2 when the inputs are unusable. Deliberately reports PRESENCE, not ChIndex: the first cut
    // read a guessed UChannel::ChIndex offset and produced garbage (repro 11 logged
    // chIndex=-173321872), which made every sample look "closed" and suppressed every transition.
    // Presence is what the churn question actually needs and it requires no unverified offset.
    int GetActorChannelIndexForConnection(AActor* Actor, UNetConnection* Connection) {
        if (!Actor || !IsReadablePointer(Connection, 0x80)) return -2;
        return GetActorChannelForConnectionAndActor(Connection, Actor) ? 1 : -1;
    }

    static bool IsActorChannelBootstrapSafe(AActor* Actor) {
        if (!Actor || !IsReadablePointer(Actor, 0x60)) return false;
        __try {
            constexpr uint32_t kRF_BeginDestroyed = 0x00008000u;
            constexpr uint32_t kRF_FinishDestroyed = 0x00010000u;
            const uintptr_t Address = reinterpret_cast<uintptr_t>(Actor);
            const uint32_t ObjectFlags = *reinterpret_cast<const uint32_t*>(Address + 0x08);
            const uint8_t ActorFlags5C = *reinterpret_cast<const uint8_t*>(Address + 0x5C);
            return (ActorFlags5C & 0x08u) == 0
                && (ObjectFlags & (kRF_BeginDestroyed | kRF_FinishDestroyed)) == 0;
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            return false;
        }
    }

    int BootstrapActorChannel(AActor* Actor, UNetConnection* Connection,
                              ActorChannelPushDiag* OutDiag) {
        if (OutDiag) *OutDiag = ActorChannelPushDiag{};
        if (!IsActorChannelBootstrapSafe(Actor) || !Connection
            || !IsReadablePointer(Connection, 0x140)) {
            return 0;
        }

        UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor);

        // [1.14.7 FIX 2026-10-08] Never create a channel here. This used the 1.12 RVAs
        // CreateChannelByName 0x03D47AC0 and SetChannelActor 0x03B80890. On 1.14.7, 0x03D47AC0 is one
        // byte inside `lea r9,[rip+..]` in the spline direction query FUN_143d47a90: entered there it
        // runs `lea ecx,[rip+..]` and calls the curve evaluator with a 32-bit image address as the
        // curve. That was the whole "hub spline crash" - every crash carried this call's own arguments
        // (r8=2, r9=0xFFFFFFFF), rax=base+0x3D47AC0, and rcx=low32(base+0x6DF33F8). 0x03B80890 is
        // mid-function on 1.14.7. Ghidra 1.14.7 candidates (string xrefs, ABI not yet proven):
        // CreateChannelByName 0x03F62E90, SetChannelActor 0x03D8FB20. The driven Archon graph opens
        // this actor's channel itself, so the bootstrap only reports whether one exists.
        if (!ActorChannel || ActorChannel->Actor != Actor) {
            NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
                + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
                + std::to_string(reinterpret_cast<uintptr_t>(Connection))
                + " result=NO_CHANNEL (creation disabled on 1.14.7; the replication graph opens it)");
            return 0;
        }

        // Snapshot the exact gates UActorChannel::ReplicateActor tests in its prologue, immediately
        // before we call it. Without this, wroteData=0 is ambiguous between "could not try" and
        // "nothing was dirty" - see ActorChannelPushDiag in Networking.h for the verified offsets.
        ActorChannelPushDiag Diag{};
        Diag.Channel = ActorChannel;
        Diag.ExistingChannel = true;
        if (IsReadablePointer(ActorChannel, 0x94)) {
            const uintptr_t ChannelAddr = reinterpret_cast<uintptr_t>(ActorChannel);
            Diag.PendingDormancy =
                (*reinterpret_cast<uint32_t*>(ChannelAddr + 0x30) & 0x100u) != 0;
            Diag.ReplicatingReentrant =
                (*reinterpret_cast<uint32_t*>(ChannelAddr + 0x90) & 0x4u) != 0;
            Diag.Valid = true;
        }
        if (IsReadablePointer(Connection, 0x1511)) {
            Diag.ResendAllDataState = *reinterpret_cast<uint8_t*>(
                reinterpret_cast<uintptr_t>(Connection) + 0x1510);
        }

        // [1.14.7 FIX 2026-10-08] 0x03B7B470 is the 1.12 ReplicateActor RVA; on 1.14.7 no function starts
        // there. The 1.14.7 ReplicateActor is FUN_143d8a2d0 (RVA 0x03D8A2D0, "ReplicateActor called while
        // already replicating!" xref) but its ABI is unproven, so the push is skipped and the graph drive
        // replicates the channel on its own schedule.
        const bool WroteData = false;
        Diag.WroteData = WroteData;
        if (OutDiag) *OutDiag = Diag;
        NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
            + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
            + std::to_string(reinterpret_cast<uintptr_t>(Connection)) + " channel="
            + std::to_string(reinterpret_cast<uintptr_t>(ActorChannel))
            + " result=EXISTING pushSkipped=1 (1.14.7 ReplicateActor ABI unproven)"
            + " wroteData=" + std::to_string(WroteData ? 1 : 0)
            + " gateRead=" + std::to_string(Diag.Valid ? 1 : 0)
            + " pendingDormancy=" + std::to_string(Diag.PendingDormancy ? 1 : 0)
            + " reentrant=" + std::to_string(Diag.ReplicatingReentrant ? 1 : 0)
            + " resendAllData=" + std::to_string(Diag.ResendAllDataState)
            + " blocked=" + std::to_string(Diag.Blocked() ? 1 : 0));
        return 1;   // channel exists, nothing written (2/3 meant "wrote data" while the push ran)
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

    bool Listen(UEngine* Engine, int Port) {
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
            return false;
        }

        using CreateNamedNetDriverFn = bool (*)(UEngine*, FWorldContext*, FName, FName);
        bool Created = reinterpret_cast<CreateNamedNetDriverFn>(BaseAddress + 0x0425FDA0)(
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
            return false;
        }

        std::cout << "[Networking::Listen] NetDriver found: " << NetDriver << std::endl;
        NetLog(Port, "[Networking::Listen] NetDriver found at 0x" + std::to_string((uintptr_t)NetDriver));
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        std::cout << "[Networking::Listen] Setting World directly (offset 0x140)..." << std::endl;
        NetLog(Port, "[Networking::Listen] Setting World");

        // SetWorld is a simple function that just stores World at NetDriver+0x140
        // We do it directly instead of calling the function with wrong RVA
        NetDriver->World = UWorld::GetWorld();

        std::cout << "[Networking::Listen] Creating URL..." << std::endl;
        FURL url = FURL();

        url.Port = Port;

        // The optional player-hosted mode may refuse the listen or pin its address (P2PHooks.h).
        // ListenHost outlives the Listen call below, which reads url.Host.
        std::wstring ListenHost;
        if (!P2PHooks::PrepareListen(ListenHost)) {
            return false;
        }
        if (!ListenHost.empty()) {
            url.Host = FString(ListenHost.c_str());
        }

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
            return false;
        }

        // SetWorld again after Listen (direct assignment)
        NetDriver->World = UWorld::GetWorld();
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        // [1.14.7 FIX 2026-10-04] DIRECT poke of UWorld::NetDriver (UWorld+0x38).
        //
        // The previous comment relied on level-collection registration propagating the driver into
        // UWorld->NetDriver. That path is rejected in this build:
        //   [CollectionFix] registration REJECTED (driver not in WorldContext; would re-null)
        // so UWorld->NetDriver kept pointing at the game's own driver and the engine's tick never drove OURS.
        // Measured consequence: with the manual drive off, the hub made ZERO receive calls while the client
        // sent "sendto -> 127.0.0.1:8790 len=29" once a second for 20s - the socket was simply never read.
        //
        // Pointing the world at our named driver makes the engine's own tick dispatch it exactly once, which
        // is what removes the need for the manual second engine tick (and its null+0x88 fault).
        // [1.14.7 FIX 2026-10-04] Poke EVERY world candidate, not just UWorld::GetWorld().
        //
        // UWorld::GetWorld() returns the GWorld global, but the engine may be ticking a different UWorld
        // object - and if that one's NetDriver (+0x38) stays null, anything that consults the net driver
        // through it reads [NULL + 0x88] = UNetDriver::ServerConnection, which is exactly the fault signature
        // measured inside the manual UIpNetDriver::TickDispatch call:
        //     ManualTickDispatchSEH code=0xC0000005 params=0x0,0x88 regs{rax=0x0 ...}
        // So cover all of them: UWorld::GetWorld(), the direct GWorld global, and every UWorld found in
        // GObjects. Each is logged with its before/after driver so the log shows which world the net path
        // actually uses.
        // [1.14.7 CORRECTION 2026-10-04] Assign the driver to the world that OWNS it - not to every UWorld.
        //
        // The previous version poked UWorld::GetWorld(), the GWorld global, and up to six further UWorld
        // objects found in GObjects. That is wrong on its own terms: a UNetDriver belongs to exactly ONE world
        // (and NetDriver->World is set to UWorld::GetWorld() just above), so fanning one driver across eight
        // worlds corrupts the ownership relation rather than establishing it - and the engine's world never
        // got the driver it actually needed.
        //
        // The authoritative owner is the FWorldContext that CreateNamedNetDriver was given. Resolve the world
        // from THAT (FWorldContext+0x280, the same offset ResolveWorldContextFromWorld uses in reverse) and
        // poke only it.
        UWorld* OwningWorld = nullptr;
        if (WorldContext && IsReadablePointer(WorldContext, 0x288)) {
            OwningWorld = *reinterpret_cast<UWorld**>(reinterpret_cast<uintptr_t>(WorldContext) + 0x280);
        }
        if (OwningWorld != nullptr && IsReadablePointer(OwningWorld, 0x40)) {
            UNetDriver** Slot = reinterpret_cast<UNetDriver**>(reinterpret_cast<uintptr_t>(OwningWorld) + 0x38);
            UNetDriver* Previous = *Slot;
            if (Previous != NetDriver) {
                *Slot = NetDriver;
                NetLog(Port, std::string("[Networking::Listen] set UWorld::NetDriver on the WorldContext's world ")
                    + (Previous ? "(replaced a previous driver)" : "(was null)"));
            }
            else {
                NetLog(Port, "[Networking::Listen] the WorldContext's world already points at our named driver");
            }

            // Validate the ownership relation in the other direction too: the driver's own World must agree
            // with the world it has just been assigned to.
            if (NetDriver->World != OwningWorld) {
                NetLog(Port, "[Networking::Listen] driver World differed from the WorldContext world; aligning them");
                NetDriver->World = OwningWorld;
            }
        }
        else {
            NetLog(Port, "[Networking::Listen] WARNING: could not resolve the WorldContext's world; the engine will not drive this driver");
        }
        std::cout << "[Networking::Listen] Complete!" << std::endl;
        NetLog(Port, "[Networking::Listen] Complete");

        // DeployServer refuses to advertise this process until this exact marker.
        // It is emitted only after UNetDriver::Listen returned true, not at process spawn.
        // The optional player-hosted mode reports to its launcher instead (P2PHooks.h).
        if (P2PHooks::ReportsReadiness()) {
            return P2PHooks::ReportReady(Port);
        }

        char LaunchId[128]{};
        const DWORD LaunchIdLength = GetEnvironmentVariableA("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", LaunchId, sizeof(LaunchId));
        if (LaunchIdLength > 0 && LaunchIdLength < sizeof(LaunchId)) {
            std::cout << "MYSTICPARADOX_GAMESERVER_READY launchId=" << LaunchId << " port=" << Port << std::endl;
            NetLog(Port, std::string("[Networking::Listen] Ready marker emitted launchId=") + LaunchId);
        }
        return true;
    }

    // [1.14.7 2026-10-03] See Networking.h. Reuses the identical marker and the same
    // MYSTICPARADOX_GAMESERVER_LAUNCH_ID contract as the manual path, so the DeployServer cannot tell the
    // difference and the harness check stays valid.
    void AnnounceEngineReady(int Port) {
        if (P2PHooks::ReportsReadiness()) {
            P2PHooks::ReportReady(Port);
            return;
        }

        char LaunchId[128]{};
        const DWORD LaunchIdLength = GetEnvironmentVariableA("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", LaunchId, sizeof(LaunchId));
        if (LaunchIdLength > 0 && LaunchIdLength < sizeof(LaunchId)) {
            std::cout << "MYSTICPARADOX_GAMESERVER_READY launchId=" << LaunchId << " port=" << Port << std::endl;
            NetLog(Port, std::string("[EngineListen] Ready marker emitted launchId=") + LaunchId);
        }
    }

    void TickNetworking() {
        UWorld* World = UWorld::GetWorld();
        if (!World || !IsReadablePointer(NetDriver, 0x2B0)) {
            NetLog(LastPort, "[TickNetworking] Invalid World or NetDriver; skipping");
            return;
        }

        // World->NetDriver is maintained via level-collection registration (engine propagates it); no direct poke.
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

        // [GraphState 2026-07-16] Periodic read-only dump of the installed native ReplicationDriver
        // (UNetDriver::ReplicationDriver @ +0x6E8). Shows whether the graph initialized its nodes
        // (GlobalGraphNodes>0 => InitForNetDriver/InitGlobalGraphNodes ran) and whether it received the
        // client connection(s) (Connections grows on join => AddClientConnection ran). Runs in ALL modes
        // (before the NATIVE_GRAPH_ONLY return). Throttled ~2s. Offsets from SDK ReplicationGraph_classes.
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
                // [ServerReplicateActors gate] TickFlush only calls ServerReplicateActors (driver vtable +0x2A8)
                // when NetDriver+0x108 (param_1[0x21]) is non-null. If this is null the graph's replicate tick
                // (which re-evaluates ActorsWithoutNetConnection) never runs -> actors stay stuck.
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
                    if (IsReadablePointer(graph, 0x4C8)) {   // Archon subclass fields (UBasicReplicationGraph layout proxy)
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

                    // [ActorsNoConn enum 2026-07-17] Enumerate the graph's stuck ActorsWithoutNetConnection
                    // (+0x4B8 TArray data, +0x4C0 num). For each: class/full-name, owner chain, and the
                    // owning PlayerController's NetConnection (+0x418) resolved by walking Owner (+0xE0).
                    //   resolvedConn != 0 while stuck  => the actor HAS a connection but the graph's reroute/
                    //                                     PrepareForReplication migration isn't running.
                    //   resolvedConn == 0              => ownership/net-connection resolves too late; actors
                    //                                     must be re-routed after possession.
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

        // [NATIVE_GRAPH_ONLY 2026-07-16] Perfectly-isolated native test: skip the manual replication-frame/
        // counter advancement (+0x2AC, +0x418) AND the whole actor-replication loop below, leaving only the
        // driver/world maintenance above. The installed native ArchonReplicationGraph + TickFlush own the full
        // lifecycle (counters, channels, visibility). Distinct from NATIVE_REPLICATION_ONLY, which still bumped
        // the counters and thus double-drove the graph's frame lifecycle.
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

        // [Phase 0i / release] Advance the driver's replication frame (NetDriver+0x418) once per networking
        // maintenance tick. The RepLayout changelist compare (FUN_143f11cc0) early-returns (no property write)
        // unless this frame advances; standard UNetDriver::ServerReplicateActors bumps it every tick, so our
        // manual loop must too — otherwise every post-initial property change on every actor is skipped
        // (loadout Num 0->2 never re-detected, and every replicated actor is affected). Unconditional +
        // wrap-safe: skip 0, which RepLayout changelists treat as "never compared".
        {
            uint32_t* repFrame = reinterpret_cast<uint32_t*>((uintptr_t)NetDriver + 0x418);
            if (++(*repFrame) == 0) *repFrame = 1;
        }

        // [A/B 2026-07-16] NATIVE_REPLICATION_ONLY: driver maintenance + both counters above have
        // run this tick; stop before the custom actor-replication loop so the engine's native
        // TickFlush/ServerReplicateActors (driven from dllmain) is the sole replication path.
        // Log once so the mode is obvious in the per-port log.
        if (NativeReplicationOnly()) {
            static bool s_loggedNativeOnly = false;
            if (!s_loggedNativeOnly) {
                s_loggedNativeOnly = true;
                NetLog(LastPort, "[NATIVE_REPLICATION_ONLY] custom actor-replication loop skipped "
                    "(driver maintenance + counters still run; native TickDispatch/TickFlush drive replication)");
            }
            return;
        }

        // [Phase 0j v2 2026-07-12] Throttle ONLY the actor-replication work below (BuildConsiderList +
        // the per-connection ReplicateActor loop). Driver maintenance (ServerConnection=nullptr, World,
        // NetDriverName) and BOTH counters (+0x2AC and the +0x418 replication frame) above run EVERY tick.
        // The v1 gate at the top of TickNetworking wrongly skipped those and broke the join handshake.
        // When debug\THROTTLE_REP.flag is present, cap the actor loop to ~20Hz. Default = unthrottled.
        {
            // [PROD] Preserve the validated known-good config (THROTTLE_REP.flag was present in
            // debug\): cap actor replication to ~20Hz permanently. Previously flag-gated.
            static uint64_t s_lastRepMs = 0;
            uint64_t nowT = static_cast<uint64_t>(GetTickCount64());
            if (nowT - s_lastRepMs < 50) return;   // ~20Hz cap on actor replication only (counters already ticked)
            s_lastRepMs = nowT;
        }

        // [1.14.7 FIX 2026-10-08] The hand-written actor loop below (EMERGENCY_LEGACY_REPLICATION.flag only)
        // still calls 1.12 RVAs that are not function entries on 1.14.7: 0x0394B400, 0x03E9ABF0,
        // 0x03D47AC0, 0x03B80890, 0x03B7B470. Running it would jump into the middle of unrelated code, so
        // it is refused until each target is remapped and its ABI verified.
        // tools/rva-port-audit.py (static signature transfer through the 1.12 exe): 0x03D47AC0 -> 0x03F62E90
        // and 0x03B7B470 -> 0x03D8A2D0 (both bidirectionally verified); 0x03B80890 -> function 0x03D8FB20
        // (interior anchor, unverified); 0x0394B400 and 0x03E9ABF0 not found. The graph drive replaced this loop.
        {
            static bool s_loggedLegacyRefused = false;
            if (!s_loggedLegacyRefused) {
                s_loggedLegacyRefused = true;
                NetLog(LastPort, "[LegacyReplication] refused on 1.14.7: the custom actor loop still uses "
                    "unmapped 1.12 RVAs (0x0394B400, 0x03E9ABF0, 0x03D47AC0, 0x03B80890, 0x03B7B470)");
            }
            return;
        }

        std::vector<std::pair<AActor*, bool>> Actors = BuildConsiderList(World, NetDriver);

        UNetConnection** Connections = *reinterpret_cast<UNetConnection***>((uintptr_t)NetDriver + 0x90);
        int32_t ConnectionCount = *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x98);
        int32_t ConnectionMax = *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x9C);

        if (!IsSanePointerArray(Connections, ConnectionCount, ConnectionMax, 1024)) {
            NetLog(LastPort, "[TickNetworking] Invalid ClientConnections array; skipping");
            return;
        }

        // [2026-07-16] REVERSE_CONNECTION_ORDER: iterate connections back-to-front when set.
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

            // [2026-07-16] Per-connection [RepActor] logging throttle (~1/sec per connection index).
            bool doRepActorLog = false;
            {
                static uint64_t s_repActorLogMs[16] = { 0 };
                uint64_t rn = static_cast<uint64_t>(GetTickCount64());
                int slotIdx = (ConnectionIndex >= 0 && ConnectionIndex < 16) ? ConnectionIndex : 0;
                if (rn - s_repActorLogMs[slotIdx] > 1000) { s_repActorLogMs[slotIdx] = rn; doRepActorLog = true; }
            }

            // [1.12.0 DIAG 2026-07-10] Actor-loop instrumentation. Only log once per second.
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

                // [2026-07-16] LEVEL_VISIBILITY_GATE: skip streamed-sublevel actors the client has not
                // acked visible (native ServerReplicateActors does this; the manual loop did not, so it
                // shipped e.g. ramsgate_01_katplaza WorldSettings early -> client SerializeNewActor
                // Actor:None + broken P1 sublevel interaction). Always keep the ownership-critical actors
                // (PlayerController / Pawn / inventory / loadout); native handles the streamed rest.
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

                // [2026-07-16] HYBRID_REPLICATION: let native ServerReplicateActors own PlayerController
                // + Pawn (correct ownership/NetGUID ordering for the late joiner); the custom loop keeps
                // only the actors native does not deliver here (inventory/loadout/etc).
                if (HybridReplication() && (Actor->IsA(APlayerController::StaticClass()) || Actor->IsA(APawn::StaticClass()))) {
                    continue;
                }
                if ((Actor->IsA(APlayerController::StaticClass()))) {
                    if (Actor != Connection->OwningActor) {
                        continue;
                    }
                    else {
                        //*(uint8_t*)((uintptr_t)Actor + 0xA14) = 0x1;
                        Connection->ViewTarget = ((APlayerController*)Actor)->GetViewTarget();

                        if (!Connection->ViewTarget)
                            std::cout << "NULL VIEWTARGET BAD THINGS WILL HAPPEN" << std::endl;

                        reinterpret_cast<void(*)(APlayerController*)>(BaseAddress + 0x03E9ABF0)((APlayerController*)Actor);
                    }
                }

                //

                UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor);
                if (ActorChannel) channelsFound++;

                bool bJustCreated = false;
                if (!ActorChannel) {
                    // [1.12.0 FIX 2026-07-10] RVA was 0x0236AF60 which is FUN_14236AF60 =
                    // TaskGraph wait routine (verified via string xref "Recursive waits are not
                    // allowed in single threaded mode." at 0x1455599D0). Called with
                    // (Connection, &name, ...) as if it were CreateChannelByName — Connection
                    // landed in TaskGraph 'this', RAX returned garbage read back as
                    // UActorChannel*. Every pawn channel-create failed silently.
                    //
                    // Real UNetConnection::CreateChannelByName is at RVA 0x03D47AC0 (verified
                    // via string xref "No free channel could be found in the channel list ...
                    // net.MaxChannelSize." at 0x145A92800, inside FUN_143D47AC0).
                    //
                    // Flag = 2 (verified via native callsite disassembly at 143f05d66:
                    //   LEA R8D, [RDI + 0x2]     ← R8 (3rd arg / flag) = 2
                    //   CALL 0x143d47ac0         ← CreateChannelByName
                    // Earlier attempt using 1<<0 = 1 was wrong. Native uses 2.
                    ActorChannel = reinterpret_cast<UActorChannel * (*)(UNetConnection*, FName*, unsigned int, int)>(BaseAddress + 0x03D47AC0)(Connection, &name, 1 << 1, -1);
                    if (ActorChannel) { channelsCreated++; bJustCreated = true; }
                    else channelsFailed++;

                    if (ActorChannel) {
                        reinterpret_cast<void(*)(UActorChannel*, AActor*, unsigned int)>(BaseAddress + 0x03B80890)(ActorChannel, Actor, 0);
                    }
                }

                if (ActorChannel && ActorChannel->Actor) {
                    channelsWithActor++;
                    // [1.12.0 FIX 2026-07-10] Removed manual "ActorChannel+0x90 |= 2" write.
                    // Native replication does not do this. The flag is set by proper channel
                    // construction via CreateChannelByName. Manually forcing it after the fact
                    // could put the channel in an incorrect state (e.g., set bClosing or a
                    // similar dirty-flag that suppresses replication).
                    //
                    // ReplicateActor: 0x03B7B470 (verified via string xref "ReplicateActor
                    // called while already replicating!" at 0x145A2C140).
                    // [Phase 0g 2026-07-12] The manual loop drives ReplicateActor, where bNetOwner is
                    // computed as (Actor->GetNetConnection()[vtable+0x4C0] == channel->Connection). Log the
                    // ACTUAL input for the loadout: if GetNetConnection() != this connection, COND_OwnerOnly
                    // is filtered right here -> trace AArchonLoadout::GetNetConnection resolution.
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

                            // [2026-07-16] Server loadout state snapshot: is this player's loadout FINAL
                            // before P1 disconnects, or does it only complete at the disconnect edge?
                            // (splits server-producer vs replication). Offsets: LoadoutSlotDataArray
                            // TArray @+0x670 (Data / Num@+0x678 / Max@+0x67C), ActiveLoadoutSlotIndex int32 @+0x680.
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
                    // [2026-07-16] Log EVERY newly-created channel (initial bunch) for this connection,
                    // regardless of class, edge-triggered on creation (bounded). wroteData=0 on a
                    // just-created channel = the server opened the channel but wrote NO initial bunch ->
                    // client SerializeNewActor "Actor: None". Also lets us compare P1 vs P2 channel sets
                    // (an actor P1 gets but P2 never does breaks P2's Owner/PC references). Send-side split,
                    // no ChIndex/NetGUID needed.
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
                    // [2026-07-16] Per-connection ReplicateActor result for join-relevant actors, keyed by
                    // connection + object. Answers: does the stuck joiner's connection get wroteData=1 for its
                    // PlayerController / pawn / inventory / loadout before the other player leaves? Throttled
                    // ~1/sec per connection. initial=channel-created-this-pass; owner=GetNetConnection==thisConn.
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
