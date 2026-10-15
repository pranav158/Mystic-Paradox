/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>

namespace mystic::bridge {

/// [2026-10-15] What one host lease heartbeat came to.
enum class HeartbeatOutcome {
    /// The backend renewed the lease.
    Renewed,
    /// No answer, or a gateway / overload status: the backend is away for a moment (a restart, a release push).
    Unavailable,
    /// An answer that refuses the lease: a fenced or stale generation, the emergency stop, an invalid heartbeat.
    Rejected,
};

/// [2026-10-15] The outcome of a lease answer. `answered` is false when no HTTP answer arrived at all. 500, 502, 504, 408
/// and 429 are the backend being away or overloaded; 503 is too, unless it is the operators' emergency stop.
inline HeartbeatOutcome ClassifyHeartbeatResponse(bool answered, unsigned long status, std::string_view body) {
    if (!answered) return HeartbeatOutcome::Unavailable;
    if (status == 200) {
        return body.find("\"renewed\":true") != std::string_view::npos ? HeartbeatOutcome::Renewed : HeartbeatOutcome::Rejected;
    }
    if (status == 503) {
        return body.find("P2P_EMERGENCY_STOP") != std::string_view::npos ? HeartbeatOutcome::Rejected : HeartbeatOutcome::Unavailable;
    }
    if (status == 500 || status == 502 || status == 504 || status == 408 || status == 429) return HeartbeatOutcome::Unavailable;
    return HeartbeatOutcome::Rejected;
}

/// [2026-10-15] The host's lease rule. A refusal ends the session after kRejectedLimit refusals in a row (a fenced
/// generation must stop quickly). A backend that is only away is waited out until kUnavailableGrace has passed since the
/// last renewal - longer than the backend's own lease and suspect window (10 s + 15 s by default), after which the backend
/// has ended the session itself and its next answer is a refusal. Until 15 Oct three failures of any kind (about 4 s) ended
/// the session, so a backend restart ended every hosted hub and the realm hunts with it.
class LeaseTracker {
public:
    static constexpr unsigned kRejectedLimit = 2;
    static constexpr std::chrono::seconds kUnavailableGrace{ 30 };

    explicit LeaseTracker(std::chrono::steady_clock::time_point start) : last_renewed_(start) {}

    /// Records one heartbeat's outcome at `now`; true when the lease must fail closed now.
    bool record(HeartbeatOutcome outcome, std::chrono::steady_clock::time_point now) {
        switch (outcome) {
        case HeartbeatOutcome::Renewed:
            last_renewed_ = now;
            rejected_in_a_row_ = 0;
            return false;
        case HeartbeatOutcome::Rejected:
            return ++rejected_in_a_row_ >= kRejectedLimit;
        case HeartbeatOutcome::Unavailable:
            rejected_in_a_row_ = 0;
            return now - last_renewed_ >= kUnavailableGrace;
        }
        return true;
    }

    /// Whole seconds since the last renewal (diagnostics).
    [[nodiscard]] long long seconds_since_renewal(std::chrono::steady_clock::time_point now) const {
        return std::chrono::duration_cast<std::chrono::seconds>(now - last_renewed_).count();
    }

private:
    std::chrono::steady_clock::time_point last_renewed_;
    unsigned rejected_in_a_row_ = 0;
};

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
    [[nodiscard]] virtual HeartbeatOutcome publish_heartbeat(const HostHeartbeatRequest& request,
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
    [[nodiscard]] HeartbeatOutcome publish_heartbeat(const HostHeartbeatRequest& request,
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
