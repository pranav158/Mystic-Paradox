/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace mystic::bridge {

// MPC1 admission control frames, the same layout as the Steam bridge: magic "MPC1", version, type, two reserved
// bytes and a 32-bit payload length. Over ICE they travel inside sealed control frames (pair_crypto.hpp).
std::vector<std::uint8_t> EncodeAdmissionRequest(std::string_view ticket);
bool DecodeAdmissionRequest(std::span<const std::uint8_t> frame, std::string& ticket);
std::vector<std::uint8_t> EncodeAdmissionResult(bool admitted, std::string_view code, std::string_view admission_id);
bool DecodeAdmissionResult(std::span<const std::uint8_t> frame, bool& admitted, std::string& code,
    std::string& admission_id);

// A random RFC 4122 version-4 UUID, or empty when the system RNG fails.
std::string RandomUuid();

} // namespace mystic::bridge
