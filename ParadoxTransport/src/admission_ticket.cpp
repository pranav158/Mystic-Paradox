/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "admission_ticket.hpp"

#include <Windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <fstream>
#include <limits>
#include <optional>

namespace mystic::bridge {

namespace {

constexpr std::size_t kFixedBytes = 106;
constexpr std::size_t kMaximumTokenBytes = 4096;

struct TokenParts {
    std::vector<std::uint8_t> payload;
    std::vector<std::uint8_t> signature;
};

AdmissionTicketResult Failure(std::string code) {
    AdmissionTicketResult result;
    result.code = std::move(code);
    return result;
}

bool SafeIdentifier(std::string_view value, std::size_t maximum,
    std::string_view extra) {
    if (value.empty() || value.size() > maximum) return false;
    return std::all_of(value.begin(), value.end(), [extra](unsigned char character) {
        return (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') || extra.find(static_cast<char>(character)) != std::string_view::npos;
    });
}

std::optional<std::vector<std::uint8_t>> Base64UrlDecode(std::string_view value,
    std::size_t maximum) {
    if (value.empty() || value.size() > maximum * 2 ||
        !std::all_of(value.begin(), value.end(), [](unsigned char character) {
            return (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') || character == '-' || character == '_';
        })) return std::nullopt;
    if ((value.size() % 4) == 1) return std::nullopt;
    const auto base64_value = [](unsigned char character) -> int {
        if (character >= 'A' && character <= 'Z') return character - 'A';
        if (character >= 'a' && character <= 'z') return character - 'a' + 26;
        if (character >= '0' && character <= '9') return character - '0' + 52;
        if (character == '-') return 62;
        if (character == '_') return 63;
        return -1;
    };
    const int final_value = base64_value(static_cast<unsigned char>(value.back()));
    if (((value.size() % 4) == 2 && (final_value & 0x0f) != 0) ||
        ((value.size() % 4) == 3 && (final_value & 0x03) != 0)) return std::nullopt;
    std::string standard(value);
    std::replace(standard.begin(), standard.end(), '-', '+');
    std::replace(standard.begin(), standard.end(), '_', '/');
    while ((standard.size() % 4) != 0) standard.push_back('=');
    DWORD required = 0;
    if (!CryptStringToBinaryA(standard.c_str(), static_cast<DWORD>(standard.size()),
        CRYPT_STRING_BASE64, nullptr, &required, nullptr, nullptr) || required > maximum) return std::nullopt;
    std::vector<std::uint8_t> result(required);
    if (!CryptStringToBinaryA(standard.c_str(), static_cast<DWORD>(standard.size()),
        CRYPT_STRING_BASE64, result.data(), &required, nullptr, nullptr)) return std::nullopt;
    result.resize(required);
    return result;
}

std::optional<TokenParts> SplitToken(std::string_view token) {
    if (token.size() > kMaximumTokenBytes || !token.starts_with("mpt1.")) return std::nullopt;
    const std::size_t separator = token.find('.', 5);
    if (separator == std::string_view::npos || token.find('.', separator + 1) != std::string_view::npos) {
        return std::nullopt;
    }
    auto payload = Base64UrlDecode(token.substr(5, separator - 5), 2048);
    auto signature = Base64UrlDecode(token.substr(separator + 1), 128);
    if (!payload || !signature || signature->size() != 64) return std::nullopt;
    return TokenParts{ std::move(*payload), std::move(*signature) };
}

class Reader final {
public:
    explicit Reader(std::span<const std::uint8_t> bytes) : bytes_(bytes) {}

    bool u8(std::uint8_t& value) {
        if (offset_ >= bytes_.size()) return false;
        value = bytes_[offset_++];
        return true;
    }
    bool u16(std::uint16_t& value) {
        if (offset_ + 2 > bytes_.size()) return false;
        value = static_cast<std::uint16_t>((bytes_[offset_] << 8) | bytes_[offset_ + 1]);
        offset_ += 2;
        return true;
    }
    bool u32(std::uint32_t& value) {
        if (offset_ + 4 > bytes_.size()) return false;
        value = (static_cast<std::uint32_t>(bytes_[offset_]) << 24) |
            (static_cast<std::uint32_t>(bytes_[offset_ + 1]) << 16) |
            (static_cast<std::uint32_t>(bytes_[offset_ + 2]) << 8) | bytes_[offset_ + 3];
        offset_ += 4;
        return true;
    }
    bool u64(std::uint64_t& value) {
        value = 0;
        if (offset_ + 8 > bytes_.size()) return false;
        for (int index = 0; index < 8; ++index) value = (value << 8) | bytes_[offset_++];
        return true;
    }
    bool bytes(std::size_t count, std::span<const std::uint8_t>& value) {
        if (offset_ + count > bytes_.size()) return false;
        value = bytes_.subspan(offset_, count);
        offset_ += count;
        return true;
    }
    bool text(std::size_t count, std::string& value) {
        std::span<const std::uint8_t> bytes;
        if (!this->bytes(count, bytes)) return false;
        value.assign(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        return true;
    }
    [[nodiscard]] bool empty() const { return offset_ == bytes_.size(); }

private:
    std::span<const std::uint8_t> bytes_;
    std::size_t offset_ = 0;
};

std::string Hex(std::span<const std::uint8_t> bytes) {
    constexpr char digits[] = "0123456789abcdef";
    std::string result(bytes.size() * 2, '0');
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        result[index * 2] = digits[bytes[index] >> 4];
        result[index * 2 + 1] = digits[bytes[index] & 0xf];
    }
    return result;
}

std::string Uuid(std::span<const std::uint8_t> bytes) {
    const std::string hex = Hex(bytes);
    return hex.substr(0, 8) + '-' + hex.substr(8, 4) + '-' + hex.substr(12, 4) + '-' +
        hex.substr(16, 4) + '-' + hex.substr(20);
}

AdmissionTicketResult ParsePayload(std::span<const std::uint8_t> payload) {
    if (payload.size() < kFixedBytes || std::memcmp(payload.data(), "MPT2", 4) != 0) {
        return Failure("malformed");
    }
    Reader reader(payload.subspan(4));
    std::uint8_t version = 0, key_length = 0;
    std::uint16_t account_length = 0, hunt_length = 0, party_length = 0, reserved = 0;
    AdmissionTicketClaims claims;
    if (!reader.u8(version) || !reader.u8(key_length) || !reader.u16(account_length) ||
        !reader.u16(hunt_length) || !reader.u16(party_length) ||
        !reader.u16(claims.bridge_protocol) || !reader.u16(claims.virtual_port) ||
        !reader.u16(reserved) || !reader.u32(claims.generation) || !reader.u32(claims.build) ||
        !reader.u64(claims.party_revision) || !reader.u64(claims.issued_at) ||
        !reader.u64(claims.not_before) || !reader.u64(claims.expires_at) ||
        !reader.u64(claims.joiner_steam_id) || !reader.u64(claims.host_steam_id)) {
        return Failure("malformed");
    }
    std::span<const std::uint8_t> session, jti;
    if (!reader.bytes(16, session) || !reader.bytes(16, jti) ||
        !reader.text(key_length, claims.key_id) || !reader.text(account_length, claims.account_id) ||
        !reader.text(hunt_length, claims.hunt_definition_id) || !reader.text(party_length, claims.party_id) ||
        !reader.empty()) return Failure("malformed");
    std::copy(jti.begin(), jti.end(), claims.jti_bytes.begin());
    claims.jti = Hex(jti);
    claims.session_id = Uuid(session);
    if (version != 2 || reserved != 0 || claims.generation == 0 || claims.build == 0 ||
        claims.bridge_protocol == 0 || claims.virtual_port == 0 || claims.virtual_port > 999 || claims.party_revision == 0 ||
        claims.joiner_steam_id == 0 || claims.host_steam_id == 0 ||
        !SafeIdentifier(claims.key_id, 32, "._-") ||
        !SafeIdentifier(claims.account_id, 96, "._:-") ||
        !SafeIdentifier(claims.hunt_definition_id, 128, "._:/-") ||
        !SafeIdentifier(claims.party_id, 192, "._:+/=-") ||
        std::all_of(session.begin(), session.end(), [](std::uint8_t byte) { return byte == 0; }) ||
        std::all_of(jti.begin(), jti.end(), [](std::uint8_t byte) { return byte == 0; })) {
        return Failure("malformed");
    }
    AdmissionTicketResult result;
    result.ok = true;
    result.code = "ok";
    result.claims = std::move(claims);
    return result;
}

std::array<std::uint8_t, 32> Sha256(std::span<const std::uint8_t> bytes) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_bytes = 0, result_bytes = 0;
    std::array<std::uint8_t, 32> result{};
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0 ||
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes),
            sizeof(object_bytes), &result_bytes, 0) != 0) {
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        return {};
    }
    std::vector<std::uint8_t> object(object_bytes);
    if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) == 0) {
        BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0);
        BCryptFinishHash(hash, result.data(), static_cast<ULONG>(result.size()), 0);
    }
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return result;
}

} // namespace

