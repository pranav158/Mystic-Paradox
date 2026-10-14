/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Player-hosted (P2P) server mode: a game server the launcher runs on a player's PC for one hunt
// session (MYSTICPARADOX_AUTH_MODE=HUNT_CAPABILITY). It binds to loopback only, authenticates to the
// backend with a session-scoped host capability instead of the gameserver key, reports readiness and
// accepts its fence over launcher-owned named pipes, and feeds the optional anti-cheat module's Hunt
// Guard evidence producer (AntiCheatHooks.h).

#include <windows.h>
#include <algorithm>
#include <ranges>
#include <string>

#include "../RuntimeShared.h"
#include "../P2PHooks.h"
#include "AntiCheatHooks.h"

namespace State {
    // MYSTICPARADOX_AUTH_MODE=HUNT_CAPABILITY on a server (ClaimAuthMode).
    static bool Active = false;
    // The launcher's bootstrap environment was complete and valid (ReadLaunch).
    static bool BootstrapValid = false;
    static volatile LONG FenceRequested = 0;
    static volatile LONG FenceHandled = 0;
    static std::string SessionId;
    static std::string Generation;
    static std::string SessionKey;
    static std::string RuntimeCapability;
    static std::string ControlPipe;
    static DWORD ExpectedLauncherPid = 0;
    // Launcher-declared role (ReadHostedRole): MYSTICPARADOX_HOSTED_ROLE=HUB makes a City/TrainingGrounds server a
    // persistent hub; absent or HUNT keeps it disposable. The two numbers are meaningful for a HUB only.
    static bool HostedHub = false;
    static int MaxPlayers = 0;        // MYSTICPARADOX_MAX_PLAYERS 1..64, 0 = not set
    static int HubAfkSeconds = -1;    // MYSTICPARADOX_HUB_AFK_SECONDS 0..7200, -1 = not set
    // The first invalid role variable (a string literal; ReadLaunch runs under the loader lock and cannot log, so
    // StartServer reports it before ending the process).
    static const char* RoleProblem = nullptr;
}

static bool MpSafeIdentifier(const std::string& Value, size_t Minimum, size_t Maximum) {
    if (Value.size() < Minimum || Value.size() > Maximum) return false;
    for (const unsigned char Character : Value) {
        if ((Character >= 'a' && Character <= 'z') ||
            (Character >= 'A' && Character <= 'Z') ||
            (Character >= '0' && Character <= '9') || Character == '.' || Character == '_' || Character == '-') {
            continue;
        }
        return false;
    }
    return true;
}

static bool MpSafePipeName(const std::string& Value, const char* Prefix) {
    const std::string PrefixString(Prefix);
    return Value.starts_with(PrefixString) &&
        MpSafeIdentifier(Value.substr(PrefixString.size()), 16, 96);
}

enum class OptionalEnvironment { Absent, Valid, Invalid };

// An optional launch variable: Absent when it is not set, Invalid when it is set but empty, too long or carries a
// control character (MpReadEnvironment cannot tell these apart from an absent variable).
static OptionalEnvironment MpReadOptionalEnvironment(const char* Name, std::string& Value, size_t Maximum) {
    Value.clear();
    char Buffer[32]{};
    SetLastError(ERROR_SUCCESS);
    const DWORD Length = GetEnvironmentVariableA(Name, Buffer, static_cast<DWORD>(sizeof(Buffer)));
    if (Length == 0) {
        return GetLastError() == ERROR_ENVVAR_NOT_FOUND ? OptionalEnvironment::Absent : OptionalEnvironment::Invalid;
    }
    if (Length >= sizeof(Buffer) || Length > Maximum) return OptionalEnvironment::Invalid;
    Value.assign(Buffer, Length);
    for (const unsigned char Character : Value) {
        if (Character < 0x20 || Character == 0x7F) return OptionalEnvironment::Invalid;
    }
    return OptionalEnvironment::Valid;
}

