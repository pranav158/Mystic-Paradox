/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace mystic::bridge {

struct AdmissionTicketClaims {
    std::string key_id;
    std::string account_id;
    std::string hunt_definition_id;
    std::string party_id;
    std::string session_id;
    std::string jti;
    std::uint64_t joiner_steam_id = 0;
    std::uint64_t host_steam_id = 0;
    std::uint64_t party_revision = 0;
    std::uint64_t issued_at = 0;
    std::uint64_t not_before = 0;
    std::uint64_t expires_at = 0;
    std::uint32_t generation = 0;
    std::uint32_t build = 0;
    std::uint16_t bridge_protocol = 0;
    std::uint16_t virtual_port = 0;
    std::array<std::uint8_t, 16> jti_bytes{};
};

struct ExpectedAdmissionTicket {
    std::string key_id;
    std::string session_id;
    std::string party_id;
    std::string hunt_definition_id;
    std::uint64_t joiner_steam_id = 0;
    std::uint64_t host_steam_id = 0;
    std::uint64_t party_revision = 0;
    std::uint32_t generation = 0;
    std::uint32_t build = 0;
    std::uint16_t bridge_protocol = 0;
    std::uint16_t virtual_port = 0;
    std::uint64_t clock_skew_seconds = 30;
    std::uint64_t maximum_lifetime_seconds = 180;
};

struct AdmissionTicketResult {
    bool ok = false;
    std::string code;
    AdmissionTicketClaims claims{};
};

class AdmissionTicketVerifier final {
public:
    bool load_public_key(const std::filesystem::path& raw_xy_path, std::string& error);
    [[nodiscard]] AdmissionTicketResult verify(std::string_view token,
        const ExpectedAdmissionTicket& expected) const;
    [[nodiscard]] static AdmissionTicketResult parse_unverified(std::string_view token);
    [[nodiscard]] bool was_consumed(const std::array<std::uint8_t, 16>& jti) const;
    bool mark_consumed(const std::array<std::uint8_t, 16>& jti);

private:
    [[nodiscard]] bool verify_signature(std::span<const std::uint8_t> payload,
        std::span<const std::uint8_t> signature) const;

    std::array<std::uint8_t, 64> public_xy_{};
    bool public_key_loaded_ = false;
    std::set<std::array<std::uint8_t, 16>> consumed_;
};

} // namespace mystic::bridge