bool AdmissionTicketVerifier::load_public_key(const std::filesystem::path& raw_xy_path,
    std::string& error) {
    error.clear();
    std::error_code code;
    const auto status = std::filesystem::symlink_status(raw_xy_path, code);
    if (code || !std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status) ||
        std::filesystem::file_size(raw_xy_path, code) != public_xy_.size()) {
        error = "admission public key must be a regular 64-byte raw X||Y file";
        return false;
    }
    std::ifstream stream(raw_xy_path, std::ios::binary);
    stream.read(reinterpret_cast<char*>(public_xy_.data()), static_cast<std::streamsize>(public_xy_.size()));
    if (!stream || stream.gcount() != static_cast<std::streamsize>(public_xy_.size())) {
        error = "could not read admission public key";
        return false;
    }
    public_key_loaded_ = true;
    return true;
}

bool AdmissionTicketVerifier::verify_signature(std::span<const std::uint8_t> payload,
    std::span<const std::uint8_t> signature) const {
    if (!public_key_loaded_ || signature.size() != 64) return false;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_KEY_HANDLE key = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) != 0) return false;
    struct PublicBlob { BCRYPT_ECCKEY_BLOB header; std::uint8_t coordinates[64]; } blob{};
    blob.header.dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
    blob.header.cbKey = 32;
    std::copy(public_xy_.begin(), public_xy_.end(), std::begin(blob.coordinates));
    bool valid = false;
    if (BCryptImportKeyPair(algorithm, nullptr, BCRYPT_ECCPUBLIC_BLOB, &key,
        reinterpret_cast<PUCHAR>(&blob), sizeof(blob), 0) == 0) {
        const auto digest = Sha256(payload);
        valid = BCryptVerifySignature(key, nullptr, const_cast<PUCHAR>(digest.data()),
            static_cast<ULONG>(digest.size()), const_cast<PUCHAR>(signature.data()),
            static_cast<ULONG>(signature.size()), 0) == 0;
    }
    if (key) BCryptDestroyKey(key);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return valid;
}

