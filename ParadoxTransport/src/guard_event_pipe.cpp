/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "guard_event_pipe.hpp"

#include <Windows.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <string_view>

namespace mystic::bridge {

namespace {
constexpr std::size_t kMaximumMessage = 8192;

bool SafeToken(std::string_view value, std::size_t maximum, bool allow_empty = false) {
    return (allow_empty || !value.empty()) && value.size() <= maximum &&
        std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == ':';
        });
}

std::wstring Wide(std::string_view value) {
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring result(static_cast<std::size_t>(size), L'\0');
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), size) == size ? result : std::wstring{};
}
} // namespace

GuardEventPipe::~GuardEventPipe() {
    if (pipe_ != INVALID_HANDLE_VALUE) {
        if (connected_) DisconnectNamedPipe(static_cast<HANDLE>(pipe_));
        CloseHandle(static_cast<HANDLE>(pipe_));
    }
}

bool GuardEventPipe::initialize(std::string pipe_name, std::uint32_t expected_process_id,
    std::string& error) {
    error.clear();
    if (!SafeToken(pipe_name, 96) || expected_process_id == 0) {
        error = "invalid local Guard pipe configuration";
        return false;
    }
    const std::wstring full = L"\\\\.\\pipe\\" + Wide(pipe_name);
    // [2026-10-13 1.14.7] The Hunt Guard producer runs inside the player-host server, which can run at Low integrity
    // (an install folder with a Low mandatory label). The default pipe security has a Medium label, which refuses a
    // Low writer, so the pipe grants SYSTEM and the owner (this user) and carries a Low no-write-up label. The random
    // pipe name and the expected client process id stay the gate. Same descriptor as the launcher's ready pipe.
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)(A;;GA;;;OW)S:(ML;;NW;;;LW)",
            SDDL_REVISION_1, &descriptor, nullptr)) {
        error = "local Guard pipe security could not be prepared";
        return false;
    }
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
    HANDLE pipe = CreateNamedPipeW(full.c_str(),
        PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 0, static_cast<DWORD>(kMaximumMessage), 0, &attributes);
    LocalFree(descriptor);
    if (pipe == INVALID_HANDLE_VALUE) {
        error = "local Guard pipe creation failed";
        return false;
    }
    pipe_ = pipe;
    expected_process_id_ = expected_process_id;
    return true;
}

void GuardEventPipe::reset_connection() {
    if (pipe_ == INVALID_HANDLE_VALUE) return;
    DisconnectNamedPipe(static_cast<HANDLE>(pipe_));
    connected_ = false;
    authenticated_ = false;
}

void GuardEventPipe::pump_once() {
    if (pipe_ == INVALID_HANDLE_VALUE) return;
    HANDLE pipe = static_cast<HANDLE>(pipe_);
    if (!connected_) {
        const BOOL connected = ConnectNamedPipe(pipe, nullptr);
        const DWORD code = GetLastError();
        if (!connected && code != ERROR_PIPE_CONNECTED) return;
        connected_ = true;
        ULONG process_id = 0;
        authenticated_ = GetNamedPipeClientProcessId(pipe, &process_id) != 0 &&
            process_id == expected_process_id_;
        if (!authenticated_) { reset_connection(); return; }
    }

    for (int iteration = 0; iteration < 16; ++iteration) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
            reset_connection(); return;
        }
        if (available == 0) return;
        if (available > kMaximumMessage) { ++dropped_events_; reset_connection(); return; }
        std::array<char, kMaximumMessage> buffer{};
        DWORD read = 0;
        if (!ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) ||
            read == 0 || read > buffer.size()) { ++dropped_events_; reset_connection(); return; }
        std::string_view message(buffer.data(), read);
        const std::size_t first = message.find('\t');
        const std::size_t second = first == std::string_view::npos ? first : message.find('\t', first + 1);
        const std::size_t third = second == std::string_view::npos ? second : message.find('\t', second + 1);
        if (first == std::string_view::npos || second == std::string_view::npos || third == std::string_view::npos ||
            message.substr(0, first) != "MGE1") { ++dropped_events_; continue; }
        const std::string type(message.substr(first + 1, second - first - 1));
        const std::string actor(message.substr(second + 1, third - second - 1));
        const std::string payload(message.substr(third + 1));
        if (!SafeToken(type, 64) || !SafeToken(actor, 96, true) || payload.empty() ||
            payload.size() > 4096 || payload.front() != '{' || payload.back() != '}') {
            ++dropped_events_;
            continue;
        }
        if (events_.size() >= 256) {
            ++dropped_events_;
            continue;
        }
        events_.push_back({ type, actor, payload });
    }
}

bool GuardEventPipe::pop(LocalGuardEvent& event) {
    if (events_.empty()) return false;
    event = std::move(events_.front());
    events_.pop_front();
    return true;
}

std::uint64_t GuardEventPipe::take_dropped_count() {
    const std::uint64_t result = dropped_events_;
    dropped_events_ = 0;
    return result;
}

} // namespace mystic::bridge
