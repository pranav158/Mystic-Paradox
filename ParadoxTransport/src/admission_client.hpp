/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace mystic::bridge {

struct AdmissionConsumeRequest {
    std::string session_id;
    std::string ticket;
    std::string bridge_instance_id;
    std::string connection_handle;
    std::string request_id;
    std::uint64_t authenticated_steam_id = 0;
};

struct AdmissionConsumeResult {
    bool admitted = false;
    bool idempotent = false;
    std::string admission_id;
    std::string code;
};

// ICE hosts have no lobby: host-ready names the transport instead (the backend accepts it from plan step 4 on).
struct HostReadyRequest {
    std::string session_id;
    std::string bridge_instance_id;
    std::string request_id;
    std::uint16_t virtual_port = 0;
};

struct HostHeartbeatRequest {
    std::string session_id;
    std::string request_id;
    std::uint64_t lease_sequence = 0;
    std::uint32_t admitted_peer_count = 0;
    std::uint32_t queue_pressure = 0;
    bool bridge_alive = true;
    bool server_ready = true;
};

struct GuardEventBatchRequest {
    std::string session_id;
    std::string batch_id;
    std::string previous_hash;
    std::string event_type;
    std::string actor_account_id;
    std::string payload_json;
    std::string request_id;
    std::uint64_t sequence = 0;
    std::uint64_t monotonic_ms = 0;
};

struct GuardEventBatchResult {
    bool accepted = false;
    std::string batch_hash;
    std::string error;
};

class IAdmissionClient {
public:
    virtual ~IAdmissionClient() = default;
    [[nodiscard]] virtual AdmissionConsumeResult consume(const AdmissionConsumeRequest& request) = 0;
    [[nodiscard]] virtual bool publish_host_ready(const HostReadyRequest& request,
        std::string& error) = 0;
    [[nodiscard]] virtual bool publish_heartbeat(const HostHeartbeatRequest& request,
        std::string& error) = 0;
    [[nodiscard]] virtual GuardEventBatchResult publish_guard_event(const GuardEventBatchRequest& request) = 0;
    [[nodiscard]] virtual bool request_guard_completion(std::string_view session_id,
        std::uint64_t final_sequence, std::string_view final_hash, std::string_view request_id,
        std::string& error) = 0;
    virtual void notify_disconnected(std::string_view session_id,
        std::string_view admission_id, std::string_view request_id) = 0;
};

class WinHttpAdmissionClient final : public IAdmissionClient {
public:
    ~WinHttpAdmissionClient() override;
    bool initialize(std::string_view base_url, std::string host_capability,
        std::string& error);
    [[nodiscard]] AdmissionConsumeResult consume(const AdmissionConsumeRequest& request) override;
    [[nodiscard]] bool publish_host_ready(const HostReadyRequest& request,
        std::string& error) override;
    [[nodiscard]] bool publish_heartbeat(const HostHeartbeatRequest& request,
        std::string& error) override;
    [[nodiscard]] GuardEventBatchResult publish_guard_event(const GuardEventBatchRequest& request) override;
    [[nodiscard]] bool request_guard_completion(std::string_view session_id,
        std::uint64_t final_sequence, std::string_view final_hash, std::string_view request_id,
        std::string& error) override;
    void notify_disconnected(std::string_view session_id,
        std::string_view admission_id, std::string_view request_id) override;

private:
    struct HttpResult { unsigned long status = 0; std::string body; std::string error; };
    [[nodiscard]] HttpResult post(std::string_view path, std::string_view body,
        std::string_view request_id) const;
    void reset();

    void* session_ = nullptr;
    std::wstring host_;
    std::wstring base_path_;
    unsigned short port_ = 0;
    std::string capability_;
};

} // namespace mystic::bridge
