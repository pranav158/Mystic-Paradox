/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "control_codec.hpp"

#include <Windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstdio>

namespace mystic::bridge {

namespace {

constexpr std::array<std::uint8_t, 4> kControlMagic{ 'M', 'P', 'C', '1' };
constexpr std::uint8_t kControlVersion = 1;
constexpr std::uint8_t kAdmissionRequest = 1;
constexpr std::uint8_t kAdmissionResult = 2;
constexpr std::size_t kHeaderBytes = 12;
constexpr std::size_t kMaximumControlFrame = 4608;

void PutU16(std::vector<std::uint8_t>& output, std::size_t offset, std::uint16_t value) {
    output[offset] = static_cast<std::uint8_t>(value >> 8);
    output[offset + 1] = static_cast<std::uint8_t>(value & 0xff);
}

void PutU32(std::vector<std::uint8_t>& output, std::size_t offset, std::uint32_t value) {
    output[offset] = static_cast<std::uint8_t>(value >> 24);
    output[offset + 1] = static_cast<std::uint8_t>((value >> 16) & 0xff);
    output[offset + 2] = static_cast<std::uint8_t>((value >> 8) & 0xff);
    output[offset + 3] = static_cast<std::uint8_t>(value & 0xff);
}

std::uint16_t GetU16(std::span<const std::uint8_t> input, std::size_t offset) {
    return static_cast<std::uint16_t>((input[offset] << 8) | input[offset + 1]);
}

std::uint32_t GetU32(std::span<const std::uint8_t> input, std::size_t offset) {
    return (static_cast<std::uint32_t>(input[offset]) << 24) |
        (static_cast<std::uint32_t>(input[offset + 1]) << 16) |
        (static_cast<std::uint32_t>(input[offset + 2]) << 8) | input[offset + 3];
}

std::vector<std::uint8_t> EncodeControl(std::uint8_t type, std::span<const std::uint8_t> payload) {
    if (payload.empty() || payload.size() > kMaximumControlFrame - kHeaderBytes) return {};
    std::vector<std::uint8_t> result(kHeaderBytes + payload.size());
    std::copy(kControlMagic.begin(), kControlMagic.end(), result.begin());
    result[4] = kControlVersion;
    result[5] = type;
    PutU16(result, 6, 0);
    PutU32(result, 8, static_cast<std::uint32_t>(payload.size()));
    std::copy(payload.begin(), payload.end(), result.begin() + kHeaderBytes);
    return result;
}

bool DecodeControl(std::span<const std::uint8_t> frame, std::uint8_t expected_type,
    std::span<const std::uint8_t>& payload) {
    if (frame.size() < kHeaderBytes || frame.size() > kMaximumControlFrame ||
        !std::equal(kControlMagic.begin(), kControlMagic.end(), frame.begin()) ||
        frame[4] != kControlVersion || frame[5] != expected_type || GetU16(frame, 6) != 0) return false;
    const std::size_t declared = GetU32(frame, 8);
    if (declared == 0 || declared != frame.size() - kHeaderBytes) return false;
    payload = frame.subspan(kHeaderBytes);
    return true;
}

} // namespace

std::vector<std::uint8_t> EncodeAdmissionRequest(std::string_view ticket) {
    if (ticket.empty() || ticket.size() > 4096) return {};
    std::vector<std::uint8_t> payload(2 + ticket.size());
    PutU16(payload, 0, static_cast<std::uint16_t>(ticket.size()));
    std::copy(ticket.begin(), ticket.end(), payload.begin() + 2);
    return EncodeControl(kAdmissionRequest, payload);
}

bool DecodeAdmissionRequest(std::span<const std::uint8_t> frame, std::string& ticket) {
    ticket.clear();
    std::span<const std::uint8_t> payload;
    if (!DecodeControl(frame, kAdmissionRequest, payload) || payload.size() < 3) return false;
    const std::size_t size = GetU16(payload, 0);
    if (size == 0 || size > 4096 || payload.size() != size + 2) return false;
    ticket.assign(reinterpret_cast<const char*>(payload.data() + 2), size);
    return true;
}

std::vector<std::uint8_t> EncodeAdmissionResult(bool admitted, std::string_view code, std::string_view admission_id) {
    if (code.empty() || code.size() > 64 || admission_id.size() > 64) return {};
    std::vector<std::uint8_t> payload(4 + code.size() + admission_id.size());
    payload[0] = admitted ? 1 : 0;
    payload[1] = static_cast<std::uint8_t>(code.size());
    payload[2] = static_cast<std::uint8_t>(admission_id.size());
    payload[3] = 0;
    std::copy(code.begin(), code.end(), payload.begin() + 4);
    std::copy(admission_id.begin(), admission_id.end(), payload.begin() + 4 + static_cast<std::ptrdiff_t>(code.size()));
    return EncodeControl(kAdmissionResult, payload);
}

bool DecodeAdmissionResult(std::span<const std::uint8_t> frame, bool& admitted, std::string& code,
    std::string& admission_id) {
    code.clear();
    admission_id.clear();
    std::span<const std::uint8_t> payload;
    if (!DecodeControl(frame, kAdmissionResult, payload) || payload.size() < 5 ||
        payload[0] > 1 || payload[3] != 0) return false;
    const std::size_t code_size = payload[1];
    const std::size_t admission_size = payload[2];
    if (code_size == 0 || code_size > 64 || admission_size > 64 ||
        payload.size() != 4 + code_size + admission_size) return false;
    admitted = payload[0] != 0;
    code.assign(reinterpret_cast<const char*>(payload.data() + 4), code_size);
    admission_id.assign(reinterpret_cast<const char*>(payload.data() + 4 + code_size), admission_size);
    if (admitted && admission_id.size() != 64) return false;
    return true;
}

std::string RandomUuid() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return {};
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0f) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3f) | 0x80);
    char result[37]{};
    std::snprintf(result, sizeof(result),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
    return result;
}

} // namespace mystic::bridge
