/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "paradox_transport_api.hpp"

#include "transport_module.hpp"

#include <algorithm>
#include <cstring>

using namespace mystic::bridge;

namespace {

constexpr int kAbiVersion = 3;

// One module instance per process. It is never destroyed: a session thread must not meet a static destructor during
// process exit, and the launcher stops its sessions through Shutdown / StopSession(H) anyway.
TransportModule& Module() {
    static TransportModule* const module = new TransportModule();
    return *module;
}

void Copy(char* buffer, std::uint32_t capacity, std::string_view text) {
    if (!buffer || capacity == 0) return;
    const std::size_t length = (std::min)(text.size(), static_cast<std::size_t>(capacity - 1));
    std::memcpy(buffer, text.data(), length);
    buffer[length] = '\0';
}

} // namespace

int __cdecl MysticTransport_AbiVersion() {
    return kAbiVersion;
}

int __cdecl MysticTransport_Initialize(char* error_buffer, std::uint32_t error_buffer_size) {
    std::string error;
    if (!Module().initialize(error)) {
        Copy(error_buffer, error_buffer_size, error);
        return 0;
    }
    return 1;
}

void __cdecl MysticTransport_Shutdown() {
    Module().shutdown();
}

std::uint64_t __cdecl MysticTransport_PeerId() {
    return Module().peer_id();
}

int __cdecl MysticTransport_NetworkingReady() {
    return Module().peer_id() != 0 ? 1 : 0;
}

int __cdecl MysticTransport_StartHost(const char*, const char*, const char*, const char*, char* error_buffer,
    std::uint32_t error_buffer_size) {
    Copy(error_buffer, error_buffer_size, "This co-op transport needs a launcher with transport ABI 2 (ICE).");
    return 0;
}

int __cdecl MysticTransport_StartJoin(const char*, const char*, const char*, char* error_buffer,
    std::uint32_t error_buffer_size) {
    Copy(error_buffer, error_buffer_size, "This co-op transport needs a launcher with transport ABI 2 (ICE).");
    return 0;
}

int __cdecl MysticTransport_StartHostV2(const char* public_key_path, const char* config_path,
    const char* capability_path, const char* host_ticket_path, const char* secrets_path,
    char* error_buffer, std::uint32_t error_buffer_size) {
    return Module().start_host_v2(public_key_path, config_path, capability_path, host_ticket_path, secrets_path,
        error_buffer, error_buffer_size);
}

int __cdecl MysticTransport_StartJoinV2(const char* public_key_path, const char* config_path,
    const char* ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    return Module().start_join_v2(public_key_path, config_path, ticket_path, secrets_path, error_buffer,
        error_buffer_size);
}

int __cdecl MysticTransport_WaitReady(std::uint32_t timeout_ms, char* ready_buffer, std::uint32_t ready_buffer_size) {
    auto& module = Module();
    const int handle = module.default_handle();
    return handle == 0 ? 0 : module.wait_ready(handle, timeout_ms, ready_buffer, ready_buffer_size);
}

int __cdecl MysticTransport_SessionRunning() {
    return Module().session_running(Module().default_handle());
}

int __cdecl MysticTransport_LastSessionResult() {
    auto& module = Module();
    const int handle = module.default_handle();
    return handle == 0 ? 0 : (std::max)(module.last_session_result(handle), 0);
}

void __cdecl MysticTransport_StopSession() {
    (void)Module().stop_session(Module().default_handle());
}

int __cdecl MysticTransport_ReadDiagnostic(char* diagnostic_buffer, std::uint32_t diagnostic_buffer_size) {
    return Module().read_diagnostic(Module().default_handle(), diagnostic_buffer, diagnostic_buffer_size);
}

int __cdecl MysticTransport_ReadSignal(char* to_account_buffer, std::uint32_t to_account_size, char* kind_buffer,
    std::uint32_t kind_size, char* data_buffer, std::uint32_t data_size) {
    return Module().read_signal(Module().default_handle(), to_account_buffer, to_account_size, kind_buffer, kind_size,
        data_buffer, data_size);
}

int __cdecl MysticTransport_SubmitSignal(const char* from_account_id, const char* kind, const char* data) {
    return Module().submit_signal(Module().default_handle(), from_account_id, kind, data);
}

int __cdecl MysticTransport_ReadPeerEvent(char* event_buffer, std::uint32_t event_buffer_size) {
    return Module().read_peer_event(Module().default_handle(), event_buffer, event_buffer_size);
}

// ---- ABI 3 --------------------------------------------------------------------------------------------------------

int __cdecl MysticTransport_HostOpen(const char* public_key_path, const char* config_path, const char* capability_path,
    const char* host_ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    return Module().host_open(public_key_path, config_path, capability_path, host_ticket_path, secrets_path,
        error_buffer, error_buffer_size);
}

int __cdecl MysticTransport_JoinOpen(const char* public_key_path, const char* config_path, const char* ticket_path,
    const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    return Module().join_open(public_key_path, config_path, ticket_path, secrets_path, error_buffer,
        error_buffer_size);
}

int __cdecl MysticTransport_WaitReadyH(int handle, std::uint32_t timeout_ms, char* ready_buffer,
    std::uint32_t ready_buffer_size) {
    return Module().wait_ready(handle, timeout_ms, ready_buffer, ready_buffer_size);
}

int __cdecl MysticTransport_SessionRunningH(int handle) {
    return Module().session_running(handle);
}

int __cdecl MysticTransport_StopSessionH(int handle) {
    return Module().stop_session(handle);
}

int __cdecl MysticTransport_LastSessionResultH(int handle) {
    return Module().last_session_result(handle);
}

int __cdecl MysticTransport_ReadSignalH(int handle, char* to_account_buffer, std::uint32_t to_account_size,
    char* kind_buffer, std::uint32_t kind_size, char* data_buffer, std::uint32_t data_size) {
    return Module().read_signal(handle, to_account_buffer, to_account_size, kind_buffer, kind_size, data_buffer,
        data_size);
}

int __cdecl MysticTransport_SubmitSignalH(int handle, const char* from_account_id, const char* kind,
    const char* data) {
    return Module().submit_signal(handle, from_account_id, kind, data);
}

int __cdecl MysticTransport_ReadPeerEventH(int handle, char* event_buffer, std::uint32_t event_buffer_size) {
    return Module().read_peer_event(handle, event_buffer, event_buffer_size);
}

int __cdecl MysticTransport_ReadDiagnosticH(int handle, char* diagnostic_buffer,
    std::uint32_t diagnostic_buffer_size) {
    return Module().read_diagnostic(handle, diagnostic_buffer, diagnostic_buffer_size);
}

int __cdecl MysticTransport_AddPeerH(int handle, const char* account_id, std::uint64_t peer_id,
    const char* pair_key_base64url) {
    return Module().add_peer(handle, account_id, peer_id, pair_key_base64url);
}

int __cdecl MysticTransport_RemovePeerH(int handle, const char* account_id, const char* reason) {
    return Module().remove_peer(handle, account_id, reason);
}