// Plain decimal in [Minimum, Maximum]: digits only, no sign, no leading zero (except "0" itself), at most 5 digits.
static bool MpParseBoundedInteger(const std::string& Text, int Minimum, int Maximum, int& Out) {
    if (Text.empty() || Text.size() > 5 || (Text.size() > 1 && Text[0] == '0')) return false;
    int Value = 0;
    for (const unsigned char Character : Text) {
        if (Character < '0' || Character > '9') return false;
        Value = Value * 10 + (Character - '0');
    }
    if (Value < Minimum || Value > Maximum) return false;
    Out = Value;
    return true;
}

// MYSTICPARADOX_HOSTED_ROLE (HUNT | HUB, absent = HUNT), MYSTICPARADOX_MAX_PLAYERS (1..64) and
// MYSTICPARADOX_HUB_AFK_SECONDS (0..7200): each is optional, a present value must be valid. The numbers are checked
// for a HUNT role too (a launcher bug should fail loudly either way) but only a HUB uses them. False = invalid.
static bool ReadHostedRole() {
    State::HostedHub = false;
    State::MaxPlayers = 0;
    State::HubAfkSeconds = -1;
    State::RoleProblem = nullptr;
    std::string Text;

    switch (MpReadOptionalEnvironment("MYSTICPARADOX_HOSTED_ROLE", Text, 8)) {
    case OptionalEnvironment::Absent:
        break;
    case OptionalEnvironment::Valid:
        if (Text == "HUB") State::HostedHub = true;
        else if (Text != "HUNT") {
            State::RoleProblem = "MYSTICPARADOX_HOSTED_ROLE is neither HUNT nor HUB";
            return false;
        }
        break;
    case OptionalEnvironment::Invalid:
        State::RoleProblem = "MYSTICPARADOX_HOSTED_ROLE is set but empty or malformed";
        return false;
    }

    switch (MpReadOptionalEnvironment("MYSTICPARADOX_MAX_PLAYERS", Text, 5)) {
    case OptionalEnvironment::Absent:
        break;
    case OptionalEnvironment::Valid:
        if (!MpParseBoundedInteger(Text, 1, 64, State::MaxPlayers)) {
            State::RoleProblem = "MYSTICPARADOX_MAX_PLAYERS is not a whole number from 1 to 64";
            return false;
        }
        break;
    case OptionalEnvironment::Invalid:
        State::RoleProblem = "MYSTICPARADOX_MAX_PLAYERS is set but empty or malformed";
        return false;
    }

    switch (MpReadOptionalEnvironment("MYSTICPARADOX_HUB_AFK_SECONDS", Text, 5)) {
    case OptionalEnvironment::Absent:
        break;
    case OptionalEnvironment::Valid:
        if (!MpParseBoundedInteger(Text, 0, 7200, State::HubAfkSeconds)) {
            State::RoleProblem = "MYSTICPARADOX_HUB_AFK_SECONDS is not a whole number from 0 to 7200";
            return false;
        }
        break;
    case OptionalEnvironment::Invalid:
        State::RoleProblem = "MYSTICPARADOX_HUB_AFK_SECONDS is set but empty or malformed";
        return false;
    }
    return true;
}

