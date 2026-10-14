/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include <cstdint>
#include <deque>
#include <string>

namespace mystic::bridge {

struct LocalGuardEvent {
    std::string type;
    std::string actor_account_id;
    std::string payload_json;
};

class GuardEventPipe final {
public:
    GuardEventPipe() = default;
    ~GuardEventPipe();
    GuardEventPipe(const GuardEventPipe&) = delete;
    GuardEventPipe& operator=(const GuardEventPipe&) = delete;

    bool initialize(std::string pipe_name, std::uint32_t expected_process_id, std::string& error);
    void pump_once();
    [[nodiscard]] bool pop(LocalGuardEvent& event);
    [[nodiscard]] std::uint64_t take_dropped_count();
    [[nodiscard]] bool authenticated() const { return authenticated_; }

private:
    void reset_connection();
    void* pipe_ = reinterpret_cast<void*>(-1);
    std::uint32_t expected_process_id_ = 0;
    bool connected_ = false;
    bool authenticated_ = false;
    std::deque<LocalGuardEvent> events_;
    std::uint64_t dropped_events_ = 0;
};

} // namespace mystic::bridge