AdmissionTicketResult AdmissionTicketVerifier::parse_unverified(std::string_view token) {
    const auto parts = SplitToken(token);
    return parts ? ParsePayload(parts->payload) : Failure("malformed");
}

AdmissionTicketResult AdmissionTicketVerifier::verify(std::string_view token,
    const ExpectedAdmissionTicket& expected) const {
    const auto parts = SplitToken(token);
    if (!parts) return Failure("malformed");
    if (!verify_signature(parts->payload, parts->signature)) return Failure("bad_signature");
    AdmissionTicketResult result = ParsePayload(parts->payload);
    if (!result.ok) return result;
    const AdmissionTicketClaims& claims = result.claims;
    const auto now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    if (claims.expires_at < claims.issued_at || claims.not_before < claims.issued_at ||
        claims.expires_at - claims.issued_at > expected.maximum_lifetime_seconds) return Failure("bad_lifetime");
    if (claims.issued_at > now + expected.clock_skew_seconds ||
        claims.not_before > now + expected.clock_skew_seconds) return Failure("not_yet_valid");
    if (now > claims.expires_at + expected.clock_skew_seconds) return Failure("expired");
    if (claims.key_id != expected.key_id) return Failure("wrong_key");
    if (claims.session_id != expected.session_id) return Failure("wrong_session");
    if (claims.generation != expected.generation) return Failure("wrong_generation");
    if (claims.party_id != expected.party_id || claims.party_revision != expected.party_revision) return Failure("wrong_party");
    if (claims.hunt_definition_id != expected.hunt_definition_id) return Failure("wrong_hunt");
    if (claims.joiner_steam_id != expected.joiner_steam_id) return Failure("wrong_joiner");
    if (claims.host_steam_id != expected.host_steam_id) return Failure("wrong_host");
    if (claims.build != expected.build) return Failure("wrong_build");
    if (claims.bridge_protocol != expected.bridge_protocol || claims.virtual_port != expected.virtual_port) return Failure("wrong_protocol");
    if (was_consumed(claims.jti_bytes)) return Failure("replay");
    return result;
}

bool AdmissionTicketVerifier::was_consumed(const std::array<std::uint8_t, 16>& jti) const {
    return consumed_.contains(jti);
}

bool AdmissionTicketVerifier::mark_consumed(const std::array<std::uint8_t, 16>& jti) {
    return consumed_.insert(jti).second;
}

} // namespace mystic::bridge
