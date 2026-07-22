
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

#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <string>
#include <set>
#include <algorithm>
#include <cmath>
#include <cstdlib>   
#include <vector>
#include <thread>
#include <iostream>
#include <ranges>

#include "framework.h"
#include "SDK.hpp"
#include "MinHook/MinHook.h"
#include "constants.h"
#include "Networking.h"
#include "deployment_config.generated.h"

#include "SDK/GameplayAbilities_parameters.hpp"
#include "SDK/Archon_parameters.hpp"
#include "SDK/lantern_equipped_ab_parameters.hpp"

#include <cwchar>
#include <fstream>
#include <iomanip>
#include <intrin.h>
#include <mutex>
#include <sstream>

using namespace SDK;

namespace Globals {
    static bool AmServer = false;
    static uintptr_t BaseAddress = 0x0;
    bool Listening = false;
    bool DoListen = false;
    const wchar_t* ServerAPIKey = nullptr;
    const wchar_t* MapPath = nullptr;
    const wchar_t* BehemothPath = nullptr;
    const wchar_t* MatchmakerHuntId = nullptr;
    const wchar_t* ExpectedPlayerString = nullptr;
    int Port = 0;
    const wchar_t* MyIpAndPort = nullptr;

    bool EnableLogging = true;

    
    
    static std::string Move10Status;

    static std::wstring ServerAPIKeyStorage;
    static std::wstring MapPathStorage;
    static std::wstring BehemothPathStorage;
    static std::wstring MatchmakerHuntIdStorage;
    static std::wstring ExpectedPlayerStringStorage;
    static std::wstring MyIpAndPortStorage;
}


static void InitLog(const std::string& Msg) {
    (void)Msg;
}





static char g_MpLogDir[MAX_PATH] = { 0 };
static volatile LONG g_MpLogDirReady = 0;
static const char* MpLogDir() {
    if (g_MpLogDirReady == 0) {
        char ExePath[MAX_PATH];
        DWORD n = GetModuleFileNameA(nullptr, ExePath, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            int slash = -1;
            for (DWORD i = 0; i < n; ++i) { if (ExePath[i] == '\\' || ExePath[i] == '/') { slash = (int)i; } }
            if (slash >= 0) {
                for (int i = 0; i <= slash; ++i) { g_MpLogDir[i] = ExePath[i]; }
                g_MpLogDir[slash + 1] = '\0';
            }
        }
        InterlockedExchange(&g_MpLogDirReady, 1);
    }
    return g_MpLogDir;
}




static bool MpExeRelativeFlagPresent(const wchar_t* FileName) {
    if (!FileName) { return false; }
    wchar_t ExePath[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) { return false; }
    for (int i = (int)n - 1; i >= 0; --i) {
        if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
    }
    std::wstring FlagPath = std::wstring(ExePath) + FileName;
    return GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES;
}


static bool VerboseDiag() {
    static int Cached = -1;
    if (Cached < 0) Cached = MpExeRelativeFlagPresent(L"VERBOSE_DIAG.flag") ? 1 : 0;
    return Cached == 1;
}




static void MpLog(const std::string& Msg) {
    char Path[MAX_PATH];
    sprintf_s(Path, "%smysticparadox_dll_port%d.log", MpLogDir(), Globals::Port);

    std::ofstream File(Path, std::ios::app);

    if (File.is_open()) {
        SYSTEMTIME Now{};
        GetLocalTime(&Now);
        File << "["
             << std::setfill('0') << std::setw(2) << Now.wHour << ":"
             << std::setfill('0') << std::setw(2) << Now.wMinute << ":"
             << std::setfill('0') << std::setw(2) << Now.wSecond << "."
             << std::setfill('0') << std::setw(3) << Now.wMilliseconds << "] "
             << "pid=" << GetCurrentProcessId() << " "
             << Msg << "\n";
        File.flush();
    }
}

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


















static bool IsRegisteredLiveObject(const void* Ptr) {
    if (!Ptr) return false;
    __try {
        
        
        
        
        
        
        
        
        const int32_t Index = reinterpret_cast<const UObject*>(Ptr)->Index;
        return reinterpret_cast<const void*>(UObject::GObjects->GetByIndex(Index)) == Ptr;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;   
    }
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


static std::string MpNarrow(const std::wstring& W) {
    std::string Out;
    Out.reserve(W.size());
    for (wchar_t Ch : W) {
        Out.push_back(static_cast<char>(Ch));
    }
    return Out;
}

static std::string MpPtr(const void* Ptr) {
    return Ptr ? std::to_string(reinterpret_cast<uintptr_t>(Ptr)) : "null";
}

static std::string MpHex(uintptr_t Value) {
    std::ostringstream Stream;
    Stream << "0x" << std::uppercase << std::hex << Value;
    return Stream.str();
}




static std::string DumpBytesHex(const void* Ptr, size_t Count) {
    std::ostringstream Stream;
    const uint8_t* Bytes = reinterpret_cast<const uint8_t*>(Ptr);
    Stream << std::uppercase << std::hex << std::setfill('0');
    for (size_t i = 0; i < Count; ++i) {
        if (i) Stream << ' ';
        Stream << std::setw(2) << static_cast<unsigned>(Bytes[i]);
    }
    return Stream.str();
}

static std::string MpBaseName(const char* Path) {
    if (!Path || !Path[0]) {
        return "(unknown)";
    }

    const char* Base = Path;
    for (const char* Cursor = Path; *Cursor; ++Cursor) {
        if (*Cursor == '\\' || *Cursor == '/') {
            Base = Cursor + 1;
        }
    }

    return std::string(Base);
}

static std::string MpAddress(const void* Ptr) {
    if (!Ptr) {
        return "null";
    }

    HMODULE Module = nullptr;
    if (GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCSTR>(Ptr),
        &Module)) {
        char ModulePath[MAX_PATH]{};
        GetModuleFileNameA(Module, ModulePath, MAX_PATH);
        uintptr_t Base = reinterpret_cast<uintptr_t>(Module);
        uintptr_t Address = reinterpret_cast<uintptr_t>(Ptr);
        return MpBaseName(ModulePath) + "+" + MpHex(Address - Base);
    }

    uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
    uintptr_t Address = reinterpret_cast<uintptr_t>(Ptr);
    if (Base && Address >= Base && Address < Base + 0x08000000) {
        return "Dauntless-Win64-Shipping.exe+" + MpHex(Address - Base);
    }

    return MpHex(Address);
}

static void MpLogStack(const std::string& Tag, uint32_t Code) {
    void* Frames[32]{};
    USHORT Count = CaptureStackBackTrace(1, static_cast<DWORD>(std::size(Frames)), Frames, nullptr);

    std::string Msg = "[ExitTrace] " + Tag + " code=" + std::to_string(Code) + " stack=";

    for (USHORT i = 0; i < Count; ++i) {
        if (i != 0) {
            Msg += " ";
        }

        Msg += MpAddress(Frames[i]);
    }

    MpLog(Msg);
}

using ExitProcessFn = void(WINAPI*)(UINT);
using RtlExitUserProcessFn = void(WINAPI*)(ULONG);
using TerminateProcessFn = BOOL(WINAPI*)(HANDLE, UINT);
using RaiseExceptionFn = void(WINAPI*)(DWORD, DWORD, DWORD, const ULONG_PTR*);
using CExitFn = void(__cdecl*)(int);
using AbortFn = void(__cdecl*)();

static ExitProcessFn OrigExitProcess = nullptr;
static RtlExitUserProcessFn OrigRtlExitUserProcess = nullptr;
static TerminateProcessFn OrigTerminateProcess = nullptr;
static RaiseExceptionFn OrigRaiseException = nullptr;
static CExitFn OrigUcrtExit = nullptr;
static CExitFn OrigUcrtUnderscoreExit = nullptr;
static CExitFn OrigMsvcrtExit = nullptr;
static CExitFn OrigMsvcrtUnderscoreExit = nullptr;
static AbortFn OrigUcrtAbort = nullptr;
static AbortFn OrigMsvcrtAbort = nullptr;
static void* OrigUnhandledExceptionFilter = nullptr;
static PVOID VectoredExceptionHandle = nullptr;
static volatile LONG ExceptionTraceCount = 0;





static volatile DWORD GameTickThreadId = 0;





static std::string MpModuleOfAddress(void* Addr) {
    if (!Addr) {
        return "null";
    }

    HMODULE Module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(Addr),
            &Module) || !Module) {
        return "?";
    }

    wchar_t PathW[MAX_PATH]{};
    DWORD PathLen = GetModuleFileNameW(Module, PathW, static_cast<DWORD>(std::size(PathW)));
    if (PathLen == 0) {
        return "?";
    }

    std::wstring Path(PathW, PathLen);
    size_t Slash = Path.find_last_of(L"\\/");
    std::wstring Base = (Slash == std::wstring::npos) ? Path : Path.substr(Slash + 1);
    return MpNarrow(Base);
}





static std::string MpExitDiag(void* ReturnAddress) {
    DWORD Tid = GetCurrentThreadId();
    DWORD GameTid = static_cast<DWORD>(InterlockedCompareExchange(
        reinterpret_cast<volatile LONG*>(&GameTickThreadId), 0, 0));

    std::string Msg = " tid=" + std::to_string(Tid);
    Msg += " gameTid=" + std::to_string(GameTid);
    Msg += " isGameThread=";
    Msg += (GameTid != 0 && Tid == GameTid) ? "1" : "0";
    Msg += " retAddr=" + MpAddress(ReturnAddress);
    Msg += " retModule=" + MpModuleOfAddress(ReturnAddress);

    return Msg;
}

void WINAPI ExitProcessHook(UINT ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] kernel32!ExitProcess entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("kernel32!ExitProcess", ExitCode);
    OrigExitProcess(ExitCode);
}

void WINAPI RtlExitUserProcessHook(ULONG ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ntdll!RtlExitUserProcess entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ntdll!RtlExitUserProcess", ExitCode);
    OrigRtlExitUserProcess(ExitCode);
}

BOOL WINAPI TerminateProcessHook(HANDLE Process, UINT ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] kernelbase!TerminateProcess handle=" + MpPtr(Process)
        + " code=" + std::to_string(ExitCode)
        + MpExitDiag(Caller));
    MpLogStack("kernelbase!TerminateProcess", ExitCode);
    return OrigTerminateProcess(Process, ExitCode);
}

static bool ShouldTraceExceptionCode(DWORD Code) {
    if (Code == DBG_PRINTEXCEPTION_C ||
        Code == DBG_PRINTEXCEPTION_WIDE_C ||
        Code == 0x406D1388 || 
        Code == 0x40010005 ||
        Code == 0x40010006 ||
        Code == 0x40010007 ||
        Code == 0x40010008) {
        return false;
    }

    return true;
}

static void LogExceptionRecord(const char* Tag, const EXCEPTION_RECORD* Record, const CONTEXT* Context) {
    if (!ShouldTraceExceptionCode(Record ? Record->ExceptionCode : 0)) {
        return;
    }

    LONG Count = InterlockedIncrement(&ExceptionTraceCount);
    if (Count > 96) {
        return;
    }

    std::string Msg = "[ExceptionTrace] ";
    Msg += Tag;

    if (Record) {
        Msg += " code=" + MpHex(Record->ExceptionCode);
        Msg += " flags=" + MpHex(Record->ExceptionFlags);
        Msg += " address=" + MpAddress(Record->ExceptionAddress);

        uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
        uintptr_t ExceptionAddress = reinterpret_cast<uintptr_t>(Record->ExceptionAddress);
        if (Base && ExceptionAddress >= Base && ExceptionAddress < Base + 0x08000000) {
            Msg += " rva=+" + MpHex(ExceptionAddress - Base);
        }

        if (Record->NumberParameters > 0) {
            Msg += " params=";
            DWORD ParamCount = Record->NumberParameters;
            if (ParamCount > EXCEPTION_MAXIMUM_PARAMETERS) {
                ParamCount = EXCEPTION_MAXIMUM_PARAMETERS;
            }

            for (DWORD i = 0; i < ParamCount; ++i) {
                if (i != 0) {
                    Msg += ",";
                }
                Msg += MpHex(static_cast<uintptr_t>(Record->ExceptionInformation[i]));
            }
        }
    }

#if defined(_M_X64)
    if (Context) {
        Msg += " rip=" + MpAddress(reinterpret_cast<void*>(Context->Rip));
        Msg += " rsp=" + MpHex(static_cast<uintptr_t>(Context->Rsp));
    }
#endif

    MpLog(Msg);
    MpLogStack(Tag, Record ? Record->ExceptionCode : 0);
}

void WINAPI RaiseExceptionHook(DWORD Code, DWORD Flags, DWORD ArgCount, const ULONG_PTR* Args) {
    EXCEPTION_RECORD Record{};
    Record.ExceptionCode = Code;
    Record.ExceptionFlags = Flags;
    Record.ExceptionAddress = _ReturnAddress();
    Record.NumberParameters = ArgCount > EXCEPTION_MAXIMUM_PARAMETERS ? EXCEPTION_MAXIMUM_PARAMETERS : ArgCount;

    if (Args && Record.NumberParameters > 0) {
        for (DWORD i = 0; i < Record.NumberParameters; ++i) {
            Record.ExceptionInformation[i] = Args[i];
        }
    }

    LogExceptionRecord("kernelbase!RaiseException", &Record, nullptr);
    OrigRaiseException(Code, Flags, ArgCount, Args);
}

LONG WINAPI VectoredExceptionTrace(EXCEPTION_POINTERS* ExceptionInfo) {
    static thread_local bool InHandler = false;
    if (InHandler) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    InHandler = true;
    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS))) {
        EXCEPTION_RECORD* Record = ExceptionInfo->ExceptionRecord;
        CONTEXT* Context = ExceptionInfo->ContextRecord;
        if (IsReadablePointer(Record, sizeof(EXCEPTION_RECORD))) {
#if defined(_M_X64)
            if (Context && IsReadablePointer(Context, sizeof(CONTEXT)) &&
                Record->ExceptionCode == EXCEPTION_ACCESS_VIOLATION &&
                Globals::BaseAddress &&
                Context->Rip == Globals::BaseAddress + 0x024AE5B0) {
                MpLog("[ExceptionTrace] guarding invalid FName text read at +0x24AE5B0 rdi="
                    + MpHex(static_cast<uintptr_t>(Context->Rdi))
                    + " access=" + (Record->NumberParameters > 1
                        ? MpHex(static_cast<uintptr_t>(Record->ExceptionInformation[1]))
                        : std::string("(unknown)")));

                Context->Rdi = Globals::BaseAddress + 0x04DF2E8C; 
                InHandler = false;
                return EXCEPTION_CONTINUE_EXECUTION;
            }
#endif
            LogExceptionRecord("VEH", Record, IsReadablePointer(Context, sizeof(CONTEXT)) ? Context : nullptr);
        }
    }
    InHandler = false;

    return EXCEPTION_CONTINUE_SEARCH;
}

void __cdecl UcrtExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ucrtbase!exit", static_cast<uint32_t>(ExitCode));
    OrigUcrtExit(ExitCode);
}

void __cdecl UcrtUnderscoreExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!_exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ucrtbase!_exit", static_cast<uint32_t>(ExitCode));
    OrigUcrtUnderscoreExit(ExitCode);
}

void __cdecl MsvcrtExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("msvcrt!exit", static_cast<uint32_t>(ExitCode));
    OrigMsvcrtExit(ExitCode);
}

void __cdecl MsvcrtUnderscoreExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!_exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("msvcrt!_exit", static_cast<uint32_t>(ExitCode));
    OrigMsvcrtUnderscoreExit(ExitCode);
}

void __cdecl UcrtAbortHook() {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!abort entry" + MpExitDiag(Caller));
    MpLogStack("ucrtbase!abort", 3);
    OrigUcrtAbort();
}

void __cdecl MsvcrtAbortHook() {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!abort entry" + MpExitDiag(Caller));
    MpLogStack("msvcrt!abort", 3);
    OrigMsvcrtAbort();
}

LONG WINAPI UEUnhandledExceptionFilterHook(EXCEPTION_POINTERS* ExceptionInfo) {
    std::string Msg = "[ExitTrace] UEUnhandledExceptionFilter";

    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        EXCEPTION_RECORD* Record = ExceptionInfo->ExceptionRecord;
        Msg += " code=" + MpHex(Record->ExceptionCode);
        Msg += " flags=" + MpHex(Record->ExceptionFlags);
        Msg += " address=" + MpAddress(Record->ExceptionAddress);

        uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
        uintptr_t ExceptionAddress = reinterpret_cast<uintptr_t>(Record->ExceptionAddress);
        if (Base && ExceptionAddress >= Base && ExceptionAddress < Base + 0x08000000) {
            Msg += " rva=+" + MpHex(ExceptionAddress - Base);
        }
    }
    else {
        Msg += " exception_info_unreadable=" + MpPtr(ExceptionInfo);
    }

#if defined(_M_X64)
    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT))) {
        Msg += " rip=" + MpAddress(reinterpret_cast<void*>(ExceptionInfo->ContextRecord->Rip));
        Msg += " rsp=" + MpHex(static_cast<uintptr_t>(ExceptionInfo->ContextRecord->Rsp));
    }
#endif

    MpLog(Msg);
    MpLogStack("UEUnhandledExceptionFilter", 3);

    return reinterpret_cast<LONG(WINAPI*)(EXCEPTION_POINTERS*)>(OrigUnhandledExceptionFilter)(ExceptionInfo);
}

static void InstallApiHook(LPCWSTR Module, LPCSTR ProcName, LPVOID Detour, LPVOID* Original, const char* Tag) {
    LPVOID Target = nullptr;
    MH_STATUS CreateStatus = MH_CreateHookApiEx(Module, ProcName, Detour, Original, &Target);
    MH_STATUS EnableStatus = CreateStatus == MH_OK ? MH_EnableHook(Target) : CreateStatus;

    MpLog("[ExitTrace] hook " + std::string(Tag)
        + " create=" + MH_StatusToString(CreateStatus)
        + " enable=" + MH_StatusToString(EnableStatus)
        + " target=" + MpPtr(Target));
}



static bool HookVirtual(void* instance, size_t index, void* detour, void** ppOrig, const char* tag) {
    if (!instance) return false;
    void** vtable = *reinterpret_cast<void***>(instance);
    void*  target = vtable[index];
    if (MH_CreateHook(target, detour, ppOrig) != MH_OK) return false;
    if (MH_EnableHook(target) != MH_OK) return false;
    if (Globals::EnableLogging)
        std::cout << "[vhook] " << tag << " idx=" << index << " -> +0x" << std::hex
                  << ((uintptr_t)target - Globals::BaseAddress) << std::dec << std::endl;
    return true;
}



static void DumpVtable(void* instance, size_t count, const char* tag) {
    if (!instance) return;
    void** vt = *reinterpret_cast<void***>(instance);
    std::cout << "[vtable] " << tag << " @ +0x" << std::hex
              << ((uintptr_t)vt - Globals::BaseAddress) << std::dec << std::endl;
    for (size_t i = 0; i < count; ++i)
        std::cout << "  [" << i << "] +0x" << std::hex
                  << ((uintptr_t)vt[i] - Globals::BaseAddress) << std::dec << std::endl;
}



constexpr size_t IDX_UGAMEENGINE_TICK          = 0;
constexpr size_t IDX_INTERNAL_GET_NETMODE      = 0;
constexpr size_t IDX_UNETCONNECTION_ISNETREADY = 0;
constexpr size_t IDX_UNETDRIVER_ISLEVELINIT    = 0;
constexpr size_t IDX_AACTOR_GETFUNCTIONCALLSPACE = 69; 
constexpr size_t IDX_AGAMEMODEBASE_CHOOSEPLAYERSTART = 207; 

__declspec(dllexport) const char* DummyLinkFunc() {
    return "mrow :3";
}

void MainThread() {
    InitLog("[MainThread] Entry");

    
    std::string logMsg = "\n=== ParadoxRuntime session start ===\n[MainThread] started. AmServer=";
    logMsg += (Globals::AmServer ? "1" : "0");
    InitLog("[MainThread] Built AmServer part");

    logMsg += " port=";
    logMsg += std::to_string(Globals::Port);
    InitLog("[MainThread] Built port part");

    logMsg += " map=";
    if (Globals::MapPath) {
        logMsg += MpNarrow(std::wstring(Globals::MapPath));
    } else {
        logMsg += "(null)";
    }
    logMsg += " base=";
    logMsg += MpHex(Globals::BaseAddress);
    
    
    
    
    InitLog("[MainThread] Built map part, calling MpLog...");

    MpLog(logMsg);
    InitLog("[MainThread] MpLog returned, entering UWorld wait loop");

    
    
    if (Globals::AmServer && !Globals::Move10Status.empty()) {
        MpLog(std::string("[move10] boot patch status:") + Globals::Move10Status);
    }

    int waitCount = 0;
    while (true) {
        InitLog(std::string("[MainThread] Loop iteration ") + std::to_string(waitCount) + ", calling UWorld::GetWorld()...");
        UWorld* world = UWorld::GetWorld();
        UWorld* directGWorld = nullptr;
        if (Globals::BaseAddress) {
            directGWorld = *reinterpret_cast<UWorld**>(Globals::BaseAddress + 0x06D001B8);
        }
        if (Globals::AmServer) {
            MpLog("[MainThread] wait=" + std::to_string(waitCount)
                + " SDKWorld=" + MpPtr(world)
                + " DirectGWorld=" + MpPtr(directGWorld));
        }
        InitLog(std::string("[MainThread] UWorld::GetWorld() returned: ") + (world ? "non-null" : "null"));
        if (world || directGWorld) break;

        if (Globals::AmServer) {
            InitLog("[MainThread] About to Sleep(1000)...");
            Sleep(1000);
            InitLog("[MainThread] Sleep complete, incrementing waitCount");
            waitCount++;
            InitLog(std::string("[MainThread] waitCount now: ") + std::to_string(waitCount));
            if (waitCount >= 30) {
                InitLog("[MainThread] Waited 30s for UWorld, giving up");
                break;
            }
        }
        else {
            Sleep(1);
        }
    }
    InitLog("[MainThread] Exited UWorld wait loop");

    if (Globals::AmServer) {
        MpLog("[MainThread] UWorld is live; requesting listen immediately");
        Globals::DoListen = true;
        return;
    }

    Sleep(3 * 1000);

    UEngine* Engine = UEngine::GetEngine();

    UInputSettings::GetDefaultObj()->ConsoleKeys[0].KeyName = UKismetStringLibrary::Conv_StringToName(L"F2");

    UObject* NewObject = UGameplayStatics::SpawnObject(Engine->ConsoleClass, Engine->GameViewport);

    Engine->GameViewport->ViewportConsole = static_cast<UConsole*>(NewObject);

    if (Globals::EnableLogging)
        std::cout << "Spawned UConsole!" << std::endl;
}






















static void* EngineRealloc(void* Ptr, size_t NewSize) {
    InitLog(std::string("[EngineRealloc] Entry: Ptr=") + (Ptr ? "0x" + std::to_string((uintptr_t)Ptr) : "NULL") + " NewSize=" + std::to_string(NewSize));

    uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
    using ReallocFn = void* (*)(void*, size_t, uint32_t);
    void* Result = reinterpret_cast<ReallocFn>(Base + 0x023BB590)(Ptr, NewSize, 0);
    InitLog(std::string("[EngineRealloc] FMemory::Realloc returned: ") + (Result ? "0x" + std::to_string((uintptr_t)Result) : "NULL"));

    return Result;
}







static void LogArchonLifecycle(const char* Tag) {
    if (!SDK::UObject::GObjects) { return; }
    SDK::UObject* GmObj = nullptr;
    SDK::UObject* GsObj = nullptr;
    const int Count = SDK::UObject::GObjects->Num();
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj || Obj->IsDefaultObject()) { continue; }
        if (!GmObj && Obj->IsA(SDK::AArchonGameMode::StaticClass())) { GmObj = Obj; }
        else if (!GsObj && Obj->IsA(SDK::AArchonGameState::StaticClass())) { GsObj = Obj; }
        if (GmObj && GsObj) { break; }
    }

    std::string Msg = std::string("[Lifecycle:") + Tag + "]";

    if (GmObj && IsReadablePointer(GmObj, 0x4A0)) {
        uintptr_t Gm = reinterpret_cast<uintptr_t>(GmObj);
        std::string MatchState = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gm + 0x02C0), 8)) {
            MatchState = reinterpret_cast<SDK::FName*>(Gm + 0x02C0)->ToString();
        }
        void* GameSession = *reinterpret_cast<void**>(Gm + 0x0278);
        int32_t GsMax = -1;
        if (IsReadablePointer(GameSession, 0x228)) {
            GsMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(GameSession) + 0x0224);
        }
        Msg += " GM=" + MpPtr(GmObj) + " class=" + GmObj->Class->GetName()
            + " match=" + MatchState
            + " NumPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02D0))
            + " NumSpectators=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02CC))
            + " NumTravelling=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02DC))
            + " ExpectedPlayerCount=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x0498))
            + " MaxPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x049C))
            + " GameSession=" + MpPtr(GameSession) + " GS.MaxPlayers=" + std::to_string(GsMax);
    } else {
        Msg += " GM=null";
    }

    if (GsObj && IsReadablePointer(GsObj, 0x278)) {
        uintptr_t Gs = reinterpret_cast<uintptr_t>(GsObj);
        std::string GsMatch = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gs + 0x0270), 8)) {
            GsMatch = reinterpret_cast<SDK::FName*>(Gs + 0x0270)->ToString();
        }
        Msg += " | GState=" + MpPtr(GsObj) + " match=" + GsMatch;
    } else {
        Msg += " | GState=null";
    }

    MpLog(Msg);
}








static SDK::UObject* g_CachedGameMode = nullptr;
static uint64_t g_LastGameModeSearchMs = 0;






static std::atomic<void*> g_wdGameModePtr{ nullptr };
static std::atomic<int>   g_wdIsHub{ -1 };   


static std::atomic<uint64_t> g_wdLastTickMs{ 0 };


static std::atomic<bool> g_wdSawPlayer{ false };

static std::atomic<uint32_t> g_wdGameThreadId{ 0 };






static constexpr int  kPeRing = 32;
static char           g_gtPeNameRing[kPeRing][160] = {};
static std::atomic<uint32_t> g_gtPeRingPos{ 0 };

static std::atomic<void*>    g_gtPeCurFunc{ nullptr };
static std::atomic<void*>    g_gtPeCurObj{ nullptr };



static void MpReapExit(const char* Reason) {
    MpLog(std::string("[Watchdog/thread] ") + Reason
        + " -> TerminateProcess(0) (skipping UE static teardown; see MpReapExit comment)");
    
    Sleep(50);
    TerminateProcess(GetCurrentProcess(), 0);
    
    exit(0);
}





static int ScanStackReturns(uint64_t rsp, uint64_t codeLo, uint64_t codeHi, uint64_t* out, int maxOut) {
    int n = 0;
    for (uint64_t p = rsp; p < rsp + 0x1400 && n < maxOut; p += 8) {
        if (!IsReadablePointer(reinterpret_cast<void*>(p), 8)) break;
        uint64_t v = *reinterpret_cast<uint64_t*>(p);
        if (v >= codeLo && v < codeHi) out[n++] = v;
    }
    return n;
}





static void MpLogRealStack(CONTEXT ctx) {   
    for (int i = 0; i < 30 && ctx.Rip; ++i) {
        MpLog("[HangTrace]   frame[" + std::to_string(i) + "] " + MpAddress(reinterpret_cast<void*>(ctx.Rip)));
        DWORD64 imgBase = 0;
        PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry(ctx.Rip, &imgBase, nullptr);
        if (rf) {
            PVOID handlerData = nullptr; DWORD64 establisher = 0;
            RtlVirtualUnwind(UNW_FLAG_NHANDLER, imgBase, ctx.Rip, rf, &ctx, &handlerData, &establisher, nullptr);
        } else {
            
            if (!IsReadablePointer(reinterpret_cast<void*>(ctx.Rsp), 8)) break;
            ctx.Rip = *reinterpret_cast<DWORD64*>(ctx.Rsp);
            ctx.Rsp += 8;
        }
    }
}




static void MpLogAllThreadRips(uint32_t gameTid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) { MpLog("[HangTrace] thread snapshot failed"); return; }
    THREADENTRY32 te{}; te.dwSize = sizeof(te);
    const DWORD myPid = GetCurrentProcessId();
    const DWORD selfTid = GetCurrentThreadId();
    int logged = 0;
    if (Thread32First(snap, &te)) {
        do {
            if (te.th32OwnerProcessID != myPid || te.th32ThreadID == selfTid) continue;
            HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, te.th32ThreadID);
            if (!th) continue;
            CONTEXT c{}; c.ContextFlags = CONTEXT_CONTROL;
            uint64_t rip = 0;
            if (SuspendThread(th) != (DWORD)-1) { if (GetThreadContext(th, &c)) rip = c.Rip; ResumeThread(th); }
            CloseHandle(th);
            if (rip) {
                MpLog("[HangTrace] thread tid=" + std::to_string(te.th32ThreadID)
                    + (te.th32ThreadID == gameTid ? " (GAME)" : "")
                    + " RIP=" + MpAddress(reinterpret_cast<void*>(rip)));
                ++logged;
            }
        } while (Thread32Next(snap, &te) && logged < 96);
    }
    CloseHandle(snap);
    MpLog("[HangTrace] all-thread snapshot: " + std::to_string(logged) + " threads sampled");
}

static void MpLogHungGameThread() {
    uint32_t Tid = g_wdGameThreadId.load(std::memory_order_relaxed);
    if (Tid == 0) { MpLog("[HangTrace] game thread id unknown; cannot sample"); return; }

    HANDLE Th = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME, FALSE, Tid);
    if (!Th) { MpLog("[HangTrace] OpenThread failed for tid=" + std::to_string(Tid)); return; }

    
    
    uint64_t rip[3] = { 0,0,0 };
    uint64_t rsp0 = 0;
    uint64_t retChain[12] = {};
    int      retN = 0;
    CONTEXT  fullCtx0{};
    bool     haveCtx0 = false;
    const uint64_t codeLo = Globals::BaseAddress + 0x1000;
    const uint64_t codeHi = Globals::BaseAddress + 0x04E00000;   

    for (int s = 0; s < 3; ++s) {
        CONTEXT Ctx{};
        Ctx.ContextFlags = CONTEXT_FULL;
        if (SuspendThread(Th) != (DWORD)-1) {
            if (GetThreadContext(Th, &Ctx)) {
                rip[s] = Ctx.Rip;
                if (s == 0) {
                    rsp0 = Ctx.Rsp;
                    fullCtx0 = Ctx; haveCtx0 = true;
                    retN = ScanStackReturns(Ctx.Rsp, codeLo, codeHi, retChain, 12);
                }
            }
            ResumeThread(Th);   
        }
        if (s < 2) Sleep(250);
    }
    CloseHandle(Th);

    if (rip[0] == 0) { MpLog("[HangTrace] GetThreadContext failed for tid=" + std::to_string(Tid)); return; }

    bool moving = (rip[0] != rip[1]) || (rip[1] != rip[2]);
    MpLog("[HangTrace] game thread tid=" + std::to_string(Tid)
        + (moving ? " SPINNING (RIP moves - loop)" : " BLOCKED (RIP fixed - wait/deadlock)")
        + " RIP=" + MpAddress(reinterpret_cast<void*>(rip[0]))
        + " / " + MpAddress(reinterpret_cast<void*>(rip[1]))
        + " / " + MpAddress(reinterpret_cast<void*>(rip[2]))
        + " RSP=" + MpAddress(reinterpret_cast<void*>(rsp0)));

    
    if (haveCtx0) { MpLog("[HangTrace] REAL unwind (game thread):"); MpLogRealStack(fullCtx0); }

    
    std::string chain;
    for (int i = 0; i < retN; ++i) { chain += (i ? " <- " : "") + MpAddress(reinterpret_cast<void*>(retChain[i])); }
    MpLog("[HangTrace] heuristic retchain(" + std::to_string(retN) + "): " + (chain.empty() ? "(none in module)" : chain));

    
    MpLog("[HangTrace] curFunc=" + MpPtr(g_gtPeCurFunc.load(std::memory_order_relaxed))
        + " curObj=" + MpPtr(g_gtPeCurObj.load(std::memory_order_relaxed)));
    uint32_t pos = g_gtPeRingPos.load(std::memory_order_relaxed);
    for (int i = 1; i <= 10; ++i) {
        uint32_t idx = (pos - static_cast<uint32_t>(i)) % kPeRing;
        
        char buf[160]; memcpy(buf, g_gtPeNameRing[idx], sizeof(buf)); buf[sizeof(buf) - 1] = '\0';
        if (buf[0]) MpLog("[HangTrace]   recentPE[-" + std::to_string(i) + "] = " + std::string(buf));
    }

    
    MpLogAllThreadRips(Tid);
}

static float BleedoutDurationFallback() {
    
    static float Cached = -1.0f;
    if (Cached < 0.0f) {
        Cached = 30.0f;
        char Buf[32]{};
        if (GetEnvironmentVariableA("MYSTICPARADOX_BLEEDOUT_SECONDS", Buf, sizeof(Buf)) > 0) {
            float Parsed = static_cast<float>(atof(Buf));
            if (Parsed > 0.0f && Parsed < 600.0f) Cached = Parsed;
        }
    }
    return Cached;
}

static void EnsureBleedoutDuration(SDK::UObject* GameMode) {
    static bool s_done = false;
    if (s_done || !GameMode) return;
    if (!IsReadablePointer(GameMode, 0x548)) return;

    
    if (!GameMode->IsA(SDK::AArchonGameMode_Island::StaticClass())) { s_done = true; return; }

    float* Duration = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(GameMode) + 0x540);
    const float Original = *Duration;

    if (Original > 0.0f) {
        MpLog("[Bleedout] GameMode BleedoutDuration=" + std::to_string(Original)
            + "s (valid; no patch needed)");
        s_done = true;
        return;
    }

    *Duration = BleedoutDurationFallback();
    MpLog("[Bleedout] GameMode BleedoutDuration was " + std::to_string(Original)
        + " (<=0) — SetTimer would fail and the player would be stuck downed forever. Patched to "
        + std::to_string(*Duration) + "s.");
    s_done = true;
}


static std::string BleedoutSnapshot(void* Comp) {
    if (!Comp || !IsReadablePointer(Comp, 0x178)) return "comp=unreadable";
    const uintptr_t C = reinterpret_cast<uintptr_t>(Comp);

    const uint8_t  State     = *reinterpret_cast<uint8_t*>(C + 0x0B0);
    const uint8_t  PrevState = *reinterpret_cast<uint8_t*>(C + 0x0B1);
    const float    Duration  = *reinterpret_cast<float*>(C + 0x0B4);
    const uint8_t  Finishing = *reinterpret_cast<uint8_t*>(C + 0x130);
    const int32_t  RepNum    = *reinterpret_cast<int32_t*>(C + 0x150);
    const int32_t  NoHealth  = *reinterpret_cast<int32_t*>(C + 0x160);
    const uint8_t  Ready     = *reinterpret_cast<uint8_t*>(C + 0x170);

    return "comp=" + MpPtr(Comp)
        + " state=" + std::to_string(State) + (State == 1 ? "(Bleedout)" : "(None)")
        + " prev=" + std::to_string(PrevState)
        + " duration=" + std::to_string(Duration) + (Duration <= 0.0f ? "  <== ZERO/NEG: SetTimer WILL FAIL" : "")
        + " replacementEffects=" + std::to_string(RepNum) + (RepNum > 0 ? "  <== REPLACEMENT PATH" : "")
        + " finishingHit=" + std::to_string(Finishing)
        + " noHealthEffectHandle=" + std::to_string(NoHealth)
        + " readyForEvents=" + std::to_string(Ready);
}



struct BleedoutWatchEntry {
    void*    Comp;
    uint64_t EnteredMs;
    float    DurationAtEntry;
    bool     Warned;
};
static BleedoutWatchEntry g_BleedWatch[8]{};

static void BleedoutWatchEnter(void* Comp, float Duration) {
    uint64_t Now = GetTickCount64();
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E.EnteredMs = Now; E.DurationAtEntry = Duration; E.Warned = false; return; }
    for (auto& E : g_BleedWatch) if (E.Comp == nullptr) { E = { Comp, Now, Duration, false }; return; }
    
    BleedoutWatchEntry* Oldest = &g_BleedWatch[0];
    for (auto& E : g_BleedWatch) if (E.EnteredMs < Oldest->EnteredMs) Oldest = &E;
    *Oldest = { Comp, Now, Duration, false };
}

static void BleedoutWatchExit(void* Comp) {
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E = {}; return; }
}



static void BleedoutWatchTick() {
    const uint64_t Now = GetTickCount64();

    for (auto& E : g_BleedWatch) {
        if (E.Comp == nullptr || E.Warned) continue;

        const uint64_t HeldMs = Now - E.EnteredMs;
        
        if (HeldMs < 120000) continue;

        if (!IsReadablePointer(E.Comp, 0x178)) { E = {}; continue; }
        if (*reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(E.Comp) + 0x0B0) != 1) { E = {}; continue; }

        MpLog("[BleedoutStuck] STILL in bleedout after " + std::to_string(HeldMs / 1000)
            + "s (durationAtEntry=" + std::to_string(E.DurationAtEntry)
            + ") — player is likely stuck downed/invincible. " + BleedoutSnapshot(E.Comp));
        E.Warned = true;
    }
}


static void BleedoutNoteEvent(const std::string& FunctionName, void* Obj) {
    
    
    
    
    if (FunctionName.find("Bleedout") == std::string::npos
        && FunctionName.find("FinishingHit") == std::string::npos
        && FunctionName.find("NoHealth") == std::string::npos) {
        return;
    }

    
    static const char* kNames[] = {
        "ServerTryStartBleedout", "TryStartBleedout", "AuthSetBleedoutState",
        "AuthOnBleedoutReplaced", "OnRep_CurrentBleedoutState",
        "ReceiveOnEnteredBleedoutState", "ReceiveOnExitedBleedoutState",
        "BroadcastPlayerStartedBleedoutDelegate", "ApplyNoHealthGameplayEffectToSelf",
        "DoFinishingHit", "FailsafeDoFinishingHit", "ClientEndFinishingHit",
        "RegisterBleedoutReplacementEffect", "UnregisterBleedoutReplacementEffect",
        "CanReplaceBleedout", "ReplaceBleedout", "OnPlayerEnterBleedout"
    };

    const char* Hit = nullptr;
    for (const char* N : kNames) {
        if (FunctionName.find(N) != std::string::npos) { Hit = N; break; }
    }
    if (!Hit) return;

    
    const bool IsComponent = Obj != nullptr
        && reinterpret_cast<UObject*>(Obj)->IsA(SDK::UArchonBleedoutComponent::StaticClass());

    const std::string Snap = IsComponent
        ? BleedoutSnapshot(Obj)
        : ("obj=" + MpPtr(Obj) + " (not the bleedout component — fields not read)");
    MpLog(std::string("[Bleedout] ") + Hit + " | " + Snap);

    
    if (IsComponent && IsReadablePointer(Obj, 0x178)) {
        const uintptr_t C = reinterpret_cast<uintptr_t>(Obj);
        const uint8_t State = *reinterpret_cast<uint8_t*>(C + 0x0B0);
        const float Duration = *reinterpret_cast<float*>(C + 0x0B4);

        if (State == 1) BleedoutWatchEnter(Obj, Duration);
        else            BleedoutWatchExit(Obj);

        
        if (State == 1 && Duration <= 0.0f) {
            MpLog("[BleedoutBUG] entered bleedout with duration=" + std::to_string(Duration)
                + " — BleedOutElasped SetTimer will fail and the player will be stuck downed. " + Snap);
        }
    }
}


static int GameModeEmptyState() {
    if (!SDK::UObject::GObjects) return -1;
    if (!g_CachedGameMode || !IsReadablePointer(g_CachedGameMode, 0x2E0)) {
        uint64_t Now = GetTickCount64();
        if (Now - g_LastGameModeSearchMs < 3000) return -1; 
        g_LastGameModeSearchMs = Now;
        g_CachedGameMode = nullptr;
        const int Count = SDK::UObject::GObjects->Num();
        for (int i = 0; i < Count; i++) {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
            if (!Obj || Obj->IsDefaultObject()) continue;
            if (Obj->IsA(SDK::AArchonGameMode::StaticClass())) { g_CachedGameMode = Obj; break; }
        }
    }
    if (!g_CachedGameMode || !IsReadablePointer(g_CachedGameMode, 0x2E0)) return -1;
    
    g_wdGameModePtr.store(g_CachedGameMode, std::memory_order_relaxed);
    if (g_wdIsHub.load(std::memory_order_relaxed) < 0) {
        SDK::UObject* Cls = *reinterpret_cast<SDK::UObject**>(reinterpret_cast<uintptr_t>(g_CachedGameMode) + 0x10);
        if (Cls && IsReadablePointer(Cls, 0x20)) {
            std::string Name = Cls->GetName();   
            g_wdIsHub.store((Name.find("City") != std::string::npos
                             || Name.find("TrainingGrounds") != std::string::npos) ? 1 : 0,
                            std::memory_order_relaxed);
        }
    }
    uintptr_t Gm = reinterpret_cast<uintptr_t>(g_CachedGameMode);
    int32_t NumPlayers    = *reinterpret_cast<int32_t*>(Gm + 0x02D0);
    int32_t NumTravelling = *reinterpret_cast<int32_t*>(Gm + 0x02DC);

    
    g_wdLastTickMs.store(GetTickCount64(), std::memory_order_relaxed);
    g_wdGameThreadId.store(GetCurrentThreadId(), std::memory_order_relaxed);

    EnsureBleedoutDuration(g_CachedGameMode);
    BleedoutWatchTick();
    if (NumPlayers > 0) g_wdSawPlayer.store(true, std::memory_order_relaxed);

    return (NumPlayers <= 0 && NumTravelling <= 0) ? 1 : 0;
}

















static std::atomic<bool> g_emptyWatchdogStarted{ false };
extern bool EnableWatchdog;   
static void StartEmptyWatchdogThread() {
    bool expected = false;
    if (!g_emptyWatchdogStarted.compare_exchange_strong(expected, true)) return;   
    std::thread([] {
        float emptySec = 0.0f;
        const float POLL_SEC = 2.0f;
        uint64_t iter = 0;
        bool hangSampled = false;   
        MpLog("[Watchdog/thread] started (poll 2s; reaps a disposable instance after 50s continuous empty)");
        for (;;) {
            Sleep(static_cast<DWORD>(POLL_SEC * 1000.0f));
            ++iter;
            if (!EnableWatchdog) { emptySec = 0.0f; continue; }
            
            
            
            void* gm  = g_wdGameModePtr.load(std::memory_order_relaxed);
            int   hub = g_wdIsHub.load(std::memory_order_relaxed);
            bool empty = false;
            int32_t numPlayers = -1, numTravelling = -1;
            if (gm && IsReadablePointer(gm, 0x2E0)) {
                numPlayers    = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gm) + 0x02D0);
                numTravelling = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gm) + 0x02DC);
                empty = (numPlayers <= 0 && numTravelling <= 0);
            }
            
            
            if ((iter % 15) == 0 || (empty && hub == 0)) {
                MpLog("[Watchdog/thread] gm=" + MpPtr(gm) + " hub=" + std::to_string(hub)
                    + " numPlayers=" + std::to_string(numPlayers) + " numTravelling=" + std::to_string(numTravelling)
                    + " empty=" + std::to_string(empty ? 1 : 0) + " emptySec=" + std::to_string(emptySec));
            }
            
            
            if (empty && hub == 0) {
                emptySec += POLL_SEC;
                if (emptySec >= 50.0f) {
                    MpReapExit("disposable instance empty 50s continuous");
                }
            } else {
                emptySec = 0.0f;
            }

            
            
            
            
            
            
            if (hub == 0 && g_wdSawPlayer.load(std::memory_order_relaxed)) {
                const uint64_t STALE_TICK_MS = 180000;   
                uint64_t lastTick = g_wdLastTickMs.load(std::memory_order_relaxed);
                if (lastTick != 0) {
                    uint64_t sinceTick = GetTickCount64() - lastTick;
                    
                    
                    
                    if (sinceTick >= 20000 && !hangSampled) {
                        hangSampled = true;
                        MpLog("[HangSuspect] game thread not ticked for " + std::to_string(sinceTick / 1000)
                            + "s while numPlayers=" + std::to_string(numPlayers)
                            + " — sampling (NOT reaping yet; reap at " + std::to_string(180) + "s)");
                        MpLogHungGameThread();
                    }
                    if (sinceTick < 10000) hangSampled = false;   
                    if (sinceTick >= STALE_TICK_MS) {
                        MpLog("[Watchdog/thread] disposable instance tick STALE for "
                            + std::to_string(sinceTick / 1000) + "s (numPlayers=" + std::to_string(numPlayers)
                            + " — hung game thread or ghost connection) -> reap");
                        
                        MpLogHungGameThread();
                        MpReapExit("tick stale");
                    }
                    
                    if (sinceTick >= 60000 && (iter % 15) == 0) {
                        MpLog("[Watchdog/thread] tick stale " + std::to_string(sinceTick / 1000)
                            + "s (numPlayers=" + std::to_string(numPlayers) + "); reaping at "
                            + std::to_string(STALE_TICK_MS / 1000) + "s");
                    }
                }
            }
        }
    }).detach();
}

void* OrigGetDefaultMap = nullptr;
void* OrigNetModeHook = nullptr;
void* OrigInternalNetModeHook = nullptr;
void* OrigWorldNetModeHook = nullptr;
void* OrigIsLevelInitForActor = nullptr;
void* OrigIsNetReady = nullptr;

bool IsNetReadyHook();
int NetModeHook(void* a1);
bool IsLevelInitForActorHook(void* a1, char a2);











static int HubMaxPlayers() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = 4; 
        wchar_t ExePath[MAX_PATH];
        DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            for (int i = (int)n - 1; i >= 0; --i) {
                if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
            }
            std::wstring Path = std::wstring(ExePath) + L"HUB_MAX_PLAYERS.txt";
            std::ifstream File(Path);
            if (File.is_open()) {
                int Value = 0;
                if ((File >> Value) && Value >= 1 && Value <= 64) { Cached = Value; }
            }
        }
    }
    return Cached;
}

FString* GetGameDefaultMap(FString* a1) {
    
    if (VerboseDiag()) MpLog("[GetGameDefaultMap] entry out=" + MpPtr(a1));
    FString* Ret = reinterpret_cast<FString*(*)(FString*)>(OrigGetDefaultMap)(a1);
    if (VerboseDiag()) MpLog("[GetGameDefaultMap] original returned " + MpPtr(Ret));

    std::wstring FinalURL(Globals::MapPath);

    std::wstring BehemothPath(Globals::BehemothPath);

    if (!BehemothPath.contains(L"NO_BEHEMOTH")) {
        FinalURL += std::wstring(L"?MonsterClass=");
        FinalURL += std::wstring(BehemothPath);
    }

    std::wstring MatchmakerHuntId(Globals::MatchmakerHuntId);

    if (!MatchmakerHuntId.contains(L"NO_MM_HUNTID")) {
        FinalURL += std::wstring(L"?HuntId=");
        FinalURL += std::wstring(MatchmakerHuntId);
    }

    std::wstring ExpectedPlayers(Globals::ExpectedPlayerString);

    if (!ExpectedPlayers.contains(L"NO_EXPECTED_PLAYERS")) {
        FinalURL += std::wstring(L"?PlayerHuntIds=");
        FinalURL += std::wstring(ExpectedPlayers);
    }

    
    
    
    
    FinalURL += std::wstring(L"?MaxPlayers=");
    FinalURL += std::to_wstring(HubMaxPlayers());

    
    
    
    
    {
        struct RawFString { wchar_t* Data; int Num; int Max; };
        RawFString* Raw = reinterpret_cast<RawFString*>(Ret);
        const int Count = static_cast<int>(FinalURL.size()) + 1; 
        MpLog("[GetGameDefaultMap] setting map URL (" + std::to_string(FinalURL.size()) + " chars): " + MpNarrow(FinalURL));
        MpLog("[GetGameDefaultMap] before write Ret=" + MpPtr(Ret)
            + " Data=" + MpPtr(Raw->Data)
            + " Num=" + std::to_string(Raw->Num)
            + " Max=" + std::to_string(Raw->Max)
            + " Count=" + std::to_string(Count));

        if (Raw->Max < Count || Raw->Data == nullptr) {
            MpLog("[GetGameDefaultMap] realloc needed");
            Raw->Data = static_cast<wchar_t*>(EngineRealloc(Raw->Data, static_cast<size_t>(Count) * sizeof(wchar_t)));
            MpLog("[GetGameDefaultMap] realloc returned Data=" + MpPtr(Raw->Data));
        }
        else {
            MpLog("[GetGameDefaultMap] reusing existing buffer");
        }

        if (!Raw->Data) {
            MpLog("[GetGameDefaultMap] null Data after allocation; returning original result");
            return Ret;
        }

        wmemcpy(Raw->Data, FinalURL.c_str(), static_cast<size_t>(Count));
        Raw->Num = Count;
        if (Raw->Max < Count) {
            Raw->Max = Count;
        }
        MpLog("[GetGameDefaultMap] written OK Data=" + MpPtr(Raw->Data)
            + " Num=" + std::to_string(Raw->Num)
            + " Max=" + std::to_string(Raw->Max));
    }

    
    
    
    

    return Ret;
}

void* OrigGetCommandLine = nullptr;

const wchar_t* GetCommandLineHook() {
    
    
    
    
    
    
    
    
    
    
    
    return L"Dauntless-Win64-Shipping.exe -server -unattended -nullrhi -warp -nosound -EpicPortal -NoEAC -RepDriverDisable -LogCmds=\"LogNet VeryVerbose, LogNetPackageMap Verbose\"";
}

















static bool MpForceWarpEnabled() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = 0;
        wchar_t ExePath[MAX_PATH];
        DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            for (int i = (int)n - 1; i >= 0; --i) {
                if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
            }
            std::wstring FlagPath = std::wstring(ExePath) + L"MP_FORCE_WARP.flag";
            if (GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES) { Cached = 1; }
        }
    }
    return Cached == 1;
}


static bool MpPathHasD3D11(const wchar_t* Path) {
    if (!Path) { return false; }
    const wchar_t* Needle = L"d3d11";
    for (const wchar_t* P = Path; *P; ++P) {
        int i = 0;
        for (; Needle[i] && P[i]; ++i) {
            wchar_t a = P[i];
            if (a >= L'A' && a <= L'Z') { a = (wchar_t)(a + 32); }
            if (a != Needle[i]) { break; }
        }
        if (!Needle[i]) { return true; }
    }
    return false;
}


using PFN_D3D11CreateDevice = long (WINAPI*)(void*, unsigned int, HMODULE, unsigned int,
    const void*, unsigned int, unsigned int, void**, void*, void**);
using PFN_D3D11CreateDeviceAndSwapChain = long (WINAPI*)(void*, unsigned int, HMODULE, unsigned int,
    const void*, unsigned int, unsigned int, const void*, void**, void**, void*, void**);
static PFN_D3D11CreateDevice OrigD3D11CreateDevice = nullptr;
static PFN_D3D11CreateDeviceAndSwapChain OrigD3D11CreateDeviceAndSwapChain = nullptr;
static volatile LONG g_D3D11Hooked = 0;

static long WINAPI D3D11CreateDeviceHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    (void)pAdapter; (void)DriverType;
    
    
    return OrigD3D11CreateDevice(nullptr, 5, Software, Flags, pFeatureLevels, FeatureLevels,
        SDKVersion, ppDevice, pFeatureLevel, ppImmediateContext);
}
static long WINAPI D3D11CreateDeviceAndSwapChainHook(void* pAdapter, unsigned int DriverType, HMODULE Software,
    unsigned int Flags, const void* pFeatureLevels, unsigned int FeatureLevels, unsigned int SDKVersion,
    const void* pSwapChainDesc, void** ppSwapChain, void** ppDevice, void* pFeatureLevel, void** ppImmediateContext) {
    (void)pAdapter; (void)DriverType;
    return OrigD3D11CreateDeviceAndSwapChain(nullptr, 5, Software, Flags, pFeatureLevels, FeatureLevels,
        SDKVersion, pSwapChainDesc, ppSwapChain, ppDevice, pFeatureLevel, ppImmediateContext);
}



static void MpTryHookD3D11(HMODULE Mod) {
    if (!Mod) { return; }
    if (InterlockedCompareExchange(&g_D3D11Hooked, 1, 0) != 0) { return; }
    void* pCreate = reinterpret_cast<void*>(GetProcAddress(Mod, "D3D11CreateDevice"));
    void* pCreateSC = reinterpret_cast<void*>(GetProcAddress(Mod, "D3D11CreateDeviceAndSwapChain"));
    if (pCreate) {
        MH_CreateHook(pCreate, reinterpret_cast<void*>(D3D11CreateDeviceHook),
            reinterpret_cast<void**>(&OrigD3D11CreateDevice));
        MH_EnableHook(pCreate);
    }
    if (pCreateSC) {
        MH_CreateHook(pCreateSC, reinterpret_cast<void*>(D3D11CreateDeviceAndSwapChainHook),
            reinterpret_cast<void**>(&OrigD3D11CreateDeviceAndSwapChain));
        MH_EnableHook(pCreateSC);
    }
}


using PFN_LoadLibraryExW = HMODULE (WINAPI*)(const wchar_t*, HANDLE, DWORD);
static PFN_LoadLibraryExW OrigLoadLibraryExW = nullptr;
static HMODULE WINAPI LoadLibraryExWHook(const wchar_t* lpLibFileName, HANDLE hFile, DWORD dwFlags) {
    HMODULE Result = OrigLoadLibraryExW(lpLibFileName, hFile, dwFlags);
    if (Result && !g_D3D11Hooked && MpPathHasD3D11(lpLibFileName)) {
        MpTryHookD3D11(Result);
    }
    return Result;
}


static void InstallWarpForceHooks() {
    MpLog("[WARP] installing (MP_FORCE_WARP.flag present)");
    
    {
        DWORD OldProtect = 0;
        unsigned char* Site = reinterpret_cast<unsigned char*>(Globals::BaseAddress + 0x0032DAA1B);
        unsigned char Before = 0xFF, After = 0xFF;
        if (VirtualProtect(Site, 1, PAGE_EXECUTE_READWRITE, &OldProtect)) {
            Before = *Site;
            if (*Site == 0x75) { *Site = 0xEB; }
            After = *Site;
            VirtualProtect(Site, 1, OldProtect, &OldProtect);
        }
        MpLog(std::string("[WARP] gate patch @+0x32DAA1B before=") + MpHex(Before) + " after=" + MpHex(After)
            + ((After == 0xEB) ? " (OK)" : " (UNEXPECTED: byte!=0x75 -> DLL likely loaded AFTER engine PreInit)"));
    }
    
    
    HMODULE Kernel = GetModuleHandleW(L"kernel32.dll");
    void* pLLEW = Kernel ? reinterpret_cast<void*>(GetProcAddress(Kernel, "LoadLibraryExW")) : nullptr;
    if (pLLEW) {
        MH_CreateHook(pLLEW, reinterpret_cast<void*>(LoadLibraryExWHook),
            reinterpret_cast<void**>(&OrigLoadLibraryExW));
        MH_EnableHook(pLLEW);
    }
    HMODULE Existing = GetModuleHandleW(L"d3d11.dll");
    MpLog(std::string("[WARP] LoadLibraryExW hook=") + (pLLEW ? "on" : "FAIL")
        + " d3d11Resident=" + (Existing ? "yes(hook now)" : "no(hook on load)"));
    if (Existing) { MpTryHookD3D11(Existing); }
}

void* OrigServerBootCrash = nullptr;









void ServerBootCrash(void* param_1) {
    const wchar_t* ErrorHist = *reinterpret_cast<const wchar_t**>(Globals::BaseAddress + 0x06B53C44);

    std::string Category = "ServerBootCrash";
    std::string MsgNarrow = ErrorHist ? MpNarrow(std::wstring(ErrorHist)) : std::string("(null error history buffer)");

    MpLog("[ServerBootCrash] SUPPRESSED FATAL - category=" + Category + " msg=" + MsgNarrow);

    (void)param_1;
    return;
}




static uintptr_t SafeReadPtr(uintptr_t base, uintptr_t offset);
static int SafeReadU8At(uintptr_t base, uintptr_t offset);

static int32_t SafeReadI32At(uintptr_t base, uintptr_t offset);



static std::string SafeGetFullNameOf(UObject* Obj);





























void* OrigArchonLoadManagerLoadFailed = nullptr;
void ArchonLoadManagerLoadFailedHook(void* This) {
    
    
    static std::atomic<int> s_hitCount{0};
    int hit = s_hitCount.fetch_add(1, std::memory_order_relaxed);

    uintptr_t self = reinterpret_cast<uintptr_t>(This);
    MpLog(std::string("[LoadFailedDiag] fire #") + std::to_string(hit)
        + " LoadManager=" + MpPtr(This));

    if (!IsReadablePointer(This, 0x60)) {
        MpLog("[LoadFailedDiag]   LoadManager pointer not readable, skipping enumeration");
        return;
    }

    
    uintptr_t arrayBase = SafeReadPtr(self, 0x48);
    int32_t   arrayCount = SafeReadI32At(self, 0x50);

    MpLog(std::string("[LoadFailedDiag]   ArrayBase=") + MpPtr((void*)arrayBase)
        + " Count=" + std::to_string(arrayCount));

    if (!arrayBase || arrayCount <= 0 || arrayCount > 128) {
        MpLog("[LoadFailedDiag]   Array empty/invalid, skipping enumeration");
        return;
    }

    if (!IsReadablePointer(reinterpret_cast<void*>(arrayBase),
                           static_cast<size_t>(arrayCount) * 0x10)) {
        MpLog("[LoadFailedDiag]   Array memory not readable at expected size");
        return;
    }

    for (int i = 0; i < arrayCount; ++i) {
        uintptr_t entryAddr = arrayBase + static_cast<uintptr_t>(i) * 0x10;
        
        
        
        
        
        
        int32_t  fnameComp = SafeReadI32At(entryAddr, 0x00);
        int32_t  fnameNum  = SafeReadI32At(entryAddr, 0x04);
        uintptr_t objPtr   = SafeReadPtr(entryAddr, 0x08);

        
        
        int loadedFlag = -1;
        if (objPtr && IsReadablePointer(reinterpret_cast<void*>(objPtr), 0x40)) {
            loadedFlag = SafeReadU8At(objPtr, 0x10);
        }

        
        
        
        std::string loaderName = "(no name)";
        if (fnameComp > 0 && fnameComp < 0x100000 ) {
            FName resolved{fnameComp, static_cast<uint32_t>(fnameNum)};
            loaderName = resolved.ToString();
        } else {
            char rawBuf[64];
            _snprintf_s(rawBuf, sizeof(rawBuf), _TRUNCATE,
                        "(FName idx=%d num=%d)", fnameComp, fnameNum);
            loaderName = rawBuf;
        }

        MpLog(std::string("[LoadFailedDiag]   [") + std::to_string(i) + "] "
            + "name=" + loaderName
            + " obj="  + MpPtr((void*)objPtr)
            + " loaded=" + std::to_string(loadedFlag)
            + " fname=(" + std::to_string(fnameComp) + "," + std::to_string(fnameNum) + ")");
    }

    
    
    (void)This;
    return;
}










static std::atomic<uint64_t> g_postLoginTimeMs{ 0 };   




static std::atomic<int> g_pawnDiagCount{ 0 };





static void* ResolveWeakObj(int32_t objectIndex, int32_t serialNumber) {
    __try {
        int32_t weak[2] = { objectIndex, serialNumber };
        using ResolveFn = void* (*)(int32_t*);
        auto fn = reinterpret_cast<ResolveFn>(Globals::BaseAddress + 0x026C2C10);
        return fn(weak);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}
































void* OrigEncounterableSetup = nullptr;

void EncounterableSetupHook() {
    return;
}

float TotalNoPlayersTime = 0.0f;

bool EnableWatchdog = true;

void* OrigGameEngineTick = nullptr;
void* OrigInteractionCalloutHideHoldText = nullptr;
void* OrigArchonLoadingScreenFadeIn = nullptr;

static bool SanitizeNetDriverClientConnections(void* NetDriver, const char* Tag);









static void* g_regWorld = nullptr;
static void* g_deferredWorld = nullptr;
static void* g_rejectedWorld = nullptr;
static bool RegisterNetDriverInLevelCollections() {
    if (!Globals::Listening || !Networking::NetDriver || !IsReadablePointer(Networking::NetDriver, 0x198)) return false;
    UWorld* w = UWorld::GetWorld();
    if (!w || !IsReadablePointer(w, 0x160)) return false;
    if (g_regWorld == reinterpret_cast<void*>(w)) return true;   

    void* drvWorld = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x140);  
    uintptr_t arr = *reinterpret_cast<uintptr_t*>(reinterpret_cast<uintptr_t>(w) + 0x148);
    int32_t count = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(w) + 0x150);
    bool collectionsOk = (arr && count > 0 && count <= 8 && IsReadablePointer(reinterpret_cast<void*>(arr), static_cast<size_t>(count) * 0x78));
    
    if (drvWorld != reinterpret_cast<void*>(w) || !collectionsOk) {
        if (g_deferredWorld != reinterpret_cast<void*>(w)) {
            g_deferredWorld = reinterpret_cast<void*>(w);
            MpLog("[CollectionFix] registration deferred: world=" + MpPtr(w) + " driverWorld=" + MpPtr(drvWorld)
                + " collections=" + (collectionsOk ? ("n=" + std::to_string(count)) : std::string("unavailable")));
        }
        return false;
    }
    
    void* gengine = IsReadablePointer(reinterpret_cast<void*>(Globals::BaseAddress + 0x06CFBF60), 8)
        ? *reinterpret_cast<void**>(Globals::BaseAddress + 0x06CFBF60) : nullptr;
    uint64_t nm = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x190);  
    void* reResolve = (gengine && IsReadablePointer(gengine, 0xC48))
        ? reinterpret_cast<void* (*)(void*, void*, uint64_t)>(Globals::BaseAddress + 0x0403A830)(gengine, w, nm) : nullptr;
    if (reResolve != reinterpret_cast<void*>(Networking::NetDriver)) {
        if (g_rejectedWorld != reinterpret_cast<void*>(w)) {
            g_rejectedWorld = reinterpret_cast<void*>(w);
            MpLog("[CollectionFix] registration REJECTED (driver not in WorldContext; would re-null): world=" + MpPtr(w)
                + " byNameResolve=" + MpPtr(reResolve) + " driver=" + MpPtr(Networking::NetDriver) + " — NOT writing collections");
        }
        return false;   
    }
    
    int populated = 0;
    for (int i = 0; i < count; ++i) {
        uintptr_t c = arr + static_cast<uintptr_t>(i) * 0x78;
        uint8_t type = *reinterpret_cast<uint8_t*>(c + 0x00);
        if (type == 0 || type == 2) {   
            *reinterpret_cast<void**>(c + 0x10) = reinterpret_cast<void*>(Networking::NetDriver);  
            ++populated;
        }
    }
    g_regWorld = reinterpret_cast<void*>(w);
    MpLog("[CollectionFix] set driver on " + std::to_string(populated) + " gameplay collection(s) world=" + MpPtr(w)
        + " driver=" + MpPtr(Networking::NetDriver) + " byNameResolve=" + MpPtr(reResolve) + " resolveMatches=Y");
    return true;
}

static void SanitizeNetDriverBeforeEngineTick() {
    if (!Globals::Listening || !Networking::NetDriver || !IsReadablePointer(Networking::NetDriver, 0x2B0)) {
        return;
    }

    UWorld* World = UWorld::GetWorld();
    if (!World || !IsReadablePointer(World, 0x40)) {
        return;
    }

    static FName GameNetDriverName = FName();
    static bool GameNetDriverNameInit = false;

    if (!GameNetDriverNameInit) {
        GameNetDriverName = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        GameNetDriverNameInit = true;
    }

    
    
    
    RegisterNetDriverInLevelCollections();
    Networking::NetDriver->World = World;
    Networking::NetDriver->NetDriverName = GameNetDriverName;
    Networking::NetDriver->ServerConnection = nullptr;
}




static bool NativeNetTick();  





struct ManualNetTickFailureState {
    bool Active = false;
    uint64_t LastReportMs = 0;
    uint64_t FailuresSinceReport = 0;
};

static ManualNetTickFailureState g_TickDispatchFailureState;
static ManualNetTickFailureState g_TickFlushFailureState;

static void ReportManualNetTickFailure(bool IsFlush, uint64_t Tick) {
    ManualNetTickFailureState& State = IsFlush ? g_TickFlushFailureState : g_TickDispatchFailureState;
    const char* Phase = IsFlush ? "TickFlush" : "TickDispatch";
    const uint64_t NowMs = GetTickCount64();
    ++State.FailuresSinceReport;

    if (!State.Active) {
        State.Active = true;
        State.LastReportMs = NowMs;
        MpLog("[NetTickFault] " + std::string(Phase) + " first exception at tick=" + std::to_string(Tick)
            + "; repeated failures will be summarized every 30s");
        State.FailuresSinceReport = 0;
        return;
    }

    if (NowMs - State.LastReportMs >= 30000) {
        MpLog("[NetTickFault] " + std::string(Phase) + " still failing at tick=" + std::to_string(Tick)
            + " failuresSinceLast=" + std::to_string(State.FailuresSinceReport));
        State.LastReportMs = NowMs;
        State.FailuresSinceReport = 0;
    }
}

static void ReportManualNetTickRecovery(bool IsFlush, uint64_t Tick) {
    ManualNetTickFailureState& State = IsFlush ? g_TickFlushFailureState : g_TickDispatchFailureState;
    if (!State.Active) return;

    const char* Phase = IsFlush ? "TickFlush" : "TickDispatch";
    MpLog("[NetTickFault] " + std::string(Phase) + " recovered at tick=" + std::to_string(Tick)
        + " unreportedFailures=" + std::to_string(State.FailuresSinceReport));
    State = {};
}

static int TickDispatchExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo) {
    if (ExceptionInfo && IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        LogExceptionRecord(
            "ManualTickDispatchSEH",
            ExceptionInfo->ExceptionRecord,
            IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT)) ? ExceptionInfo->ContextRecord : nullptr);
    }
    else {
        EXCEPTION_RECORD Record{};
        Record.ExceptionCode = Code;
        Record.ExceptionAddress = _ReturnAddress();
        LogExceptionRecord("ManualTickDispatchSEH", &Record, nullptr);
    }

    return EXCEPTION_EXECUTE_HANDLER;
}

static bool SafeManualTickDispatch(UNetDriver* NetDriver, float DeltaTime) {
    
    
    
    if (NativeNetTick()) return true;
    using TickDispatchFn = void(*)(UNetDriver*, float);

    __try {
        reinterpret_cast<TickDispatchFn>(Globals::BaseAddress + 0x00A6F220)(NetDriver, DeltaTime);
        return true;
    }
    __except (TickDispatchExceptionFilter(GetExceptionCode(), GetExceptionInformation())) {
        return false;
    }
}















static int TickFlushExceptionFilter(unsigned int Code, EXCEPTION_POINTERS* ExceptionInfo) {
    if (ExceptionInfo && IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        LogExceptionRecord(
            "ManualTickFlushSEH",
            ExceptionInfo->ExceptionRecord,
            IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT)) ? ExceptionInfo->ContextRecord : nullptr);
    }
    else {
        EXCEPTION_RECORD Record{};
        Record.ExceptionCode = Code;
        Record.ExceptionAddress = _ReturnAddress();
        LogExceptionRecord("ManualTickFlushSEH", &Record, nullptr);
    }
    return EXCEPTION_EXECUTE_HANDLER;
}

static bool SafeManualTickFlush(UNetDriver* NetDriver, float DeltaTime) {
    
    if (NativeNetTick()) return true;
    using TickFlushFn = void(*)(UNetDriver*, float);

    __try {
        reinterpret_cast<TickFlushFn>(Globals::BaseAddress + 0x03D91DC0)(NetDriver, DeltaTime);
        return true;
    }
    __except (TickFlushExceptionFilter(GetExceptionCode(), GetExceptionInformation())) {
        return false;
    }
}



















static bool ManualTickZeroDeltaTime() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"MANUAL_TICK_ZERO_DT.flag") ? 1 : 0;
        MpLog(std::string("[ManualTickDT] MANUAL_TICK_ZERO_DT.flag ")
            + (c ? "PRESENT -> *** BROKEN: server will be UNJOINABLE (handshake timers frozen). REMOVE THIS FLAG. *** "
                   "Replication still runs; server stays joinable. Watch whether orbit/beam visuals correct "
                   "themselves while everything else is unchanged."
                 : "absent -> manual TickDispatch gets the real DeltaTime (default; clock may double-advance)."));
    }
    return c == 1;
}


static bool ManualTickHalfRate() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"MANUAL_TICK_HALF_RATE.flag") ? 1 : 0;
        MpLog(std::string("[ManualTickRate] MANUAL_TICK_HALF_RATE.flag ")
            + (c ? "PRESENT -> manual TickDispatch/TickFlush run every OTHER frame (~30Hz SRA, matches "
                   "NetServerMaxTickRate). NOTE: also halves player-pawn replication rate."
                 : "absent -> manual drive runs every frame (default)."));
    }
    return c == 1;
}

static bool NativeNetTick() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"NATIVE_NET_TICK.flag") ? 1 : 0;
        MpLog(std::string("[NativeNetTick] NATIVE_NET_TICK.flag ")
            + (c ? "PRESENT -> manual TickDispatch/TickFlush SKIPPED; native engine tick is the sole net driver. "
                   "Expect [SRA enter] ~30Hz (enable REPGRAPH_DIAG.flag to confirm). If [SRA enter] stops / goes ~0Hz, "
                   "native does NOT drive TickFlush here -> remove the flag (replication broken in this mode)."
                 : "absent -> manual TickDispatch/TickFlush ACTIVE (default; current double-drive ~60Hz behaviour)."));
    }
    return c == 1;
}







static bool PlayerRepBoost();  

































static void ForceServerMeshPose() {
    if (!MpExeRelativeFlagPresent(L"FORCE_SERVER_MESH_POSE.flag")) return;
    if (!SDK::UObject::GObjects) return;

    static uint64_t s_lastMs = 0;
    uint64_t now = GetTickCount64();
    if (s_lastMs != 0 && now - s_lastMs < 4000) return;   
    s_lastMs = now;

    SDK::UClass* MeshClass = SDK::USkeletalMeshComponent::StaticClass();
    if (!MeshClass) {
        MpLog("[ForceServerMeshPose] pass: USkeletalMeshComponent::StaticClass() returned null - class lookup failed");
        return;
    }

    const int Count = SDK::UObject::GObjects->Num();
    
    
    
    
    
    
    
    
    
    int walked = 0, matched = 0, unreadable = 0, changed = 0, logged = 0;
    const int LogCap = 500;   
    const int NameSampleCap = 20;   
    int nameSampled = 0;
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj || Obj->IsDefaultObject()) continue;
        ++walked;
        if (!Obj->IsA(MeshClass)) continue;
        ++matched;

        uint8_t* opt = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Obj) + 0x5FC);
        if (!IsReadablePointer(opt, 1)) {
            ++unreadable;
            if (nameSampled < NameSampleCap) {
                ++nameSampled;
                MpLog("[ForceServerMeshPose] MATCHED-BUT-UNREADABLE " + Obj->GetFullName() + " ptr=" + MpPtr(opt));
            }
            continue;
        }

        uint8_t oldVal = *opt;
        bool willChange = (oldVal == 1 || oldVal == 2 || oldVal == 3);   
        if (willChange) {
            *opt = 0;                                       
            ++changed;
        }
        if (logged < LogCap) {
            ++logged;
            MpLog("[ForceServerMeshPose] " + Obj->GetFullName()
                + " VisibilityBasedAnimTickOption " + std::to_string(oldVal)
                + (willChange ? " -> 0 (forced)" : " (already 0, no change)"));
        }
    }
    MpLog("[ForceServerMeshPose] pass walked " + std::to_string(walked) + " object(s), IsA-matched "
        + std::to_string(matched) + ", unreadable " + std::to_string(unreadable) + ", changed "
        + std::to_string(changed) + ", logged " + std::to_string(logged));
}









static void SampleBleedoutGrace() {
    UWorld* w = *reinterpret_cast<UWorld**>(Globals::BaseAddress + 0x06D001B8);
    if (!w || !IsReadablePointer(w, 0x128)) return;
    void* gs = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(w) + 0x120);
    if (!gs || !IsReadablePointer(gs, 0x248)) return;
    void** psData = *reinterpret_cast<void***>(reinterpret_cast<uintptr_t>(gs) + 0x238);
    int psNum = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gs) + 0x240);
    if (!psData || psNum <= 0 || psNum > 64 || !IsReadablePointer(psData, 8)) return;
    for (int i = 0; i < psNum; ++i) {
        void* ps = psData[i];
        if (!ps || !IsReadablePointer(ps, 0x3B8)) continue;
        int32_t state = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ps) + 0x3AC);
        if (state == 0) continue;   
        float len = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B0);
        float rem = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(ps) + 0x3B4);
        MpLog("[GraceDiag] ps=" + reinterpret_cast<UObject*>(ps)->GetName()
            + " BleedoutState=" + std::to_string(state)
            + " timerLen=" + std::to_string(len)
            + " timeRemaining=" + std::to_string(rem));
    }
}


static void SampleBleedoutGraceGuarded() {
    __try { SampleBleedoutGrace(); } __except (EXCEPTION_EXECUTE_HANDLER) {}
}







void* OrigKnockout = nullptr;
static void LogKnockout(void* self) {
    std::string nm = (self && IsReadablePointer(self, 0x40)) ? reinterpret_cast<UObject*>(self)->GetName() : std::string("?");
    MpLog("[GraceDiag] KNOCKOUT actor=" + nm);
}
void KnockoutHook(void* self) {
    reinterpret_cast<void(*)(void*)>(OrigKnockout)(self);
    if (MpExeRelativeFlagPresent(L"TRIALS_GRACE_DIAG.flag")) {
        __try { LogKnockout(self); } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
}




static bool DiagNaturalMode();
void TriggerArchonInputActivation(UObject* PC, const char* TriggerLabel);
static std::string CoreCapFString(void* fstr);   
                                                  





extern void* OrigApplyPlayerRole;
void ApplyPlayerRoleHook(void* a1);
static void TickPlayerRoleRetries();
static void TickPlayerRolePostActivationRefresh();
static void TickTempestModifierEnsure();
static void TickTempestChargeDiag();
static void TickProgressionHudRefresh();











static UObject* s_LastPossessedPC = nullptr;
static UObject* s_LastRestartPawn = nullptr;
static uint64_t s_LastPossessedAtMs = 0;
static bool s_ArchonInputActivated = false;
static bool s_ProgressionHudRefreshPending = false;
static uint32_t s_ProgressionHudRefreshAttempts = 0;
static uint64_t s_ProgressionHudRefreshNotBeforeMs = 0;

void GameEngineTickHook(UGameEngine* GameEngine, float DeltaTime, char CanRender) {
    static uint64_t tickCounter = 0;    ++tickCounter;

    
    
    
    DWORD CurTid = GetCurrentThreadId();
    InterlockedCompareExchange(
        reinterpret_cast<volatile LONG*>(&GameTickThreadId),
        static_cast<LONG>(CurTid),
        0);

    static bool tickHookLogged = false;
    if (!tickHookLogged) {
        tickHookLogged = true;
        MpLog("[GameEngineTick] first entry GameEngine=" + MpPtr(GameEngine)
            + " DeltaTime=" + std::to_string(DeltaTime)
            + " CanRender=" + std::to_string(static_cast<int>(CanRender))
            + " DoListen=" + std::to_string(Globals::DoListen ? 1 : 0)
            + " Listening=" + std::to_string(Globals::Listening ? 1 : 0)
            + " tid=" + std::to_string(CurTid));
    }

    
    
    
    
    
    if (Globals::AmServer) {
        *(uint8_t*)(Globals::BaseAddress + 0x06B5325A) = 0x1; 
        *(uint8_t*)(Globals::BaseAddress + 0x06B53259) = 0x0; 
    }

    SanitizeNetDriverBeforeEngineTick();

    reinterpret_cast<void(*)(UGameEngine*, float, char)>(OrigGameEngineTick)(GameEngine, DeltaTime, CanRender);

    
    
    if (Globals::AmServer) {
        ForceServerMeshPose();
    }

    
    
    if (Globals::AmServer) {
        static uint32_t s_graceTick = 0;
        static bool s_graceOn = false;
        ++s_graceTick;
        if ((s_graceTick & 0xFF) == 1) s_graceOn = MpExeRelativeFlagPresent(L"TRIALS_GRACE_DIAG.flag");
        if (s_graceOn && (s_graceTick & 7) == 0) {
            SampleBleedoutGraceGuarded();
        }
    }

    
    
    
    
    
    if (Globals::AmServer) {
        static uint32_t s_roleRetryTick = 0;
        if ((++s_roleRetryTick & 0x3F) == 0) {   
            TickPlayerRoleRetries();
            TickPlayerRolePostActivationRefresh();
            TickTempestModifierEnsure();
        }
    }

    
    
    
    
    
    if (Globals::AmServer) {
        static uint32_t s_tempestDiagTick = 0;
        if ((++s_tempestDiagTick & 0x7) == 0) {
            TickTempestChargeDiag();
        }
    }

    
    
    
    
    
    
    
    

    
    
    
    
    
    if (Globals::AmServer) {
        *(uint8_t*)(Globals::BaseAddress + 0x06B5325A) = 0x1; 
        *(uint8_t*)(Globals::BaseAddress + 0x06B53259) = 0x0; 
    }

    
    

    if (GetAsyncKeyState(VK_F7)) {
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsA(SDK::AActor::StaticClass()))
            {
                AActor* Quest = (AActor*)Obj;

                if (Quest->Role != ENetRole::ROLE_Authority) {
                    std::cout << (int)(uint8_t)Quest->Role << std::endl;

                    std::cout << Quest->GetFullName() << std::endl;
                }
            }
        }

        while (GetAsyncKeyState(VK_F7)) {

        }
    }

    if (Globals::Listening) {
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        static int s_disableExpectedZero = -1;
        if (s_disableExpectedZero < 0) {
            s_disableExpectedZero = MpExeRelativeFlagPresent(L"DISABLE_EXPECTED_PLAYER_ZERO.flag") ? 1 : 0;
            MpLog(std::string("[ExpectedPlayerCount] DISABLE_EXPECTED_PLAYER_ZERO.flag ")
                + (s_disableExpectedZero ? "PRESENT -> zeroing DISABLED (native session state preserved)"
                                         : "absent -> zeroing ENABLED (default)"));
        }

        if (s_disableExpectedZero == 0 && SDK::UObject::GObjects) {
            static bool s_loggedGameMode  = false;
            static bool s_loggedGameState = false;

            const int Count = SDK::UObject::GObjects->Num();
            for (int i = 0; i < Count; i++) {
                SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
                if (!Obj) continue;
                if (Obj->IsDefaultObject()) continue;

                if (Obj->IsA(SDK::AArchonGameMode::StaticClass())) {
                    int32_t* Field = reinterpret_cast<int32_t*>(
                        reinterpret_cast<uintptr_t>(Obj) + 0x0498);
                    if (IsReadablePointer(Field, sizeof(int32_t))) {
                        int32_t Before = *Field;
                        if (Before != 0) {
                            *Field = 0;
                            if (!s_loggedGameMode) {
                                s_loggedGameMode = true;
                                MpLog("[ExpectedPlayerCount@GameMode] zeroed  instance=" + MpPtr(Obj)
                                    + " class=" + Obj->Class->GetName()
                                    + " before=" + std::to_string(Before)
                                    + " after=0"
                                    + " offset=+0x0498");
                            }
                        }
                    }
                }

                if (Obj->IsA(SDK::AArchonGameState::StaticClass())) {
                    int32_t* Field = reinterpret_cast<int32_t*>(
                        reinterpret_cast<uintptr_t>(Obj) + 0x02E8);
                    if (IsReadablePointer(Field, sizeof(int32_t))) {
                        int32_t Before = *Field;
                        if (Before != 0) {
                            *Field = 0;
                            if (!s_loggedGameState) {
                                s_loggedGameState = true;
                                MpLog("[ExpectedPlayerCount@GameState] zeroed  instance=" + MpPtr(Obj)
                                    + " class=" + Obj->Class->GetName()
                                    + " before=" + std::to_string(Before)
                                    + " after=0"
                                    + " offset=+0x02E8");
                            }
                        }
                    }
                }
            }
        }

        static int netTickTraceBudget = 180;
        int32_t preConnectionCount = -1;
        int32_t preConnectionMax = -1;

        if (Networking::NetDriver &&
            IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), sizeof(int32_t) * 2)) {
            preConnectionCount = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
            preConnectionMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x9C);
        }

        
        
        
        
        
        {
            static int32_t s_lastConnCount = -2;   
            if (preConnectionCount != s_lastConnCount) {
                MpLog("[NetConnEdge] tick=" + std::to_string(tickCounter)
                    + " connCount " + std::to_string(s_lastConnCount)
                    + " -> " + std::to_string(preConnectionCount)
                    + " connMax=" + std::to_string(preConnectionMax)
                    + " NetDriver=" + MpPtr(Networking::NetDriver));
                
                
                
                LogArchonLifecycle(("ConnEdge " + std::to_string(s_lastConnCount) + "->" + std::to_string(preConnectionCount)).c_str());
                s_lastConnCount = preConnectionCount;
            }
        }

        
        
        
        
        
        {
            static AArchonGameMode* s_gm = nullptr;
            static uint64_t s_lastFindMs = 0;
            static int32_t s_lastMatchIdx = -0x7fffffff;
            uint64_t nowMs = static_cast<uint64_t>(GetTickCount64());

            bool gmOk = s_gm && IsReadablePointer(s_gm, 0x4A0) && s_gm->IsA(AArchonGameMode::StaticClass());
            if (!gmOk && (nowMs - s_lastFindMs) > 1000) {
                s_lastFindMs = nowMs;
                s_gm = nullptr;
                if (SDK::UObject::GObjects) {
                    const int n = SDK::UObject::GObjects->Num();
                    for (int i = 0; i < n; i++) {
                        SDK::UObject* o = SDK::UObject::GObjects->GetByIndex(i);
                        if (!o || o->IsDefaultObject()) { continue; }
                        if (o->IsA(AArchonGameMode::StaticClass())) { s_gm = reinterpret_cast<AArchonGameMode*>(o); break; }
                    }
                }
                gmOk = s_gm && IsReadablePointer(s_gm, 0x4A0);
            }

            if (gmOk) {
                int32_t idx = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(s_gm) + 0x02C0);
                if (idx != s_lastMatchIdx) {
                    std::string ms = reinterpret_cast<SDK::FName*>(reinterpret_cast<uintptr_t>(s_gm) + 0x02C0)->ToString();
                    MpLog("[MatchStateChange] tick=" + std::to_string(tickCounter) + " -> " + ms
                        + " (idx " + std::to_string(s_lastMatchIdx) + "->" + std::to_string(idx) + ")");
                    LogArchonLifecycle(("MatchState=" + ms).c_str());
                    s_lastMatchIdx = idx;
                }
            }
        }

        
        bool traceNetTick = VerboseDiag() && netTickTraceBudget > 0;   
        if (traceNetTick && netTickTraceBudget > 0) {
            --netTickTraceBudget;
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickNetworking NetDriver=" + MpPtr(Networking::NetDriver)
                + " connCount=" + std::to_string(preConnectionCount)
                + " connMax=" + std::to_string(preConnectionMax)
                + " GIsServer=" + std::to_string(*(uint8_t*)(Globals::BaseAddress + 0x06B5325A))
                + " GIsClient=" + std::to_string(*(uint8_t*)(Globals::BaseAddress + 0x06B53259)));
        }

        Networking::TickNetworking();

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter) + " after TickNetworking");
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickDispatch fn=" + MpAddress(reinterpret_cast<void*>(Globals::BaseAddress + 0x00A6F220)));
        }

        
        
        static uint64_t s_manualTickFrame = 0;
        const bool SkipManualDriveThisFrame = ManualTickHalfRate() && ((++s_manualTickFrame & 1ull) != 0ull);

        bool tickDispatchOk = true;
        if (SkipManualDriveThisFrame) {
            tickDispatchOk = false;   
        }
        else if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickDispatch")) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " skipped TickDispatch after sanitizing unsafe NetDriver state");
            tickDispatchOk = false;
        }
        
        
        else if (!SafeManualTickDispatch(Networking::NetDriver,
                     ManualTickZeroDeltaTime() ? 0.0f : DeltaTime)) {
            ReportManualNetTickFailure(false, tickCounter);
            tickDispatchOk = false;
        }
        else {
            ReportManualNetTickRecovery(false, tickCounter);
        }

        if (traceNetTick) {
            int32_t postConnectionCount = -1;
            if (Networking::NetDriver &&
                IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98), sizeof(int32_t))) {
                postConnectionCount = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x98);
            }

            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " after TickDispatch ok=" + std::to_string(tickDispatchOk ? 1 : 0)
                + " connCount=" + std::to_string(postConnectionCount));
        }

        
        
        
        
        
        
        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " before TickFlush fn=" + MpAddress(reinterpret_cast<void*>(Globals::BaseAddress + 0x03D91DC0)));
        }

        bool tickFlushOk = true;
        if (SkipManualDriveThisFrame) {
            tickFlushOk = false;
        }
        else if (!SanitizeNetDriverClientConnections(Networking::NetDriver, "GameEngineTickBeforeTickFlush")) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " skipped TickFlush after sanitizing unsafe NetDriver state");
            tickFlushOk = false;
        }
        else if (!SafeManualTickFlush(Networking::NetDriver, DeltaTime)) {
            ReportManualNetTickFailure(true, tickCounter);
            tickFlushOk = false;
        }
        else {
            ReportManualNetTickRecovery(true, tickCounter);
        }

        if (traceNetTick) {
            MpLog("[NetTickTrace] tick=" + std::to_string(tickCounter)
                + " after TickFlush ok=" + std::to_string(tickFlushOk ? 1 : 0));
        }

        static bool netDiagLogged = false;
        if (!netDiagLogged) {
            netDiagLogged = true;
            MpLog(std::string("[NetDiag] GIsServer=") + std::to_string(*(uint8_t*)(Globals::BaseAddress + 0x06B5325A))
                + " GIsClient=" + std::to_string(*(uint8_t*)(Globals::BaseAddress + 0x06B53259)));
        }
    }

    if (Globals::DoListen) {
        Globals::DoListen = false;

        MpLog("[GameEngineTick] calling Networking::Listen(port=" + std::to_string(Globals::Port) + ")");
        Networking::Listen(UEngine::GetEngine(), Globals::Port);
        MpLog("[GameEngineTick] Networking::Listen returned OK");

        Globals::Listening = true;
        MpLog("[GameEngineTick] Listening armed; skipping post-listen watchdog this tick");
        
        
        
        StartEmptyWatchdogThread();
        return;
    }

    if (Globals::Listening && Networking::NetDriver) {
        bool HasConnection = false;

        auto ClientConnectionData = *reinterpret_cast<UNetConnection***>((uintptr_t)Networking::NetDriver + 0x90);
        int32_t ClientConnectionCount = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x98);
        int32_t ClientConnectionMax = *reinterpret_cast<int32_t*>((uintptr_t)Networking::NetDriver + 0x9C);

        if (!IsSanePointerArray(ClientConnectionData, ClientConnectionCount, ClientConnectionMax, 1024)) {
            MpLog("[GameEngineTick] Invalid ClientConnections array; skipping watchdog/stamina");
        }
        else {
            for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
                UNetConnection* Connection = ClientConnectionData[Index];
                if (!IsReadablePointer(Connection, 0x140)) {
                    continue;
                }

                if (!Connection->OwningActor || *(uint32_t*)((uintptr_t)Connection + 0x134) != 3)
                    continue;

                HasConnection = true;
            }

            if (EnableWatchdog) {
                
                
                
                
                
                int EmptyState = GameModeEmptyState();               
                bool IsEmpty = (EmptyState == 1) || (EmptyState == -1 && !HasConnection);

                if (IsEmpty) {
                    TotalNoPlayersTime += DeltaTime;

                    
                    
                    
                    
                    
                    if (TotalNoPlayersTime >= 50.0f && g_wdIsHub.load(std::memory_order_relaxed) == 0) {
                        
                        
                        
                        
                        MpReapExit(("tick-path: disposable instance empty 50s continuous (gmState="
                            + std::to_string(EmptyState) + ")").c_str());
                    }
                }
                else {
                    
                    
                    
                    TotalNoPlayersTime = 0.0f;
                }
            }

            for (int32_t Index = 0; Index < ClientConnectionCount; ++Index) {
                UNetConnection* Conn = ClientConnectionData[Index];
                if (!IsReadablePointer(Conn, 0x140)) {
                    continue;
                }

                if (Conn->PlayerController && Conn->PlayerController->Pawn && Conn->PlayerController->Pawn->IsA(ABP_PlayerCharacter_C::StaticClass())) {
                    ((ABP_PlayerCharacter_C*)Conn->PlayerController->Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All);
                    
                    
                    
                    
                    if (PlayerRepBoost()) {
                        AActor* pawn = Conn->PlayerController->Pawn;
                        if (IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(pawn) + 0x110), 4)) {
                            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(pawn) + 0x108) = 60.0f; 
                            *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(pawn) + 0x10C) = 30.0f; 
                        }
                    }
                }
            }
        }
    }
}

void InteractionCalloutHideHoldTextHook(void* Widget) {
    if (!IsReadablePointer(Widget, 0x3C8)) {
        MpLog("[InteractionCalloutHideHoldText] skipping unreadable widget=" + MpPtr(Widget));
        return;
    }

    void* HoldTextController = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Widget) + 0x3C0);
    if (!IsReadablePointer(HoldTextController, sizeof(void*))) {
        MpLog("[InteractionCalloutHideHoldText] skipping null/unreadable widget+0x3C0 widget="
            + MpPtr(Widget)
            + " member=" + MpPtr(HoldTextController));
        return;
    }

    reinterpret_cast<void(*)(void*)>(OrigInteractionCalloutHideHoldText)(Widget);
}















void ArchonLoadingScreenFadeInHook(void* LoadingScreen, uint8_t FadeMode) {
    void* PrimaryFadeWidget = nullptr;
    void* SecondaryFadeWidget = nullptr;

    if (IsReadablePointer(LoadingScreen, 0x3F0)) {
        PrimaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E8);
        SecondaryFadeWidget = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadingScreen) + 0x3E0);
    }

    
    
    const bool WidgetsValid =
        LoadingScreen != nullptr &&
        PrimaryFadeWidget != nullptr &&
        SecondaryFadeWidget != nullptr &&
        IsReadablePointer(PrimaryFadeWidget, sizeof(void*)) &&
        IsReadablePointer(SecondaryFadeWidget, sizeof(void*));

    if (!WidgetsValid) {
        MpLog("[ArchonLoadingScreenFadeIn] suppressed (null-widget guard) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode));
        return;
    }

    
    static bool s_loggedMode[256] = {};
    if (!s_loggedMode[FadeMode]) {
        s_loggedMode[FadeMode] = true;
        MpLog("[ArchonLoadingScreenFadeIn] pass-through (widgets valid) loadingScreen="
            + MpPtr(LoadingScreen)
            + " primary(+0x3E8)=" + MpPtr(PrimaryFadeWidget)
            + " secondary(+0x3E0)=" + MpPtr(SecondaryFadeWidget)
            + " mode=" + std::to_string(FadeMode)
            + " -> calling original");
    }

    reinterpret_cast<void(*)(void*, uint8_t)>(OrigArchonLoadingScreenFadeIn)(LoadingScreen, FadeMode);
}

struct RawPointerArray { void** Data; int32_t Num; int32_t Max; };

static bool SanitizeNetDriverClientConnections(void* NetDriver, const char* Tag) {
    if (!NetDriver || !IsReadablePointer(NetDriver, 0xA0)) {
        MpLog(std::string("[") + Tag + "] invalid NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    RawPointerArray* ClientConnections = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0x90);

    if (!IsReadablePointer(ClientConnections, sizeof(RawPointerArray))) {
        MpLog(std::string("[") + Tag + "] unreadable ClientConnections metadata NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    if (!IsSanePointerArray(ClientConnections->Data, ClientConnections->Num, ClientConnections->Max, 1024)) {
        MpLog(std::string("[") + Tag + "] resetting invalid ClientConnections"
            + " data=" + MpPtr(ClientConnections->Data)
            + " num=" + std::to_string(ClientConnections->Num)
            + " max=" + std::to_string(ClientConnections->Max));
        ClientConnections->Data = nullptr;
        ClientConnections->Num = 0;
        ClientConnections->Max = 0;
        return false;
    }

    int32_t WriteIndex = 0;
    for (int32_t ReadIndex = 0; ReadIndex < ClientConnections->Num; ++ReadIndex) {
        void* Connection = ClientConnections->Data[ReadIndex];
        if (!IsReadablePointer(Connection, 0x138)) {
            MpLog(std::string("[") + Tag + "] dropping invalid connection"
                + " index=" + std::to_string(ReadIndex)
                + " ptr=" + MpPtr(Connection));
            continue;
        }

        ClientConnections->Data[WriteIndex++] = Connection;
    }

    for (int32_t Index = WriteIndex; Index < ClientConnections->Num; ++Index) {
        ClientConnections->Data[Index] = nullptr;
    }

    if (WriteIndex != ClientConnections->Num) {
        MpLog(std::string("[") + Tag + "] compacted ClientConnections"
            + " oldNum=" + std::to_string(ClientConnections->Num)
            + " newNum=" + std::to_string(WriteIndex));
        ClientConnections->Num = WriteIndex;
        return false;
    }

    RawPointerArray* PendingCleanup = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0xF0);

    if (!IsReadablePointer(PendingCleanup, sizeof(RawPointerArray))) {
        MpLog(std::string("[") + Tag + "] unreadable NetDriver+0xF0 cleanup metadata NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    if (PendingCleanup->Num < 0 || PendingCleanup->Max < 0 ||
        PendingCleanup->Num > PendingCleanup->Max || PendingCleanup->Num > 1024 ||
        (PendingCleanup->Num > 0 && !IsReadablePointer(PendingCleanup->Data, static_cast<size_t>(PendingCleanup->Num) * 0x18))) {
        MpLog(std::string("[") + Tag + "] resetting invalid cleanup array"
            + " data=" + MpPtr(PendingCleanup->Data)
            + " num=" + std::to_string(PendingCleanup->Num)
            + " max=" + std::to_string(PendingCleanup->Max));
        PendingCleanup->Data = nullptr;
        PendingCleanup->Num = 0;
        PendingCleanup->Max = 0;
        return false;
    }

    return true;
}

void* OrigNetDriverTickDispatchInner = nullptr;

void NetDriverTickDispatchInnerHook(void* NetDriver, float DeltaTime) {
    if (!SanitizeNetDriverClientConnections(NetDriver, "NetDriverTickDispatchInner")) {
        MpLog("[NetDriverTickDispatchInner] skipped original after sanitizing unsafe connection state");
        return;
    }

    reinterpret_cast<void(*)(void*, float)>(OrigNetDriverTickDispatchInner)(NetDriver, DeltaTime);
}

void* OrigFixupNetworkNotify = nullptr;

void* FixupNetworkNotifyHook(void* a1) {
    if(UWorld::GetWorld())
        *(void**)((uintptr_t)a1 + 0x208) = (void*)((uintptr_t)UWorld::GetWorld() + 0x28); 

    return reinterpret_cast<void* (*)(void*)>(OrigFixupNetworkNotify)(a1);
}

void* OrigNotifyClientDisconnected = nullptr;

void NotifyClientDisconnectedHook(void* NetDriver, void* Connection) {
    MpLog("[NotifyClientDisconnected] hook entry");

    if (!NetDriver || !IsReadablePointer(NetDriver, 0x240)) {
        MpLog("[NotifyClientDisconnected] invalid NetDriver pointer");
        return;
    }

    if (Connection && !IsReadablePointer(Connection, 0x140)) {
        MpLog("[NotifyClientDisconnected] skipping invalid connection pointer");
        return;
    }

    
    
    
    
    
    
    
    RawPointerArray* DisconnectedClients = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0x238);

    if (!IsSanePointerArray(DisconnectedClients->Data, DisconnectedClients->Num, DisconnectedClients->Max, 1024)) {
        MpLog("[NotifyClientDisconnected] invalid NetDriver+0x238 array; skipping original");
        return;
    }

    for (int32_t Index = 0; Index < DisconnectedClients->Num; ++Index) {
        if (DisconnectedClients->Data[Index] != Connection) {
            continue;
        }

        const int32_t LastIndex = DisconnectedClients->Num - 1;
        if (Index != LastIndex) {
            DisconnectedClients->Data[Index] = DisconnectedClients->Data[LastIndex];
        }
        DisconnectedClients->Data[LastIndex] = nullptr;
        DisconnectedClients->Num = LastIndex;
        MpLog("[NotifyClientDisconnected] removed connection from NetDriver+0x238");
        return;
    }

    MpLog("[NotifyClientDisconnected] connection not present in NetDriver+0x238");
}



















void* OrigNetConnectionClose = nullptr;
void NetConnectionCloseHook(void* Connection) {
    if (!Connection || !IsReadablePointer(Connection, 0x1320)) {
        MpLog("[NetConnectionClose] invalid connection=" + MpPtr(Connection));
        reinterpret_cast<void(*)(void*)>(OrigNetConnectionClose)(Connection);
        return;
    }

    
    
    void* OwningObj = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Connection) + 0x1318);
    std::string OwningClassName = "(null)";
    std::string OwningName = "(null)";
    if (OwningObj && IsReadablePointer(OwningObj, 0x20)) {
        void* Cls = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(OwningObj) + 0x10);
        if (Cls && IsReadablePointer(Cls, 0x20)) {
            OwningClassName = reinterpret_cast<UObject*>(Cls)->GetName();
            OwningName = reinterpret_cast<UObject*>(OwningObj)->GetName();
        }
    }

    static std::atomic<int> s_ncCloseSeq{ 0 };
    int Seq = s_ncCloseSeq.fetch_add(1, std::memory_order_relaxed);

    MpLog("[NetConnectionClose #" + std::to_string(Seq) + "] ENTER conn=" + MpPtr(Connection)
        + " owningObj=" + MpPtr(OwningObj) + "/" + OwningClassName + "/" + OwningName);

    reinterpret_cast<void(*)(void*)>(OrigNetConnectionClose)(Connection);

    MpLog("[NetConnectionClose #" + std::to_string(Seq) + "] EXIT conn=" + MpPtr(Connection));
}

void* OrigProcessRequest = nullptr;

char ProcessRequest(void* Request) {
    FString APIHeader(L"x-mysticparadox-gameserver-apikey");
    FString APIKey(Globals::ServerAPIKey);

    
    {
        using SetHeaderFn = void(*)(void*, FString*, FString*);
        void* setHeader = (*reinterpret_cast<void***>(Request))[16];
        reinterpret_cast<SetHeaderFn>(setHeader)(Request, &APIHeader, &APIKey);
    }

    return reinterpret_cast<char(*)(void*)>(OrigProcessRequest)(Request);
}


























static const wchar_t* kMpApiBase = L"https://" MP_PUBLIC_HOST;

void* OrigSetURL = nullptr;



static bool MpIsRedirectHost(const std::wstring& Host) {
    static const wchar_t* kApexHosts[] = {
        L"steelyard.ca",        
        L"steelyard.online",    
        L"ol.epicgames.com",    
        L"api.epicgames.dev",   
    };
    for (const wchar_t* Apex : kApexHosts) {
        const size_t Alen = wcslen(Apex);
        if (Host.size() < Alen) continue;
        if (Host.size() == Alen) {
            if (_wcsicmp(Host.c_str(), Apex) == 0) return true;
            continue;
        }
        
        if (Host[Host.size() - Alen - 1] != L'.') continue;
        if (_wcsicmp(Host.c_str() + (Host.size() - Alen), Apex) == 0) return true;
    }
    return false;
}



static bool MpSplitUrl(const std::wstring& Url, std::wstring& OutHost, std::wstring& OutTail) {
    const size_t SchemeEnd = Url.find(L"://");
    if (SchemeEnd == std::wstring::npos) return false;
    const std::wstring Scheme = Url.substr(0, SchemeEnd);
    if (_wcsicmp(Scheme.c_str(), L"http") != 0 && _wcsicmp(Scheme.c_str(), L"https") != 0) return false;

    const size_t AuthStart = SchemeEnd + 3;
    
    
    const size_t AuthEnd = Url.find_first_of(L"/?#", AuthStart);
    std::wstring Authority = (AuthEnd == std::wstring::npos)
        ? Url.substr(AuthStart) : Url.substr(AuthStart, AuthEnd - AuthStart);
    
    
    if (AuthEnd == std::wstring::npos)  OutTail = L"/";
    else if (Url[AuthEnd] == L'/')      OutTail = Url.substr(AuthEnd);
    else                                OutTail = L"/" + Url.substr(AuthEnd);

    const size_t At = Authority.find(L'@');
    if (At != std::wstring::npos) Authority = Authority.substr(At + 1);
    const size_t Colon = Authority.find(L':');
    if (Colon != std::wstring::npos) Authority = Authority.substr(0, Colon);

    OutHost = Authority;
    return !OutHost.empty();
}

static std::wstring MpBuildRedirectUrl(const std::wstring& Host, const std::wstring& Tail) {
    
    std::wstring Out = kMpApiBase;
    Out += L"/__origin/";
    Out += Host;
    Out += Tail;
    return Out;
}





static bool MpUrlRewriteEnabled() {
    static int Logged = 0;
    if (!Logged) {
        Logged = 1;
        MpLog("[UrlRedirect] rewrite ENABLED (permanent; allowlisted hosts -> paradox.example.com)");
    }
    return true;
}



static bool MpUrlLogEnabled() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = (GetFileAttributesW(L".\\debug\\URL_LOG.flag") != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
    }
    return Cached == 1;
}






static constexpr int kUrlObsMax = 512;
static volatile LONG g_UrlObsSpin = 0;      
static uint64_t g_UrlObsSeen[kUrlObsMax];   
static int g_UrlObsCount = 0;               

static uint64_t MpUrlKeyHash(const std::wstring& Host, const std::wstring& Path) {
    uint64_t H = 1469598103934665603ULL; 
    auto Mix = [&H](const std::wstring& S) {
        for (wchar_t C : S) { H ^= static_cast<uint16_t>(C); H *= 1099511628211ULL; }
        H ^= static_cast<uint8_t>('|'); H *= 1099511628211ULL;
    };
    Mix(Host); Mix(Path);
    return H;
}





static void MpLogUrlObservation(const std::wstring& Host, const std::wstring& Tail, bool WillRewrite) {
    auto Narrow = [](const std::wstring& W) {
        std::string S; S.reserve(W.size());
        for (wchar_t C : W) S += (C >= 0x20 && C < 0x7f) ? static_cast<char>(C) : '?';
        return S;
    };
    std::wstring Path = Tail;
    const size_t Q = Path.find(L'?');
    const bool HadQuery = (Q != std::wstring::npos);
    if (HadQuery) Path.resize(Q);

    const uint64_t Key = MpUrlKeyHash(Host, Path);
    bool LogLine = false;
    bool LogBudgetNotice = false;

    while (InterlockedCompareExchange(&g_UrlObsSpin, 1, 0) != 0) { YieldProcessor(); }
    if (g_UrlObsCount < kUrlObsMax) {
        bool Seen = false;
        for (int i = 0; i < g_UrlObsCount; ++i) { if (g_UrlObsSeen[i] == Key) { Seen = true; break; } }
        if (!Seen) {
            g_UrlObsSeen[g_UrlObsCount++] = Key;
            LogLine = true;
            if (g_UrlObsCount == kUrlObsMax) LogBudgetNotice = true;
        }
    }
    InterlockedExchange(&g_UrlObsSpin, 0);

    if (LogLine) {
        MpLog(std::string("[UrlRedirect] host=") + Narrow(Host) + " path=" + Narrow(Path)
            + (HadQuery ? " ?<redacted>" : "") + (WillRewrite ? "  => REWRITE" : "  (observe)"));
    }
    if (LogBudgetNotice) {
        MpLog("[UrlRedirect] observation budget reached (512 distinct host+path); further observations suppressed");
    }
}




void SetURLHook(void* Request, FString* Url) {
    if (Url != nullptr) {
        std::wstring Incoming = Url->ToWString(); 
        if (!Incoming.empty()) {
            std::wstring Host, Tail;
            if (MpSplitUrl(Incoming, Host, Tail) && MpIsRedirectHost(Host)) {
                const bool Rewrite = MpUrlRewriteEnabled();
                if (MpUrlLogEnabled()) MpLogUrlObservation(Host, Tail, Rewrite);
                if (Rewrite) {
                    std::wstring NewUrl = MpBuildRedirectUrl(Host, Tail);
                    FString Replacement(NewUrl.c_str()); 
                    reinterpret_cast<void(*)(void*, FString*)>(OrigSetURL)(Request, &Replacement);
                    return;
                }
            }
        }
    }
    reinterpret_cast<void(*)(void*, FString*)>(OrigSetURL)(Request, Url);
}


static void InstallSetUrlRedirectHook(const char* Mode) {
    MH_STATUS Create = MH_CreateHook((void*)(Globals::BaseAddress + 0x03102740), SetURLHook, &OrigSetURL);
    MH_STATUS Enable = (Create == MH_OK) ? MH_EnableHook((void*)(Globals::BaseAddress + 0x03102740)) : Create;
    MpLog(std::string("[UrlRedirect] (") + Mode + ") SetURL hook create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(0x03102740));
}
























static const wchar_t* kMpXmppWsUrl = L"wss://" MP_PUBLIC_HOST;

static bool MpXmppTraceEnabled() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = (GetFileAttributesW(L".\\debug\\XMPP_TRACE.flag") != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
    }
    return Cached == 1;
}





static bool MpXmppRedirectEnabled() {
    return true;
}


static bool MpWContainsCI(const std::wstring& Haystack, const wchar_t* Needle) {
    const size_t NLen = wcslen(Needle);
    if (NLen == 0) return true;
    if (Haystack.size() < NLen) return false;
    for (size_t i = 0; i + NLen <= Haystack.size(); ++i) {
        if (_wcsnicmp(Haystack.c_str() + i, Needle, NLen) == 0) return true;
    }
    return false;
}




static bool MpIsXmppServerAddr(const std::wstring& Section, const std::wstring& Key) {
    const bool KeyIsServerAddr =
        (_wcsicmp(Key.c_str(), L"ServerAddr") == 0) || MpWContainsCI(Key, L"serveraddr");
    if (!KeyIsServerAddr) return false;
    return MpWContainsCI(Section, L"xmpp") || MpWContainsCI(Key, L"xmpp");
}




static bool MpIsXmppInterestingConfig(const std::wstring& Section, const std::wstring& Key) {
    static const wchar_t* kNeedles[] = {
        L"xmpp", L"messaging", L"serveraddr", L"onlinesubsystem", L"mcp",
        L"presence", L"jabber", L"notification", L"stomp", L"epicgames", L"steelyard",
    };
    for (const wchar_t* N : kNeedles) {
        if (MpWContainsCI(Section, N) || MpWContainsCI(Key, N)) return true;
    }
    return false;
}



static constexpr int kXmppObsMax = 512;
static volatile LONG g_XmppObsSpin = 0;      
static uint64_t g_XmppObsSeen[kXmppObsMax];  
static int g_XmppObsCount = 0;

static void MpLogXmppConfigObservation(const std::wstring& Section, const std::wstring& Key, bool Found, bool WillRewrite) {
    uint64_t H = 1469598103934665603ULL; 
    auto AsciiFold = [](wchar_t c) -> uint16_t { return (c >= L'A' && c <= L'Z') ? static_cast<uint16_t>(c + 32) : static_cast<uint16_t>(c); };
    auto Mix = [&H, &AsciiFold](const std::wstring& S) {
        for (wchar_t C : S) { H ^= AsciiFold(C); H *= 1099511628211ULL; }
        H ^= static_cast<uint8_t>('|'); H *= 1099511628211ULL;
    };
    Mix(Section); Mix(Key);

    bool LogLine = false;
    while (InterlockedCompareExchange(&g_XmppObsSpin, 1, 0) != 0) { YieldProcessor(); }
    if (g_XmppObsCount < kXmppObsMax) {
        bool Seen = false;
        for (int i = 0; i < g_XmppObsCount; ++i) { if (g_XmppObsSeen[i] == H) { Seen = true; break; } }
        if (!Seen) { g_XmppObsSeen[g_XmppObsCount++] = H; LogLine = true; }
    }
    InterlockedExchange(&g_XmppObsSpin, 0);

    if (LogLine) {
        MpLog(std::string("[XmppConfig] section=") + MpNarrow(Section) + " key=" + MpNarrow(Key)
            + " found=" + (Found ? "1" : "0") + (WillRewrite ? "  => REWRITE ServerAddr" : ""));
    }
}

void* OrigGetConfigString = nullptr;


bool GetConfigStringHook(void* This, const wchar_t* Section, const wchar_t* Key, void* Value, const void* Filename) {
    using GetStringFn = bool(*)(void*, const wchar_t*, const wchar_t*, void*, const void*);
    const bool Found = reinterpret_cast<GetStringFn>(OrigGetConfigString)(This, Section, Key, Value, Filename);

    
    const bool Trace = MpXmppTraceEnabled();
    const bool Redirect = MpXmppRedirectEnabled();
    if (!Trace && !Redirect) return Found;

    
    std::wstring Sec = (Section && IsReadablePointer((void*)Section, sizeof(wchar_t))) ? std::wstring(Section) : std::wstring();
    std::wstring K   = (Key && IsReadablePointer((void*)Key, sizeof(wchar_t))) ? std::wstring(Key) : std::wstring();

    const bool IsServerAddr = MpIsXmppServerAddr(Sec, K);

    if (Trace && (IsServerAddr || MpIsXmppInterestingConfig(Sec, K))) {
        MpLogXmppConfigObservation(Sec, K, Found, Redirect && IsServerAddr);
    }

    if (Redirect && IsServerAddr && Value != nullptr) {
        
        
        
        struct RawFString { wchar_t* Data; int Num; int Max; };
        RawFString* Raw = reinterpret_cast<RawFString*>(Value);
        const std::wstring New = kMpXmppWsUrl;
        const int Count = static_cast<int>(New.size()) + 1; 

        if (Raw->Max < Count || Raw->Data == nullptr) {
            Raw->Data = static_cast<wchar_t*>(EngineRealloc(Raw->Data, static_cast<size_t>(Count) * sizeof(wchar_t)));
        }
        if (Raw->Data != nullptr) {
            wmemcpy(Raw->Data, New.c_str(), static_cast<size_t>(Count));
            Raw->Num = Count;
            if (Raw->Max < Count) Raw->Max = Count;

            static int LoggedOnce = 0;
            if (!LoggedOnce) { LoggedOnce = 1; MpLog(std::string("[XmppConfig] ServerAddr -> ") + MpNarrow(New)); }
            return true; 
        }
        
    }

    return Found;
}


static void InstallXmppConfigRedirectHook(const char* Mode) {
    MH_STATUS Create = MH_CreateHook((void*)(Globals::BaseAddress + 0x0243CAD0), GetConfigStringHook, &OrigGetConfigString);
    MH_STATUS Enable = (Create == MH_OK) ? MH_EnableHook((void*)(Globals::BaseAddress + 0x0243CAD0)) : Create;
    MpLog(std::string("[XmppConfig] (") + Mode + ") GetString hook create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(0x0243CAD0)
        + " trace=" + (MpXmppTraceEnabled() ? "on" : "off") + " redirect=" + (MpXmppRedirectEnabled() ? "on" : "off"));
}

enum EFunctionCallspace : uint32_t
{
    
    Absorbed = 0x0,
    
    Remote = 0x1,
    
    Local = 0x2
};




void* OrigPostLogin = nullptr;






void PostLoginHook(void* a1, AArchonPlayerController* a2) {
    reinterpret_cast<void(*)(void*, void*)>(OrigPostLogin)(a1, a2);
}

void* OrigHasFinishedLoading = nullptr;





static bool DiagNaturalMode() {
    static int cached = -1;
    if (cached < 0) {
        cached = (GetFileAttributesW(L".\\debug\\DIAG_NATURAL.flag") != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
        MpLog(std::string("[Diag] natural-mode ") + (cached ? "ON (gameplay bypasses DISABLED)" : "off (bypasses active)"));
    }
    return cached == 1;
}









static bool UseArchonRepGraph() {
    
    
    static bool s_loggedRepGraph = false;
    if (!s_loggedRepGraph) {
        s_loggedRepGraph = true;
        MpLog("[Phase0f] ReplicationGraph = ArchonReplicationGraph (game's own) [permanent]");
    }
    return true;
}

bool HasFinishedLoadingHook(UObject* a1) {
    bool Ret = reinterpret_cast<bool(*)(UObject*)>(OrigHasFinishedLoading)(a1);

    if (!Ret) {
        if (DiagNaturalMode()) {
            
            static std::atomic<int> s_hfl{ 0 };
            if (s_hfl.fetch_add(1, std::memory_order_relaxed) < 20)
                MpLog(std::string("[Diag] HasFinishedLoading NOT forced (natural mode) -> false obj=") + a1->GetFullName());
            return false;
        }
        
        
        
        
        
        
        
        
        
        {
            UObject* cls = a1 ? *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(a1) + 0x10) : nullptr;
            std::string cn = (cls && IsReadablePointer(cls, 0x20)) ? cls->GetName() : std::string();
            if (cn == "bp_archon_inventory_C" || cn.find("ArchonInventory") != std::string::npos) {
                static std::atomic<int> s_invReal{ 0 };
                if (s_invReal.fetch_add(1, std::memory_order_relaxed) < 10)
                    MpLog(std::string("[ScopedBypass] inventory NOT forced (real result -> loadout stays pending) obj=") + a1->GetFullName());
                return false;
            }
        }
        if (Globals::EnableLogging)
        std::cout << "[FORCEREADY] " << a1->GetFullName() << std::endl;
        return true;
    }

    return Ret;
}

bool IsNetReadyHook() {
    return true;
}

int NetModeHook(void* a1) {
    return 1;
}

bool IsLevelInitForActorHook(void* a1, char a2) {
    bool real = reinterpret_cast<bool (*)(void*, char)>(OrigIsLevelInitForActor)(a1, a2);

    
    
    
    
    
    
    
    
    
    
    
    static bool s_loggedLevelInit = false;
    if (!s_loggedLevelInit) {
        s_loggedLevelInit = true;
        MpLog("[Phase0P] IsLevelInitForActor force DISABLED (respect real visibility) [permanent]");
    }
    return real;
}

void* OrigSetReplicationDriver = nullptr;









void* OrigServerReplicateActors = nullptr;










static bool UseNativeGraph() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"EMERGENCY_LEGACY_REPLICATION.flag") ? 0 : 1;
    return c == 1;
}
static bool RepGraphDiag() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"REPGRAPH_DIAG.flag") ? 1 : 0;
    return c == 1;
}
static bool DriveArchonGraph() {
    return UseNativeGraph();
}










static bool PlayerRepBoost() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"DISABLE_PLAYER_REP_BOOST.flag") ? 0 : 1;
    return c == 1;
}











static bool PlayerAlwaysRelevant() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"PLAYER_ALWAYS_RELEVANT.flag") ? 1 : 0;
    return c == 1;
}














static bool OwnerPawnRelevancyFix() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"DISABLE_OWNER_PAWN_RELEVANCY.flag") ? 0 : 1;
    return c == 1;
}


static int SafeCallGraphServerReplicate(void* graph, float dt) {
    __try {
        return reinterpret_cast<int(__fastcall*)(void*, float)>(Globals::BaseAddress + 0x01AB43D0)(graph, dt);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -999;
    }
}





void* OrigReplicateActorFreq = nullptr;
bool __fastcall ReplicateActorFreqHook(UActorChannel* channel) {
    if (channel && IsReadablePointer(reinterpret_cast<void*>(channel), 0x78)) {
        void* actor = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(channel) + 0x70);
        if (actor && IsReadablePointer(actor, 0x20)) {
            void* cls = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(actor) + 0x10);
            if (cls && IsReadablePointer(cls, 0x20)) {
                static std::vector<std::pair<std::string, int>> s_counts;
                static uint64_t s_ms = 0;
                std::string cn = reinterpret_cast<UObject*>(cls)->GetName();
                bool found = false;
                for (auto& kv : s_counts) { if (kv.first == cn) { kv.second++; found = true; break; } }
                if (!found && s_counts.size() < 64) s_counts.push_back(std::make_pair(cn, 1));
                uint64_t now = static_cast<uint64_t>(GetTickCount64());
                if (s_ms == 0) s_ms = now;
                if (now - s_ms > 1000) {
                    std::string line;
                    for (auto& kv : s_counts) { line += " " + kv.first + "=" + std::to_string(kv.second); }
                    MpLog("[RepFreq] window=" + std::to_string(now - s_ms) + "ms reps/class:" + line);
                    s_counts.clear();
                    s_ms = now;
                }
            }
        }
    }
    return reinterpret_cast<bool(__fastcall*)(UActorChannel*)>(OrigReplicateActorFreq)(channel);
}









static bool SraRateCap() {
    static int c = -1;
    if (c < 0) {
        c = MpExeRelativeFlagPresent(L"SRA_RATE_CAP.flag") ? 1 : 0;
        MpLog(std::string("[SraRateCap] SRA_RATE_CAP.flag ")
            + (c ? "PRESENT -> ServerReplicateActors coalesced to NetServerMaxTickRate (SRA ~= configured "
                   "net rate). TickDispatch/handshakes untouched -> server stays joinable. Watch [SRA enter]."
                 : "absent -> SRA runs every TickFlush (default; ~engine frame rate)."));
    }
    return c == 1;
}

int __fastcall ServerReplicateActorsHook(void* NetDriver, float DeltaSeconds) {
    static uint64_t s_lastMs = 0;
    uint64_t now = static_cast<uint64_t>(GetTickCount64());
    bool doLog = RepGraphDiag() && (now - s_lastMs) > 1000;

    void* graph = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                  ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
    auto readIntAt = [](void* base, uintptr_t off) -> int {
        return (base && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)base + off), 4))
               ? *reinterpret_cast<int*>((uintptr_t)base + off) : -1;
    };
    int ancBefore   = readIntAt(graph, 0x4C0);
    int connMgrs    = readIntAt(graph, 0x40);
    int clientConns = readIntAt(NetDriver, 0x98);

    
    
    
    
    
    if (SraRateCap()) {
        static uint64_t s_lastSraDispatchMs = 0;
        int maxRate = readIntAt(NetDriver, 0x58);   
        if (maxRate > 0) {
            double minIntervalMs = (1000.0 / static_cast<double>(maxRate)) * 0.9;
            if (s_lastSraDispatchMs != 0 && static_cast<double>(now - s_lastSraDispatchMs) < minIntervalMs) {
                return 0;   
            }
            s_lastSraDispatchMs = now;
        }
    }

    
    
    
    static int s_sraCalls = 0;
    s_sraCalls++;
    if (doLog) {
        uint64_t elapsed = now - s_lastMs;
        float sraHz = (elapsed > 0) ? (s_sraCalls * 1000.0f / static_cast<float>(elapsed)) : 0.0f;
        int nstr = readIntAt(NetDriver, 0x58);
        int mntr = readIntAt(NetDriver, 0x5C);
        s_lastMs = now;
        s_sraCalls = 0;
        MpLog("[SRA enter] NetDriver=" + MpPtr(NetDriver) + " RepDriver=" + MpPtr(graph)
            + " ActorsNoConn_before=" + std::to_string(ancBefore)
            + " ConnMgrs=" + std::to_string(connMgrs) + " ClientConns=" + std::to_string(clientConns)
            + " | SRA=" + std::to_string(sraHz) + "Hz NetServerMaxTickRate=" + std::to_string(nstr)
            + " MaxNetTickRate=" + std::to_string(mntr));
    }

    
    
    
    void* graphNetDriver = (graph && IsReadablePointer(graph, 0x38)) ? *reinterpret_cast<void**>((uintptr_t)graph + 0x30) : nullptr;
    static thread_local bool s_inGraphSRA = false;
    int ret;
    const char* mode;
    if (DriveArchonGraph() && graph && !s_inGraphSRA && graphNetDriver == NetDriver && IsReadablePointer(graph, 0x4C8)) {
        s_inGraphSRA = true;
        ret = SafeCallGraphServerReplicate(graph, DeltaSeconds);
        s_inGraphSRA = false;
        mode = "ArchonDirect";
    } else {
        ret = reinterpret_cast<int(__fastcall*)(void*, float)>(OrigServerReplicateActors)(NetDriver, DeltaSeconds);
        mode = DriveArchonGraph() ? "Original(guard-failed)" : "Original";
    }

    if (doLog) {
        int ancAfter = readIntAt(graph, 0x4C0);
        MpLog(std::string("[SRA exit ] mode=") + mode + " ret=" + std::to_string(ret)
            + " ActorsNoConn " + std::to_string(ancBefore) + " -> " + std::to_string(ancAfter)
            + " graph.NetDriver=" + MpPtr(graphNetDriver));
    }
    return ret;
}














static uint32_t* g_RepDriverEnableFlag = nullptr;         
static void*    g_ArchonRepGraphClass = nullptr;         
static bool     g_ArchonRepGraphSearched = false;

static void* FindArchonReplicationGraphClass() {
    if (g_ArchonRepGraphSearched) return g_ArchonRepGraphClass;
    g_ArchonRepGraphSearched = true;
    if (!SDK::UObject::GObjects) return nullptr;
    const int Count = SDK::UObject::GObjects->Num();

    
    
    
    
    
    void* archonClass = nullptr;
    void* basicClass = nullptr;
    void* concreteArchonSubclass = nullptr;
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj) continue;
        const std::string nm = Obj->GetName();
        if (nm == "ArchonReplicationGraph")           archonClass = Obj;
        else if (nm == "BasicReplicationGraph")       basicClass = Obj;
        
    }

    
    std::string report;
    report += "archonClass=" + MpPtr(archonClass);
    report += " basicClass=" + MpPtr(basicClass);
    report += " concreteArchonSubclass=" + MpPtr(concreteArchonSubclass);
    MpLog("[FindArchonRepGraph] candidates: " + report);

    
    
    
    void* chosen;
    if (UseArchonRepGraph() && archonClass) {
        chosen = archonClass;
    } else {
        chosen = concreteArchonSubclass ? concreteArchonSubclass
               : (basicClass ? basicClass
                              : archonClass);
    }
    if (chosen) {
        uintptr_t base = reinterpret_cast<uintptr_t>(chosen);
        
        
        std::string wideProbe;
        for (uintptr_t off = 0xA0; off <= 0x120; off += 4) {
            if (IsReadablePointer(reinterpret_cast<void*>(base + off), 4)) {
                uint32_t v = *reinterpret_cast<uint32_t*>(base + off);
                if (v != 0) {   
                    char b[32]; _snprintf_s(b, _TRUNCATE, "+0x%02llX=0x%08X", (long long)off, v);
                    if (!wideProbe.empty()) wideProbe += " ";
                    wideProbe += b;
                }
            }
        }
        SDK::UObject* co = reinterpret_cast<SDK::UObject*>(chosen);
        MpLog(std::string("[FindArchonRepGraph] chose ") + co->GetName()
            + " ptr=" + MpPtr(chosen)
            + " metaclass=" + (co->Class ? co->Class->GetName() : "(null)")
            + " nonzero-dwords: " + wideProbe);

        
        
        void* transientPkg = nullptr;
        uintptr_t transAddr = Globals::BaseAddress + 0x06B8BC00;
        if (IsReadablePointer(reinterpret_cast<void*>(transAddr), 8)) {
            transientPkg = *reinterpret_cast<void**>(transAddr);
        }
        std::string pkgName = "(null-package)";
        if (transientPkg && IsReadablePointer(transientPkg, 0x20)) {
            SDK::UObject* pkg = reinterpret_cast<SDK::UObject*>(transientPkg);
            pkgName = pkg->GetName();
        }
        MpLog(std::string("[FindArchonRepGraph] TransientPackage @ RVA_0x06B8BC00 = ")
            + MpPtr(transientPkg) + " (" + pkgName + ")");

        
        void* cdoPtr = nullptr;
        if (IsReadablePointer(reinterpret_cast<void*>(base + 0x118), 8)) {
            cdoPtr = *reinterpret_cast<void**>(base + 0x118);
        }
        std::string cdoName = "(null)";
        if (cdoPtr && IsReadablePointer(cdoPtr, 0x20)) {
            cdoName = reinterpret_cast<SDK::UObject*>(cdoPtr)->GetName();
        }
        MpLog(std::string("[FindArchonRepGraph] ClassDefaultObject(+0x118)=") + MpPtr(cdoPtr) + " (" + cdoName + ")");
    } else {
        MpLog("[FindArchonRepGraph] NOTHING found in GObjects (Count=" + std::to_string(Count) + ")");
    }
    g_ArchonRepGraphClass = chosen;
    return g_ArchonRepGraphClass;
}





static void*  g_ArchonRepGraphCDO = nullptr;
static bool   g_ArchonRepGraphCDOSearched = false;
static void* FindArchonReplicationGraphCDO() {
    if (g_ArchonRepGraphCDOSearched) return g_ArchonRepGraphCDO;
    g_ArchonRepGraphCDOSearched = true;
    if (!SDK::UObject::GObjects) return nullptr;
    const int Count = SDK::UObject::GObjects->Num();
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj) continue;
        if (Obj->GetName() == "Default__ArchonReplicationGraph") {
            g_ArchonRepGraphCDO = Obj;
            MpLog("[FindArchonRepGraphCDO] found at " + MpPtr(Obj)
                + "  class=" + (Obj->Class ? Obj->Class->GetName() : "(null)"));
            return g_ArchonRepGraphCDO;
        }
    }
    MpLog("[FindArchonRepGraphCDO] NOT FOUND in GObjects (Count=" + std::to_string(Count) + ")");
    return nullptr;
}

void* OrigCreateRepDriver = nullptr;



static void** g_RepGraphFeatureArrayData = nullptr;   
static int*   g_RepGraphFeatureArrayNum  = nullptr;   








static bool RepGraphSelfConstruct() {
    return UseNativeGraph();   
}

void* __fastcall CreateRepDriverHook(void* NetDriver, void* p2, void* p3) {
    static std::atomic<int> s_crdCount{0};
    int n = s_crdCount.fetch_add(1, std::memory_order_relaxed);

    
    
    if (g_RepDriverEnableFlag && IsReadablePointer(g_RepDriverEnableFlag, 4)) {
        uint32_t before = *g_RepDriverEnableFlag;
        *g_RepDriverEnableFlag = 1u;
        if (n < 3) MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] "
            "forced RepDriverEnable flag: before=" + std::to_string(before)
            + " after=1  addr=" + MpPtr(g_RepDriverEnableFlag));
    }

    
    if (n < 3 && g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4)) {
        int num = *g_RepGraphFeatureArrayNum;
        void* data0 = (g_RepGraphFeatureArrayData && IsReadablePointer(g_RepGraphFeatureArrayData, 8))
                       ? *g_RepGraphFeatureArrayData : nullptr;
        std::string helperClass = "(null)";
        void* firstHelper = nullptr;
        if (data0 && num > 0 && IsReadablePointer(data0, 8)) {
            firstHelper = *reinterpret_cast<void**>(data0);
            if (firstHelper && IsReadablePointer(firstHelper, 0x20)) {
                UObject* cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(firstHelper) + 0x10);
                if (cls && IsReadablePointer(cls, 0x20)) helperClass = cls->GetName();
            }
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] "
            "RepGraphFeature array: count=" + std::to_string(num)
            + " data[0]=" + MpPtr(firstHelper) + " (" + helperClass + ")");
    }

    void*  beforeCls = nullptr;
    void*  afterCls  = nullptr;
    if (NetDriver && IsReadablePointer(NetDriver, 0x200)) {
        void** classField = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(NetDriver) + 0x178);
        beforeCls = *classField;
        if (!beforeCls) {
            void* cls = FindArchonReplicationGraphClass();
            if (cls) {
                *classField = cls;
                afterCls = cls;
            }
        } else {
            afterCls = beforeCls;
        }
    }

    if (n < 6) {
        std::string clsName = "(null)";
        if (afterCls && IsReadablePointer(afterCls, 0x20)) {
            clsName = reinterpret_cast<UObject*>(afterCls)->GetName();
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] NetDriver=" + MpPtr(NetDriver)
            + " NetDriver+0x178 before=" + MpPtr(beforeCls) + " after=" + MpPtr(afterCls)
            + " (" + clsName + ")");
    }

    
    
    int savedCount = 0;
    bool didSuppress = false;
    if (g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4)) {
        savedCount = *g_RepGraphFeatureArrayNum;
        if (savedCount > 0) {
            *g_RepGraphFeatureArrayNum = 0;
            didSuppress = true;
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    if (n < 3 && afterCls && IsReadablePointer(afterCls, 0x130)) {
        std::stringstream ss;
        for (uintptr_t off = 0x40; off <= 0x120; off += 4) {
            uint32_t v = *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + off);
            ss << "+0x" << std::hex << off << "=0x" << v << " ";
        }
        
        
        void* cdo = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(afterCls) + 0x118);
        std::string cdoName = "(null)";
        if (cdo && IsReadablePointer(cdo, 0x20)) cdoName = reinterpret_cast<UObject*>(cdo)->GetName();
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] classConstructScan afterCls=" + MpPtr(afterCls)
            + " CDO(+0x118)=" + MpPtr(cdo) + " (" + cdoName + ")  " + ss.str());
    }

    uint32_t savedClassFlags = 0;
    bool didClearAbstract = false;
    if (afterCls && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC), 4)) {
        uint32_t* flagsPtr = reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC);
        savedClassFlags = *flagsPtr;
        if (savedClassFlags & 0x00000001u) {                    
            *flagsPtr = savedClassFlags & ~0x00000001u;
            didClearAbstract = true;
        }
    }

    if (RepGraphSelfConstruct() && NetDriver && afterCls) {
        
        
        
        int fcount = (g_RepGraphFeatureArrayNum && IsReadablePointer(g_RepGraphFeatureArrayNum, 4))
                     ? *g_RepGraphFeatureArrayNum : -1;
        void* pkg = reinterpret_cast<void*(__fastcall*)()>(Globals::BaseAddress + 0x02659120)();
        void* params[10] = {};          
        params[0] = afterCls;           
        params[1] = pkg;                
        void* obj = reinterpret_cast<void*(__fastcall*)(void*)>(Globals::BaseAddress + 0x026CEC20)(&params[0]);
        std::string on = "(null)";
        if (obj && IsReadablePointer(obj, 0x20)) {
            UObject* c = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(obj) + 0x10);
            if (c && IsReadablePointer(c, 0x20)) on = c->GetName();
        }
        std::string pn = "(null)";
        if (pkg && IsReadablePointer(pkg, 0x20)) pn = reinterpret_cast<UObject*>(pkg)->GetName();
        MpLog("[RGSelf #" + std::to_string(n) + "] featureCount=" + std::to_string(fcount)
            + " pkg=" + MpPtr(pkg) + " (" + pn + ") cls=" + MpPtr(afterCls)
            + " -> StaticConstructObject=" + MpPtr(obj) + " (" + on + ")");
        if (obj) {
            if (didClearAbstract && afterCls) {
                *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC) = savedClassFlags;
            }
            if (didSuppress) *g_RepGraphFeatureArrayNum = savedCount;
            MpLog("[RGSelf #" + std::to_string(n) + "] installing self-constructed driver " + MpPtr(obj));
            return obj;
        }
        MpLog("[RGSelf #" + std::to_string(n) + "] self-construct returned null; falling back to Orig");
    }

    void* ret = reinterpret_cast<void*(__fastcall*)(void*, void*, void*)>(OrigCreateRepDriver)(NetDriver, p2, p3);

    
    if (didClearAbstract && afterCls) {
        uint32_t* flagsPtr = reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(afterCls) + 0xCC);
        *flagsPtr = savedClassFlags;
    }
    if (didSuppress) *g_RepGraphFeatureArrayNum = savedCount;

    if (n < 6) {
        std::string retClass = "(null)";
        if (ret && IsReadablePointer(ret, 0x20)) {
            UObject* cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ret) + 0x10);
            if (cls && IsReadablePointer(cls, 0x20)) retClass = cls->GetName();
        }
        MpLog("[CreateRepDriverHook #" + std::to_string(n) + "] Orig returned=" + MpPtr(ret)
            + " (" + retClass + ")  suppressedHelper=" + (didSuppress ? "1" : "0")
            + "  clearedAbstract=" + (didClearAbstract ? "1" : "0")
            + "  savedFlags=0x" + [&]{ char b[16]; _snprintf_s(b, _TRUNCATE, "%08X", savedClassFlags); return std::string(b); }());
    }
    return ret;
}



















static void* g_PlayerCharCDO = nullptr;
static bool  g_PlayerCharCDOSearched = false;
static void BoostPlayerCharCDONetFreq() {
    if (!g_PlayerCharCDOSearched) {
        g_PlayerCharCDOSearched = true;
        if (SDK::UObject::GObjects) {
            const int Count = SDK::UObject::GObjects->Num();
            for (int i = 0; i < Count; i++) {
                SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
                if (!Obj) continue;
                if (Obj->GetName() == "Default__BP_PlayerCharacter_C") { g_PlayerCharCDO = Obj; break; }
            }
        }
        MpLog(std::string("[PlayerRepBoost] Default__BP_PlayerCharacter_C CDO = ") + MpPtr(g_PlayerCharCDO));
    }
    if (g_PlayerCharCDO && IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(g_PlayerCharCDO) + 0x110), 4)) {
        uintptr_t Cdo = reinterpret_cast<uintptr_t>(g_PlayerCharCDO);
        if (PlayerRepBoost()) {
            float* nuf  = reinterpret_cast<float*>(Cdo + 0x108);
            float* mnuf = reinterpret_cast<float*>(Cdo + 0x10C);
            static bool s_logged = false;
            if (!s_logged) { s_logged = true; MpLog("[PlayerRepBoost] CDO NetUpdateFrequency " + std::to_string(*nuf) + " -> 60, MinNetUpdateFrequency " + std::to_string(*mnuf) + " -> 30"); }
            *nuf = 60.0f;
            *mnuf = 30.0f;
        }
        if (PlayerAlwaysRelevant() && IsReadablePointer(reinterpret_cast<void*>(Cdo + 0x58), 1)) {
            
            uint8_t* flags = reinterpret_cast<uint8_t*>(Cdo + 0x58);
            static bool s_arLogged = false;
            if (!s_arLogged) { s_arLogged = true; MpLog("[PlayerAlwaysRelevant] CDO bAlwaysRelevant byte(+0x58)=0x" + std::to_string(*flags) + " -> set bit3"); }
            *flags |= 0x08;
        }
    }
}

void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver) {
    static std::atomic<int> s_setRepDrvCount{0};
    int n = s_setRepDrvCount.fetch_add(1, std::memory_order_relaxed);

    if (n < 16) {
        std::string clsName = "(null-driver)";
        if (RepDriver && IsReadablePointer(reinterpret_cast<void*>(RepDriver), 0x20)) {
            UObject* CLS = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(RepDriver) + 0x10);
            if (CLS && IsReadablePointer(CLS, 0x20)) {
                clsName = reinterpret_cast<UObject*>(CLS)->GetName();
            } else {
                clsName = "(no-class)";
            }
        }
        MpLog("[SetReplicationDriverHook #" + std::to_string(n) + "] NetDriver=" + MpPtr(NetDriver)
            + " RepDriver=" + MpPtr(RepDriver) + " class=" + clsName);
    }
    if (PlayerRepBoost() || PlayerAlwaysRelevant()) BoostPlayerCharCDONetFreq();
    reinterpret_cast<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(NetDriver, RepDriver);

    
    
    
    
    
    if (n < 16 && RepDriver && IsReadablePointer(reinterpret_cast<void*>(RepDriver), 0xB8)) {
        uintptr_t g = reinterpret_cast<uintptr_t>(RepDriver);
        void* gDriver    = *reinterpret_cast<void**>(g + 0x30);
        void* connMgrCls = *reinterpret_cast<void**>(g + 0x28);
        int globalNodes  = *reinterpret_cast<int*>(g + 0xA0);
        int prepNodes    = *reinterpret_cast<int*>(g + 0xB0);
        int connMgrs     = *reinterpret_cast<int*>(g + 0x40);
        int pendConns    = *reinterpret_cast<int*>(g + 0x50);
        void* ndWorld    = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x148), 8))
                           ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x140) : nullptr;
        void* ndRepDrv   = (NetDriver && IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                           ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
        std::string sub = "";
        if (IsReadablePointer(reinterpret_cast<void*>(g), 0x4C8)) {
            void* gridNode  = *reinterpret_cast<void**>(g + 0x498);
            void* alwaysRel = *reinterpret_cast<void**>(g + 0x4A0);
            int arfc        = *reinterpret_cast<int*>(g + 0x4B0);
            int actorsNoC   = *reinterpret_cast<int*>(g + 0x4C0);
            sub = " GridNode=" + MpPtr(gridNode) + " AlwaysRelevantNode=" + MpPtr(alwaysRel)
                + " ARFCList=" + std::to_string(arfc) + " ActorsNoConn=" + std::to_string(actorsNoC);
        }
        MpLog("[SetReplicationDriverHook #" + std::to_string(n) + "] POST-INSTALL graph=" + MpPtr(RepDriver)
            + " graph.NetDriver=" + MpPtr(gDriver) + " ConnMgrClass=" + MpPtr(connMgrCls)
            + " GlobalGraphNodes=" + std::to_string(globalNodes) + " PrepareNodes=" + std::to_string(prepNodes)
            + " ConnMgrs=" + std::to_string(connMgrs) + " PendingConns=" + std::to_string(pendConns)
            + sub
            + " | NetDriver.World=" + MpPtr(ndWorld) + " NetDriver.RepDriver=" + MpPtr(ndRepDrv));
    }
    return;
}




void* OrigGetStartSpot = nullptr;







static bool NativePlayerStart() {
    
    
    return true;
}


static APlayerStart* NthPlayerStart(int n) {
    if (!SDK::UObject::GObjects) { return nullptr; }
    const int Num = SDK::UObject::GObjects->Num();
    int Total = 0;
    for (int i = 0; i < Num; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (Obj && !Obj->IsDefaultObject() && Obj->IsA(SDK::APlayerStart::StaticClass())) { Total++; }
    }
    if (Total == 0) { return nullptr; }
    const int Target = ((n % Total) + Total) % Total;
    int Idx = 0;
    for (int i = 0; i < Num; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (Obj && !Obj->IsDefaultObject() && Obj->IsA(SDK::APlayerStart::StaticClass())) {
            if (Idx == Target) { return (APlayerStart*)Obj; }
            Idx++;
        }
    }
    return nullptr;
}

APlayerStart* GetStartSpotHook(void* a1, void* a2, void* a3) {
    APlayerStart* Chosen = nullptr;
    const char* Mode = "forced";

    if (NativePlayerStart()) {
        Chosen = reinterpret_cast<APlayerStart*(*)(void*, void*, void*)>(OrigGetStartSpot)(a1, a2, a3);
        Mode = "native";
        if (!Chosen) {
            static std::atomic<int> s_fallbackIdx{ 0 };
            Chosen = NthPlayerStart(s_fallbackIdx.fetch_add(1, std::memory_order_relaxed));
            Mode = "fallback";
        }
    } else {
        Chosen = NthPlayerStart(0); 
    }

    
    
    static std::atomic<int> s_psLog{ 0 };
    if (s_psLog.fetch_add(1, std::memory_order_relaxed) < 40) {
        void* netConn = (a2 && IsReadablePointer(a2, 0x420)) ? *reinterpret_cast<void**>((uintptr_t)a2 + 0x418) : nullptr;
        std::string startName = (Chosen && IsReadablePointer(Chosen, 0x40)) ? reinterpret_cast<UObject*>(Chosen)->GetName() : std::string("null");
        std::string pcName = (a2 && IsReadablePointer(a2, 0x40)) ? reinterpret_cast<UObject*>(a2)->GetName() : std::string("?");
        MpLog(std::string("[PlayerStart] mode=") + Mode + " pc=" + MpPtr(a2) + "/" + pcName
            + " netConn=" + MpPtr(netConn) + " chose=" + MpPtr(Chosen) + "/" + startName);
    }
    return Chosen;
}

struct PlayerRoleChargeSnapshot {
    bool Valid = false;
    float MaxAbilityCharge = 0.0f;
    float Value = 0.0f;
    float Rate = 0.0f;
    float LastUpdateTime = 0.0f;
    float MaxValue = 0.0f;
    float MinValue = 0.0f;
    int NetDormancy = -1;
    float NetUpdateFrequency = 0.0f;
};

static float SafeCallPlayerRoleFloat(void* PlayerRole, uintptr_t Rva) {
    __try {
        if (!PlayerRole || !Globals::BaseAddress || !Rva) return -9999.0f;
        return reinterpret_cast<float(*)(void*)>(Globals::BaseAddress + Rva)(PlayerRole);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -9999.0f;
    }
}

static int SafeCallPlayerRoleBoolRva(void* PlayerRole, uintptr_t Rva) {
    __try {
        if (!PlayerRole || !Globals::BaseAddress || !Rva) return -1;
        return reinterpret_cast<bool(*)(void*)>(Globals::BaseAddress + Rva)(PlayerRole) ? 1 : 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -2;
    }
}

struct PlayerRoleModifierSnapshot {
    bool Valid = false;
    void* Group = nullptr;
    int DesiredBuffs = -1;
    int DesiredEffects = -1;
    int DesiredAbilities = -1;
    int AppliedBuffs = -1;
    int AppliedEffects = -1;
    int AppliedAbilities = -1;
    int PendingBuffs = -1;
    int PendingEffects = -1;
    int PendingAbilities = -1;
};

static PlayerRoleModifierSnapshot CapturePlayerRoleModifiers(void* PlayerRole) {
    PlayerRoleModifierSnapshot Result{};
    __try {
        if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) return Result;
        const uintptr_t Role = reinterpret_cast<uintptr_t>(PlayerRole);
        Result.DesiredBuffs = *reinterpret_cast<const int*>(Role + 0x2B0);
        Result.DesiredEffects = *reinterpret_cast<const int*>(Role + 0x2C0);
        Result.DesiredAbilities = *reinterpret_cast<const int*>(Role + 0x2D0);
        Result.Group = *reinterpret_cast<void* const*>(Role + 0x2F8);
        if (Result.DesiredBuffs < 0 || Result.DesiredBuffs > 256
            || Result.DesiredEffects < 0 || Result.DesiredEffects > 256
            || Result.DesiredAbilities < 0 || Result.DesiredAbilities > 256) return Result;

        if (Result.Group) {
            if (!IsReadablePointer(Result.Group, 0xD0)) return Result;
            const uintptr_t Group = reinterpret_cast<uintptr_t>(Result.Group);
            Result.AppliedEffects = *reinterpret_cast<const int*>(Group + 0x68);
            Result.AppliedAbilities = *reinterpret_cast<const int*>(Group + 0x78);
            Result.AppliedBuffs = *reinterpret_cast<const int*>(Group + 0x88);
            Result.PendingBuffs = *reinterpret_cast<const int*>(Group + 0xA8);
            Result.PendingEffects = *reinterpret_cast<const int*>(Group + 0xB8);
            Result.PendingAbilities = *reinterpret_cast<const int*>(Group + 0xC8);
            const int Counts[] = { Result.AppliedEffects, Result.AppliedAbilities, Result.AppliedBuffs,
                Result.PendingBuffs, Result.PendingEffects, Result.PendingAbilities };
            for (int Count : Counts) {
                if (Count < 0 || Count > 256) return Result;
            }
        }
        Result.Valid = true;
        return Result;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return PlayerRoleModifierSnapshot{};
    }
}

static std::string PlayerRoleModifierSummary(void* PlayerRole) {
    if (!PlayerRole) return "role=null";
    const PlayerRoleModifierSnapshot Snapshot = CapturePlayerRoleModifiers(PlayerRole);
    if (!Snapshot.Valid) return "role=" + MpPtr(PlayerRole) + " unreadable";
    return "group=" + MpPtr(Snapshot.Group)
        + " desired[b=" + std::to_string(Snapshot.DesiredBuffs)
        + ",e=" + std::to_string(Snapshot.DesiredEffects)
        + ",a=" + std::to_string(Snapshot.DesiredAbilities) + "]"
        + " applied[b=" + std::to_string(Snapshot.AppliedBuffs)
        + ",e=" + std::to_string(Snapshot.AppliedEffects)
        + ",a=" + std::to_string(Snapshot.AppliedAbilities) + "]"
        + " pending[b=" + std::to_string(Snapshot.PendingBuffs)
        + ",e=" + std::to_string(Snapshot.PendingEffects)
        + ",a=" + std::to_string(Snapshot.PendingAbilities) + "]";
}

static PlayerRoleChargeSnapshot CapturePlayerRoleCharge(void* PlayerRole) {
    PlayerRoleChargeSnapshot Result{};
    if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x35C)) return Result;
    const uintptr_t Base = reinterpret_cast<uintptr_t>(PlayerRole);
    Result.Valid = true;
    Result.MaxAbilityCharge = *reinterpret_cast<const float*>(Base + 0x308);
    Result.Value = *reinterpret_cast<const float*>(Base + 0x348);
    Result.Rate = *reinterpret_cast<const float*>(Base + 0x34C);
    Result.LastUpdateTime = *reinterpret_cast<const float*>(Base + 0x350);
    Result.MaxValue = *reinterpret_cast<const float*>(Base + 0x354);
    Result.MinValue = *reinterpret_cast<const float*>(Base + 0x358);
    Result.NetDormancy = *reinterpret_cast<const uint8_t*>(Base + 0xF1);
    Result.NetUpdateFrequency = *reinterpret_cast<const float*>(Base + 0x108);
    return Result;
}

static std::string PlayerRoleChargeSummary(void* PlayerRole) {
    if (!PlayerRole) return "role=null";
    const PlayerRoleChargeSnapshot Snapshot = CapturePlayerRoleCharge(PlayerRole);
    if (!Snapshot.Valid) return "role=" + MpPtr(PlayerRole) + " unreadable";
    const float Current = SafeCallPlayerRoleFloat(PlayerRole, 0x01B983E0);
    const float Percent = SafeCallPlayerRoleFloat(PlayerRole, 0x01B98410);
    const float CurrentRate = SafeCallPlayerRoleFloat(PlayerRole, 0x01B98470);
    const float NativeMax = SafeCallPlayerRoleFloat(PlayerRole, 0x01B99F30);
    
    
    
    
    
    const int CanActivateNative = SafeCallPlayerRoleBoolRva(PlayerRole, 0x01B8D8A0);
    return "role=" + MpPtr(PlayerRole)
        + " max=" + std::to_string(Snapshot.MaxAbilityCharge)
        + " lazyValue=" + std::to_string(Snapshot.Value)
        + " lazyRate=" + std::to_string(Snapshot.Rate)
        + " lazyLast=" + std::to_string(Snapshot.LastUpdateTime)
        + " lazyMax=" + std::to_string(Snapshot.MaxValue)
        + " lazyMin=" + std::to_string(Snapshot.MinValue)
        + " current=" + std::to_string(Current)
        + " percent=" + std::to_string(Percent)
        + " currentRate=" + std::to_string(CurrentRate)
        + " nativeMax=" + std::to_string(NativeMax)
        + " canActivateNative=" + std::to_string(CanActivateNative)
        + " canNativeRva=" + MpHex(0x01B8D8A0)
        + " dormancy=" + std::to_string(Snapshot.NetDormancy)
        + " netHz=" + std::to_string(Snapshot.NetUpdateFrequency);
}

struct AbilitySpecDiagnostic {
    void* Ability = nullptr;
    void* SourceObject = nullptr;
    int Level = -1;
    int InputId = -1;
};

static AbilitySpecDiagnostic FindAbilitySpecDiagnostic(UAbilitySystemComponent* Component, uint32_t Handle) {
    AbilitySpecDiagnostic Result{};
    if (!Component || !IsReadablePointer(Component, 0x508)) return Result;
    const uintptr_t Items = reinterpret_cast<uintptr_t>(Component) + 0x4F8;
    void* Data = *reinterpret_cast<void**>(Items);
    const int Num = *reinterpret_cast<int*>(Items + 8);
    if (!Data || Num <= 0 || Num > 4096
        || !IsReadablePointer(Data, static_cast<size_t>(Num) * 0xE0)) return Result;
    for (int i = 0; i < Num; ++i) {
        const uintptr_t Spec = reinterpret_cast<uintptr_t>(Data) + static_cast<uintptr_t>(i) * 0xE0;
        if (*reinterpret_cast<const uint32_t*>(Spec + 0x0C) != Handle) continue;
        Result.Ability = *reinterpret_cast<void**>(Spec + 0x10);
        Result.Level = *reinterpret_cast<const int*>(Spec + 0x18);
        Result.InputId = *reinterpret_cast<const int*>(Spec + 0x1C);
        Result.SourceObject = *reinterpret_cast<void**>(Spec + 0x20);
        break;
    }
    return Result;
}

static std::string SafeObjectNameForDiagnostic(void* Object) {
    if (!Object || !IsReadablePointer(Object, 0x40)) return Object ? "unreadable" : "null";
    return reinterpret_cast<UObject*>(Object)->GetName();
}






static std::string ExperienceGrantSummary(const FExperienceGrant& Grant) {
    return "type=" + std::to_string(static_cast<int>(Grant.ExperienceType))
        + " increase=" + std::to_string(Grant.IncreaseAmount)
        + " boost=" + std::to_string(Grant.BoostAmount)
        + " level=" + std::to_string(Grant.PreviousLevel) + "->" + std::to_string(Grant.Level)
        + " levelAmount=" + std::to_string(Grant.PreviousLevelAmount) + "->" + std::to_string(Grant.LevelAmount)
        + " maxLevelAmount=" + std::to_string(Grant.PreviousMaxLevelAmount) + "->" + std::to_string(Grant.MaxLevelAmount);
}

static bool IsClientExperienceGrantConsumer(const std::string& FunctionName) {
    return FunctionName.find("HUDExperienceBar.OnPlayerExperienceGranted") != std::string::npos
        || FunctionName.find("mastery_stinger_manager_C.OnExperienceGranted") != std::string::npos
        || FunctionName.find("Objective_PlayerXP.OnExperienceGranted") != std::string::npos
        || FunctionName.find("PlayerJourneyComponent.HandleGrantPlayerExperience") != std::string::npos;
}

bool ServerTryActivateAbilityInternal(UAbilitySystemComponent* Component, FGameplayAbilitySpecHandle& AbilityHandle, bool InputPressed, FPredictionKey& PredictionKey, FGameplayEventData* TriggerEventData) {
    const AbilitySpecDiagnostic Spec = FindAbilitySpecDiagnostic(Component, AbilityHandle.Handle);
    void* OwnerActor = (Component && IsReadablePointer(Component, 0x3E0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Component) + 0x3D0) : nullptr;
    void* AvatarActor = (Component && IsReadablePointer(Component, 0x3E0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Component) + 0x3D8) : nullptr;
    void* PlayerRole = (AvatarActor && IsReadablePointer(AvatarActor, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(AvatarActor) + 0x738) : nullptr;
    const std::string ChargeBefore = PlayerRoleChargeSummary(PlayerRole);

    if(InputPressed)
        Component->ServerSetInputPressed(AbilityHandle);

    void* InstancedAbility = nullptr;

    bool Activated = reinterpret_cast<bool(*)(UAbilitySystemComponent*, uint32_t, FPredictionKey*, void**, void*, FGameplayEventData*)>(Globals::BaseAddress + 0x015B9E20)(Component, AbilityHandle.Handle, &PredictionKey, &InstancedAbility, nullptr, TriggerEventData);

    if (!Activated && InputPressed)
        Component->ServerSetInputReleased(AbilityHandle);

    static std::atomic<int> s_abilityActivateLogCount{ 0 };
    if (s_abilityActivateLogCount.fetch_add(1, std::memory_order_relaxed) < 128) {
        MpLog("[AbilityActivate] component=" + MpPtr(Component)
            + " handle=" + std::to_string(AbilityHandle.Handle)
            + " inputPressed=" + std::to_string(InputPressed ? 1 : 0)
            + " activated=" + std::to_string(Activated ? 1 : 0)
            + " owner=" + MpPtr(OwnerActor) + "/" + SafeObjectNameForDiagnostic(OwnerActor)
            + " avatar=" + MpPtr(AvatarActor) + "/" + SafeObjectNameForDiagnostic(AvatarActor)
            + " ability=" + MpPtr(Spec.Ability) + "/" + SafeObjectNameForDiagnostic(Spec.Ability)
            + " source=" + MpPtr(Spec.SourceObject) + "/" + SafeObjectNameForDiagnostic(Spec.SourceObject)
            + " level=" + std::to_string(Spec.Level) + " inputId=" + std::to_string(Spec.InputId)
            + " chargeBefore={" + ChargeBefore + "} chargeAfter={" + PlayerRoleChargeSummary(PlayerRole) + "}");
    }

    return Activated;
}

void* OrigMakeDoDamage = nullptr;

bool MakeDoDamageHook(void* a1, void* a2, void* a3) {
    *(uint8_t*)((uintptr_t)a1 + 0x57C) = 1;

    return true;
}

#include <fstream>

void* OrigProcessEventClient = nullptr;
void* OrigEasyAntiCheatErrorProc = nullptr;
void* OrigEasyAntiCheatStartup = nullptr;









static bool SuppressEacPopupEnabled() {
    return true;
}





void EasyAntiCheatErrorProcHook(void* Context, void* Stack, void* Result) {
    (void)Context;
    (void)Stack;
    if (SuppressEacPopupEnabled()) {
        
        
        if (Result && IsReadablePointer(Result, 0x11)) {
            *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Result) + 0x10) = 0;
        }
        static bool Logged = false;
        if (!Logged) {
            Logged = true;
            MpLog("[EACPopup] suppressed native EasyAntiCheatErrorProc");
        }
        return;
    }
    if (OrigEasyAntiCheatErrorProc) {
        reinterpret_cast<void(*)(void*, void*, void*)>(OrigEasyAntiCheatErrorProc)(Context, Stack, Result);
    }
}




void EasyAntiCheatStartupHook(void* Module) {
    if (SuppressEacPopupEnabled()) {
        (void)Module;
        static bool Logged = false;
        if (!Logged) {
            Logged = true;
            MpLog("[EACPopup] suppressed FEasyAntiCheatClient::StartupModule");
        }
        return;
    }
    if (OrigEasyAntiCheatStartup) {
        reinterpret_cast<void(*)(void*)>(OrigEasyAntiCheatStartup)(Module);
    }
}


static uint8_t SafeReadByte(uintptr_t base, uintptr_t offset, uint8_t fallback);
static bool SafeWriteByte(uintptr_t base, uintptr_t offset, uint8_t value);
static float SafeReadFloat(void* addr, float fallback);
static uintptr_t SafeReadPtr(uintptr_t base, uintptr_t offset);
static bool SafeWriteFloat(uintptr_t base, uintptr_t offset, float value);
static void RefreshPlayerRoleGameplayLifecycle(UObject* PC, const char* TriggerLabel);
static void ReconcileAirshipGameplayHUD(const char* TriggerLabel);
static int TraceEscalationFlowEnter(const char* Side, UObject* Object,
                                    const std::string& FunctionName, void* Parms);
static void TraceEscalationFlowExit(const char* Side, int Seq, UObject* Object,
                                   const std::string& FunctionName, void* Parms);






static UObject* s_AirshipHUD = nullptr;
static UObject* s_AirshipGameState = nullptr;
static bool s_AirshipHUDCompatHidden = false;











void TriggerArchonInputActivation(UObject* PC, const char* TriggerLabel) {
    uint8_t onlineReady = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);

    if (onlineReady != 1) {
        
        
        bool wrote = SafeWriteByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 1);
        uint8_t after = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);
        MpLog(std::string("[ArchonInputActivate] trigger=") + TriggerLabel + " Force-set bOnlineDataReady: "
            + "was=" + std::to_string(onlineReady)
            + " wrote=" + (wrote ? "ok" : "FAIL")
            + " after=" + std::to_string(after)
            + " PC=" + PC->GetFullName());

        if (after != 1) {
            
            
            return;
        }
        
    }

    
    
    
    s_ArchonInputActivated = true;

    MpLog(std::string("[ArchonInputActivate] trigger=") + TriggerLabel + " PC=" + PC->GetFullName()
        + " bOnlineDataReady@0xC59=1 (forced or natural)");

    
    
    
    
    
    
    static UFunction* s_EnableCharacterInputFn = nullptr;
    if (!s_EnableCharacterInputFn) {
        s_EnableCharacterInputFn = PC->Class->GetFunction("ArchonPlayerController", "EnableCharacterInput");
        MpLog(std::string("[ArchonInputActivate] Resolve EnableCharacterInput  → ")
            + MpPtr(s_EnableCharacterInputFn));
    }
    if (s_EnableCharacterInputFn) {
        struct { bool bEnableInput; } enableCharParms = { true };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_EnableCharacterInputFn, &enableCharParms);
        MpLog("[ArchonInputActivate] Called AArchonPlayerController::EnableCharacterInput(true)");
    }

    
    
    
    
    static UFunction* s_GetLoadoutFn = nullptr;
    if (!s_GetLoadoutFn) {
        s_GetLoadoutFn = PC->Class->GetFunction("ArchonPlayerController", "GetLoadout");
    }
    if (s_GetLoadoutFn) {
        struct { UObject* ReturnValue; } getLoadoutParms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetLoadoutFn, &getLoadoutParms);
        if (getLoadoutParms.ReturnValue) {
            static UFunction* s_SetLoadoutSlotFn = getLoadoutParms.ReturnValue->Class->GetFunction("ArchonLoadout", "ServerInternalSetActiveLoadoutSlotIndex");
            if (s_SetLoadoutSlotFn) {
                struct { int32 InDesiredLoadoutSlotIndex; bool bForceApply; } setSlotParms = { 0, true };
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                    getLoadoutParms.ReturnValue, s_SetLoadoutSlotFn, &setSlotParms);
                MpLog("[ArchonInputActivate] Forced AArchonLoadout::ServerInternalSetActiveLoadoutSlotIndex(0, true)");

                
                
                
                
                
                if (OrigApplyPlayerRole) {
                    ApplyPlayerRoleHook(getLoadoutParms.ReturnValue);
                    MpLog("[ArchonInputActivate] Re-applied local PlayerRole after selecting loadout slot 0");
                    
                    
                    
                    
                    RefreshPlayerRoleGameplayLifecycle(PC, "post-apply");
                }
            }
        }
        else {
            MpLog("[ArchonInputActivate] PC->GetLoadout() returned null, unable to force ActiveLoadoutSlotIndex");
        }
    }

    
    
    
    
    
    
    
    static UFunction* s_ResetIgnoreMoveInputFn = nullptr;
    static UFunction* s_ResetIgnoreLookInputFn = nullptr;
    static UFunction* s_SetCinematicModeFn    = nullptr;
    if (!s_ResetIgnoreMoveInputFn) {
        s_ResetIgnoreMoveInputFn = PC->Class->GetFunction("Controller", "ResetIgnoreMoveInput");
        MpLog(std::string("[ArchonInputActivate] Resolve ResetIgnoreMoveInput → ")
            + MpPtr(s_ResetIgnoreMoveInputFn));
    }
    if (!s_ResetIgnoreLookInputFn) {
        s_ResetIgnoreLookInputFn = PC->Class->GetFunction("Controller", "ResetIgnoreLookInput");
        MpLog(std::string("[ArchonInputActivate] Resolve ResetIgnoreLookInput → ")
            + MpPtr(s_ResetIgnoreLookInputFn));
    }
    if (!s_SetCinematicModeFn) {
        s_SetCinematicModeFn = PC->Class->GetFunction("PlayerController", "SetCinematicMode");
        MpLog(std::string("[ArchonInputActivate] Resolve SetCinematicMode → ")
            + MpPtr(s_SetCinematicModeFn));
    }
    if (s_ResetIgnoreMoveInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ResetIgnoreMoveInputFn, nullptr);
        MpLog("[ArchonInputActivate] Called AController::ResetIgnoreMoveInput()");
    }
    if (s_ResetIgnoreLookInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ResetIgnoreLookInputFn, nullptr);
        MpLog("[ArchonInputActivate] Called AController::ResetIgnoreLookInput()");
    }
    if (s_SetCinematicModeFn) {
        struct {
            bool bInCinematicMode;
            bool bHidePlayer;
            bool bAffectsHUD;
            bool bAffectsMovement;
            bool bAffectsTurning;
        } cineParms = { false, false, false, false, false };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_SetCinematicModeFn, &cineParms);
        MpLog("[ArchonInputActivate] Called APlayerController::SetCinematicMode(false, ...)");
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    static UFunction* s_ApplyInputConfigFn = nullptr;
    static UFunction* s_ApplyInputConfigFromSettingsFn = nullptr;
    static UFunction* s_PCSetupArchonInputFn = nullptr;
    if (!s_ApplyInputConfigFn) {
        s_ApplyInputConfigFn = PC->Class->GetFunction(
            "ArchonPlayerControllerBase", "ApplyInputConfiguration");
        MpLog(std::string("[InputConfigCascade] Resolve ApplyInputConfiguration → ")
            + MpPtr(s_ApplyInputConfigFn));
    }
    if (!s_ApplyInputConfigFromSettingsFn) {
        s_ApplyInputConfigFromSettingsFn = PC->Class->GetFunction(
            "ArchonPlayerControllerBase", "ApplyInputConfigurationFromSettings");
        MpLog(std::string("[InputConfigCascade] Resolve ApplyInputConfigurationFromSettings → ")
            + MpPtr(s_ApplyInputConfigFromSettingsFn));
    }
    if (!s_PCSetupArchonInputFn) {
        
        s_PCSetupArchonInputFn = PC->Class->GetFunction(
            "player_controller_bp_C", "SetupArchonInput");
        if (!s_PCSetupArchonInputFn) {
            
            s_PCSetupArchonInputFn = PC->Class->GetFunction(
                "ArchonPlayerController", "SetupArchonInput");
        }
        MpLog(std::string("[InputConfigCascade] Resolve PC SetupArchonInput → ")
            + MpPtr(s_PCSetupArchonInputFn));
    }

    
    
    if (s_ApplyInputConfigFn) {
        struct {
            uint8_t InputConfiguration;   
            uint8_t Pad[3];
            bool    ReturnValue;
        } cfgParms = { 1, {0,0,0}, false };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ApplyInputConfigFn, &cfgParms);
        MpLog(std::string("[InputConfigCascade] Called ApplyInputConfiguration(Hunter=1) → ret=")
            + std::to_string(cfgParms.ReturnValue ? 1 : 0));

        
        if (!cfgParms.ReturnValue) {
            cfgParms.InputConfiguration = 0;
            cfgParms.ReturnValue = false;
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                PC, s_ApplyInputConfigFn, &cfgParms);
            MpLog(std::string("[InputConfigCascade] Hunter unavailable, fell back to Default(0) → ret=")
                + std::to_string(cfgParms.ReturnValue ? 1 : 0));
        }
    }

    
    
    
    if (s_ApplyInputConfigFromSettingsFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_ApplyInputConfigFromSettingsFn, nullptr);
        MpLog("[InputConfigCascade] Called ApplyInputConfigurationFromSettings()");
    }

    
    
    
    if (s_PCSetupArchonInputFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_PCSetupArchonInputFn, nullptr);
        MpLog("[InputConfigCascade] Called player_controller_bp_C::SetupArchonInput()");
    }

    
    
    
    uintptr_t pawnPtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PC), 0x0250);
    if (pawnPtr) {
        UObject* Pawn = reinterpret_cast<UObject*>(pawnPtr);
        static UFunction* s_PawnSetupArchonInputFn = nullptr;
        if (!s_PawnSetupArchonInputFn) {
            s_PawnSetupArchonInputFn = Pawn->Class->GetFunction(
                "BP_PlayerCharacter_C", "SetupArchonInput");
            if (!s_PawnSetupArchonInputFn) {
                s_PawnSetupArchonInputFn = Pawn->Class->GetFunction(
                    "ArchonCharacter", "SetupArchonInput");
            }
            MpLog(std::string("[InputConfigCascade] Resolve pawn SetupArchonInput → ")
                + MpPtr(s_PawnSetupArchonInputFn));
        }
        if (s_PawnSetupArchonInputFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                Pawn, s_PawnSetupArchonInputFn, nullptr);
            MpLog("[InputConfigCascade] Called pawn SetupArchonInput()");
        }
    }

    
    
    
    ReconcileAirshipGameplayHUD("input-activation");
}














static bool RunClientRolePumpGuarded(UObject* PC) {
    __try {
        TickPlayerRoleRetries();
        if (PC) RefreshPlayerRoleGameplayLifecycle(PC, "pump");
        ReconcileAirshipGameplayHUD("role-retry-pump");
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void ProcessEventClientHook(UObject* Object, UFunction* Function, void* Parms) {
    
    
    

    
    
    
    
    
    
    static thread_local int s_processEventDepthClient = 0;
    struct DepthGuardClient {
        DepthGuardClient()  { ++s_processEventDepthClient; }
        ~DepthGuardClient() { --s_processEventDepthClient; }
    } g_depthGuardClient;

    if (s_processEventDepthClient > 32) {
        static thread_local bool s_reportedRecursionClient = false;
        if (!s_reportedRecursionClient) {
            s_reportedRecursionClient = true;
            std::string FunctionName = Function ? Function->GetFullName() : "null";
            std::string ObjectName = Object ? Object->GetFullName() : "null";
            MpLog("[ProcessEventClientHook] REENTRANCY-GUARD tripped (depth="
                + std::to_string(s_processEventDepthClient) + ") — ABSORBING call. "
                + "fn=" + FunctionName + " obj=" + ObjectName);
        }
        return;   
    }

    

    std::string FunctionName = Function ? Function->GetFullName() : "null";
    const int EscalationFlowClientSeq = TraceEscalationFlowEnter(
        "Client", Object, FunctionName, Parms);

    
    
    
    const bool AirshipStateUpdateEvent = Function && Object
        && FunctionName.find(".OnAirshipStateUpdate") != std::string::npos;
    if (AirshipStateUpdateEvent && Parms && IsReadablePointer(Parms, sizeof(void*))) {
        UObject* GameState = *reinterpret_cast<UObject**>(Parms);
        if (GameState && IsReadablePointer(GameState, 0x2D1)) {
            s_AirshipHUD = Object;
            s_AirshipGameState = GameState;
        }
    }

    
    
    const bool AirshipHUDMayHaveBeenShown = Function && (
        FunctionName.find(".ShowGameplayHUD") != std::string::npos
        || FunctionName.find(".Player_HUD_Ready") != std::string::npos
        || FunctionName.find(".Progression_HUD_Ready") != std::string::npos
        || FunctionName.find(".ReceiveGameplayStart") != std::string::npos
        || FunctionName.find(".Refresh_HUD_Widget_Visibility") != std::string::npos
        || FunctionName.find(".Show_HUD") != std::string::npos
        || FunctionName.find(".Show HUD") != std::string::npos);

    
    
    
    
    
    int WeaponXpClientEventSeq = -1;
    const FExperienceGrant* WeaponXpClientGrant = nullptr;
    if (Function && Parms && IsClientExperienceGrantConsumer(FunctionName)
        && IsReadablePointer(Parms, sizeof(FExperienceGrant))) {
        static std::atomic<int> s_weaponXpClientEventCount{ 0 };
        WeaponXpClientEventSeq = s_weaponXpClientEventCount.fetch_add(1, std::memory_order_relaxed);
        if (WeaponXpClientEventSeq < 256) {
            WeaponXpClientGrant = reinterpret_cast<const FExperienceGrant*>(Parms);
            MpLog("[WeaponXP][ClientEvent] ENTER seq=" + std::to_string(WeaponXpClientEventSeq)
                + " fn=" + FunctionName
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " " + ExperienceGrantSummary(*WeaponXpClientGrant));
        }
    }

    
    
    
    if (Function && Parms
        && FunctionName.find("ArchonProgressBar.AnimatePointsAdded") != std::string::npos
        && IsReadablePointer(Parms, sizeof(int32_t))) {
        static std::atomic<int> s_weaponXpBarAnimationCount{ 0 };
        int Seq = s_weaponXpBarAnimationCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 256) {
            int32_t AddedAmount = *reinterpret_cast<const int32_t*>(Parms);
            MpLog("[WeaponXP][ClientBar] seq=" + std::to_string(Seq)
                + " added=" + std::to_string(AddedAmount)
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " fn=" + FunctionName);
        }
    }

    
    
    
    
    int TempestPerfectDodgeClientSeq = -1;
    if (Function && FunctionName.find("PerfectDodge") != std::string::npos) {
        static std::atomic<int> s_tempestPerfectDodgeClientCount{ 0 };
        TempestPerfectDodgeClientSeq = s_tempestPerfectDodgeClientCount.fetch_add(1, std::memory_order_relaxed);
        if (TempestPerfectDodgeClientSeq < 64) {
            MpLog("[TempestPerfectDodge][Client] ENTER seq=" + std::to_string(TempestPerfectDodgeClientSeq)
                + " fn=" + FunctionName + " obj=" + MpPtr(Object) + "/"
                + SafeObjectNameForDiagnostic(Object));
        }
    }

    
    
    
    
    
    
    const bool PlayerRoleInputEvent = Object && (
        FunctionName.find("BP_PlayerCharacter_C.LanternAbilityPress") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.LanternAbilityRelease") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.HandleLanternShortPressInput") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.HandleLanternLongPressInput") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.PlayerRoleAttackPress") != std::string::npos
        || FunctionName.find("BP_PlayerCharacter_C.Client_TryActivateAbility") != std::string::npos);
    void* InputDiagRole = nullptr;
    void* InputDiagAbilityClass = nullptr;
    float HeldLanternBefore = -1.0f;
    if (PlayerRoleInputEvent && IsReadablePointer(Object, 0x15CC)) {
        InputDiagRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x738);
        HeldLanternBefore = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Object) + 0x15C8);
        if (FunctionName.find("Client_TryActivateAbility") != std::string::npos
            && Parms && IsReadablePointer(Parms, sizeof(void*))) {
            InputDiagAbilityClass = *reinterpret_cast<void**>(Parms);
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const bool IsAccessoryItemCheckFn = Function && (
        FunctionName.find("CanUseAccessory") != std::string::npos
        || FunctionName.find("IsUnlockedAsTransmogTarget") != std::string::npos
        || FunctionName.find("CanBeTransmogTarget") != std::string::npos);
    const bool IsInventoryDataQueryFn = Function && (
        FunctionName.find("GetInventoryData") != std::string::npos
        || FunctionName.find("GetItemFromInstanceId") != std::string::npos);
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const bool IsWidgetUpdateViewFn = Function && FunctionName.find("UpdateView") != std::string::npos;
    const bool IsAccessoryUnlockDiagFn = IsAccessoryItemCheckFn || IsInventoryDataQueryFn || IsWidgetUpdateViewFn;
    std::string AccessoryUnlockDiagItemId, AccessoryUnlockDiagInstanceId, AccessoryUnlockDiagParmsBefore;
    if (IsAccessoryItemCheckFn && Object) {
        AccessoryUnlockDiagItemId = IsReadablePointer(Object, 0x80)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Object) + 0x70))
            : std::string("?");
        AccessoryUnlockDiagInstanceId = IsReadablePointer(Object, 0x98)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Object) + 0x88))
            : std::string("?");
    }
    std::string AccessoryUnlockDiagQueriedInstanceId;
    if (IsAccessoryUnlockDiagFn) {
        AccessoryUnlockDiagParmsBefore = (Parms && IsReadablePointer(Parms, 24))
            ? DumpBytesHex(Parms, 24) : std::string("(unreadable)");
        
        
        
        
        if (FunctionName.find("GetItemFromInstanceId") != std::string::npos
            && Parms && IsReadablePointer(Parms, 0x10)) {
            AccessoryUnlockDiagQueriedInstanceId = CoreCapFString(Parms);
        }
    }

    
    
    
    
    if (s_processEventDepthClient == 1) {
        static uint32_t s_clientRoleRetryPump = 0;
        if ((++s_clientRoleRetryPump & 0xFF) == 0) {
            if (!RunClientRolePumpGuarded(s_LastPossessedPC)) {
                MpLog("[ClientRolePump] FAULTED (stale pointer, likely a level travel tore down"
                    " the owning pawn/PC) - caught, skipping this pump cycle instead of crashing");
            }

            
            
            
            
            
            
            
            
            
            
            if (s_LastPossessedPC && s_LastPossessedAtMs != 0
                && !s_ArchonInputActivated && !DiagNaturalMode())
            {
                constexpr uint64_t kInputActivateTimeoutMs = 8000;   
                uint64_t Elapsed = GetTickCount64() - s_LastPossessedAtMs;
                if (Elapsed >= kInputActivateTimeoutMs) {
                    MpLog(std::string("[ArchonInputActivate] trigger=timeout normal OnInputModeChanged never fired within ")
                        + std::to_string(Elapsed) + "ms of ClientRestart - forcing activation now");
                    TriggerArchonInputActivation(s_LastPossessedPC, "timeout");
                }
            }

            
            
            
            
            
            TickProgressionHudRefresh();
        }
    }

    
    
    
    
    
    
    if (SuppressEacPopupEnabled() && FunctionName.find("EasyAntiCheatErrorProc") != std::string::npos) {
        
        if (Parms && IsReadablePointer(Parms, 0x11)) {
            *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x10) = 0;
        }
        static bool s_loggedEacSuppression = false;
        if (!s_loggedEacSuppression) {
            s_loggedEacSuppression = true;
            MpLog("[EACPopup] suppressed ArchonGameInstance.EasyAntiCheatErrorProc");
        }
        return;
    }

    

    
    


    


    


    


    


    
    
    
    
    
    
    
    
    


    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(Object, Function, Parms);

    if (IsAccessoryUnlockDiagFn) {
        static std::atomic<int> s_accessoryUnlockDiagCount{ 0 };
        if (s_accessoryUnlockDiagCount.fetch_add(1, std::memory_order_relaxed) < 2000) {
            std::string ParmsAfter = (Parms && IsReadablePointer(Parms, 24))
                ? DumpBytesHex(Parms, 24) : std::string("(unreadable)");
            
            
            
            
            void* ReturnValueAtOffset0 = (Parms && IsReadablePointer(Parms, 8))
                ? *reinterpret_cast<void**>(Parms) : nullptr;
            void* ReturnValueAtOffset0x10 = (Parms && IsReadablePointer(Parms, 0x18))
                ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Parms) + 0x10) : nullptr;
            MpLog("[AccessoryUnlockDiag] fn=" + FunctionName
                + " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " itemId=" + AccessoryUnlockDiagItemId
                + " instanceId=" + AccessoryUnlockDiagInstanceId
                + " queriedInstanceId=" + AccessoryUnlockDiagQueriedInstanceId
                + " retAt0x0=" + MpPtr(ReturnValueAtOffset0)
                + " retAt0x10=" + MpPtr(ReturnValueAtOffset0x10)
                + " parmsBefore=[" + AccessoryUnlockDiagParmsBefore + "]"
                + " parmsAfter=[" + ParmsAfter + "]");
        }
    }

    if (AirshipStateUpdateEvent) {
        ReconcileAirshipGameplayHUD("state-update");
    }
    else if (AirshipHUDMayHaveBeenShown) {
        ReconcileAirshipGameplayHUD("hud-show-path");
    }

    if (WeaponXpClientGrant && WeaponXpClientEventSeq >= 0 && WeaponXpClientEventSeq < 256) {
        MpLog("[WeaponXP][ClientEvent] EXIT seq=" + std::to_string(WeaponXpClientEventSeq)
            + " fn=" + FunctionName + " " + ExperienceGrantSummary(*WeaponXpClientGrant));
    }

    TraceEscalationFlowExit("Client", EscalationFlowClientSeq, Object, FunctionName, Parms);

    if (TempestPerfectDodgeClientSeq >= 0 && TempestPerfectDodgeClientSeq < 64) {
        MpLog("[TempestPerfectDodge][Client] EXIT seq=" + std::to_string(TempestPerfectDodgeClientSeq)
            + " fn=" + FunctionName);
    }

    if (PlayerRoleInputEvent) {
        static std::atomic<int> s_playerRoleInputLogCount{ 0 };
        if (s_playerRoleInputLogCount.fetch_add(1, std::memory_order_relaxed) < 128) {
            const float HeldLanternAfter = IsReadablePointer(Object, 0x15CC)
                ? *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Object) + 0x15C8) : -1.0f;
            const int CharacterActive = IsReadablePointer(Object, 0xA1B)
                ? SafeReadByte(reinterpret_cast<uintptr_t>(Object), 0xA1A, 0xEE) : -1;
            const int GameplayEquipped = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F5, 0xEE) : -1;
            const int RoleActive = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F6, 0xEE) : -1;
            const int BpEquipCalled = InputDiagRole
                ? SafeReadByte(reinterpret_cast<uintptr_t>(InputDiagRole), 0x2F7, 0xEE) : -1;
            MpLog("[PlayerRoleInput] fn=" + FunctionName
                + " pawn=" + MpPtr(Object) + " role=" + MpPtr(InputDiagRole)
                + " held=" + std::to_string(HeldLanternBefore) + "->" + std::to_string(HeldLanternAfter)
                + " charActive=" + std::to_string(CharacterActive)
                + " gameplayEquipped=" + std::to_string(GameplayEquipped)
                + " roleActive=" + std::to_string(RoleActive)
                + " bpEquipCalled=" + std::to_string(BpEquipCalled)
                + " abilityClass=" + MpPtr(InputDiagAbilityClass) + "/"
                + SafeObjectNameForDiagnostic(InputDiagAbilityClass)
                + " charge={" + PlayerRoleChargeSummary(InputDiagRole) + "}"
                + " modifiers={" + PlayerRoleModifierSummary(InputDiagRole) + "}");
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (Function && Parms && Object
        && FunctionName == "Function BP_PlayerCharacter.BP_PlayerCharacter_C.OnInputModeChanged")
    {
        bool bGameInputEnabled = *reinterpret_cast<bool*>(Parms);
        MpLog(std::string("[InputModeVal] pawn=") + Object->GetFullName()
            + " bGameInputEnabled=" + (bGameInputEnabled ? "true" : "false"));

        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        if (!s_ArchonInputActivated && s_LastPossessedPC && !DiagNaturalMode()) {
            TriggerArchonInputActivation(s_LastPossessedPC, "event");
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (Function && Object
        && FunctionName == "Function BP_PlayerCharacter.BP_PlayerCharacter_C.OnInputModeChanged")
    {
        uintptr_t pawnAddr = reinterpret_cast<uintptr_t>(Object);
        uint8_t canMove = SafeReadByte(pawnAddr, 0x15E0, 0xEE);
        uintptr_t charMove = SafeReadPtr(pawnAddr, 0x0288);
        uintptr_t rootComp = SafeReadPtr(pawnAddr, 0x0130);
        uint8_t replMovMode = SafeReadByte(pawnAddr, 0x0328, 0xEE);
        
        
        uint8_t actorRole = SafeReadByte(pawnAddr, 0x00F0, 0xEE);
        uint8_t remoteRole = SafeReadByte(pawnAddr, 0x005F, 0xEE);
        uint8_t movMode = 0xEE, defaultLandMode = 0xEE, customMovMode = 0xEE;
        uintptr_t updatedComp = 0, pawnOwner = 0, characterOwner = 0;
        float velX = 0, velY = 0, velZ = 0, maxWalkSpeed = 0, maxAccel = 0, gravScale = 0;
        if (charMove) {
            movMode = SafeReadByte(charMove, 0x0168, 0xEE);
            customMovMode = SafeReadByte(charMove, 0x0169, 0xEE);
            defaultLandMode = SafeReadByte(charMove, 0x03B8, 0xEE);
            updatedComp = SafeReadPtr(charMove, 0x00B0);
            pawnOwner   = SafeReadPtr(charMove, 0x0130);
            characterOwner = SafeReadPtr(charMove, 0x0148);
            velX = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00C4, 0);
            velY = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00C8, 0);
            velZ = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x00CC, 0);
            maxWalkSpeed = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x018C, 0);
            maxAccel = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x01A0, 0);
            gravScale = SafeReadFloat(reinterpret_cast<uint8_t*>(charMove) + 0x0150, 0);
        }
        
        uint8_t mobility = 0xEE;
        float locX = 0, locY = 0, locZ = 0;
        if (rootComp) {
            mobility = SafeReadByte(rootComp, 0x014F, 0xEE);
            locX = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x011C, 0);
            locY = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x0120, 0);
            locZ = SafeReadFloat(reinterpret_cast<uint8_t*>(rootComp) + 0x0124, 0);
        }

        char buf[768];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE,
            "pawn=%s CanMove_=%u Role=%u RemoteRole=%u"
            " CharMove=%p RootComp=%p Updated=%p"
            " PawnOwner=%p CharOwner=%p Mobility=%u"
            " MovMode=%u CustomMovMode=%u DefaultLandMode=%u ReplMovMode=%u"
            " Vel=(%.1f,%.1f,%.1f) MaxWalk=%.1f MaxAcc=%.1f Grav=%.2f"
            " Loc=(%.1f,%.1f,%.1f)",
            Object->GetFullName().c_str(),
            canMove, actorRole, remoteRole,
            reinterpret_cast<void*>(charMove),
            reinterpret_cast<void*>(rootComp),
            reinterpret_cast<void*>(updatedComp),
            reinterpret_cast<void*>(pawnOwner),
            reinterpret_cast<void*>(characterOwner),
            mobility,
            movMode, customMovMode, defaultLandMode, replMovMode,
            velX, velY, velZ, maxWalkSpeed, maxAccel, gravScale,
            locX, locY, locZ);
        MpLog(std::string("[MovementDiag] ") + buf);

        
        if (canMove != 1) {
            SafeWriteByte(pawnAddr, 0x15E0, 1);
            SafeWriteByte(pawnAddr, 0x1604, 1);  
            MpLog("[ForceCanMove] wrote 1 to pawn+0x15E0 (CanMove_)");
        }

        
        if (charMove && movMode == 0) {
            bool ok1 = SafeWriteByte(charMove, 0x0168, 1);
            bool ok2 = SafeWriteByte(charMove, 0x03B8, 1);  
            bool ok3 = SafeWriteByte(pawnAddr, 0x0328, 1);  
            MpLog(std::string("[ForceMovementMode] wrote MOVE_Walking → CharMove+0x168 (")
                + (ok1 ? "ok" : "FAIL") + ") DefaultLandMode (" + (ok2 ? "ok" : "FAIL")
                + ") ReplMovMode (" + (ok3 ? "ok" : "FAIL") + ")");
        }

        
        
        
        if (rootComp && mobility != 2) {
            bool ok = SafeWriteByte(rootComp, 0x014F, 2);
            MpLog(std::string("[ForceMobility] RootComp+0x14F: was=") + std::to_string(mobility)
                + " wrote 2 (Movable) " + (ok ? "ok" : "FAIL"));
        }

        
        
        
        if (actorRole != 2 && actorRole != 3) {
            bool ok = SafeWriteByte(pawnAddr, 0x00F0, 2);
            MpLog(std::string("[ForceRole] pawn+0xF0: was=") + std::to_string(actorRole)
                + " wrote 2 (AutonomousProxy) " + (ok ? "ok" : "FAIL"));
        }
    }

    
    
    
    
    if (Function && FunctionName.contains("AddMovementInput")) {
        
        float dx = 0, dy = 0, dz = 0, scale = 0;
        if (Parms) {
            dx = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x0, 0);
            dy = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x4, 0);
            dz = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0x8, 0);
            scale = SafeReadFloat(reinterpret_cast<uint8_t*>(Parms) + 0xC, 0);
        }
        char buf[128];
        _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%.2f,%.2f,%.2f scale=%.2f", dx, dy, dz, scale);
        MpLog(std::string("[AddMovementInput] obj=") + (Object ? Object->GetFullName() : "null")
            + " dir=(" + buf + ")");
    }
    if (Function && FunctionName.contains("SetMovementMode") && Parms) {
        uint8_t newMode = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 0, 0xEE);
        MpLog(std::string("[SetMovementMode] obj=") + (Object ? Object->GetFullName() : "null")
            + " newMode=" + std::to_string(newMode));
    }
    if (Function && FunctionName.contains("K2_OnMovementModeChanged") && Parms) {
        
        uint8_t prev = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 0, 0xEE);
        uint8_t next = SafeReadByte(reinterpret_cast<uintptr_t>(Parms), 1, 0xEE);
        MpLog(std::string("[K2_OnMovementModeChanged] obj=") + (Object ? Object->GetFullName() : "null")
            + " prev=" + std::to_string(prev) + " new=" + std::to_string(next));
    }

    
    
    
    
    
    
    
    if (Function && Parms && FunctionName.contains("BP_PlayerCharacter_C.InpAxisEvt_")) {
        float axisValue = SafeReadFloat(Parms, 0.f);
        
        
        

        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        bool isForward = FunctionName.contains("InpAxisEvt_MoveForward");
        bool isRight   = FunctionName.contains("InpAxisEvt_MoveRight");
        if ((isForward || isRight) && Object && s_LastPossessedPC
            && (axisValue > 0.05f || axisValue < -0.05f))
        {
            float yawDeg = SafeReadFloat(
                reinterpret_cast<uint8_t*>(s_LastPossessedPC) + 0x288 + 4, 0.f);
            float yawRad = yawDeg * 0.01745329252f; 
            float cosY = std::cos(yawRad);
            float sinY = std::sin(yawRad);
            float dirX, dirY;
            if (isForward) {
                
                dirX = cosY;
                dirY = sinY;
            } else {
                
                
                
                
                dirX = -sinY;
                dirY = cosY;
            }

            
            

            
            
            
            
            
            
            
            
            uintptr_t pawnAddr = reinterpret_cast<uintptr_t>(Object);
            uintptr_t charMove = SafeReadPtr(pawnAddr, 0x0288);
            if (charMove) {
                float speed = 500.0f;
                float vx = dirX * speed * axisValue;
                float vy = dirY * speed * axisValue;
                
                
                
                
                
                
                
                
                static int s_velLogCount = 0;
                if (++s_velLogCount <= 1) {
                    char buf[128];
                    _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                        "DISABLED — target=(%.1f,%.1f) via %s (server RemoteRole fix should suffice)",
                        vx, vy, isForward ? "MoveForward" : "MoveRight");
                    MpLog(std::string("[ForceVelocity] ") + buf);
                }
            }

            
            
            
            
            
            
            static int s_tpDisabledLogCount = 0;
            if (++s_tpDisabledLogCount == 1) {
                MpLog("[ForceTeleport] DISABLED — relying on server-side RemoteRole fix");
            }
        }
    }

    
    
    
    
    if (Function && Object
        && FunctionName == "Function Engine.PlayerController.ClientRestart")
    {
        UObject* NewPawn = Parms
            ? reinterpret_cast<UObject*>(SafeReadPtr(reinterpret_cast<uintptr_t>(Parms), 0))
            : nullptr;
        const bool NewPossession = Object != s_LastPossessedPC || NewPawn != s_LastRestartPawn;
        s_LastPossessedPC = Object;
        s_LastRestartPawn = NewPawn;
        
        
        
        if (NewPossession) {
            s_LastPossessedAtMs = GetTickCount64();
            s_ArchonInputActivated = false;
            s_ProgressionHudRefreshPending = true;
            s_ProgressionHudRefreshAttempts = 0;
            
            
            s_ProgressionHudRefreshNotBeforeMs = s_LastPossessedAtMs + 1500;
        }
        MpLog(std::string("[ClientRestartObserved] PC=") + Object->GetFullName()
            + " pawn=" + MpPtr(NewPawn)
            + " newPossession=" + std::to_string(NewPossession ? 1 : 0)
            + " activationRearmed=" + std::to_string(NewPossession ? 1 : 0)
            + " progressionHudRefreshRearmed=" + std::to_string(NewPossession ? 1 : 0));
    }
}

static int NumTimesOnAirshipUpdated = 0;
bool DidDoTravelReset = false;






static uint8_t SafeReadByte(uintptr_t base, uintptr_t offset, uint8_t fallback) {
    __try {
        return *reinterpret_cast<uint8_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return fallback;
    }
}



static bool SafeWriteByte(uintptr_t base, uintptr_t offset, uint8_t value) {
    __try {
        *reinterpret_cast<uint8_t*>(base + offset) = value;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}



static float SafeReadFloat(void* addr, float fallback) {
    __try {
        return *reinterpret_cast<float*>(addr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return fallback;
    }
}



static uintptr_t SafeReadPtr(uintptr_t base, uintptr_t offset) {
    __try {
        return *reinterpret_cast<uintptr_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

























enum class HudFnCallResult { Ok, NotFound, Faulted };
static HudFnCallResult CallHudLifecycleFunctionGuarded(UObject* HudObject, const char* Outer, const char* FuncName) {
    __try {
        if (!HudObject || !HudObject->Class) return HudFnCallResult::NotFound;
        UFunction* Fn = HudObject->Class->GetFunction(Outer, FuncName);
        if (!Fn) return HudFnCallResult::NotFound;
        if (OrigProcessEventClient) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(HudObject, Fn, nullptr);
        }
        return HudFnCallResult::Ok;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return HudFnCallResult::Faulted;
    }
}

static void ReconcileAirshipGameplayHUD(const char* TriggerLabel) {
    if (Globals::AmServer || !OrigProcessEventClient || !s_AirshipHUD || !s_AirshipGameState) return;
    
    
    
    
    
    
    if (!IsRegisteredLiveObject(s_AirshipHUD) || !IsRegisteredLiveObject(s_AirshipGameState)) {
        s_AirshipHUD = nullptr;
        s_AirshipGameState = nullptr;
        return;
    }
    if (!IsReadablePointer(s_AirshipHUD, 0x522)
        || !IsReadablePointer(s_AirshipGameState, 0x2D1)
        || !s_AirshipHUD->Class) {
        return;
    }

    const uint8_t InPreMatchAirship = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipGameState), 0x2D0, 0xEE);
    const uint8_t VisibilityBefore = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);
    const uint8_t AirshipUIActive = SafeReadByte(
        reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x520, 0xEE);

    if (InPreMatchAirship == 1) {
        const HudFnCallResult HideResult = CallHudLifecycleFunctionGuarded(s_AirshipHUD, "ArchonHUD", "HideGameplayHUD");
        if (HideResult == HudFnCallResult::Faulted) {
            MpLog(std::string("[AirshipHUD] FAULTED calling HideGameplayHUD trigger=") + TriggerLabel
                + " hud=" + MpPtr(s_AirshipHUD)
                + " (stale pointer, likely a level travel repurposed this object's memory) - caught, skipping");
            return;
        }
        if (HideResult == HudFnCallResult::NotFound) {
            static bool s_LoggedMissingHide = false;
            if (!s_LoggedMissingHide) {
                s_LoggedMissingHide = true;
                MpLog("[AirshipHUD] HideGameplayHUD UFunction not found");
            }
            return;
        }

        const uint8_t VisibilityAfter = SafeReadByte(
            reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);

        static int s_HideLogCount = 0;
        if (!s_AirshipHUDCompatHidden || VisibilityBefore != VisibilityAfter || s_HideLogCount == 0) {
            if (s_HideLogCount++ < 32) {
                MpLog(std::string("[AirshipHUD] HIDE trigger=") + TriggerLabel
                    + " hud=" + MpPtr(s_AirshipHUD)
                    + " gameState=" + MpPtr(s_AirshipGameState)
                    + " inPreMatchAirship=1"
                    + " airshipUIActive=" + std::to_string(AirshipUIActive)
                    + " gameplayVisibility=" + std::to_string(VisibilityBefore)
                    + "->" + std::to_string(VisibilityAfter));
            }
        }
        s_AirshipHUDCompatHidden = true;
        return;
    }

    if (InPreMatchAirship == 0 && s_AirshipHUDCompatHidden) {
        const HudFnCallResult ShowResult = CallHudLifecycleFunctionGuarded(s_AirshipHUD, "ArchonHUD", "ShowGameplayHUD");
        if (ShowResult == HudFnCallResult::Faulted) {
            MpLog(std::string("[AirshipHUD] FAULTED calling ShowGameplayHUD trigger=") + TriggerLabel
                + " hud=" + MpPtr(s_AirshipHUD)
                + " (stale pointer, likely a level travel repurposed this object's memory) - caught, skipping");
            return;
        }
        if (ShowResult == HudFnCallResult::NotFound) {
            static bool s_LoggedMissingShow = false;
            if (!s_LoggedMissingShow) {
                s_LoggedMissingShow = true;
                MpLog("[AirshipHUD] ShowGameplayHUD UFunction not found");
            }
            return;
        }

        const uint8_t VisibilityAfter = SafeReadByte(
            reinterpret_cast<uintptr_t>(s_AirshipHUD), 0x361, 0xEE);
        MpLog(std::string("[AirshipHUD] RESTORE trigger=") + TriggerLabel
            + " hud=" + MpPtr(s_AirshipHUD)
            + " gameState=" + MpPtr(s_AirshipGameState)
            + " inPreMatchAirship=0"
            + " airshipUIActive=" + std::to_string(AirshipUIActive)
            + " gameplayVisibility=" + std::to_string(VisibilityBefore)
            + "->" + std::to_string(VisibilityAfter));
        s_AirshipHUDCompatHidden = false;
    }
}




static int SafeReadU8At(uintptr_t base, uintptr_t offset) {
    __try {
        return static_cast<int>(*reinterpret_cast<uint8_t*>(base + offset));
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}



static int32_t SafeReadI32At(uintptr_t base, uintptr_t offset) {
    __try {
        return *reinterpret_cast<int32_t*>(base + offset);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}


























static void TickProgressionHudRefreshHeartbeat() {
    static uint64_t s_calls = 0;
    static uint64_t s_lastHeartbeatMs = 0;
    ++s_calls;
    const uint64_t Now = GetTickCount64();
    if (s_lastHeartbeatMs != 0 && Now - s_lastHeartbeatMs < 5000) return;
    s_lastHeartbeatMs = Now;
    MpLog("[WeaponXP][HudInit][Heartbeat] calls=" + std::to_string(s_calls)
        + " pending=" + std::to_string(s_ProgressionHudRefreshPending ? 1 : 0)
        + " attempts=" + std::to_string(s_ProgressionHudRefreshAttempts)
        + " ArchonInputActivated=" + std::to_string(s_ArchonInputActivated ? 1 : 0)
        + " LastPossessedPC=" + MpPtr(s_LastPossessedPC));
}

static void TickProgressionHudRefreshInner() {
    if (!s_ProgressionHudRefreshPending) return;   

    
    
    
    
    
    
    
    
    
    
    
    static uint64_t s_lastGuardLogMs = 0;
    const uint64_t NowGuard = GetTickCount64();
    const bool GuardBlocked = Globals::AmServer || DiagNaturalMode() || !OrigProcessEventClient
        || !s_ArchonInputActivated || !s_LastPossessedPC;
    if (GuardBlocked) {
        if (s_lastGuardLogMs == 0 || NowGuard - s_lastGuardLogMs >= 2000) {
            s_lastGuardLogMs = NowGuard;
            MpLog("[WeaponXP][HudInit] blocked at top guard: AmServer="
                + std::to_string(Globals::AmServer ? 1 : 0)
                + " DiagNaturalMode=" + std::to_string(DiagNaturalMode() ? 1 : 0)
                + " OrigProcessEventClient=" + MpPtr(OrigProcessEventClient)
                + " ArchonInputActivated=" + std::to_string(s_ArchonInputActivated ? 1 : 0)
                + " LastPossessedPC=" + MpPtr(s_LastPossessedPC));
        }
        return;
    }

    const uint64_t Now = GetTickCount64();
    if (Now < s_ProgressionHudRefreshNotBeforeMs) return;

    
    
    
    
    
    
    
    
    
    
    
    constexpr uint32_t kMaxAttempts = 45;
    constexpr uint64_t kRetryDelayMs = 1000;
    ++s_ProgressionHudRefreshAttempts;
    s_ProgressionHudRefreshNotBeforeMs = Now + kRetryDelayMs;

    UObject* PC = s_LastPossessedPC;
    
    
    
    
    if (!IsRegisteredLiveObject(PC)) {
        s_ProgressionHudRefreshPending = false;
        return;
    }
    const uint8_t OnlineReady = SafeReadByte(reinterpret_cast<uintptr_t>(PC), 0xC59, 0xEE);
    if (OnlineReady != 1 || !PC->Class) {
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] giving up: player controller never became online-ready");
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    static UFunction* s_GetProgressionFn = nullptr;
    static UFunction* s_GetPlayerExperienceFn = nullptr;
    static UFunction* s_GetHUDFn = nullptr;
    if (!s_GetProgressionFn) {
        s_GetProgressionFn = PC->Class->GetFunction(
            "ArchonPlayerController", "GetProgressionComponent");
    }
    if (!s_GetPlayerExperienceFn) {
        s_GetPlayerExperienceFn = PC->Class->GetFunction(
            "ArchonPlayerController", "GetPlayerExperienceComponent");
    }
    if (!s_GetHUDFn) {
        s_GetHUDFn = PC->Class->GetFunction("PlayerController", "GetHUD");
    }

    UObject* Progression = nullptr;
    UObject* PlayerExperience = nullptr;
    UObject* HUD = nullptr;
    if (s_GetProgressionFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetProgressionFn, &Parms);
        Progression = Parms.ReturnValue;
    }
    if (s_GetPlayerExperienceFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetPlayerExperienceFn, &Parms);
        PlayerExperience = Parms.ReturnValue;
    }
    if (s_GetHUDFn) {
        struct { UObject* ReturnValue; } Parms = { nullptr };
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            PC, s_GetHUDFn, &Parms);
        HUD = Parms.ReturnValue;
    }

    const int ProgressionReady = Progression
        ? SafeReadU8At(reinterpret_cast<uintptr_t>(Progression), 0x290) : -1;
    int ExperienceCount = PlayerExperience
        ? SafeReadI32At(reinterpret_cast<uintptr_t>(PlayerExperience), 0x140) : -1;

    if (!Progression || !PlayerExperience || !HUD || ProgressionReady != 1) {
        if (s_ProgressionHudRefreshAttempts == 1
            || s_ProgressionHudRefreshAttempts == kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] waiting attempt="
                + std::to_string(s_ProgressionHudRefreshAttempts)
                + " progression=" + MpPtr(Progression)
                + " progressionReady=" + std::to_string(ProgressionReady)
                + " playerExperience=" + MpPtr(PlayerExperience)
                + " experienceCount=" + std::to_string(ExperienceCount)
                + " hud=" + MpPtr(HUD));
        }
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            MpLog("[WeaponXP][HudInit] giving up after bounded readiness retries");
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    bool InitializedExperiences = false;
    bool InitializeResult = true;
    if (ExperienceCount == 0 && PlayerExperience->Class) {
        UFunction* InitializeExperiencesFn = PlayerExperience->Class->GetFunction(
            "PlayerExperienceComponent", "InitializeExperiences");
        if (InitializeExperiencesFn) {
            struct {
                UObject* InProgressionComponent;
                bool ReturnValue;
                uint8_t Pad[7];
            } Parms = { Progression, false, {0, 0, 0, 0, 0, 0, 0} };
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                PlayerExperience, InitializeExperiencesFn, &Parms);
            InitializedExperiences = true;
            InitializeResult = Parms.ReturnValue;
            ExperienceCount = SafeReadI32At(
                reinterpret_cast<uintptr_t>(PlayerExperience), 0x140);
        }
    }

    if (ExperienceCount <= 0) {
        
        
        
        
        
        
        
        
        const uintptr_t ExperienceTablePtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PlayerExperience), 0x130);
        const uintptr_t ExperienceTrackTablePtr = SafeReadPtr(reinterpret_cast<uintptr_t>(PlayerExperience), 0x148);
        MpLog("[WeaponXP][HudInit] experience objects unavailable attempt="
            + std::to_string(s_ProgressionHudRefreshAttempts)
            + " initializeCalled=" + std::to_string(InitializedExperiences ? 1 : 0)
            + " initializeResult=" + std::to_string(InitializeResult ? 1 : 0)
            + " experienceCount=" + std::to_string(ExperienceCount)
            + " experienceTable=" + MpPtr(reinterpret_cast<void*>(ExperienceTablePtr))
            + " experienceTrackTable=" + MpPtr(reinterpret_cast<void*>(ExperienceTrackTablePtr)));
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    UFunction* ProgressionHudReadyFn = HUD->Class
        ? HUD->Class->GetFunction("BPH_ArchonHUD_C", "Progression HUD Ready") : nullptr;
    bool UsedComponentFallback = false;
    if (ProgressionHudReadyFn) {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
            HUD, ProgressionHudReadyFn, nullptr);
    }
    else if (Progression->Class) {
        ProgressionHudReadyFn = Progression->Class->GetFunction(
            "ProgressionComponent", "OnPlayerHUDReady");
        if (ProgressionHudReadyFn) {
            UsedComponentFallback = true;
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                Progression, ProgressionHudReadyFn, nullptr);
        }
    }

    if (!ProgressionHudReadyFn) {
        MpLog("[WeaponXP][HudInit] no Progression HUD Ready function found");
        if (s_ProgressionHudRefreshAttempts >= kMaxAttempts) {
            s_ProgressionHudRefreshPending = false;
        }
        return;
    }

    MpLog("[WeaponXP][HudInit] refreshed native progression HUD"
        " attempt=" + std::to_string(s_ProgressionHudRefreshAttempts)
        + " progressionReady=" + std::to_string(ProgressionReady)
        + " experienceCount=" + std::to_string(ExperienceCount)
        + " initializeCalled=" + std::to_string(InitializedExperiences ? 1 : 0)
        + " initializeResult=" + std::to_string(InitializeResult ? 1 : 0)
        + " componentFallback=" + std::to_string(UsedComponentFallback ? 1 : 0));
    s_ProgressionHudRefreshPending = false;

    
    ReconcileAirshipGameplayHUD("progression-hud-refresh");
}








static bool TickProgressionHudRefreshGuarded() {
    __try {
        TickProgressionHudRefreshInner();
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static void TickProgressionHudRefresh() {
    TickProgressionHudRefreshHeartbeat();   
    if (!TickProgressionHudRefreshGuarded()) {
        MpLog("[WeaponXP][HudInit] FAULTED (stale pointer, likely a level travel repurposed the"
            " cached player controller) - caught, giving up for this session instead of crashing");
        s_ProgressionHudRefreshPending = false;
    }
}





static std::string SafeGetFullNameOf(UObject* ) {
    
    
    return "";
}


static bool SafeWriteFloat(uintptr_t base, uintptr_t offset, float value) {
    __try {
        *reinterpret_cast<float*>(base + offset) = value;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void* OrigProcessEvent = nullptr;




static bool SafeSetClientWorldPackageName(void* NetConn, uint64_t FNameValue) {
    using SetCWPNFn = void(__fastcall*)(void*, uint64_t);
    auto SetCWPN = reinterpret_cast<SetCWPNFn>(Globals::BaseAddress + 0x03D64090);
    __try {
        SetCWPN(NetConn, FNameValue);
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}


































static std::string CoreCapFString(void* fstr) {
    if (!IsReadablePointer(fstr, 0x0C)) return "";
    wchar_t* Data = *reinterpret_cast<wchar_t**>(fstr);
    int32_t Num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(fstr) + 0x8);
    if (!Data || Num <= 0 || Num > 1024 || !IsReadablePointer(Data, 2)) return "";
    std::string Out;
    Out.reserve(Num);
    for (int i = 0; i < Num && Data[i] != L'\0'; ++i) Out += static_cast<char>(Data[i] & 0xFF);
    return Out;
}






static bool IsEscalationFlowFunction(const std::string& FunctionName) {
    const char* Markers[] = {
        "EscalationGameModeComponent.SpawnPlayerBuffChoicesForFinishedRound",
        "EscalationGameModeComponent.OnPlayerActivatedCrystal",
        "EscalationGameModeComponent.PlayerChoseRelic",
        "EscalationGameModeComponent.PlayerEscalationRelicsChanged",
        "EscalationGameModeComponent.RelicSelectedBP",
        "EscalationGameModeComponent.SpawnAllRelics",
        "EscalationGameModeComponent.SpawnRelics",
        "EscalationGameModeComponent.SpawnSpecificRelic",
        "EscalationGameModeComponent.SpawnPersonalBuffPickupsForPlayer",
        "PlayerEscalationComponent.ClientDisplayRelicChoiceUI",
        "PlayerEscalationComponent.OnRep_EscalationRelics",
        "PlayerEscalationComponent.OnShowRelicChoiceScreen",
        "PlayerEscalationComponent.RoundEnded",
        "PlayerEscalationComponent.SelectRelicOption",
        "PlayerEscalationComponent.ServerSelectRelicOption",
        "PlayerEscalationComponent.ServerForceReplication",
        "PlayerEscalationComponent.RelicSelectedNative",
        "PlayerEscalationComponent.OnRelicSelected",
        "escalation_buff_gatherable_bp_C.OnInteractionEnabled",
        "escalation_buff_gatherable_bp_C.OnCrystalActivated",
        "escalation_buff_gatherable_bp_C.Failsafe_EnableInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCanceledInteraction",
        "escalation_buff_gatherable_bp_C.OnUserStartedInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCompletedInteraction",
        "escalation_buff_gatherable_bp_C.AuthEnableInteractable",
        "EscalationRelicChoiceScreen.EnableRelicInteractions",
        "EscalationRelicChoiceScreen.HandleRelicSelected",
        "escalation_relic_choice_screen_C.EnableRelicInteraction",
        "escalation_relic_choice_screen_C.BeginRelicAnimations"
    };
    for (const char* Marker : Markers) {
        if (FunctionName.find(Marker) != std::string::npos) return true;
    }
    return false;
}

static UObject* ResolveEscalationFlowPlayer(UObject* Object, const std::string& FunctionName,
                                            void* Parms, const char* Side) {
    const bool FirstParamIsPlayer =
        FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos;
    if (FirstParamIsPlayer && Parms && IsReadablePointer(Parms, sizeof(void*))) {
        UObject* Player = *reinterpret_cast<UObject**>(Parms);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    
    if (Object && FunctionName.find("escalation_buff_gatherable_bp_C.") != std::string::npos
        && IsReadablePointer(Object, 0x500)) {
        UObject* Player = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Object) + 0x4F8);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    
    
    UObject* Cursor = Object;
    for (int Depth = 0; Cursor && Depth < 4; ++Depth) {
        if (IsReadablePointer(Cursor, 0x28)
            && Cursor->IsA(SDK::APlayerController::StaticClass())) return Cursor;
        Cursor = IsReadablePointer(Cursor, 0x28) ? Cursor->Outer : nullptr;
    }

    
    
    if (Side && strcmp(Side, "Client") == 0 && s_LastPossessedPC
        && IsReadablePointer(s_LastPossessedPC, 0x258)) return s_LastPossessedPC;
    return nullptr;
}

static std::string EscalationArrayState(UObject* Object) {
    if (!Object || !IsReadablePointer(Object, 0x158)
        || !Object->IsA(SDK::UPlayerEscalationComponent::StaticClass())) return "component=n/a";
    const uintptr_t Base = reinterpret_cast<uintptr_t>(Object);
    const int Seasons = SafeReadI32At(Base, 0x128);
    const int SeasonsMax = SafeReadI32At(Base, 0x12C);
    const int Choices = SafeReadI32At(Base, 0x138);
    const int ChoicesMax = SafeReadI32At(Base, 0x13C);
    const int Options = SafeReadI32At(Base, 0x148);
    const int OptionsMax = SafeReadI32At(Base, 0x14C);
    const int Rewards = SafeReadI32At(Base, 0x150);
    return "component=" + MpPtr(Object)
        + " seasons=" + std::to_string(Seasons) + "/" + std::to_string(SeasonsMax)
        + " choices=" + std::to_string(Choices) + "/" + std::to_string(ChoicesMax)
        + " options=" + std::to_string(Options) + "/" + std::to_string(OptionsMax)
        + " roundRewards=" + std::to_string(Rewards);
}

static std::string EscalationFlowParams(const std::string& FunctionName, void* Parms) {
    if (!Parms) return "none";
    const uintptr_t P = reinterpret_cast<uintptr_t>(Parms);
    if (FunctionName.find("ClientDisplayRelicChoiceUI") != std::string::npos) {
        return "relicOptions=" + std::to_string(SafeReadI32At(P, 0x8))
            + " debugChances=" + std::to_string(SafeReadI32At(P, 0x18))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x20));
    }
    if (FunctionName.find("SelectRelicOption") != std::string::npos) {
        std::string RelicId = IsReadablePointer(Parms, 0x8)
            ? reinterpret_cast<SDK::FName*>(Parms)->ToString() : std::string("?");
        return "relicId=" + RelicId + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    if (FunctionName.find("OnShowRelicChoiceScreen") != std::string::npos
        || FunctionName.find("HandleRelicSelected") != std::string::npos
        || FunctionName.find("OnUserStartedInteraction") != std::string::npos
        || FunctionName.find("OnUserCompletedInteraction") != std::string::npos
        || FunctionName.find("OnUserCanceledInteraction") != std::string::npos) {
        return "arg0=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    return "present";
}

static std::string EscalationFlowContext(UObject* Object, const std::string& FunctionName,
                                         void* Parms, const char* Side) {
    UObject* Player = ResolveEscalationFlowPlayer(Object, FunctionName, Parms, Side);
    void* PlayerState = (Player && IsReadablePointer(Player, 0x230))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Player) + 0x228) : nullptr;
    const std::string PlayerName = (PlayerState && IsReadablePointer(PlayerState, 0x310))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x300))
        : std::string();
    UObject* Outer = (Object && IsReadablePointer(Object, 0x28)) ? Object->Outer : nullptr;
    return " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
        + " outer=" + MpPtr(Outer) + "/" + SafeObjectNameForDiagnostic(Outer)
        + " player=" + MpPtr(Player) + "/" + SafeObjectNameForDiagnostic(Player)
        + " playerState=" + MpPtr(PlayerState)
        + " playerName=" + (PlayerName.empty() ? std::string("?") : PlayerName)
        + " state={" + EscalationArrayState(Object) + "}"
        + " params={" + EscalationFlowParams(FunctionName, Parms) + "}";
}

static int TraceEscalationFlowEnter(const char* Side, UObject* Object,
                                    const std::string& FunctionName, void* Parms) {
    if (!IsEscalationFlowFunction(FunctionName)) return -1;
    static std::atomic<int> s_EscalationFlowSequence{ 0 };
    const int Seq = s_EscalationFlowSequence.fetch_add(1, std::memory_order_relaxed);
    if (Seq >= 512) return -1;
    MpLog(std::string("[EscalationFlow][") + Side + "][ENTER #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
    return Seq;
}

static void TraceEscalationFlowExit(const char* Side, int Seq, UObject* Object,
                                   const std::string& FunctionName, void* Parms) {
    if (Seq < 0) return;
    MpLog(std::string("[EscalationFlow][") + Side + "][EXIT #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
}




static bool CoreCaptureEnabled() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"CORE_CAPTURE.flag") ? 1 : 0;
    return c == 1;
}

void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    static thread_local int s_processEventDepth = 0;
    static thread_local UFunction* s_peStack[64] = {};   
    struct DepthGuard {
        DepthGuard(UFunction* f)  { if (s_processEventDepth >= 0 && s_processEventDepth < 64) s_peStack[s_processEventDepth] = f; ++s_processEventDepth; }
        ~DepthGuard() { --s_processEventDepth; }
    } g_depthGuard(Function);

    if (s_processEventDepth > 32) {
        static thread_local bool s_reportedRecursion = false;
        if (!s_reportedRecursion) {
            s_reportedRecursion = true;
            std::string FunctionName = Function ? Function->GetFullName() : "null";
            std::string ObjectName = Object ? Object->GetFullName() : "null";
            MpLog("[ProcessEventHook] REENTRANCY-GUARD tripped (depth="
                + std::to_string(s_processEventDepth) + ") — ABSORBING call. "
                + "fn=" + FunctionName + " obj=" + ObjectName);
        }
        return;   
    }

    static UFunction* ServerTryActivateAbilityWithEventData = nullptr;
    static UFunction* ServerTryActivateAbility = nullptr;
    static UFunction* OnAirshipUpdated = nullptr;
    static UFunction* OnPostMitDealtAnyDamage = nullptr;

    std::string FunctionName = Function ? Function->GetFullName() : "null";
    const int EscalationFlowServerSeq = TraceEscalationFlowEnter(
        "Server", Object, FunctionName, Parms);

    
    
    
    
    int WeaponXpServerGrantSeq = -1;
    Params::PlayerExperienceComponent_GrantWeaponExperience* WeaponXpServerGrant = nullptr;
    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.HandleBehemothKilled") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_HandleBehemothKilled))) {
        static std::atomic<int> s_weaponXpServerKillCount{ 0 };
        int Seq = s_weaponXpServerKillCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 128) {
            auto* KillParms = reinterpret_cast<Params::PlayerExperienceComponent_HandleBehemothKilled*>(Parms);
            void* Behemoth = KillParms->Behemoth;
            void* ThreatComponent = (Behemoth && IsReadablePointer(Behemoth, 0x67C))
                ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Behemoth) + 0x5E8) : nullptr;
            int32_t ContentLevel = (ThreatComponent && IsReadablePointer(ThreatComponent, 0x10C))
                ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(ThreatComponent) + 0x108) : -1;
            float GlobalPower = (Behemoth && IsReadablePointer(Behemoth, 0x67C))
                ? *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(Behemoth) + 0x678) : -1.0f;
            MpLog("[WeaponXP][ServerKill] seq=" + std::to_string(Seq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " behemoth=" + MpPtr(Behemoth) + "/" + SafeObjectNameForDiagnostic(Behemoth)
                + " threat=" + MpPtr(ThreatComponent)
                + " contentLevel=" + std::to_string(ContentLevel)
                + " globalPower=" + std::to_string(GlobalPower));
        }
    }

    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.GrantWeaponExperience") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_GrantWeaponExperience))) {
        static std::atomic<int> s_weaponXpServerGrantCount{ 0 };
        WeaponXpServerGrantSeq = s_weaponXpServerGrantCount.fetch_add(1, std::memory_order_relaxed);
        if (WeaponXpServerGrantSeq < 256) {
            WeaponXpServerGrant = reinterpret_cast<Params::PlayerExperienceComponent_GrantWeaponExperience*>(Parms);
            MpLog("[WeaponXP][ServerGrant] ENTER seq=" + std::to_string(WeaponXpServerGrantSeq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " type=" + std::to_string(static_cast<int>(WeaponXpServerGrant->WeaponXPType))
                + " base=" + std::to_string(WeaponXpServerGrant->BaseAmount)
                + " bonus=" + std::to_string(WeaponXpServerGrant->BonusAmount));
        }
    }

    if (Function && Parms
        && FunctionName.find("PlayerExperienceComponent.GrantPlayerExperience") != std::string::npos
        && IsReadablePointer(Parms, sizeof(Params::PlayerExperienceComponent_GrantPlayerExperience))) {
        static std::atomic<int> s_playerXpServerGrantCount{ 0 };
        int Seq = s_playerXpServerGrantCount.fetch_add(1, std::memory_order_relaxed);
        if (Seq < 256) {
            auto* PlayerGrant = reinterpret_cast<Params::PlayerExperienceComponent_GrantPlayerExperience*>(Parms);
            MpLog("[WeaponXP][ServerPlayerGrant] ENTER seq=" + std::to_string(Seq)
                + " component=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
                + " amount=" + std::to_string(PlayerGrant->Amount));
        }
    }

    
    
    int TempestPerfectDodgeServerSeq = -1;
    if (Function && FunctionName.find("PerfectDodge") != std::string::npos) {
        static std::atomic<int> s_tempestPerfectDodgeServerCount{ 0 };
        TempestPerfectDodgeServerSeq = s_tempestPerfectDodgeServerCount.fetch_add(1, std::memory_order_relaxed);
        if (TempestPerfectDodgeServerSeq < 64) {
            MpLog("[TempestPerfectDodge][Server] ENTER seq=" + std::to_string(TempestPerfectDodgeServerSeq)
                + " fn=" + FunctionName + " obj=" + MpPtr(Object) + "/"
                + SafeObjectNameForDiagnostic(Object));
        }
    }

    
    
    
    BleedoutNoteEvent(FunctionName, Object);

    
    
    
    
    
    {
        uint32_t gt = g_wdGameThreadId.load(std::memory_order_relaxed);
        if (gt == 0 || GetCurrentThreadId() == gt) {
            g_gtPeCurFunc.store(Function, std::memory_order_relaxed);
            g_gtPeCurObj.store(Object, std::memory_order_relaxed);
            if (VerboseDiag()) {
                uint32_t p = g_gtPeRingPos.fetch_add(1, std::memory_order_relaxed) % kPeRing;
                strncpy_s(g_gtPeNameRing[p], sizeof(g_gtPeNameRing[p]), FunctionName.c_str(), _TRUNCATE);
            }
        }
    }

    
    
    
    
    if (Function && Parms && CoreCaptureEnabled()) {
        auto DumpQtyArray = [](void* arrBase) -> std::string {
            
            
            if (!IsReadablePointer(arrBase, 0x0C)) return "[?]";
            void* Data = *reinterpret_cast<void**>(arrBase);
            int32_t Num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(arrBase) + 0x8);
            if (!Data || Num < 0 || Num > 256) return "[?]";
            std::string Out = "[";
            for (int i = 0; i < Num; ++i) {
                uintptr_t Elem = reinterpret_cast<uintptr_t>(Data) + static_cast<uintptr_t>(i) * 0x18;
                if (!IsReadablePointer(reinterpret_cast<void*>(Elem), 0x14)) { Out += (i ? ", ?" : "?"); continue; }
                std::string Item = CoreCapFString(reinterpret_cast<void*>(Elem));
                int32_t Amt = *reinterpret_cast<int32_t*>(Elem + 0x10);
                if (i) Out += ", ";
                Out += Item + " x" + std::to_string(Amt);
            }
            return Out + "]";
        };

        if (FunctionName.find("GrantAndConsumeItemsWithQuantity") != std::string::npos) {
            
            MpLog("[CORE-CAP] GrantAndConsumeItemsWithQuantity obj=" + MpPtr(Object)
                + " grant=" + DumpQtyArray(Parms)
                + " consume=" + DumpQtyArray(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10))
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x20)));
        }
        else if (FunctionName.find("ServerConsumeItem") != std::string::npos) {
            
            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x10) : 0;
            MpLog("[CORE-CAP] ServerConsumeItem instanceId=" + CoreCapFString(Parms)
                + " amount=" + std::to_string(Amt)
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x18)));
        }
        else if (FunctionName.find("InventoryConsumeItem") != std::string::npos) {
            
            int32_t Idx = IsReadablePointer(Parms, 4) ? *reinterpret_cast<int32_t*>(Parms) : -1;
            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x04), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x04) : 0;
            MpLog("[CORE-CAP] InventoryConsumeItem itemIndex=" + std::to_string(Idx) + " amount=" + std::to_string(Amt));
        }
        else if (FunctionName.find("ConsumeItem") != std::string::npos) {
            
            void* Item = *reinterpret_cast<void**>(Parms);
            int32_t Amt = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x08), 4) ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Parms) + 0x08) : 0;
            std::string InstId = IsReadablePointer(Item, 0x98) ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Item) + 0x88)) : std::string("?");
            MpLog("[CORE-CAP] ConsumeItem item=" + MpPtr(Item) + " instanceId=" + InstId
                + " amount=" + std::to_string(Amt)
                + " source=" + CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Parms) + 0x10)));
        }
    }

    
    
    {
        static std::atomic<bool> s_postLoginAnchor{ false };
        if (Function && FunctionName.find("K2_PostLogin") != std::string::npos) {
            bool expected = false;
            if (s_postLoginAnchor.compare_exchange_strong(expected, true)) {
                g_postLoginTimeMs.store(GetTickCount64(), std::memory_order_relaxed);
            }
        }
    }

    
    
    
    
    
    if (Function && FunctionName.find("PostLogin") != std::string::npos) {
        static std::atomic<int> s_plSeq{ 0 };
        int Seq = s_plSeq.fetch_add(1, std::memory_order_relaxed);
        std::string ObjName = (Object && IsReadablePointer(Object, 0x40)) ? Object->GetName() : std::string("?");
        std::string Extra;
        if (Parms && FunctionName.find("K2_PostLogin") != std::string::npos) {
            void* NewPlayer = *reinterpret_cast<void**>(Parms);
            std::string PcName = (NewPlayer && IsReadablePointer(NewPlayer, 0x40)) ? reinterpret_cast<UObject*>(NewPlayer)->GetName() : std::string("?");
            Extra = " newPlayer=" + MpPtr(NewPlayer) + "/" + PcName;
            
            
            g_pawnDiagCount.store(0, std::memory_order_relaxed);
        }
        MpLog("[PostLoginPE #" + std::to_string(Seq) + "] fn=" + FunctionName
            + " obj=" + MpPtr(Object) + "/" + ObjName + Extra);
        LogArchonLifecycle(("PostLoginPE#" + std::to_string(Seq)).c_str());
    }

    
    
    
    
    
    void* AckCapturePc = nullptr;
    void* AckPawnBefore = nullptr;
    if (Function &&
        (FunctionName.find("AcknowledgePossession") != std::string::npos
            || FunctionName.find("CheckClientPossession") != std::string::npos
            || FunctionName.find("AcknowledgePawn") != std::string::npos)) {
        std::string PossObjName = (Object && IsReadablePointer(Object, 0x420)) ? Object->GetName() : std::string("?");
        void* pawnParam = (Parms && FunctionName.find("AcknowledgePossession") != std::string::npos) ? *reinterpret_cast<void**>(Parms) : nullptr;
        void* pcPawn = nullptr; void* ackPawn = nullptr; void* netConn = nullptr;
        if (Object && IsReadablePointer(Object, 0x420)) {
            uintptr_t Pc = reinterpret_cast<uintptr_t>(Object);
            pcPawn  = *reinterpret_cast<void**>(Pc + 0x250);
            ackPawn = *reinterpret_cast<void**>(Pc + 0x2A0);
            netConn = *reinterpret_cast<void**>(Pc + 0x418);
            if (FunctionName.find("AcknowledgePossession") != std::string::npos) { AckCapturePc = Object; AckPawnBefore = ackPawn; }
        }
        MpLog("[PossessionRPC] fn=" + FunctionName + " pc=" + MpPtr(Object) + "/" + PossObjName
            + " netConn=" + MpPtr(netConn)
            + " pawnParam=" + MpPtr(pawnParam)
            + " PC.Pawn=" + MpPtr(pcPawn)
            + " AcknowledgedPawn(before)=" + MpPtr(ackPawn));
    }

    
    

    
    
    
    

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    

    


    


    


    


    
    


    if (Function && FunctionName.find("vendor_interactive_bp_C.UpdateCameraForAspect")
        != std::string::npos)
    {
        static std::atomic<int> s_vendorAbsorbCount{0};
        int slot = s_vendorAbsorbCount.fetch_add(1, std::memory_order_relaxed);
        if (slot < 3 || (slot % 60) == 0) {
            MpLog("[VendorFix] Absorbed UpdateCameraForAspect on server (slot="
                + std::to_string(slot) + ") — avoids GetCurrentScreenAspectRatio 0/0");
        }
        return;   
    }

    


    


    


    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    if (Function && (FunctionName == "Function Engine.PlayerController.ClientRestart"
                     || FunctionName == "Function Engine.PlayerController.ClientRetryClientRestart")) {
        const int PAWN_DIAG_BUDGET = 8;   
        int slot = g_pawnDiagCount.fetch_add(1, std::memory_order_relaxed);
        if (Parms && IsReadablePointer(Parms, 0x8)) {
            UObject* PawnObj = *reinterpret_cast<UObject**>(Parms);   

            
            bool     patchApplied = false;
            uint8_t  before_58 = 0, after_58 = 0;
            uint8_t  before_dorm = 0xFF, after_dorm = 0xFF;
            float    before_freq = 0.0f, after_freq = 0.0f;
            float    before_prio = 0.0f, after_prio = 0.0f;
            uint8_t  before_remoteRole = 0xFF, after_remoteRole = 0xFF;
            if (PawnObj && IsReadablePointer(PawnObj, 0x120)) {
                uint8_t* byte58 = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x58);
                uint8_t* byteDorm = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0xF1);
                float*   fFreq   = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x108);
                float*   fPrio   = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x110);
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                
                uint8_t* byteRemoteRole = reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5F);
                before_58 = *byte58;
                before_dorm = *byteDorm;
                before_freq = *fFreq;
                before_prio = *fPrio;
                before_remoteRole = *byteRemoteRole;
                
                
                
                
                
                
                
                
                
                if (!OwnerPawnRelevancyFix()) {
                    *byte58 = *byte58 | 0x08;   
                }
                *byteDorm = 0;              
                if (*fFreq < 60.0f) *fFreq = 60.0f;
                if (*fPrio < 3.0f)  *fPrio = 3.0f;
                *byteRemoteRole = 2;        
                after_58 = *byte58;
                after_dorm = *byteDorm;
                after_freq = *fFreq;
                after_prio = *fPrio;
                after_remoteRole = *byteRemoteRole;
                patchApplied = true;
            }

            
            
            
            
            
            
            
            
            
            if (OwnerPawnRelevancyFix() && PawnObj && Object && IsReadablePointer(Object, 0x420)) {
                void* netConn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x418);
                if (netConn && IsReadablePointer(netConn, 0x98)) {
                    void** connViewTarget = reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(netConn) + 0x90);
                    if (*connViewTarget != reinterpret_cast<void*>(PawnObj)) {
                        static std::atomic<int> s_vtLog{ 0 };
                        if (s_vtLog.fetch_add(1, std::memory_order_relaxed) < 8)
                            MpLog("[OwnerPawnRelevancy] conn=" + MpPtr(netConn) + " ViewTarget "
                                + MpPtr(*connViewTarget) + " -> pawn " + MpPtr(PawnObj) + " (per-connection relevancy)");
                        *connViewTarget = reinterpret_cast<void*>(PawnObj);
                    }
                }
            }

            if (slot < PAWN_DIAG_BUDGET) {
                std::string pClass = "(null-pawn)";
                std::string pFullName = "(null-pawn)";
                uint8_t     pReplicatesByte = 0;
                uint8_t     pRemoteRole = 0xFF;
                uint8_t     pRole = 0xFF;
                UObject*    pOwner = nullptr;
                std::string pOwnerClass = "(none)";
                std::string pOwnerName = "(none)";

                if (PawnObj && IsReadablePointer(PawnObj, 0x110)) {
                    pFullName = PawnObj->GetFullName();
                    UObject* Cls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PawnObj) + 0x10);
                    if (Cls && IsReadablePointer(Cls, 0x20)) pClass = Cls->GetName();
                    pReplicatesByte = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5B);
                    pRemoteRole = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0x5F);
                    pRole = *reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(PawnObj) + 0xF0);
                    pOwner = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PawnObj) + 0xE0);
                    if (pOwner && IsReadablePointer(pOwner, 0x20)) {
                        pOwnerName = pOwner->GetFullName();
                        UObject* OwnerCls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(pOwner) + 0x10);
                        if (OwnerCls && IsReadablePointer(OwnerCls, 0x20)) pOwnerClass = OwnerCls->GetName();
                    }
                }

                void* pcPawn = nullptr;
                if (Object && IsReadablePointer(Object, 0x258)) {
                    pcPawn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Object) + 0x250);
                }

                bool bReplicates = (pReplicatesByte & 0x01) != 0;
                const char* remoteRoleName =
                    pRemoteRole == 0 ? "None" : pRemoteRole == 1 ? "SimulatedProxy" :
                    pRemoteRole == 2 ? "AutonomousProxy" : pRemoteRole == 3 ? "Authority" : "?";
                const char* roleName =
                    pRole == 0 ? "None" : pRole == 1 ? "SimulatedProxy" :
                    pRole == 2 ? "AutonomousProxy" : pRole == 3 ? "Authority" : "?";

                MpLog("[PAWN #" + std::to_string(slot) + "] fn=" + FunctionName
                    + " pawn=" + MpPtr(PawnObj) + "/" + pClass
                    + " pcPawn(+0x250)=" + MpPtr(pcPawn)
                    + " match=" + std::to_string(pcPawn == PawnObj ? 1 : 0));
                MpLog("[PAWN #" + std::to_string(slot) + "] pawnFullName=" + pFullName);
                MpLog("[PAWN #" + std::to_string(slot) + "] bReplicates=" + std::to_string(bReplicates ? 1 : 0)
                    + " Role=" + std::string(roleName) + "(" + std::to_string(pRole) + ")"
                    + " RemoteRole=" + std::string(remoteRoleName) + "(" + std::to_string(pRemoteRole) + ")");
                MpLog("[PAWN #" + std::to_string(slot) + "] owner=" + MpPtr(pOwner) + "/" + pOwnerClass
                    + " ownerName=" + pOwnerName);
                MpLog("[PAWN #" + std::to_string(slot) + "] FORCE-REP patch applied=" + std::to_string(patchApplied ? 1 : 0)
                    + "  +0x58 before=0x" + std::to_string(before_58) + " after=0x" + std::to_string(after_58)
                    + " (bAlwaysRelevant bit3 mask 0x08)"
                    + "  NetDormancy before=" + std::to_string(before_dorm) + " after=" + std::to_string(after_dorm)
                    + "  NetUpdateFreq before=" + std::to_string(before_freq) + " after=" + std::to_string(after_freq)
                    + "  NetPriority before=" + std::to_string(before_prio) + " after=" + std::to_string(after_prio)
                    + "  RemoteRole before=" + std::to_string(before_remoteRole) + " after=" + std::to_string(after_remoteRole)
                    + " (2=AutonomousProxy)");
            }
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    static UFunction* CachedMustSpectate = nullptr;
    if ((CachedMustSpectate && Function == CachedMustSpectate) ||
        (!CachedMustSpectate && Function && FunctionName == "Function Engine.GameModeBase.MustSpectate")) {
        CachedMustSpectate = Function;
        if (Parms && IsReadablePointer(Parms, 0x10)) {
            UObject* PlayerObj = *reinterpret_cast<UObject**>(Parms);
            bool Ret = *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8);
            static std::atomic<int> s_msLog{0};
            if (s_msLog.fetch_add(1, std::memory_order_relaxed) < 20)
                MpLog("[MustSpectate] ret=" + std::to_string(Ret ? 1 : 0)
                    + " player=" + (PlayerObj ? PlayerObj->GetFullName() : "null"));
        }
    }

    
    static UFunction* CachedPlayerCanRestart = nullptr;
    if ((CachedPlayerCanRestart && Function == CachedPlayerCanRestart) ||
        (!CachedPlayerCanRestart && Function && FunctionName == "Function Engine.GameModeBase.PlayerCanRestart")) {
        CachedPlayerCanRestart = Function;

        if (Parms && IsReadablePointer(Parms, 0x10)) {
            UObject* PlayerObj = *reinterpret_cast<UObject**>(Parms);
            bool     PriorRet  = *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8);

            static std::atomic<int> s_diagLogCount{0};
            const int LOG_BUDGET = 5;

            
            UObject* ConnFrom298 = nullptr;   
            UObject* ConnFrom418 = nullptr;   
            std::string Class298 = "(none)";
            std::string Class418 = "(none)";

            if (PlayerObj && IsReadablePointer(PlayerObj, 0x420)) {
                ConnFrom298 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PlayerObj) + 0x298);
                ConnFrom418 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PlayerObj) + 0x418);

                if (ConnFrom298 && IsReadablePointer(ConnFrom298, 0x20)) {
                    UObject* ClsObj = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ConnFrom298) + 0x10);
                    if (ClsObj && IsReadablePointer(ClsObj, 0x20)) Class298 = ClsObj->GetName();
                }
                if (ConnFrom418 && IsReadablePointer(ConnFrom418, 0x20)) {
                    UObject* ClsObj = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(ConnFrom418) + 0x10);
                    if (ClsObj && IsReadablePointer(ClsObj, 0x20)) Class418 = ClsObj->GetName();
                }
            }

            
            UObject* NetConnObj = nullptr;
            std::string NetConnClass = "(none)";
            std::string ConnSource = "none";
            if (ConnFrom418) {
                
                NetConnObj = ConnFrom418;
                NetConnClass = Class418;
                ConnSource = "+0x418";
            }
            else if (ConnFrom298
                     && Class298.find("Connection") != std::string::npos
                     && Class298.find("local_player") == std::string::npos) {
                
                NetConnObj = ConnFrom298;
                NetConnClass = Class298;
                ConnSource = "+0x298";
            }

            
            std::string OuterChain;
            uint64_t WorldOutermostFName = 0;
            UObject* TopOuter = nullptr;
            if (PlayerObj) {
                UObject* Cur = PlayerObj;
                TopOuter = Cur;
                for (int hops = 0; hops < 8; ++hops) {
                    if (!IsReadablePointer(Cur, 0x28)) break;
                    if (!OuterChain.empty()) OuterChain += " -> ";
                    OuterChain += Cur->GetFullName();
                    UObject* Nxt = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Cur) + 0x20);
                    if (!Nxt) break;
                    TopOuter = Nxt;
                    Cur = Nxt;
                }
                if (TopOuter && IsReadablePointer(TopOuter, 0x20)) {
                    WorldOutermostFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(TopOuter) + 0x18);
                }
            }

            uint64_t ConnBeforeFName = 0;
            uint64_t ConnAfterFName  = 0;
            bool     SetterInvoked   = false;
            if (NetConnObj && IsReadablePointer(NetConnObj, 0x1608)) {
                ConnBeforeFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1600);
                if (WorldOutermostFName != 0) {
                    SetterInvoked = SafeSetClientWorldPackageName(NetConnObj, WorldOutermostFName);
                    ConnAfterFName = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1600);
                }
            }

            int slot = s_diagLogCount.fetch_add(1, std::memory_order_relaxed);
            if (slot < LOG_BUDGET) {
                MpLog("[CWPN #" + std::to_string(slot) + "] object=" + (Object ? Object->GetFullName() : std::string("null"))
                    + " player=" + MpPtr(PlayerObj)
                    + " conn+0x298=" + MpPtr(ConnFrom298) + "/" + Class298
                    + " conn+0x418=" + MpPtr(ConnFrom418) + "/" + Class418
                    + " chosen=" + ConnSource + "/" + NetConnClass);
                MpLog("[CWPN #" + std::to_string(slot) + "] outerChain: " + OuterChain);
                MpLog("[CWPN #" + std::to_string(slot) + "] topFName=" + std::to_string(WorldOutermostFName)
                    + " conn+0x1600 before=" + std::to_string(ConnBeforeFName)
                    + " setterInvoked=" + std::to_string(SetterInvoked ? 1 : 0)
                    + " conn+0x1600 after=" + std::to_string(ConnAfterFName));

                
                
                
                
                
                
                
                
                
                
                
                if (NetConnObj && IsReadablePointer(NetConnObj, 0xA0)) {
                    UObject* connPC   = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x30);
                    UObject* connDrv  = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x58);
                    UObject* viewTgt  = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    UObject* owning   = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x98);
                    int32_t  chNum    = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x78);
                    std::string connPCName  = (connPC  && IsReadablePointer(connPC,  0x20)) ? connPC->GetFullName()  : std::string("(null-or-unreadable)");
                    std::string viewTgtName = (viewTgt && IsReadablePointer(viewTgt, 0x20)) ? viewTgt->GetFullName() : std::string("(null-or-unreadable)");
                    std::string owningName  = (owning  && IsReadablePointer(owning,  0x20)) ? owning->GetFullName()  : std::string("(null-or-unreadable)");
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " PC(+0x30)=" + MpPtr(connPC) + "/" + connPCName);
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " OwningActor(+0x98)=" + MpPtr(owning) + "/" + owningName);
                    MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                        + " ViewTarget(+0x90)=" + MpPtr(viewTgt) + "/" + viewTgtName
                        + "  Driver(+0x58)=" + MpPtr(connDrv)
                        + "  OpenChannels.Num(+0x78)=" + std::to_string(chNum));

                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    if (IsReadablePointer(NetConnObj, 0x1D8)) {
                        int32_t sockState = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x134);
                        double  lastRecv  = *reinterpret_cast<double*>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x1D0);
                        const char* stateName =
                            sockState == 0 ? "Invalid" :
                            sockState == 1 ? "Closed" :
                            sockState == 2 ? "Pending" :
                            sockState == 3 ? "Open" : "?";

                        float   drvTime   = 0.0f;
                        UObject* repDriver = nullptr;
                        std::string repDriverClass = "(none)";
                        UObject* repDriver6F0 = nullptr;
                        std::string repDriver6F0Class = "(none)";
                        if (connDrv && IsReadablePointer(connDrv, 0x6F8)) {
                            drvTime = *reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(connDrv) + 0x210);
                            repDriver = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(connDrv) + 0x6E8);
                            if (repDriver && IsReadablePointer(repDriver, 0x20)) {
                                UObject* rdCls = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(repDriver) + 0x10);
                                if (rdCls && IsReadablePointer(rdCls, 0x20)) repDriverClass = rdCls->GetName();
                            }
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            repDriver6F0 = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(connDrv) + 0x6F0);
                            repDriver6F0Class = ""; 
                        }
                        double delta = static_cast<double>(drvTime) - lastRecv;

                        
                        
                        
                        
                        
                        
                        
                        std::string scanReport = "(disabled — see 1.12.0 fix note)";
                        MpLog("[CWPN #" + std::to_string(slot) + "] Driver-wider: " + scanReport);

                        MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                            + " State(+0x134)=" + std::string(stateName) + "(" + std::to_string(sockState) + ")"
                            + "  LastReceiveTime(+0x1D0)=" + std::to_string(lastRecv)
                            + "  Driver->Time(+0x210)=" + std::to_string(drvTime)
                            + "  delta=" + std::to_string(delta)
                            + "  freshOK=" + std::to_string(delta < 1.5 ? 1 : 0));
                        MpLog("[CWPN #" + std::to_string(slot) + "] CONN STATE:"
                            + " Driver->@+0x6E8=" + MpPtr(repDriver) + "/" + repDriverClass
                            + "  Driver->@+0x6F0=" + MpPtr(repDriver6F0) + "/" + repDriver6F0Class);
                    }

                    MpLog("[CWPN #" + std::to_string(slot) + "] pc_match_check: interceptPC=" + MpPtr(PlayerObj)
                        + "  connPC=" + MpPtr(connPC)
                        + "  same=" + std::to_string(PlayerObj == connPC ? 1 : 0));

                    
                    
                    
                    
                    
                    if (connDrv && IsReadablePointer(connDrv, 0x10)) {
                        void** driverVtable = *reinterpret_cast<void***>(connDrv);
                        if (driverVtable && IsReadablePointer(driverVtable, 0x400)) {
                            auto rva = [](void* p) -> uint64_t {
                                if (!p) return 0;
                                uintptr_t rvaVal = reinterpret_cast<uintptr_t>(p) - Globals::BaseAddress;
                                return rvaVal;
                            };
                            void* slot2a8 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x2A8);
                            void* slot320 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x320);
                            void* slot328 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x328);
                            void* slot330 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x330);
                            void* slot378 = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(driverVtable) + 0x378);

                            char buf[512];
                            _snprintf_s(buf, _TRUNCATE,
                                "[CWPN #%d] VTABLE dump (Driver->vtable=%p): "
                                "+0x2a8=RVA_0x%llX  +0x320=RVA_0x%llX  +0x328=RVA_0x%llX  +0x330=RVA_0x%llX  +0x378=RVA_0x%llX",
                                slot, driverVtable, rva(slot2a8), rva(slot320), rva(slot328), rva(slot330), rva(slot378));
                            MpLog(buf);
                        }
                    }
                }

                
                
                
                
                
                
                
                
                
                
                if (NetConnObj && IsReadablePointer(NetConnObj, 0xA0)) {
                    UObject* owning = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x98);
                    UObject* preferView = owning;
                    
                    if (owning && IsReadablePointer(owning, 0x258)) {
                        UObject* pcPawn = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(owning) + 0x250);
                        if (pcPawn) preferView = pcPawn;
                    }
                    UObject* viewBefore = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90) = preferView;
                    UObject* viewAfter = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x90);
                    if (slot < LOG_BUDGET) {
                        MpLog("[CWPN #" + std::to_string(slot) + "] FORCE-VIEWTARGET write:"
                            + " viewBefore=" + MpPtr(viewBefore)
                            + " forced=" + MpPtr(preferView)
                            + " viewAfter=" + MpPtr(viewAfter)
                            + " (owning=" + MpPtr(owning) + ")");
                    }

                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    
                    void* dbgDriver = nullptr;
                    if (NetConnObj && IsReadablePointer(NetConnObj, 0x60)) {
                        dbgDriver = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(NetConnObj) + 0x58);
                    }
                    if (slot < LOG_BUDGET && dbgDriver && IsReadablePointer(dbgDriver, 0x800)) {
                        
                        
                        
                        
                        
                        
                        
                        
                        
                        
                        
                        static constexpr bool kEnableSet0Walker = false;
                        void* netObjList = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(dbgDriver) + 0x6F0);
                        if (kEnableSet0Walker && netObjList && IsReadablePointer(netObjList, 0x1A0)) {
                            
                            
                            
                            std::string layout;
                            for (uintptr_t off = 0x00; off <= 0x180; off += 8) {
                                uint64_t v = *reinterpret_cast<uint64_t*>(reinterpret_cast<uintptr_t>(netObjList) + off);
                                if (v == 0) continue;
                                std::string tag;
                                if (v < 0x1000000ull) {
                                    char b[32]; _snprintf_s(b, _TRUNCATE, "int=%llu", (unsigned long long)v);
                                    tag = b;
                                } else if (v >= 0x10000000ull && v < 0x800000000000ull) {
                                    bool readable = IsReadablePointer(reinterpret_cast<void*>(v), 0x18);
                                    char b[48]; _snprintf_s(b, _TRUNCATE, "ptr=0x%llX/%s", (unsigned long long)v, readable ? "r" : "nr");
                                    tag = b;
                                } else {
                                    char b[32]; _snprintf_s(b, _TRUNCATE, "u64=0x%llX", (unsigned long long)v);
                                    tag = b;
                                }
                                char pref[16]; _snprintf_s(pref, _TRUNCATE, "+0x%03llX=", (long long)off);
                                if (!layout.empty()) layout += " ";
                                layout += pref;
                                layout += tag;
                            }
                            MpLog("[CWPN #" + std::to_string(slot) + "] NetObjList@" + MpPtr(netObjList) + " raw: " + layout);

                            
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            
                            void* set0Data = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(netObjList) + 0x00);
                            uint32_t set0Num = *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(netObjList) + 0x08);
                            uint32_t set0Max = *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(netObjList) + 0x0C);
                            if (set0Data && set0Num > 0 && set0Num < 500 && set0Max >= set0Num
                                && IsReadablePointer(set0Data, static_cast<size_t>(set0Max) * 0x18)) {
                                
                                std::string elemDump;
                                for (uint32_t i = 0; i < set0Num && i < 6; i++) {
                                    uintptr_t e = reinterpret_cast<uintptr_t>(set0Data) + static_cast<uintptr_t>(i) * 0x18;
                                    uint64_t q0 = *reinterpret_cast<uint64_t*>(e + 0x00);
                                    uint64_t q1 = *reinterpret_cast<uint64_t*>(e + 0x08);
                                    uint64_t q2 = *reinterpret_cast<uint64_t*>(e + 0x10);
                                    char b[128];
                                    _snprintf_s(b, _TRUNCATE, "el[%u]={q0:%llX q1:%llX q2:%llX}",
                                                i, (unsigned long long)q0, (unsigned long long)q1, (unsigned long long)q2);
                                    if (!elemDump.empty()) elemDump += " ";
                                    elemDump += b;
                                }
                                MpLog("[CWPN #" + std::to_string(slot) + "] Set0(AllNetworkObjects) Data=" + MpPtr(set0Data)
                                    + " Num=" + std::to_string(set0Num) + " Max=" + std::to_string(set0Max)
                                    + " raw: " + elemDump);

                                
                                int foundPawn = 0, foundPC = 0, parsed = 0;
                                std::string sample;
                                for (uint32_t i = 0; i < set0Num && parsed < 20; i++) {
                                    uintptr_t e = reinterpret_cast<uintptr_t>(set0Data) + static_cast<uintptr_t>(i) * 0x18;
                                    
                                    void* infoPtr = *reinterpret_cast<void**>(e + 0x00);
                                    if (!infoPtr || !IsReadablePointer(infoPtr, 0x40)) continue;
                                    
                                    for (uint32_t actorOff : {0x00u, 0x08u, 0x10u, 0x18u}) {
                                        void* actor = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(infoPtr) + actorOff);
                                        if (!actor || !IsReadablePointer(actor, 0x30)) continue;
                                        
                                        void* vtable = *reinterpret_cast<void**>(actor);
                                        if (!vtable || !IsReadablePointer(vtable, 8)) continue;
                                        
                                        void* cls = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(actor) + 0x10);
                                        if (!cls || !IsReadablePointer(cls, 0x30)) continue;
                                        
                                        uint32_t clsIdx = *reinterpret_cast<uint32_t*>(reinterpret_cast<uintptr_t>(cls) + 0x18);
                                        if (clsIdx == 0 || clsIdx > 0x2000000u) continue;
                                        
                                        int32_t clsObjIdx = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(cls) + 0x0C);
                                        if (clsObjIdx < 0 || clsObjIdx > 1000000) continue;
                                        
                                        UObject* actorObj = reinterpret_cast<UObject*>(actor);
                                        UObject* clsObj = reinterpret_cast<UObject*>(cls);
                                        std::string cName = clsObj->GetName();
                                        std::string aName = actorObj->GetName();
                                        if (cName.find("PlayerCharacter") != std::string::npos) foundPawn++;
                                        if (cName.find("player_controller") != std::string::npos ||
                                            cName.find("PlayerController") != std::string::npos) foundPC++;
                                        if (parsed < 20) {
                                            if (!sample.empty()) sample += ", ";
                                            char b[32]; _snprintf_s(b, _TRUNCATE, "[%u@+0x%X]", i, actorOff);
                                            sample += b;
                                            sample += cName + "/" + aName;
                                        }
                                        parsed++;
                                        break; 
                                    }
                                }
                                MpLog("[CWPN #" + std::to_string(slot) + "] Set0 actors: Num=" + std::to_string(set0Num)
                                    + " parsed=" + std::to_string(parsed)
                                    + " pawns=" + std::to_string(foundPawn)
                                    + " PCs=" + std::to_string(foundPC));
                                MpLog("[CWPN #" + std::to_string(slot) + "] Set0 sample: " + sample);
                            }
                        }
                    }
                }
            }

            
            
            
            if (DiagNaturalMode()) {
                static std::atomic<int> s_pcrNat{ 0 };
                if (s_pcrNat.fetch_add(1, std::memory_order_relaxed) < 5)
                    MpLog("[Diag] PlayerCanRestart NOT forced (natural mode) priorRet=" + std::to_string(PriorRet ? 1 : 0));
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
                return;
            }

            
            *reinterpret_cast<bool*>(reinterpret_cast<uintptr_t>(Parms) + 0x8) = true;

            static bool s_loggedPCR = false;
            if (!s_loggedPCR) {
                s_loggedPCR = true;
                MpLog("[PlayerCanRestart] first-intercept — player=" + MpPtr(PlayerObj)
                    + " priorRet=" + std::to_string(PriorRet ? 1 : 0)
                    + " forcedRet=1");
            }
            return; 
        }
    }

    if (Function == ServerTryActivateAbilityWithEventData || (!ServerTryActivateAbilityWithEventData && FunctionName.contains("ServerTryActivateAbilityWithEventData"))) {
        ServerTryActivateAbilityWithEventData = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, &ActivateAbilityParams->TriggerEventData);
    }
    else if (Function == ServerTryActivateAbility || (!ServerTryActivateAbility && FunctionName.contains("ServerTryActivateAbility"))) {
        ServerTryActivateAbility = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbility* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbility*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, nullptr);
    }

    

    
    
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);

    if (WeaponXpServerGrant && WeaponXpServerGrantSeq >= 0 && WeaponXpServerGrantSeq < 256) {
        MpLog("[WeaponXP][ServerGrant] EXIT seq=" + std::to_string(WeaponXpServerGrantSeq)
            + " returned=" + std::to_string(WeaponXpServerGrant->ReturnValue ? 1 : 0)
            + " type=" + std::to_string(static_cast<int>(WeaponXpServerGrant->WeaponXPType))
            + " base=" + std::to_string(WeaponXpServerGrant->BaseAmount)
            + " bonus=" + std::to_string(WeaponXpServerGrant->BonusAmount));
    }

    TraceEscalationFlowExit("Server", EscalationFlowServerSeq, Object, FunctionName, Parms);

    if (TempestPerfectDodgeServerSeq >= 0 && TempestPerfectDodgeServerSeq < 64) {
        MpLog("[TempestPerfectDodge][Server] EXIT seq=" + std::to_string(TempestPerfectDodgeServerSeq)
            + " fn=" + FunctionName);
    }

    
    
    
    if (AckCapturePc && IsReadablePointer(AckCapturePc, 0x420)) {
        uintptr_t Pc = reinterpret_cast<uintptr_t>(AckCapturePc);
        void* ackAfter = *reinterpret_cast<void**>(Pc + 0x2A0);
        void* pcPawn   = *reinterpret_cast<void**>(Pc + 0x250);
        MpLog("[PossessionRPC] AFTER pc=" + MpPtr(AckCapturePc)
            + " AcknowledgedPawn=" + MpPtr(ackAfter) + " (before=" + MpPtr(AckPawnBefore) + ")"
            + " PC.Pawn=" + MpPtr(pcPawn)
            + " stuck=" + std::to_string((ackAfter != nullptr && ackAfter == pcPawn) ? 1 : 0));
    }
}























static void* OrigGetViewportSize = nullptr;
static void ExecGetViewportSizeHook(void* ctx, void* stack, void* result) {
    reinterpret_cast<void(*)(void*, void*, void*)>(OrigGetViewportSize)(ctx, stack, result);
    static int s_vpFallback = (GetFileAttributesW(L".\\debug\\VIEWPORT_FALLBACK.flag") != INVALID_FILE_ATTRIBUTES) ? 1 : 0;
    if (s_vpFallback && result && IsReadablePointer(result, 8)) {
        float* v = reinterpret_cast<float*>(result);        
        float w = v[0], h = v[1];
        if (!(w > 0.0f) || !(h > 0.0f)) {                   
            v[0] = 1920.0f; v[1] = 1080.0f;
            static std::atomic<int> s_vpOnce{ 0 };
            if (s_vpOnce.fetch_add(1, std::memory_order_relaxed) < 3)
                MpLog("[ViewportFallback] " + std::to_string(w) + "x" + std::to_string(h) + " -> 1920x1080");
        }
    }
}



void InitClientHooks() {
    MH_STATUS InitStatus = MH_Initialize();
    MpLog(std::string("[InitClientHooks] MH_Initialize=") + MH_StatusToString(InitStatus));

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    static constexpr bool kEnableHasFinishedLoadingHook = true;
    static constexpr bool kEnableProcessEventClientHook = true;
    static constexpr bool kEnableArchonLoadingScreenFadeInHook = false;

    
    if (kEnableHasFinishedLoadingHook) {
        MH_STATUS HasFinishedCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01A60BC0), HasFinishedLoadingHook, &OrigHasFinishedLoading);
        MH_STATUS HasFinishedEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01A60BC0));
        MpLog(std::string("[InitClientHooks] HasFinishedLoading create=")
            + MH_StatusToString(HasFinishedCreate)
            + " enable=" + MH_StatusToString(HasFinishedEnable)
            + " target=+" + MpHex(0x01A60BC0));
    }
    else {
        MpLog("[InitClientHooks] HasFinishedLoading skipped for travel handshake bisect");
    }

    
    if (kEnableProcessEventClientHook) {
        MH_STATUS ProcessEventCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x026A9890), ProcessEventClientHook, &OrigProcessEventClient);
        MH_STATUS ProcessEventEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x026A9890));
        MpLog(std::string("[InitClientHooks] ProcessEvent create=")
            + MH_StatusToString(ProcessEventCreate)
            + " enable=" + MH_StatusToString(ProcessEventEnable)
            + " target=+" + MpHex(0x026A9890));
    }
    else {
        MpLog("[InitClientHooks] ProcessEvent skipped for travel handshake bisect");
    }

    
    
    
    {
        MH_STATUS AprCreate = MH_CreateHook(
            (void*)(Globals::BaseAddress + 0x01A4B790),
            ApplyPlayerRoleHook,
            &OrigApplyPlayerRole);
        MH_STATUS AprEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01A4B790));
        MpLog(std::string("[InitClientHooks] ApplyPlayerRole hook create=")
            + MH_StatusToString(AprCreate) + " enable=" + MH_StatusToString(AprEnable)
            + " target=+" + MpHex(0x01A4B790));
    }

    
    
    
    {
        MH_STATUS EacCreate = MH_CreateHook(
            (void*)(Globals::BaseAddress + 0x020DC460),
            EasyAntiCheatErrorProcHook,
            &OrigEasyAntiCheatErrorProc);
        MH_STATUS EacEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x020DC460));
        MpLog(std::string("[InitClientHooks] EasyAntiCheatErrorProc create=")
            + MH_StatusToString(EacCreate)
            + " enable=" + MH_StatusToString(EacEnable)
            + " target=+" + MpHex(0x020DC460));
    }

    
    
    
    
    {
        MH_STATUS EacStartupCreate = MH_CreateHook(
            (void*)(Globals::BaseAddress + 0x0136FE40),
            EasyAntiCheatStartupHook,
            &OrigEasyAntiCheatStartup);
        MH_STATUS EacStartupEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x0136FE40));
        MpLog(std::string("[InitClientHooks] EasyAntiCheatStartup create=")
            + MH_StatusToString(EacStartupCreate)
            + " enable=" + MH_StatusToString(EacStartupEnable)
            + " target=+" + MpHex(0x0136FE40));
    }

    
    if (kEnableArchonLoadingScreenFadeInHook) {
        MH_STATUS FadeCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01CADE20), ArchonLoadingScreenFadeInHook, &OrigArchonLoadingScreenFadeIn);
        MH_STATUS FadeEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01CADE20));
        MpLog(std::string("[InitClientHooks] ArchonLoadingScreenFadeIn create=")
            + MH_StatusToString(FadeCreate)
            + " enable=" + MH_StatusToString(FadeEnable)
            + " target=+" + MpHex(0x01CADE20));
    }
    else {
        MpLog("[InitClientHooks] ArchonLoadingScreenFadeIn skipped for travel handshake bisect");
    }

    
    

    
    
    InstallSetUrlRedirectHook("client");

    
    
    
    InstallXmppConfigRedirectHook("client");
}

void* OrigSprint = nullptr;

bool SprintHook(uintptr_t a1, uintptr_t a2) { 
    return true;
}





static void Move10_PatchMovByteImm(uintptr_t Rva, uintptr_t TargetOff, uint8_t ExpectImm, uint8_t NewImm,
                                   const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0xC6 && p[1] == 0x05);                       
    const int32_t disp = (int32_t)((uint32_t)p[2] | ((uint32_t)p[3] << 8) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 24));
    const bool targetOk = ((p + 7 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff));
    const bool immOk = (p[6] == ExpectImm);
    if (opcodeOk && immOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p + 6, 1, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[6] = NewImm;
            DWORD tmpP = 0; VirtualProtect(p + 6, 1, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 7);
            Status += std::string("\n  ") + Tag + " OK imm " + std::to_string((int)ExpectImm) + "->" + std::to_string((int)NewImm);
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " immOk=" + std::to_string((int)immOk) + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]) + "," + std::to_string((int)p[6]);
    }
}




static void Move10_PatchMovRegToImm0(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0x44 && p[1] == 0x88 && p[2] == 0x25);
    const int32_t disp = (int32_t)((uint32_t)p[3] | ((uint32_t)p[4] << 8) | ((uint32_t)p[5] << 16) | ((uint32_t)p[6] << 24));
    const bool targetOk = ((p + 7 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff));
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 7, PAGE_EXECUTE_READWRITE, &oldP)) {
            const uint8_t d0 = p[3], d1 = p[4], d2 = p[5], d3 = p[6];           
            p[0] = 0xC6; p[1] = 0x05; p[2] = d0; p[3] = d1; p[4] = d2; p[5] = d3; p[6] = 0x00;
            DWORD tmpP = 0; VirtualProtect(p, 7, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 7);
            Status += std::string("\n  ") + Tag + " OK rewrite MOV[..],R12B -> MOV[..],0";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]) + "," + std::to_string((int)p[6]);
    }
}








static void Move10_NopMovByteAlStore(uintptr_t Rva, uintptr_t TargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0x88 && p[1] == 0x05);
    const int32_t disp = (int32_t)((uint32_t)p[2] | ((uint32_t)p[3] << 8) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 24));
    const bool targetOk = ((p + 6 + disp) == (uint8_t*)(Globals::BaseAddress + TargetOff)); 
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 6, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[0] = 0x90; p[1] = 0x90; p[2] = 0x90; p[3] = 0x90; p[4] = 0x90; p[5] = 0x90;
            DWORD tmpP = 0; VirtualProtect(p, 6, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 6);
            Status += std::string("\n  ") + Tag + " OK NOPx6 (was MOV[..],AL)";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]) + "," + std::to_string((int)p[5]);
    }
}









static void Move10_PatchCallToMovAl1(uintptr_t Rva, uintptr_t ExpectTargetOff, const char* Tag, std::string& Status) {
    uint8_t* p = (uint8_t*)(Globals::BaseAddress + Rva);
    const bool opcodeOk = (p[0] == 0xE8);                                  
    const int32_t rel = (int32_t)((uint32_t)p[1] | ((uint32_t)p[2] << 8) | ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24));
    const bool targetOk = ((p + 5 + rel) == (uint8_t*)(Globals::BaseAddress + ExpectTargetOff));
    if (opcodeOk && targetOk) {
        DWORD oldP = 0;
        if (VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &oldP)) {
            p[0] = 0xB0; p[1] = 0x01; p[2] = 0x90; p[3] = 0x90; p[4] = 0x90; 
            DWORD tmpP = 0; VirtualProtect(p, 5, oldP, &tmpP);
            FlushInstructionCache(GetCurrentProcess(), p, 5);
            Status += std::string("\n  ") + Tag + " OK CALL->MOV AL,1;NOPx3";
        } else {
            Status += std::string("\n  ") + Tag + " ABORT VirtualProtect-failed";
        }
    } else {
        Status += std::string("\n  ") + Tag + " ABORT opcodeOk=" + std::to_string((int)opcodeOk)
            + " targetOk=" + std::to_string((int)targetOk)
            + " bytes=" + std::to_string((int)p[0]) + "," + std::to_string((int)p[1]) + "," + std::to_string((int)p[2])
            + "," + std::to_string((int)p[3]) + "," + std::to_string((int)p[4]);
    }
}

void* OrigApplyPlayerRole = nullptr;




















struct PlayerRoleGraphActorInfo {
    void* Actor;
    SDK::FName StreamingLevelName;
    void* Class;
};
static_assert(sizeof(PlayerRoleGraphActorInfo) == 0x18, "1.12 FNewReplicatedActorInfo layout drift");

struct PlayerRoleGraphRoute {
    void* Actor = nullptr;
    void* Node = nullptr;
    void* Connection = nullptr;
    uint64_t ActiveSeenMs = 0;
    uint64_t LastRefreshMs = 0;
    int RefreshAttempts = 0;
    bool WasFullyActive = false;
    bool PostActiveRefreshComplete = false;
};
static PlayerRoleGraphRoute s_playerRoleGraphRoutes[64]{};

static int RoutePlayerRoleToOwningConnectionRaw(void* PlayerRole, void** OutConnection,
                                                 void** OutGraph, void** OutNode,
                                                 int* OutBootstrapResult) {
    if (OutConnection) *OutConnection = nullptr;
    if (OutGraph) *OutGraph = nullptr;
    if (OutNode) *OutNode = nullptr;
    if (OutBootstrapResult) *OutBootstrapResult = 0;
    __try {
        if (!PlayerRole || !Networking::NetDriver || !IsReadablePointer(PlayerRole, 0x100)
            || !IsReadablePointer(Networking::NetDriver, 0x6F0)) return 0;

        uintptr_t VTable = *reinterpret_cast<uintptr_t*>(PlayerRole);
        if (!VTable || !IsReadablePointer(reinterpret_cast<void*>(VTable + 0x4C0), 8)) return 0;
        void* GetNetConnectionFn = *reinterpret_cast<void**>(VTable + 0x4C0);
        if (!GetNetConnectionFn) return 0;
        void* Connection = reinterpret_cast<void*(*)(void*)>(GetNetConnectionFn)(PlayerRole);
        if (OutConnection) *OutConnection = Connection;
        if (!Connection || !IsReadablePointer(Connection, 0x140)) return 0;

        void* Graph = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Networking::NetDriver) + 0x6E8);
        if (OutGraph) *OutGraph = Graph;
        if (!Graph || !IsReadablePointer(Graph, 0x4C8)) return 0;
        if (*reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Graph) + 0x30)
            != reinterpret_cast<void*>(Networking::NetDriver)) return 0;

        void* Node = reinterpret_cast<void*(*)(void*, void*)>(Globals::BaseAddress + 0x01A8F4C0)(Graph, Connection);
        if (OutNode) *OutNode = Node;
        if (!Node || !IsReadablePointer(Node, 0x20)) return 0;

        for (PlayerRoleGraphRoute& Existing : s_playerRoleGraphRoutes) {
            if (Existing.Actor == PlayerRole && Existing.Node == Node) {
                Existing.Connection = Connection;
                
                
                
                
                const int BootstrapResult = Networking::BootstrapActorChannel(
                    reinterpret_cast<AActor*>(PlayerRole), reinterpret_cast<UNetConnection*>(Connection));
                if (OutBootstrapResult) *OutBootstrapResult = BootstrapResult;
                return 2; 
            }
        }

        int FreeSlot = -1;
        for (int i = 0; i < static_cast<int>(std::size(s_playerRoleGraphRoutes)); ++i) {
            if (!s_playerRoleGraphRoutes[i].Actor && FreeSlot < 0) FreeSlot = i;
        }
        if (FreeSlot < 0) return 0;

        void** NodeVTable = *reinterpret_cast<void***>(Node);
        if (!NodeVTable || !IsReadablePointer(NodeVTable + (0x270 / 8), 8)) return 0;
        void* NotifyAdd = NodeVTable[0x270 / 8];
        if (!NotifyAdd) return 0;

        PlayerRoleGraphActorInfo Info{};
        Info.Actor = PlayerRole;
        Info.StreamingLevelName = SDK::FName(); 
        Info.Class = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x10);
        reinterpret_cast<void(*)(void*, const PlayerRoleGraphActorInfo&)>(NotifyAdd)(Node, Info);
        s_playerRoleGraphRoutes[FreeSlot] = { PlayerRole, Node, Connection };

        
        
        
        
        const int BootstrapResult = Networking::BootstrapActorChannel(reinterpret_cast<AActor*>(PlayerRole),
            reinterpret_cast<UNetConnection*>(Connection));
        if (OutBootstrapResult) *OutBootstrapResult = BootstrapResult;
        return 1;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -1;
    }
}

static void RoutePlayerRoleToOwningConnection(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole
        || MpExeRelativeFlagPresent(L"DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag")) return;
    void* Connection = nullptr; void* Graph = nullptr; void* Node = nullptr;
    int BootstrapResult = 0;
    const int Result = RoutePlayerRoleToOwningConnectionRaw(PlayerRole, &Connection, &Graph, &Node,
        &BootstrapResult);
    if (Result == 1 || Result == 2 || Result == -1) {
        MpLog("[PlayerRoleGraphRoute] role=" + MpPtr(PlayerRole)
            + " conn=" + MpPtr(Connection) + " graph=" + MpPtr(Graph) + " node=" + MpPtr(Node)
            + " result=" + (Result == 1 ? std::string("ADDED")
                : (Result == 2 ? std::string("EXISTING_REFRESHED") : std::string("FAULT")))
            + " bootstrap=" + std::to_string(BootstrapResult));
    }
}













static constexpr uint64_t kPlayerRolePostActiveSettleMs = 1500;
static constexpr uint64_t kPlayerRolePostActiveRetryMs = 1500;
static constexpr int kPlayerRolePostActiveMaxAttempts = 3;

static void TickPlayerRolePostActivationRefresh() {
    if (!Globals::AmServer || !OrigProcessEvent
        || MpExeRelativeFlagPresent(L"DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag")) return;

    const uint64_t Now = GetTickCount64();
    for (PlayerRoleGraphRoute& Entry : s_playerRoleGraphRoutes) {
        if (!Entry.Actor) continue;
        if (!IsReadablePointer(Entry.Actor, 0x360)
            || !IsReadablePointer(Entry.Connection, 0x140)
            || !IsReadablePointer(Entry.Node, 0x20)) {
            Entry = PlayerRoleGraphRoute{};
            continue;
        }

        const uintptr_t Role = reinterpret_cast<uintptr_t>(Entry.Actor);
        const int Equipped = SafeReadU8At(Role, 0x2F4);
        const int GameplayEquipped = SafeReadU8At(Role, 0x2F5);
        const int ActiveGameplay = SafeReadU8At(Role, 0x2F6);
        const int BpEquipCalled = SafeReadU8At(Role, 0x2F7);
        const bool FullyActive = Equipped == 1 && GameplayEquipped == 1
            && ActiveGameplay == 1 && BpEquipCalled == 1;

        if (!FullyActive) {
            
            Entry.ActiveSeenMs = 0;
            Entry.LastRefreshMs = 0;
            Entry.RefreshAttempts = 0;
            Entry.WasFullyActive = false;
            Entry.PostActiveRefreshComplete = false;
            continue;
        }

        if (!Entry.WasFullyActive) {
            Entry.WasFullyActive = true;
            Entry.ActiveSeenMs = Now;
            MpLog("[PlayerRolePostActiveRefresh] WAIT role=" + MpPtr(Entry.Actor)
                + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
                + " conn=" + MpPtr(Entry.Connection)
                + " settleMs=" + std::to_string(kPlayerRolePostActiveSettleMs)
                + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
            continue;
        }
        if (Entry.PostActiveRefreshComplete
            || Now - Entry.ActiveSeenMs < kPlayerRolePostActiveSettleMs
            || (Entry.LastRefreshMs != 0 && Now - Entry.LastRefreshMs < kPlayerRolePostActiveRetryMs)) {
            continue;
        }

        if (Entry.RefreshAttempts >= kPlayerRolePostActiveMaxAttempts) {
            Entry.PostActiveRefreshComplete = true;
            MpLog("[PlayerRolePostActiveRefresh] EXHAUSTED role=" + MpPtr(Entry.Actor)
                + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
                + " attempts=" + std::to_string(Entry.RefreshAttempts)
                + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
            continue;
        }

        UObject* RoleObject = reinterpret_cast<UObject*>(Entry.Actor);
        static UFunction* s_FlushNetDormancyFn = nullptr;
        static UFunction* s_ForceNetUpdateFn = nullptr;
        if (RoleObject->Class) {
            if (!s_FlushNetDormancyFn) {
                s_FlushNetDormancyFn = RoleObject->Class->GetFunction("Actor", "FlushNetDormancy");
            }
            if (!s_ForceNetUpdateFn) {
                s_ForceNetUpdateFn = RoleObject->Class->GetFunction("Actor", "ForceNetUpdate");
            }
        }

        const int DormancyBefore = SafeReadU8At(Role, 0xF1);
        const bool FlushDispatched = s_FlushNetDormancyFn != nullptr;
        const bool ForceDispatched = s_ForceNetUpdateFn != nullptr;
        if (s_FlushNetDormancyFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
                RoleObject, s_FlushNetDormancyFn, nullptr);
        }
        if (s_ForceNetUpdateFn) {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
                RoleObject, s_ForceNetUpdateFn, nullptr);
        }

        Entry.LastRefreshMs = Now;
        ++Entry.RefreshAttempts;
        const int BootstrapResult = Networking::BootstrapActorChannel(
            reinterpret_cast<AActor*>(Entry.Actor),
            reinterpret_cast<UNetConnection*>(Entry.Connection));
        const bool WroteData = BootstrapResult == 2 || BootstrapResult == 3;
        if (WroteData) Entry.PostActiveRefreshComplete = true;

        MpLog("[PlayerRolePostActiveRefresh] PUSH attempt=" + std::to_string(Entry.RefreshAttempts)
            + " role=" + MpPtr(Entry.Actor)
            + " itemId=" + CoreCapFString(reinterpret_cast<void*>(Role + 0x240))
            + " conn=" + MpPtr(Entry.Connection)
            + " activeForMs=" + std::to_string(Now - Entry.ActiveSeenMs)
            + " dormancy=" + std::to_string(DormancyBefore)
            + " flush=" + std::to_string(FlushDispatched ? 1 : 0)
            + " force=" + std::to_string(ForceDispatched ? 1 : 0)
            + " bootstrap=" + std::to_string(BootstrapResult)
            + " wroteData=" + std::to_string(WroteData ? 1 : 0)
            + " complete=" + std::to_string(Entry.PostActiveRefreshComplete ? 1 : 0)
            + " charge={" + PlayerRoleChargeSummary(Entry.Actor) + "}");
    }
}


























struct TempestModifierEnsureEntry {
    void* PlayerRole = nullptr;
    uint64_t ActiveSeenMs = 0;
    uint64_t LastRepairMs = 0;
    uint64_t LastStateLogMs = 0;
    int RepairAttempts = 0;
    bool InUse = false;
};
static TempestModifierEnsureEntry s_tempestModifierEnsure[16]{};
static constexpr uint64_t kTempestModifierSettleMs = 3000;
static constexpr uint64_t kTempestModifierRetryMs = 3500;
static constexpr int kTempestModifierMaxAttempts = 3;

static void NoteTempestModifierRole(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) return;
    const std::string ItemId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x240));
    if (ItemId != "PR_TEMPEST") return;

    int FreeSlot = -1;
    for (int i = 0; i < static_cast<int>(std::size(s_tempestModifierEnsure)); ++i) {
        TempestModifierEnsureEntry& Entry = s_tempestModifierEnsure[i];
        if (Entry.InUse && Entry.PlayerRole == PlayerRole) return;
        if (!Entry.InUse && FreeSlot < 0) FreeSlot = i;
    }
    if (FreeSlot < 0) {
        MpLog("[TempestModifierEnsure] tracking table full; role=" + MpPtr(PlayerRole));
        return;
    }
    s_tempestModifierEnsure[FreeSlot].PlayerRole = PlayerRole;
    s_tempestModifierEnsure[FreeSlot].InUse = true;
    MpLog("[TempestModifierEnsure] TRACK role=" + MpPtr(PlayerRole)
        + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
}

struct TempestRawUeArray {
    void* Data;
    int32_t Num;
    int32_t Max;
};
static_assert(sizeof(TempestRawUeArray) == 0x10, "UE TArray layout drift");

static bool DispatchTempestModifierApply(void* PlayerRole, uintptr_t ArrayOffset,
                                         const char* FunctionName, const char* Kind) {
    if (!PlayerRole || !OrigProcessEvent || !IsReadablePointer(PlayerRole, ArrayOffset + 0x10)) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " dispatch prerequisites missing role="
            + MpPtr(PlayerRole) + " origPE=" + MpPtr(OrigProcessEvent));
        return false;
    }

    const TempestRawUeArray Source = *reinterpret_cast<const TempestRawUeArray*>(
        reinterpret_cast<uintptr_t>(PlayerRole) + ArrayOffset);
    if (!Source.Data || Source.Num <= 0 || Source.Num > 256 || Source.Max < Source.Num
        || !IsReadablePointer(Source.Data, 1)) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " catalog array invalid data="
            + MpPtr(Source.Data) + " num=" + std::to_string(Source.Num)
            + " max=" + std::to_string(Source.Max));
        return false;
    }

    UObject* RoleObject = reinterpret_cast<UObject*>(PlayerRole);
    UFunction* ApplyFunction = RoleObject->Class
        ? RoleObject->Class->GetFunction("ArchonEquipment", FunctionName) : nullptr;
    if (!ApplyFunction) {
        MpLog(std::string("[TempestModifierEnsure] ") + Kind + " UFunction missing: " + FunctionName);
        return false;
    }

    
    
    TempestRawUeArray Params = Source;
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
        RoleObject, ApplyFunction, &Params);
    return true;
}

static void TickTempestModifierEnsure() {
    if (!Globals::AmServer) return;
    const uint64_t Now = GetTickCount64();

    for (TempestModifierEnsureEntry& Entry : s_tempestModifierEnsure) {
        if (!Entry.InUse) continue;
        void* PlayerRole = Entry.PlayerRole;
        if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) {
            Entry = TempestModifierEnsureEntry{};
            continue;
        }
        const std::string ItemId = CoreCapFString(
            reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerRole) + 0x240));
        if (ItemId != "PR_TEMPEST") {
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        const int Equipped = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F4);
        const int GameplayEquipped = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5);
        const int ActiveGameplay = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6);
        const int BpEquipCalled = SafeReadU8At(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7);
        if (Equipped != 1 || GameplayEquipped != 1 || ActiveGameplay != 1 || BpEquipCalled != 1) {
            Entry.ActiveSeenMs = 0;
            continue;
        }

        if (Entry.ActiveSeenMs == 0) {
            Entry.ActiveSeenMs = Now;
            Entry.LastStateLogMs = Now;
            MpLog("[TempestModifierEnsure] ACTIVE_WAIT role=" + MpPtr(PlayerRole)
                + " settleMs=" + std::to_string(kTempestModifierSettleMs)
                + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            continue;
        }
        if (Now - Entry.ActiveSeenMs < kTempestModifierSettleMs) continue;

        const PlayerRoleModifierSnapshot Before = CapturePlayerRoleModifiers(PlayerRole);
        if (!Before.Valid) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] INVALID_SNAPSHOT role=" + MpPtr(PlayerRole));
            }
            continue;
        }

        
        
        if (Before.DesiredBuffs <= 0 || Before.DesiredAbilities <= 0) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] CATALOG_EMPTY role=" + MpPtr(PlayerRole)
                    + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            }
            continue;
        }

        const int AppliedBuffs = Before.Group ? Before.AppliedBuffs : 0;
        const int AppliedAbilities = Before.Group ? Before.AppliedAbilities : 0;
        const int PendingBuffs = Before.Group ? Before.PendingBuffs : 0;
        const int PendingAbilities = Before.Group ? Before.PendingAbilities : 0;

        if (AppliedBuffs > 0 && AppliedAbilities > 0) {
            MpLog("[TempestModifierEnsure] HEALTHY role=" + MpPtr(PlayerRole)
                + " native catalog modifiers already applied; state={"
                + PlayerRoleModifierSummary(PlayerRole) + "}");
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        if (PendingBuffs > 0 || PendingAbilities > 0) {
            if (Now - Entry.LastStateLogMs >= 10000) {
                Entry.LastStateLogMs = Now;
                MpLog("[TempestModifierEnsure] NATIVE_PENDING role=" + MpPtr(PlayerRole)
                    + " elapsedActiveMs=" + std::to_string(Now - Entry.ActiveSeenMs)
                    + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            }
            continue;
        }

        const bool NeedBuffs = AppliedBuffs <= 0;
        const bool NeedAbilities = AppliedAbilities <= 0;
        if ((!NeedBuffs && !NeedAbilities)
            || (Entry.LastRepairMs != 0 && Now - Entry.LastRepairMs < kTempestModifierRetryMs)) continue;
        if (Entry.RepairAttempts >= kTempestModifierMaxAttempts) {
            MpLog("[TempestModifierEnsure] EXHAUSTED role=" + MpPtr(PlayerRole)
                + " attempts=" + std::to_string(Entry.RepairAttempts)
                + " state={" + PlayerRoleModifierSummary(PlayerRole) + "}");
            Entry = TempestModifierEnsureEntry{};
            continue;
        }

        Entry.LastRepairMs = Now;
        ++Entry.RepairAttempts;
        const bool BuffDispatch = !NeedBuffs || DispatchTempestModifierApply(
            PlayerRole, 0x2A8, "ApplyGameplayBuffsToOwner", "buff");
        const bool AbilityDispatch = !NeedAbilities || DispatchTempestModifierApply(
            PlayerRole, 0x2C8, "ApplyGameplayAbilitiesToOwner", "ability");
        MpLog("[TempestModifierEnsure] REPAIR attempt=" + std::to_string(Entry.RepairAttempts)
            + " role=" + MpPtr(PlayerRole)
            + " requestedBuff=" + std::to_string(NeedBuffs ? 1 : 0)
            + " requestedAbility=" + std::to_string(NeedAbilities ? 1 : 0)
            + " dispatchBuff=" + std::to_string(BuffDispatch ? 1 : 0)
            + " dispatchAbility=" + std::to_string(AbilityDispatch ? 1 : 0)
            + " before={group=" + MpPtr(Before.Group)
            + " appliedBuffs=" + std::to_string(AppliedBuffs)
            + " appliedAbilities=" + std::to_string(AppliedAbilities) + "}"
            + " after={" + PlayerRoleModifierSummary(PlayerRole) + "}");
    }
}














struct TempestChargeDiagEntry {
    void* PlayerRole = nullptr;
    bool InUse = false;
    int LastCanActivate = -99;
    int LastChargeMilli = INT32_MIN;   
    uint64_t LastHeartbeatMs = 0;
};
static TempestChargeDiagEntry s_tempestChargeDiag[16]{};

static void NoteTempestChargeDiagRole(void* PlayerRole) {
    if (!Globals::AmServer || !PlayerRole
        || !MpExeRelativeFlagPresent(L"TEMPEST_CHARGE_DIAG.flag")) return;
    for (const TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (E.InUse && E.PlayerRole == PlayerRole) return;
    }
    for (TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (!E.InUse) {
            E = TempestChargeDiagEntry{};
            E.PlayerRole = PlayerRole;
            E.InUse = true;
            MpLog("[TempestChargeDiag] TRACK role=" + MpPtr(PlayerRole)
                + " state={" + PlayerRoleChargeSummary(PlayerRole) + "}");
            return;
        }
    }
}

static void TickTempestChargeDiag() {
    if (!Globals::AmServer || !MpExeRelativeFlagPresent(L"TEMPEST_CHARGE_DIAG.flag")) return;
    const uint64_t Now = GetTickCount64();
    for (TempestChargeDiagEntry& E : s_tempestChargeDiag) {
        if (!E.InUse) continue;
        void* Role = E.PlayerRole;
        if (!Role || !IsReadablePointer(Role, 0x360) || !IsRegisteredLiveObject(Role)) {
            E = TempestChargeDiagEntry{}; continue;
        }
        const std::string ItemId = CoreCapFString(
            reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x240));
        if (ItemId != "PR_TEMPEST") { E = TempestChargeDiagEntry{}; continue; }

        const float Current = SafeCallPlayerRoleFloat(Role, 0x01B983E0);    
        const float MaxCharge = SafeCallPlayerRoleFloat(Role, 0x01B99F30);  
        const int CanActivate = SafeCallPlayerRoleBoolRva(Role, 0x01B8D8A0); 
        if (Current <= -9990.0f) continue;   
        const int CurMilli = static_cast<int>(Current * 1000.0f);

        const bool Activation = (E.LastChargeMilli != INT32_MIN)
            && (CurMilli < E.LastChargeMilli - 400);        
        const bool CanFlip = (E.LastCanActivate != -99) && (CanActivate != E.LastCanActivate);
        const bool Heartbeat = (Now - E.LastHeartbeatMs) >= 5000;

        if (Activation || CanFlip || Heartbeat) {
            const char* Evt = Activation ? "ACTIVATION" : (CanFlip ? "CANACT_FLIP" : "heartbeat");
            const bool ChargeFull = MaxCharge > 0.0f && Current >= MaxCharge - 0.05f;
            const char* StacksHint = (!ChargeFull) ? "unknown(charge<max)"
                : (CanActivate == 1 ? "PRESENT(>=1)" : "ABSENT(0)");
            MpLog(std::string("[TempestChargeDiag] role=") + MpPtr(Role)
                + " event=" + Evt
                + " charge=" + std::to_string(Current) + "/" + std::to_string(MaxCharge)
                + " canActivate=" + std::to_string(CanActivate)
                + " (was " + std::to_string(E.LastCanActivate) + ")"
                + " windFuryStacks=" + StacksHint);
            if (Heartbeat) E.LastHeartbeatMs = Now;
        }
        E.LastChargeMilli = CurMilli;
        if (CanActivate >= 0) E.LastCanActivate = CanActivate;
    }
}










struct PendingPlayerRoleRetry {
    void* LoadoutPtr = nullptr;
    uint64_t FirstSeenInvalidMs = 0;
    uint64_t LastRetryMs = 0;
    int RetryCount = 0;
    bool InUse = false;
};
constexpr int kMaxPendingPlayerRoleRetries = 8;          
constexpr uint64_t kPlayerRoleRetryIntervalMs = 1500;
constexpr int kMaxPlayerRoleRetryAttempts = 20;           
static PendingPlayerRoleRetry s_pendingPlayerRoleRetries[kMaxPendingPlayerRoleRetries];



static void GetPlayerRoleAndSlot(void* LoadoutPtr, void** OutRole, void** OutSlot) {
    *OutRole = nullptr; *OutSlot = nullptr;
    if (!LoadoutPtr || !IsReadablePointer(LoadoutPtr, 0x40)) return;
    void* Inter = reinterpret_cast<void*(*)(void*)>(Globals::BaseAddress + 0x01A52080)(LoadoutPtr);
    if (!Inter || !IsReadablePointer(Inter, 0x40)) return;
    *OutRole = reinterpret_cast<void*(*)(void*)>(Globals::BaseAddress + 0x01A95C60)(Inter);
    *OutSlot = reinterpret_cast<void*(*)(void*)>(Globals::BaseAddress + 0x0173F670)(Inter);
}





static bool IsPlayerRoleAppliedToPawn(void* LoadoutPtr, void** OutRole = nullptr, void** OutSlot = nullptr,
                                     void** OutPawn = nullptr, void** OutPawnRole = nullptr) {
    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(LoadoutPtr, &Role, &Slot);

    void* PC = (LoadoutPtr && IsReadablePointer(LoadoutPtr, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(LoadoutPtr) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;

    if (OutRole) *OutRole = Role;
    if (OutSlot) *OutSlot = Slot;
    if (OutPawn) *OutPawn = Pawn;
    if (OutPawnRole) *OutPawnRole = PawnRole;

    if (!Role || !Slot || !Pawn || !PawnRole) return false;
    const std::string InputId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    const std::string PawnId = CoreCapFString(
        reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240));
    return !InputId.empty() && InputId == PawnId;
}




static void NotePlayerRoleValidity(void* LoadoutPtr, bool AppliedToPawn) {
    int FreeSlot = -1;
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        if (s_pendingPlayerRoleRetries[i].InUse && s_pendingPlayerRoleRetries[i].LoadoutPtr == LoadoutPtr) {
            if (AppliedToPawn) s_pendingPlayerRoleRetries[i] = PendingPlayerRoleRetry{};
            return;
        }
        if (FreeSlot < 0 && !s_pendingPlayerRoleRetries[i].InUse) FreeSlot = i;
    }
    if (AppliedToPawn || FreeSlot < 0) return;
    s_pendingPlayerRoleRetries[FreeSlot] = PendingPlayerRoleRetry{ LoadoutPtr, GetTickCount64(), 0, 0, true };
}



















static bool TryApplyPlayerRoleRetryGuarded(
    void* LoadoutPtr, void** OutRole, void** OutSlot, void** OutPawn, void** OutPawnRole,
    bool* OutAppliedBefore, bool* OutAppliedAfter)
{
    __try {
        *OutAppliedBefore = IsPlayerRoleAppliedToPawn(LoadoutPtr, OutRole, OutSlot, OutPawn, OutPawnRole);
        if (!*OutAppliedBefore && OrigApplyPlayerRole) {
            reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(LoadoutPtr);
        }
        *OutAppliedAfter = IsPlayerRoleAppliedToPawn(LoadoutPtr);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}




static void TickPlayerRoleRetries() {
    uint64_t Now = GetTickCount64();
    for (int i = 0; i < kMaxPendingPlayerRoleRetries; ++i) {
        PendingPlayerRoleRetry& Entry = s_pendingPlayerRoleRetries[i];
        if (!Entry.InUse) continue;

        if (!IsReadablePointer(Entry.LoadoutPtr, 0x40) || Entry.RetryCount >= kMaxPlayerRoleRetryAttempts) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }
        if (Now - Entry.LastRetryMs < kPlayerRoleRetryIntervalMs) continue;

        
        
        
        
        
        
        
        
        
        
        if (!IsRegisteredLiveObject(Entry.LoadoutPtr)) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " no longer a live registered object (owning world torn down, e.g. Ramsgate->Training"
                " travel) - discarding retry entry WITHOUT calling native code");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        void* RoleBefore = nullptr; void* SlotBefore = nullptr;
        void* PawnBefore = nullptr; void* PawnRoleBefore = nullptr;
        bool AppliedBefore = false; bool AppliedAfter = false;
        const bool Survived = TryApplyPlayerRoleRetryGuarded(
            Entry.LoadoutPtr, &RoleBefore, &SlotBefore, &PawnBefore, &PawnRoleBefore,
            &AppliedBefore, &AppliedAfter);

        if (!Survived) {
            MpLog("[ApplyPlayerRole][RetryTimeout] loadout=" + MpPtr(Entry.LoadoutPtr)
                + " FAULTED re-running native apply (stale pointer, likely a level travel tore down"
                " the owning pawn/loadout) - caught, discarding retry entry instead of crashing");
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        if (AppliedBefore) {
            Entry = PendingPlayerRoleRetry{};
            continue;
        }

        Entry.LastRetryMs = Now;
        Entry.RetryCount++;
        MpLog("[ApplyPlayerRole][RetryTimeout] attempt=" + std::to_string(Entry.RetryCount)
            + " loadout=" + MpPtr(Entry.LoadoutPtr) + " elapsedMs=" + std::to_string(Now - Entry.FirstSeenInvalidMs)
            + " role=" + MpPtr(RoleBefore) + " slot=" + MpPtr(SlotBefore)
            + " pawn=" + MpPtr(PawnBefore) + " pawnRole=" + MpPtr(PawnRoleBefore)
            + " - re-running native apply");

        if (AppliedAfter) {
            MpLog("[ApplyPlayerRole][RetryTimeout] resolved after " + std::to_string(Entry.RetryCount)
                + " attempt(s), matching role is now installed on pawn loadout=" + MpPtr(Entry.LoadoutPtr));
            Entry = PendingPlayerRoleRetry{};
        }
    }
}






#pragma intrinsic(_ReturnAddress)
void ApplyPlayerRoleHook(void* a1) {
    
    
    
    uintptr_t Ret = reinterpret_cast<uintptr_t>(_ReturnAddress());
    uintptr_t RetRva = (Ret >= Globals::BaseAddress) ? (Ret - Globals::BaseAddress) : Ret;
    const char* Caller =
        (RetRva >= 0x01A664A0 && RetRva < 0x01A66900) ? "possession(0x01A664A0)" :
        (RetRva >= 0x01A4B6C0 && RetRva < 0x01A4B720) ? "apply-all(0x01A4B6C0)" :
        (RetRva >= 0x01A4B720 && RetRva < 0x01A4B790) ? "repfield-case8(0x01A4B720)" :
        (RetRva >= 0x01A72900 && RetRva < 0x01A72A80) ? "caller4(~0x01A729C3)" : "other";

    static std::atomic<int> s_aprSeq{ 0 };
    int Seq = s_aprSeq.fetch_add(1, std::memory_order_relaxed);

    
    
    
    
    
    void* Role = nullptr; void* Slot = nullptr;
    GetPlayerRoleAndSlot(a1, &Role, &Slot);
    std::string Name = (a1 && IsReadablePointer(a1, 0x40)) ? reinterpret_cast<UObject*>(a1)->GetName() : std::string("?");

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] ENTER this=" + MpPtr(a1) + "/" + Name
        + " caller=" + Caller + " retRva=+" + MpHex(RetRva)
        + " PlayerRole=" + (Role ? "Valid" : "INVALID") + "(" + MpPtr(Role) + ")"
        + " Slot=" + (Slot ? "Valid" : "INVALID") + "(" + MpPtr(Slot) + ")");

    reinterpret_cast<void(*)(void*)>(OrigApplyPlayerRole)(a1);

    
    
    
    
    
    
    
    std::string InputRoleId = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x70));
    std::string InputRoleInstance = CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Role) + 0x88));
    void* SlotCachedItem = (Slot && IsReadablePointer(Slot, 0xC0))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Slot) + 0xB8) : nullptr;
    std::string SlotCachedId = SlotCachedItem
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(SlotCachedItem) + 0x70)) : std::string();

    void* PC = (a1 && IsReadablePointer(a1, 0x638))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(a1) + 0x630) : nullptr;
    void* Pawn = (PC && IsReadablePointer(PC, 0x258))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250) : nullptr;
    void* PawnRole = (Pawn && IsReadablePointer(Pawn, 0x740))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738) : nullptr;
    void* PlayerState = (Pawn && IsReadablePointer(Pawn, 0x248))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x240) : nullptr;
    std::string PlayerStateRoleId = (PlayerState && IsReadablePointer(PlayerState, 0x648))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x638))
        : std::string();
    std::string PawnRoleId = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x240)) : std::string();
    std::string PawnRoleInstance = PawnRole
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PawnRole) + 0x250)) : std::string();
    int Equipped = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F4) : -1;
    int EquippedGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F5) : -1;
    int ActiveGameplay = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F6) : -1;
    int BpEquipCalled = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x2F7) : -1;
    int RoleActorFlags58 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x58) : -1;
    int RoleActorFlags59 = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x59) : -1;
    int RoleActorFlags5B = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5B) : -1;
    int RoleActorRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0xF0) : -1;
    int RoleActorRemoteRole = PawnRole ? SafeReadU8At(reinterpret_cast<uintptr_t>(PawnRole), 0x5F) : -1;
    void* RoleActorOwner = (PawnRole && IsReadablePointer(PawnRole, 0xE8))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PawnRole) + 0xE0) : nullptr;
    const bool AppliedToPawn = Role && Slot && Pawn && PawnRole
        && !InputRoleId.empty() && InputRoleId == PawnRoleId;
    NotePlayerRoleValidity(a1, AppliedToPawn);
    if (AppliedToPawn) {
        RoutePlayerRoleToOwningConnection(PawnRole);
        NoteTempestModifierRole(PawnRole);
        NoteTempestChargeDiagRole(PawnRole);
    }
    const std::string RoleCharge = PlayerRoleChargeSummary(PawnRole);
    MpLog("[PlayerRoleState #" + std::to_string(Seq) + "] inputId=" + InputRoleId
        + " inputInstance=" + InputRoleInstance + " slotCached=" + MpPtr(SlotCachedItem)
        + "/" + SlotCachedId + " pc=" + MpPtr(PC) + " pawn=" + MpPtr(Pawn)
        + " playerState=" + MpPtr(PlayerState) + " playerStateRoleId=" + PlayerStateRoleId
        + " pawnRole=" + MpPtr(PawnRole) + " pawnRoleId=" + PawnRoleId
        + " pawnRoleInstance=" + PawnRoleInstance + " equipped=" + std::to_string(Equipped)
        + " gameplayEquipped=" + std::to_string(EquippedGameplay)
        + " activeGameplay=" + std::to_string(ActiveGameplay)
        + " bpEquipCalled=" + std::to_string(BpEquipCalled)
        + " roleActorOwner=" + MpPtr(RoleActorOwner)
        + " netFlags58=" + std::to_string(RoleActorFlags58)
        + " netFlags59=" + std::to_string(RoleActorFlags59)
        + " netFlags5B=" + std::to_string(RoleActorFlags5B)
        + " role=" + std::to_string(RoleActorRole)
        + " remoteRole=" + std::to_string(RoleActorRemoteRole)
        + " charge={" + RoleCharge + "}"
        + " modifiers={" + PlayerRoleModifierSummary(PawnRole) + "}"
        + " appliedToPawn=" + std::to_string(AppliedToPawn ? 1 : 0));

    MpLog("[ApplyPlayerRole #" + std::to_string(Seq) + "] EXIT  this=" + MpPtr(a1) + "/" + Name + " caller=" + Caller);
}

















static void RefreshPlayerRoleGameplayLifecycle(UObject* PC, const char* TriggerLabel) {
    if (Globals::AmServer || !PC || !OrigProcessEventClient || !IsReadablePointer(PC, 0x258)) return;
    
    
    
    
    if (!IsRegisteredLiveObject(PC)) return;

    void* Pawn = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(PC) + 0x250);
    if (!Pawn || !IsReadablePointer(Pawn, 0x740)) return;
    void* PlayerState = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x240);
    void* PlayerRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738);
    if (!PlayerState || !IsReadablePointer(PlayerState, 0x691)) return;

    if (!PlayerRole) {
        const std::string ReplicatedRoleId = IsReadablePointer(PlayerState, 0x648)
            ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x638))
            : std::string();

        
        
        
        static void* s_LastRoleNotifyPawn = nullptr;
        static std::string s_LastRoleNotifyId;
        static uint64_t s_LastRoleNotifyMs = 0;
        static int s_RoleNotifyAttempts = 0;
        static uint64_t s_RoleNotifyExhaustedAtMs = 0;
        static void* s_LastEmptyRoleIdPawn = nullptr;
        const uint64_t NotifyNow = GetTickCount64();
        if (ReplicatedRoleId.empty()) {
            if (s_LastEmptyRoleIdPawn != Pawn) {
                s_LastEmptyRoleIdPawn = Pawn;
                MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                    + " pawn=" + MpPtr(Pawn) + " playerState=" + MpPtr(PlayerState)
                    + " PlayerRoleId is empty; waiting for replication");
            }
            return;
        }
        if (s_LastRoleNotifyPawn != Pawn || s_LastRoleNotifyId != ReplicatedRoleId) {
            s_LastRoleNotifyPawn = Pawn;
            s_LastRoleNotifyId = ReplicatedRoleId;
            s_LastRoleNotifyMs = 0;
            s_RoleNotifyAttempts = 0;
            s_RoleNotifyExhaustedAtMs = 0;
        }
        
        
        
        
        
        
        
        
        
        
        
        constexpr uint64_t kRoleNotifyGiveUpCooldownMs = 30000;
        if (s_RoleNotifyAttempts >= kMaxPlayerRoleRetryAttempts) {
            if (s_RoleNotifyExhaustedAtMs == 0) s_RoleNotifyExhaustedAtMs = NotifyNow;
            if (NotifyNow - s_RoleNotifyExhaustedAtMs < kRoleNotifyGiveUpCooldownMs) return;
            MpLog(std::string("[PlayerRoleRepNotify] pawn=") + MpPtr(Pawn)
                + " exhausted " + std::to_string(kMaxPlayerRoleRetryAttempts)
                + " attempts with no success - retrying after a "
                + std::to_string(kRoleNotifyGiveUpCooldownMs / 1000)
                + "s cooldown instead of giving up for the rest of the hunt");
            s_RoleNotifyAttempts = 0;
            s_RoleNotifyExhaustedAtMs = 0;
        }
        if (s_LastRoleNotifyPawn == Pawn && NotifyNow - s_LastRoleNotifyMs < 1500) return;
        s_LastRoleNotifyMs = NotifyNow;
        ++s_RoleNotifyAttempts;

        
        
        
        
        
        
        
        
        
        
        
        
        
        UObject* PlayerStateObject = reinterpret_cast<UObject*>(PlayerState);
        if (MpExeRelativeFlagPresent(L"USE_LEGACY_ROLE_ONREP_REPAIR.flag")) {
            UFunction* OnRepPlayerRoleIdFn = PlayerStateObject->Class
                ? PlayerStateObject->Class->GetFunction("ArchonPlayerState", "OnRep_PlayerRoleId")
                : nullptr;
            if (!OnRepPlayerRoleIdFn) {
                MpLog("[PlayerRoleRepNotify] OnRep_PlayerRoleId UFunction not found");
                return;
            }
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                PlayerStateObject, OnRepPlayerRoleIdFn, nullptr);
            PlayerRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738);
            MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                + " pawn=" + MpPtr(Pawn) + " playerState=" + MpPtr(PlayerState)
                + " attempt=" + std::to_string(s_RoleNotifyAttempts)
                + " replicatedId=" + ReplicatedRoleId + " replayed OnRep_PlayerRoleId (LEGACY no-op lever)"
                + " pawnRoleAfter=" + MpPtr(PlayerRole));
            if (!PlayerRole) return;
        }
        else {
            
            
            UObject* PCObject = reinterpret_cast<UObject*>(PC);
            static UFunction* s_RepairGetLoadoutFn = nullptr;
            if (!s_RepairGetLoadoutFn && PCObject->Class) {
                s_RepairGetLoadoutFn = PCObject->Class->GetFunction("ArchonPlayerController", "GetLoadout");
            }
            void* Loadout = nullptr;
            if (s_RepairGetLoadoutFn) {
                struct { void* ReturnValue; } getLoadout{ nullptr };
                reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
                    PCObject, s_RepairGetLoadoutFn, &getLoadout);
                Loadout = getLoadout.ReturnValue;
            }
            if (!Loadout || !IsRegisteredLiveObject(Loadout)) {
                MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                    + " pawn=" + MpPtr(Pawn) + " attempt=" + std::to_string(s_RoleNotifyAttempts)
                    + " replicatedId=" + ReplicatedRoleId
                    + " could not resolve a live owning loadout to re-apply; will retry");
                return;
            }
            void* RoleRef = nullptr; void* SlotRef = nullptr; void* PawnRef = nullptr; void* PawnRoleRef = nullptr;
            bool AppliedBefore = false; bool AppliedAfter = false;
            const bool Survived = TryApplyPlayerRoleRetryGuarded(
                Loadout, &RoleRef, &SlotRef, &PawnRef, &PawnRoleRef, &AppliedBefore, &AppliedAfter);
            PlayerRole = *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Pawn) + 0x738);
            MpLog(std::string("[PlayerRoleRepNotify] trigger=") + TriggerLabel
                + " pawn=" + MpPtr(Pawn) + " playerState=" + MpPtr(PlayerState)
                + " attempt=" + std::to_string(s_RoleNotifyAttempts)
                + " replicatedId=" + ReplicatedRoleId + " re-ran REAL ApplyPlayerRole"
                + " loadout=" + MpPtr(Loadout)
                + " loadoutRoleRef=" + MpPtr(RoleRef) + " loadoutSlotRef=" + MpPtr(SlotRef)
                + " survived=" + std::to_string(Survived ? 1 : 0)
                + " pawnRoleAfter=" + MpPtr(PlayerRole));
            if (!PlayerRole) return;
        }
    }
    if (!IsReadablePointer(PlayerRole, 0x2F8)) return;

    const uint8_t PlayerStateActive = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerState), 0x690, 0xEE);
    const uint8_t EquippedGameplayBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5, 0xEE);
    const uint8_t RoleActiveBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6, 0xEE);
    const uint8_t BpCalledBefore = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7, 0xEE);
    if (PlayerStateActive != 1
        || (EquippedGameplayBefore == 1 && RoleActiveBefore == 1 && BpCalledBefore == 1)) return;

    
    
    
    
    static void* s_LastLifecyclePawn = nullptr;
    static void* s_LastLifecycleRole = nullptr;
    if (s_LastLifecyclePawn == Pawn && s_LastLifecycleRole == PlayerRole) return;
    s_LastLifecyclePawn = Pawn;
    s_LastLifecycleRole = PlayerRole;

    UObject* PawnObject = reinterpret_cast<UObject*>(Pawn);
    UFunction* HandleActiveFn = PawnObject->Class
        ? PawnObject->Class->GetFunction("ArchonCharacter", "HandleActiveGameplayStateChanged")
        : nullptr;
    if (!HandleActiveFn) {
        static bool s_LoggedMissingHandleActive = false;
        if (!s_LoggedMissingHandleActive) {
            s_LoggedMissingHandleActive = true;
            MpLog("[PlayerRoleLifecycle] HandleActiveGameplayStateChanged UFunction not found");
        }
        return;
    }

    struct {
        bool bInIsActiveGameplay;
        bool bForceUpdate;
    } Params = { true, true };
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(
        PawnObject, HandleActiveFn, &Params);

    const uint8_t EquippedGameplayAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F5, 0xEE);
    const uint8_t RoleActiveAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F6, 0xEE);
    const uint8_t BpCalledAfter = SafeReadByte(reinterpret_cast<uintptr_t>(PlayerRole), 0x2F7, 0xEE);
    MpLog(std::string("[PlayerRoleLifecycle] trigger=") + TriggerLabel
        + " pc=" + MpPtr(PC) + " pawn=" + MpPtr(Pawn) + " role=" + MpPtr(PlayerRole)
        + " playerStateActive=" + std::to_string(PlayerStateActive)
        + " gameplayEquipped=" + std::to_string(EquippedGameplayBefore)
        + "->" + std::to_string(EquippedGameplayAfter)
        + " roleActive=" + std::to_string(RoleActiveBefore)
        + "->" + std::to_string(RoleActiveAfter)
        + " bpEquipCalled=" + std::to_string(BpCalledBefore)
        + "->" + std::to_string(BpCalledAfter));
}












void* OrigOnPlayerDataLoadComplete = nullptr;



static std::wstring ServerSharedPlayerHuntId() {
    if (!Globals::ExpectedPlayerString) return L"";
    std::wstring S(Globals::ExpectedPlayerString);
    size_t Colon = S.find(L':');
    if (Colon == std::wstring::npos) return L"";
    size_t Start = Colon + 1;
    size_t Comma = S.find(L',', Start);
    return S.substr(Start, Comma == std::wstring::npos ? std::wstring::npos : Comma - Start);
}

















void* OrigSchedulerInitialize = nullptr;

static constexpr int kTrialsRotationRowCount = 181;
static constexpr int kDefaultTrialsRotationMinutes = 7 * 24 * 60;

static int TrialsRotationMinutes() {
    static int Cached = 0;
    if (Cached != 0) return Cached;

    Cached = kDefaultTrialsRotationMinutes;
    char Value[32] = {};
    DWORD n = GetEnvironmentVariableA("TRIALS_ROTATION_MINUTES", Value, static_cast<DWORD>(sizeof(Value)));
    if (n > 0 && n < sizeof(Value)) {
        char* End = nullptr;
        long Parsed = std::strtol(Value, &End, 10);
        if (End != Value && *End == '\0' && Parsed >= 1 && Parsed <= 525600) {
            Cached = static_cast<int>(Parsed);
        }
    }
    return Cached;
}

static int TrialsLaunchWeekOverride() {
    char Value[16] = {};
    DWORD n = GetEnvironmentVariableA("MYSTICPARADOX_TRIALS_WEEK", Value, static_cast<DWORD>(sizeof(Value)));
    if (n == 0 || n >= sizeof(Value)) return 0;
    char* End = nullptr;
    long Parsed = std::strtol(Value, &End, 10);
    return (End != Value && *End == '\0' && Parsed >= 1 && Parsed <= kTrialsRotationRowCount)
        ? static_cast<int>(Parsed) : 0;
}

static bool TryParseTrialsScheduleWeek(const std::string& RowName, int& WeekOut) {
    static const std::string Prefix = "Scheduled_Arena_Hunt_";
    if (RowName.size() != Prefix.size() + 3 || RowName.compare(0, Prefix.size(), Prefix) != 0) return false;
    const char* Digits = RowName.c_str() + Prefix.size();
    if (Digits[0] < '0' || Digits[0] > '9' || Digits[1] < '0' || Digits[1] > '9' || Digits[2] < '0' || Digits[2] > '9') return false;
    int Week = (Digits[0] - '0') * 100 + (Digits[1] - '0') * 10 + (Digits[2] - '0');
    if (Week < 1 || Week > kTrialsRotationRowCount) return false;
    WeekOut = Week;
    return true;
}

static std::string TrialsScheduleRowName(int Week) {
    std::ostringstream Name;
    Name << "Scheduled_Arena_Hunt_" << std::setfill('0') << std::setw(3) << Week;
    return Name.str();
}

static void PatchArenaScheduleForCurrentTime(void* tablesArr) {
    
    if (!tablesArr || !IsReadablePointer(tablesArr, 0x10)) return;
    void** data = *reinterpret_cast<void***>(tablesArr);
    int num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(tablesArr) + 8);
    if (!data || num <= 0 || num > 64 || !IsReadablePointer(data, 8)) return;

    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    int64_t realNow = static_cast<int64_t>((static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime) + 504911232000000000LL;
    constexpr int64_t kTicksPerHour = 36000000000LL;
    constexpr int64_t kTicksPerMinute = 600000000LL;
    constexpr int64_t kTicksPerDay = 864000000000LL;
    constexpr int64_t kNativeArenaWeek = kTicksPerDay * 7;
    constexpr int64_t kUnixEpochDotNetTicks = 621355968000000000LL;
    const int RotationMinutes = TrialsRotationMinutes();
    const int64_t RotationTicks = static_cast<int64_t>(RotationMinutes) * kTicksPerMinute;
    const int64_t Bucket = (realNow - kUnixEpochDotNetTicks) / RotationTicks;
    const int CurrentWeek = static_cast<int>(Bucket % kTrialsRotationRowCount) + 1;
    const int64_t BucketStart = kUnixEpochDotNetTicks + Bucket * RotationTicks;
    const int LaunchWeek = TrialsLaunchWeekOverride();

    for (int t = 0; t < num; ++t) {
        UObject* tobj = reinterpret_cast<UObject*>(data[t]);
        if (!tobj || !IsReadablePointer(tobj, 0x40)) continue;
        std::string tname = tobj->GetName();
        if (tname.find("arena") == std::string::npos && tname.find("Arena") == std::string::npos) continue;
        SDK::UDataTable* dt = static_cast<SDK::UDataTable*>(tobj);
        uint8_t* Rows[kTrialsRotationRowCount + 1] = {};
        int FoundRows = 0;
        for (auto& pair : dt->RowMap) {
            std::string rn = pair.Key().GetRawString();
            uint8_t* row = pair.Value();
            if (!row || !IsReadablePointer(row, 0x30)) continue;
            int Week = 0;
            if (!TryParseTrialsScheduleWeek(rn, Week)) continue;
            Rows[Week] = row;
            ++FoundRows;
        }

        if (LaunchWeek > 0) {
            uint8_t* target = Rows[LaunchWeek];
            if (target) {
                
                
                
                const int64_t NewStart = realNow - kTicksPerHour;
                *reinterpret_cast<int64_t*>(target + 0x20) = NewStart;
                *reinterpret_cast<int64_t*>(target + 0x28) = NewStart + kNativeArenaWeek;
            }
            MpLog(target
                ? "[TrialsSchedule] Initialize: launch-pinned row='" + TrialsScheduleRowName(LaunchWeek)
                    + "' duration=7d table=" + tname
                : "[TrialsSchedule] Initialize: launch-pinned row missing '" + TrialsScheduleRowName(LaunchWeek)
                    + "' table=" + tname);
            continue;
        }

        int PatchedRows = 0;
        for (int Week = 1; Week <= kTrialsRotationRowCount; ++Week) {
            uint8_t* target = Rows[Week];
            if (!target) continue;
            const int Forward = (Week - CurrentWeek + kTrialsRotationRowCount) % kTrialsRotationRowCount;
            const int64_t NewStart = BucketStart + static_cast<int64_t>(Forward) * RotationTicks;
            *reinterpret_cast<int64_t*>(target + 0x20) = NewStart;
            *reinterpret_cast<int64_t*>(target + 0x28) = NewStart + RotationTicks;
            ++PatchedRows;
        }
        MpLog("[TrialsSchedule] Initialize: rotating intervalMinutes=" + std::to_string(RotationMinutes)
            + " currentRow='" + TrialsScheduleRowName(CurrentWeek) + "' patchedRows=" + std::to_string(PatchedRows)
            + "/" + std::to_string(FoundRows) + " bucketStartTicks=" + std::to_string(BucketStart)
            + " horizonEndTicks=" + std::to_string(BucketStart + static_cast<int64_t>(kTrialsRotationRowCount) * RotationTicks)
            + " table=" + tname);
    }
}

void SchedulerInitializeHook(void* self, void* tablesArr) {
    __try { PatchArenaScheduleForCurrentTime(tablesArr); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
    reinterpret_cast<void(*)(void*, void*)>(OrigSchedulerInitialize)(self, tablesArr);
}

void ApplyTrialsScheduleOffset(UObject* PC) {
    if (!PC || !IsReadablePointer(PC, 0x780)) return;

    
    static UFunction* s_GetSchedFn = nullptr;
    if (!s_GetSchedFn) {
        s_GetSchedFn = PC->Class->GetFunction("ArchonPlayerController", "GetSchedulerComponent");
        MpLog(std::string("[TrialsSchedule] resolve GetSchedulerComponent -> ") + MpPtr(s_GetSchedFn));
    }
    if (!s_GetSchedFn) return;
    struct { UObject* ReturnValue; } getParms{ nullptr };
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(PC, s_GetSchedFn, &getParms);
    UObject* Sched = getParms.ReturnValue;
    if (!Sched || !IsReadablePointer(Sched, 0x138)) { MpLog("[TrialsSchedule] scheduler component not ready"); return; }

    static UFunction* s_SetOffFn = nullptr;
    if (!s_SetOffFn) {
        s_SetOffFn = Sched->Class->GetFunction("SchedulerComponent", "ServerSetScheduleOffset");
        MpLog(std::string("[TrialsSchedule] resolve ServerSetScheduleOffset -> ") + MpPtr(s_SetOffFn));
    }
    static UFunction* s_UpdateFn = nullptr;
    if (!s_UpdateFn) {
        s_UpdateFn = Sched->Class->GetFunction("SchedulerComponent", "UpdateSchedules");
        MpLog(std::string("[TrialsSchedule] resolve UpdateSchedules -> ") + MpPtr(s_UpdateFn));
    }
    if (!s_UpdateFn) { MpLog("[TrialsSchedule] UpdateSchedules unresolved; cannot re-evaluate"); return; }

    
    
    
    {
        void* stData = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Sched) + 0xD0), 8)
                     ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Sched) + 0xD0) : nullptr;
        int stNum = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Sched) + 0xD8), 4)
                     ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Sched) + 0xD8) : 0;
        MpLog("[TrialsSchedule] ScheduleTables count=" + std::to_string(stNum));
        for (int i = 0; i < stNum && i < 16 && stData; ++i) {
            UObject* dt = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(stData) + static_cast<uintptr_t>(i) * 8);
            MpLog("[TrialsSchedule]   table[" + std::to_string(i) + "] = "
                + ((dt && IsReadablePointer(dt, 0x20)) ? dt->GetName() : std::string("?")));
        }
        FILETIME ft; GetSystemTimeAsFileTime(&ft);
        int64_t realNow = static_cast<int64_t>((static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime) + 504911232000000000LL;
        MpLog("[TrialsSchedule] realNow(.NET ticks)=" + std::to_string(realNow)
            + " (arena windows span 636988644000000000..638085348000000000; escalation-heroic is repeatable=always-on)");
    }

    
    
    auto scanActive = [&](bool& arenaOut) -> int {
        arenaOut = false;
        void* items = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Sched) + 0xE0), 8)
                    ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Sched) + 0xE0) : nullptr;
        int num = IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(Sched) + 0xE8), 4)
                    ? *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(Sched) + 0xE8) : 0;
        if (!items || num <= 0 || num > 4096) return num;
        for (int i = 0; i < num && i < 24; ++i) {
            uintptr_t entry = reinterpret_cast<uintptr_t>(items) + static_cast<uintptr_t>(i) * 0x18;
            if (!IsReadablePointer(reinterpret_cast<void*>(entry), 0x10)) break;
            wchar_t* idData = *reinterpret_cast<wchar_t**>(entry);
            int idNum = *reinterpret_cast<int32_t*>(entry + 8);
            std::wstring id = (idData && idNum > 0 && IsReadablePointer(idData, 2)) ? std::wstring(idData) : L"";
            if (id.find(L"Arena") != std::wstring::npos || id.find(L"Trial") != std::wstring::npos) arenaOut = true;
            MpLog("[TrialsSchedule]   active[" + std::to_string(i) + "] = " + MpNarrow(id));
        }
        return num;
    };

    
    
    
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Sched, s_UpdateFn, nullptr);
    bool arena = false;
    int cnt = scanActive(arena);
    MpLog("[TrialsSchedule] active set: count=" + std::to_string(cnt) + " arenaActive=" + std::to_string(arena ? 1 : 0));
    MpLog(std::string("[TrialsSchedule] RESULT arena/trial active = ") + (arena
        ? "YES (Trials should ungrey + launch that week's behemoth)"
        : "NO - Initialize hook likely did not fire for this scheduler; look for the 'Initialize: pre-build patched' line above"));
}

void OnPlayerDataLoadCompleteHook(UObject* PC, bool bWasSuccessful) {
    
    
    reinterpret_cast<void(*)(UObject*, bool)>(OrigOnPlayerDataLoadComplete)(PC, bWasSuccessful);

    
    
    
    if (!bWasSuccessful) return;

    if (MpExeRelativeFlagPresent(L"DISABLE_PLAYER_HUNTID_BACKFILL.flag")) return;
    if (!PC || !IsReadablePointer(PC, 0x770)) return;

    
    UObject* HuntSystem = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PC) + 0x768);
    if (!HuntSystem || !IsReadablePointer(HuntSystem, 0x190)) return;

    
    int32_t HuntIdLen = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(HuntSystem) + 0x188);
    if (HuntIdLen >= 2) return;   

    std::wstring HuntId = ServerSharedPlayerHuntId();
    if (HuntId.empty()) {
        MpLog("[HuntIdBackfill] PlayerHuntId empty but no hunt id in ExpectedPlayerString; skipping");
        return;
    }

    static UFunction* s_DebugSetPlayerHuntIDFn = nullptr;
    if (!s_DebugSetPlayerHuntIDFn) {
        s_DebugSetPlayerHuntIDFn = HuntSystem->Class->GetFunction("HuntSystemComponent", "DebugSetPlayerHuntID");
        MpLog(std::string("[HuntIdBackfill] resolve DebugSetPlayerHuntID -> ") + MpPtr(s_DebugSetPlayerHuntIDFn));
    }
    if (!s_DebugSetPlayerHuntIDFn) return;

    
    
    
    struct { FString HuntID; } Parms{ FString(HuntId.c_str()) };
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(HuntSystem, s_DebugSetPlayerHuntIDFn, &Parms);
    MpLog("[HuntIdBackfill] PlayerHuntId was empty -> set '" + MpNarrow(HuntId) + "'");
}

void InitServerHooks() {
    InitLog("[InitServerHooks] Entry - MH_Initialize");
    MH_Initialize();
    InitLog("[InitServerHooks] MH_Initialize OK");

    InstallApiHook(L"kernel32.dll", "ExitProcess", ExitProcessHook, reinterpret_cast<LPVOID*>(&OrigExitProcess), "kernel32!ExitProcess");
    InstallApiHook(L"ntdll.dll", "RtlExitUserProcess", RtlExitUserProcessHook, reinterpret_cast<LPVOID*>(&OrigRtlExitUserProcess), "ntdll!RtlExitUserProcess");
    InstallApiHook(L"kernelbase.dll", "TerminateProcess", TerminateProcessHook, reinterpret_cast<LPVOID*>(&OrigTerminateProcess), "kernelbase!TerminateProcess");
    InstallApiHook(L"kernelbase.dll", "RaiseException", RaiseExceptionHook, reinterpret_cast<LPVOID*>(&OrigRaiseException), "kernelbase!RaiseException");
    InstallApiHook(L"ucrtbase.dll", "exit", UcrtExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtExit), "ucrtbase!exit");
    InstallApiHook(L"ucrtbase.dll", "_exit", UcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtUnderscoreExit), "ucrtbase!_exit");
    InstallApiHook(L"ucrtbase.dll", "abort", UcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigUcrtAbort), "ucrtbase!abort");
    InstallApiHook(L"msvcrt.dll", "exit", MsvcrtExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtExit), "msvcrt!exit");
    InstallApiHook(L"msvcrt.dll", "_exit", MsvcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtUnderscoreExit), "msvcrt!_exit");
    InstallApiHook(L"msvcrt.dll", "abort", MsvcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtAbort), "msvcrt!abort");
    VectoredExceptionHandle = AddVectoredExceptionHandler(1, VectoredExceptionTrace);
    MpLog("[ExceptionTrace] AddVectoredExceptionHandler handle=" + MpPtr(VectoredExceptionHandle));

    
    
    MH_STATUS UnhandledCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x024A69F0), UEUnhandledExceptionFilterHook, &OrigUnhandledExceptionFilter);
    MH_STATUS UnhandledEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x024A69F0));
    MpLog(std::string("[ExitTrace] hook UEUnhandledExceptionFilter create=")
        + MH_StatusToString(UnhandledCreate)
        + " enable=" + MH_StatusToString(UnhandledEnable)
        + " target=+" + MpHex(0x024A69F0));

    

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x026A9890), ProcessEventHook, &OrigProcessEvent);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x026A9890));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x01B690F0), OnPlayerDataLoadCompleteHook, &OrigOnPlayerDataLoadComplete);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x01B690F0));

    
    
    MH_STATUS KnockoutCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01B8ACD0), KnockoutHook, &OrigKnockout);
    MH_STATUS KnockoutEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01B8ACD0));
    MpLog(std::string("[InitServerHooks] Knockout diag hook create=")
        + MH_StatusToString(KnockoutCreate) + " enable=" + MH_StatusToString(KnockoutEnable)
        + " target=+" + MpHex(0x01B8ACD0));

    
    
    
    MH_STATUS SchedInitCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01C412E0), SchedulerInitializeHook, &OrigSchedulerInitialize);
    MH_STATUS SchedInitEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01C412E0));
    MpLog(std::string("[InitServerHooks] FGameplayScheduler::Initialize create=")
        + MH_StatusToString(SchedInitCreate) + " enable=" + MH_StatusToString(SchedInitEnable)
        + " target=+" + MpHex(0x01C412E0));

    
    
    MH_STATUS AprCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01A4B790), ApplyPlayerRoleHook, &OrigApplyPlayerRole);
    MH_STATUS AprEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01A4B790));
    MpLog(std::string("[InitServerHooks] ApplyPlayerRole hook create=")
        + MH_StatusToString(AprCreate) + " enable=" + MH_StatusToString(AprEnable)
        + " target=+" + MpHex(0x01A4B790));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x02D2BD50), GetGameDefaultMap, &OrigGetDefaultMap);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x02D2BD50));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03BFDB50), GameEngineTickHook, &OrigGameEngineTick);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03BFDB50));

    
    
    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x01CDF5E0), InteractionCalloutHideHoldTextHook, &OrigInteractionCalloutHideHoldText);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x01CDF5E0));

    
    
    
    MH_STATUS FadeCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x01CADE20), ArchonLoadingScreenFadeInHook, &OrigArchonLoadingScreenFadeIn);
    MH_STATUS FadeEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01CADE20));
    MpLog(std::string("[InitServerHooks] ArchonLoadingScreenFadeIn create=")
        + MH_StatusToString(FadeCreate)
        + " enable=" + MH_StatusToString(FadeEnable)
        + " target=+" + MpHex(0x01CADE20));

    
    
    
    MH_STATUS NetDriverTickCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x03D91AC0), NetDriverTickDispatchInnerHook, &OrigNetDriverTickDispatchInner);
    MH_STATUS NetDriverTickEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x03D91AC0));
    MpLog(std::string("[InitServerHooks] NetDriverTickDispatchInner create=")
        + MH_StatusToString(NetDriverTickCreate)
        + " enable=" + MH_StatusToString(NetDriverTickEnable)
        + " target=+" + MpHex(0x03D91AC0));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03102BD0), ProcessRequest, &OrigProcessRequest);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03102BD0));

    
    
    InstallSetUrlRedirectHook("server");
    
    

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03D90740), SetReplicationDriverHook, &OrigSetReplicationDriver);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03D90740));

    
    
    MH_STATUS SraCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x03D75EF0), ServerReplicateActorsHook, &OrigServerReplicateActors);
    MH_STATUS SraEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x03D75EF0));
    MpLog(std::string("[InitServerHooks] ServerReplicateActors create=") + MH_StatusToString(SraCreate)
        + " enable=" + MH_StatusToString(SraEnable) + " target=+" + MpHex(0x03D75EF0));

    
    
    if (RepGraphDiag()) {
        MH_CreateHook((void*)(Globals::BaseAddress + 0x03B7B470), ReplicateActorFreqHook, &OrigReplicateActorFreq);
        MH_EnableHook((void*)(Globals::BaseAddress + 0x03B7B470));
        MpLog("[InitServerHooks] RepFreq diag hook installed (REPGRAPH_DIAG.flag present)");
    }

    
    

    
    
    
    
    g_RepDriverEnableFlag = reinterpret_cast<uint32_t*>(Globals::BaseAddress + 0x06729DA8);
    
    
    g_RepGraphFeatureArrayData = reinterpret_cast<void**>(Globals::BaseAddress + 0x06CE9588);
    g_RepGraphFeatureArrayNum  = reinterpret_cast<int*>(Globals::BaseAddress + 0x06CE9588 + 8);
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03D72A80), CreateRepDriverHook, &OrigCreateRepDriver);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03D72A80));

    

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03D56360), IsLevelInitForActorHook, &OrigIsLevelInitForActor);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03D56360));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x01811B40), GetStartSpotHook, &OrigGetStartSpot);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x01811B40));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x0409EC10), NetModeHook, &OrigNetModeHook);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x0409EC10));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03D77000), NetModeHook, &OrigInternalNetModeHook);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03D77000));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x0409EF00), NetModeHook, &OrigWorldNetModeHook);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x0409EF00));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x03D7C820), IsNetReadyHook, &OrigIsNetReady);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x03D7C820));

    
    
    *reinterpret_cast<uint8_t*>(Globals::BaseAddress + 0x069F6290) = 5;

    
    MH_STATUS NotifyCreate = MH_CreateHook((void*)(Globals::BaseAddress + 0x00A59270), NotifyClientDisconnectedHook, &OrigNotifyClientDisconnected);
    MH_STATUS NotifyEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x00A59270));
    MpLog(std::string("[InitServerHooks] NotifyClientDisconnected hook create=") +
        MH_StatusToString(NotifyCreate) + " enable=" + MH_StatusToString(NotifyEnable));

    
    
    
    MpLog("[InitServerHooks] NetConnectionClose diagnostic disabled (unsafe +0x1318 UObject assumption)");


    
    
    
    
    

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x01A60BC0), HasFinishedLoadingHook, &OrigHasFinishedLoading);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x01A60BC0));

    
    
    
    
    {
        MH_STATUS c = MH_CreateHook((void*)(Globals::BaseAddress + 0x03795740), ExecGetViewportSizeHook, &OrigGetViewportSize);
        MH_STATUS e = MH_EnableHook((void*)(Globals::BaseAddress + 0x03795740));
        MpLog(std::string("[InitServerHooks] GetViewportSize create=") + MH_StatusToString(c) + " enable=" + MH_StatusToString(e) + " target=+" + MpHex(0x03795740));
    }
    

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x024A8120), ServerBootCrash, &OrigServerBootCrash);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x024A8120));

    
    
    
    MH_STATUS LoadFailedCreate = MH_CreateHook(
        (void*)(Globals::BaseAddress + 0x01B65EB0),
        ArchonLoadManagerLoadFailedHook,
        &OrigArchonLoadManagerLoadFailed);
    MH_STATUS LoadFailedEnable = MH_EnableHook((void*)(Globals::BaseAddress + 0x01B65EB0));
    MpLog(std::string("[LoadFailed hook installed] create=")
        + MH_StatusToString(LoadFailedCreate)
        + " enable=" + MH_StatusToString(LoadFailedEnable)
        + " target=+" + MpHex(0x01B65EB0));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x0243A310), GetCommandLineHook, &OrigGetCommandLine);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x0243A310));

    
    
    
    {
        wchar_t ExeW[MAX_PATH];
        DWORD nw = GetModuleFileNameW(nullptr, ExeW, MAX_PATH);
        MpLog(std::string("[WARP] exe=") + ((nw > 0 && nw < MAX_PATH) ? MpNarrow(std::wstring(ExeW, nw)) : std::string("?"))
            + "  (put MP_FORCE_WARP.flag in that folder)  detected=" + (MpForceWarpEnabled() ? "YES" : "no"));
    }
    if (MpForceWarpEnabled()) {
        InstallWarpForceHooks();
        Globals::Move10Status += " [WARP force ENABLED (MP_FORCE_WARP.flag present)]";
    } else {
        Globals::Move10Status += " [WARP force off (no MP_FORCE_WARP.flag)]";
    }

    
    DWORD oldProtect;
    
    
    
    

    VirtualProtect((void*)(Globals::BaseAddress + 0x017BD9BC), 0x7, PAGE_READWRITE, &oldProtect);
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x0) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x1) = 0xF6;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x2) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x3) = 0xC0;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x4) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x5) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x017BD9BC + 0x6) = 0x90;
    VirtualProtect((void*)(Globals::BaseAddress + 0x017BD9BC), 0x7, oldProtect, &oldProtect);

#if 0 
    
    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x2) = 0x84;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x6) = 0x00;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x2) = 0x78;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x6) = 0x01;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x2) = 0x17;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x3) = 0x14;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x6) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A680 + 0x0) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A815 + 0x0) = 0x01;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, oldProtect, &oldProtect);
#endif

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    {
        std::string s;
        Move10_PatchMovByteImm(0x009E934A, 0x06B53259, 0x01, 0x00, "0x934A GIsClient 1->0", s);
        Move10_PatchMovByteImm(0x009E94FB, 0x06B5325A, 0x00, 0x01, "0x94FB GIsServer 0->1", s);
        Move10_PatchMovRegToImm0(0x009E9507, 0x06B53259, "0x9507 GIsClient ->0", s);
        Move10_NopMovByteAlStore(0x009E4FD4, 0x06B53259, "0x4FD4 E37A0 GIsClient store", s);
        Move10_NopMovByteAlStore(0x009E4FE1, 0x06B5325A, "0x4FE1 E37A0 GIsServer store", s);
        Move10_PatchCallToMovAl1(0x04046888, 0x009D81A0, "0x4046888 InitListen-gate ->true", s);
        Globals::Move10Status = s;
    }

    InitLog("[InitServerHooks] Hooks and patches installed, returning");
}

void Init() {
    InitLog("[Init] Entry");

    Globals::AmServer = std::string(GetCommandLineA()).contains("-server");
    Globals::BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);
    InitLog(std::string("[Init] BaseAddress=") + std::to_string(Globals::BaseAddress) + " AmServer=" + (Globals::AmServer ? "1" : "0"));

    
    if (Globals::AmServer) {
        *(uint8_t*)(Globals::BaseAddress + 0x06B5325A) = 0x1; 
        *(uint8_t*)(Globals::BaseAddress + 0x06B53259) = 0x0; 
    }

    

    if (Globals::AmServer) {
        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);
        InitLog(std::string("[Init] NumArgs=") + std::to_string(NumArgs));

        if (NumArgs > 8) {
            
            
            
            
            Globals::ServerAPIKeyStorage = Args[1];
            Globals::MapPathStorage = Args[3];
            Globals::BehemothPathStorage = Args[4];
            Globals::MatchmakerHuntIdStorage = Args[5];
            Globals::ExpectedPlayerStringStorage = Args[6];
            Globals::MyIpAndPortStorage = Args[7];

            Globals::ServerAPIKey = Globals::ServerAPIKeyStorage.c_str();
            Globals::Port = std::stoi(std::wstring(Args[2]));
            Globals::MapPath = Globals::MapPathStorage.c_str();
            Globals::BehemothPath = Globals::BehemothPathStorage.c_str();
            Globals::MatchmakerHuntId = Globals::MatchmakerHuntIdStorage.c_str();
            Globals::ExpectedPlayerString = Globals::ExpectedPlayerStringStorage.c_str();
            Globals::MyIpAndPort = Globals::MyIpAndPortStorage.c_str();

            InitLog(std::string("[Init] Parsed DeployServer args: Port=") + std::to_string(Globals::Port));

            if (Globals::Port >= 8776) {
                
                
                
                
                
                
                
                
                
                EnableWatchdog = true;
                Globals::EnableLogging = true;
            }
        }
        else {
            
            InitLog("[Init] Manual test mode - parsing URL args");
            std::string cmdLine = GetCommandLineA();
            InitLog("[Init] Command line captured for local parsing; details suppressed");

            
            Globals::Port = 8777;
            static std::wstring DefaultMapPath = L"Ramsgate";
            Globals::MapPath = DefaultMapPath.c_str();
            Globals::EnableLogging = true;
            EnableWatchdog = false;

            
            size_t portPos = cmdLine.find("Port=");
            if (portPos != std::string::npos) {
                int parsedPort = std::stoi(cmdLine.substr(portPos + 5));
                if (parsedPort > 0) {
                    Globals::Port = parsedPort;
                    InitLog(std::string("[Init] Parsed Port from URL: ") + std::to_string(Globals::Port));
                }
            }

            
            size_t mapStart = cmdLine.find_first_not_of(" \t", cmdLine.find_first_of(" \t") + 1);
            if (mapStart != std::string::npos && cmdLine[mapStart] != '-') {
                size_t mapEnd = cmdLine.find_first_of("? \t", mapStart);
                if (mapEnd != std::string::npos) {
                    std::string mapName = cmdLine.substr(mapStart, mapEnd - mapStart);
                    static std::wstring parsedMapPath = std::wstring(mapName.begin(), mapName.end());
                    Globals::MapPath = parsedMapPath.c_str();
                    InitLog(std::string("[Init] Parsed Map: ") + mapName);
                }
            }

            std::string mapStr;
            if (Globals::MapPath) {
                for (const wchar_t* p = Globals::MapPath; *p; ++p) mapStr += (char)*p;
            }
            InitLog(std::string("[Init] Manual test mode: Port=") + std::to_string(Globals::Port) + " Map=" + mapStr);
        }

        InitLog("[Init] Calling InitServerHooks...");
        InitServerHooks();
        InitLog("[Init] InitServerHooks returned OK");
    }
    else {
        Globals::EnableLogging = true;

        InitClientHooks();
    }

    InitLog("[Init] About to create MainThread...");
    DWORD threadId;
    CreateThread(nullptr, 0x1000, (LPTHREAD_START_ROUTINE)MainThread, nullptr, 0, &threadId);
    InitLog("[Init] MainThread created, returning from DllMain");
}

BOOL APIENTRY DllMain( HMODULE hModule,
                       DWORD  ul_reason_for_call,
                       LPVOID lpReserved
                     )
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        Init();
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}