static DWORD WINAPI PlayerHostControlThread(void*) {
    const std::string PipeName = State::ControlPipe;
    HANDLE Pipe = CreateNamedPipeA(
        PipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 512, 512, 0, nullptr);
    if (Pipe == INVALID_HANDLE_VALUE) {
        MpLog("[PlayerHostControl] failed to create control pipe error=" + std::to_string(GetLastError()));
        InterlockedExchange(&State::FenceRequested, 1);
        return 1;
    }

    const BOOL Connected = ConnectNamedPipe(Pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
    if (!Connected) {
        MpLog("[PlayerHostControl] launcher did not connect error=" + std::to_string(GetLastError()));
        CloseHandle(Pipe);
        InterlockedExchange(&State::FenceRequested, 1);
        return 1;
    }

    ULONG ClientPid = 0;
    if (!GetNamedPipeClientProcessId(Pipe, &ClientPid) || ClientPid != State::ExpectedLauncherPid) {
        MpLog("[PlayerHostControl] rejected unexpected client pid");
        DisconnectNamedPipe(Pipe);
        CloseHandle(Pipe);
        InterlockedExchange(&State::FenceRequested, 1);
        return 1;
    }

    char Buffer[512]{};
    DWORD Read = 0;
    const BOOL ReadOk = ReadFile(Pipe, Buffer, sizeof(Buffer) - 1, &Read, nullptr);
    const std::string Expected = "MYS1 FENCE session=" + State::SessionId +
        " generation=" + State::Generation + "\n";
    if (!ReadOk || Read == 0 || Read >= sizeof(Buffer) || std::string(Buffer, Read) != Expected) {
        MpLog("[PlayerHostControl] rejected malformed fence request");
        DisconnectNamedPipe(Pipe);
        CloseHandle(Pipe);
        InterlockedExchange(&State::FenceRequested, 1);
        return 1;
    }

    InterlockedExchange(&State::FenceRequested, 1);
    const std::string Response = "MYS1 FENCE_ACK session=" + State::SessionId +
        " generation=" + State::Generation + "\n";
    DWORD Written = 0;
    WriteFile(Pipe, Response.data(), static_cast<DWORD>(Response.size()), &Written, nullptr);
    FlushFileBuffers(Pipe);
    DisconnectNamedPipe(Pipe);
    CloseHandle(Pipe);
    MpLog("[PlayerHostControl] generation fenced by authenticated launcher pid");
    return 0;
}

// Headless player host: the process the launcher spawned with a valid bootstrap and -nullrhi (reported in [InitRole]).
static bool IsHeadlessPlayerHost() {
    static int s_cached = -1;
    if (s_cached < 0) {
        const bool amServer = Globals::AmServer;
        const bool isHuntCapability = State::Active;
        const bool bootstrapValid = State::BootstrapValid;
        const bool hasNullRhi = std::string(GetCommandLineA()).contains("-nullrhi");
        s_cached = (amServer && isHuntCapability && bootstrapValid && hasNullRhi) ? 1 : 0;
    }
    return s_cached == 1;
}

bool P2PHooks::ClaimAuthMode(const std::string& Value) {
    if (Value != "HUNT_CAPABILITY") return false;
    State::Active = true;
    return true;
}

void P2PHooks::ReadLaunch(int NumArgs, wchar_t** Args) {
    bool HasLoopbackMultihome = false;
    for (int Index = 1; Index < NumArgs; ++Index) {
        if (_wcsicmp(Args[Index], L"-MULTIHOME=127.0.0.1") == 0) {
            HasLoopbackMultihome = true;
        }
    }

    std::string BindAddress;
    std::string ReadyPipe;
    std::string LaunchId;
    std::string LauncherPid;
    State::BootstrapValid =
        NumArgs > 1 && std::wstring(Args[1]) == L"-" && HasLoopbackMultihome &&
        MpReadEnvironment("MYSTICPARADOX_BIND_ADDRESS", BindAddress, 15) && BindAddress == "127.0.0.1" &&
        MpReadEnvironment("MYSTICPARADOX_SESSION_ID", State::SessionId, 36) &&
        MpSafeIdentifier(State::SessionId, 36, 36) &&
        MpReadEnvironment("MYSTICPARADOX_SESSION_GENERATION", State::Generation, 10) &&
        !State::Generation.empty() &&
        std::ranges::all_of(State::Generation, [](unsigned char Character) { return Character >= '0' && Character <= '9'; }) &&
        MpReadEnvironment("MYSTICPARADOX_HOST_RUNTIME_CAPABILITY", State::RuntimeCapability, 43) &&
        MpSafeIdentifier(State::RuntimeCapability, 43, 43) &&
        MpReadEnvironment("MYSTICPARADOX_CONTROL_PIPE", State::ControlPipe, 240) &&
        MpSafePipeName(State::ControlPipe, "\\\\.\\pipe\\MysticInternalServer.") &&
        MpReadEnvironment("MYSTICPARADOX_READY_PIPE", ReadyPipe, 240) &&
        MpSafePipeName(ReadyPipe, "\\\\.\\pipe\\MysticInternalServer.") &&
        MpReadEnvironment("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", LaunchId, 96) &&
        MpSafeIdentifier(LaunchId, 16, 96) &&
        MpReadEnvironment("MYSTICPARADOX_LAUNCHER_PID", LauncherPid, 10) &&
        std::ranges::all_of(LauncherPid, [](unsigned char Character) { return Character >= '0' && Character <= '9'; });
    if (State::BootstrapValid) {
        try {
            const unsigned long ParsedPid = std::stoul(LauncherPid);
            State::ExpectedLauncherPid = ParsedPid <= MAXDWORD ? static_cast<DWORD>(ParsedPid) : 0;
            State::BootstrapValid = State::ExpectedLauncherPid != 0;
        }
        catch (...) {
            State::BootstrapValid = false;
        }
    }
    // The launcher's hosted role (hub or hunt): an invalid value ends the process before listen like any other
    // invalid launch value. Read even when the checks above failed so StartServer can name every problem it knows.
    if (!ReadHostedRole()) State::BootstrapValid = false;
    State::SessionKey = State::SessionId + ":" + State::Generation;
}

void P2PHooks::InstallServerHooks() {
    // Evidence is produced only by a player-hosted process the launcher explicitly opted in, and only
    // when the anti-cheat module is compiled in.
    std::string HuntGuardEvents;
    const bool EnableHuntGuardEvents = State::Active
        && MpReadEnvironment("MYSTICPARADOX_HUNT_GUARD_EVENTS", HuntGuardEvents, 8)
        && HuntGuardEvents == "1";
    AntiCheatHooks::Initialize(EnableHuntGuardEvents, State::SessionKey);
    if (!AntiCheatHooks::Present()) {
        MpLog("[HuntGuard] anti-cheat module not built in; no evidence (unmonitored hunt, no rewards)");
    }
    else {
        MpLog(std::string("[HuntGuard] event pipe is ")
            + (EnableHuntGuardEvents ? "ENABLED (explicit opt-in)" : "disabled (safe default)"));
    }

    // [2026-10-10] The WebBrowserWidget (Chromium/CEF) startup skip that used to live here, for this headless host
    // only, is now installed for every server role by InstallServerWebBrowserSkip in dllmain.cpp.
}

std::string P2PHooks::DescribeRole() {
    return std::string(" BootstrapValid=") + (State::BootstrapValid ? "1" : "0")
        + " HeadlessPlayerHost=" + (IsHeadlessPlayerHost() ? "1" : "0")
        + " HostedRole=" + (State::HostedHub ? "HUB" : "HUNT");
}

bool P2PHooks::StartServer() {
    if (!State::BootstrapValid) {
        MpLog("[PlayerHostControl] invalid player-host bootstrap; terminating before listen");
        if (State::RoleProblem) MpLog(std::string("[HostedRole] invalid launcher role: ") + State::RoleProblem);
        TerminateProcess(GetCurrentProcess(), 0xE103);
        return false;
    }
    // The launcher's role decision, once, so a hub or hunt log always states which one the launcher asked for.
    if (State::HostedHub) {
        MpLog(std::string("[HostedRole] launcher role=HUB (persistent hub) maxPlayers=")
            + (State::MaxPlayers > 0 ? std::to_string(State::MaxPlayers) + " (launcher)"
                                     : std::string("HUB_MAX_PLAYERS.txt/default"))
            + " hubAfkSeconds="
            + (State::HubAfkSeconds >= 0 ? std::to_string(State::HubAfkSeconds) + " (launcher)"
                                         : std::string("HUB_AFK_TIMEOUT_SECONDS.txt/default")));
    }
    else {
        MpLog(std::string("[HostedRole] launcher role=HUNT (disposable)")
            + ((State::MaxPlayers > 0 || State::HubAfkSeconds >= 0)
                ? " - MYSTICPARADOX_MAX_PLAYERS / MYSTICPARADOX_HUB_AFK_SECONDS are set but ignored (they apply to a HUB only)"
                : ""));
    }
    HANDLE ControlThread = CreateThread(nullptr, 0, PlayerHostControlThread, nullptr, 0, nullptr);
    if (!ControlThread) {
        MpLog("[PlayerHostControl] control thread creation failed; terminating before listen");
        TerminateProcess(GetCurrentProcess(), 0xE104);
        return false;
    }
    CloseHandle(ControlThread);
    MpLog("[PlayerHostControl] control pipe worker started");

    if (!AntiCheatHooks::StartWorker()) {
        // A player-host process without its evidence worker has no completion authority.
        // Fail before listen instead of running a hunt that can never be validated.
        MpLog("[HuntGuard] evidence worker creation failed; terminating before listen");
        TerminateProcess(GetCurrentProcess(), 0xE105);
        return false;
    }
    if (AntiCheatHooks::Present()) MpLog("[HuntGuard] non-blocking evidence worker started");
    return true;
}

bool P2PHooks::PrepareListen(std::wstring& Host) {
    if (!State::Active) return true;
    std::string BindAddress;
    if (!MpReadEnvironment("MYSTICPARADOX_BIND_ADDRESS", BindAddress, 15) || BindAddress != "127.0.0.1") {
        MpLog("[Networking::Listen] player-host bind address is not loopback; refusing listen");
        return false;
    }
    // [2026-10-11 1.14.7] The socket's address is not the FURL host: UE binds the MULTIHOME= of the engine's
    // FCommandLine. The launcher passes -MULTIHOME=127.0.0.1 (ReadLaunch requires it), the core carries it into the
    // engine line (dllmain HookFCommandLineGet) and Networking::Listen refuses the listen unless that MULTIHOME is
    // exactly this Host - so pinning Host here is what enforces the loopback-only bind.
    Host = L"127.0.0.1";
    return true;
}

bool P2PHooks::ReportsReadiness() {
    return State::Active;
}

// The launcher, not DeployServer, waits for this process: report readiness on its private pipe.
bool P2PHooks::ReportReady(int Port) {
    std::string PipeName;
    std::string SessionId;
    std::string Generation;
    std::string LaunchId;
    const std::string PipePrefix = "\\\\.\\pipe\\MysticInternalServer.";
    if (!MpReadEnvironment("MYSTICPARADOX_READY_PIPE", PipeName, 240) || !MpSafePipeName(PipeName, PipePrefix.c_str()) ||
        !MpReadEnvironment("MYSTICPARADOX_SESSION_ID", SessionId, 36) || !MpSafeIdentifier(SessionId, 36, 36) ||
        !MpReadEnvironment("MYSTICPARADOX_SESSION_GENERATION", Generation, 10) || !MpSafeIdentifier(Generation, 1, 10) ||
        Generation.find_first_not_of("0123456789") != std::string::npos ||
        !MpReadEnvironment("MYSTICPARADOX_GAMESERVER_LAUNCH_ID", LaunchId, 96) || !MpSafeIdentifier(LaunchId, 16, 96)) {
        MpLog("[Networking::Listen] player-host readiness environment is invalid");
        return false;
    }

    // [2026-10-13 1.14.7] The first live host on 1.14.7 failed this open right after a successful wait, and the
    // error was not logged. Log it, and retry a busy pipe (another opener can take the single instance between the
    // wait and the open) for up to 5 s.
    HANDLE Pipe = INVALID_HANDLE_VALUE;
    DWORD OpenError = 0;
    const ULONGLONG OpenDeadline = GetTickCount64() + 5000;
    for (int Attempt = 1;; ++Attempt) {
        if (!WaitNamedPipeA(PipeName.c_str(), 5000)) {
            MpLog("[Networking::Listen] launcher readiness pipe did not become available error=" +
                std::to_string(GetLastError()) + " attempt=" + std::to_string(Attempt));
            return false;
        }
        Pipe = CreateFileA(PipeName.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (Pipe != INVALID_HANDLE_VALUE) break;
        OpenError = GetLastError();
        MpLog("[Networking::Listen] launcher readiness pipe open failed error=" + std::to_string(OpenError) +
            " attempt=" + std::to_string(Attempt));
        if (OpenError != ERROR_PIPE_BUSY || GetTickCount64() >= OpenDeadline) return false;
        Sleep(100);
    }
    const std::string Message = "MYS1 READY session=" + SessionId + " generation=" + Generation +
        " launch=" + LaunchId + " port=" + std::to_string(Port) + " bind=127.0.0.1\n";
    DWORD Written = 0;
    const BOOL Ok = WriteFile(Pipe, Message.data(), static_cast<DWORD>(Message.size()), &Written, nullptr);
    FlushFileBuffers(Pipe);
    CloseHandle(Pipe);
    if (!Ok || Written != static_cast<DWORD>(Message.size())) {
        MpLog("[Networking::Listen] launcher readiness message write failed");
        return false;
    }
    MpLog("[Networking::Listen] player-host readiness acknowledged by launcher pipe");
    return true;
}

bool P2PHooks::TickShutdown() {
    if (InterlockedCompareExchange(&State::FenceRequested, 0, 0) == 0) return false;
    static ULONGLONG FenceStartedAt = 0;
    if (InterlockedCompareExchange(&State::FenceHandled, 1, 0) == 0) {
        FenceStartedAt = GetTickCount64();
        // [2026-10-11 1.14.7] On a server MpQuitGame ends the process at once with exit code 0 (the reap path; QuitGame
        // did nothing without a local PlayerController, so every fence used to end in the 0xE105 fallback below, which
        // stays for SERVER_QUITGAME_EXIT.flag).
        MpLog("[PlayerHostControl] applying fence on game thread; ending the process (MpQuitGame)");
        MpQuitGame();
    }
    else if (GetTickCount64() - FenceStartedAt >= 5000) {
        MpLog("[PlayerHostControl] graceful quit deadline elapsed; forcing process termination");
        TerminateProcess(GetCurrentProcess(), 0xE105);
    }
    return true;
}

void P2PHooks::OnListenFailed() {
    InterlockedExchange(&State::FenceRequested, 1);
}

// Player-hosted processes never receive the global gameserver credential. The launcher-provisioned
// capability is bound to this one host/session and is validated as ordinary player authority by the
// Metagame.
void P2PHooks::RequestHeader(std::wstring& Name, std::wstring& Value) {
    if (State::RuntimeCapability.size() != 43) return;
    Name = L"x-mystic-host-capability";
    Value.assign(State::RuntimeCapability.begin(), State::RuntimeCapability.end());
}

void P2PHooks::ObserveServerEvent(const std::string& FunctionName, void* Parms) {
    AntiCheatHooks::ObserveServerEvent(FunctionName, Parms);
}

// A hub role only counts for a valid bootstrap of this mode; every other process answers "no hub, no override".
bool P2PHooks::HostedRoleIsHub() {
    return State::Active && State::BootstrapValid && State::HostedHub;
}

int P2PHooks::MaxPlayersOverride() {
    return HostedRoleIsHub() ? State::MaxPlayers : 0;
}

int P2PHooks::HubAfkSecondsOverride() {
    return HostedRoleIsHub() ? State::HubAfkSeconds : -1;
}
