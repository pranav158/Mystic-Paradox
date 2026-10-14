/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "pair_crypto.hpp"

#include <Windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <limits>

namespace mystic::bridge {

namespace {

constexpr std::uint8_t kMagic0 = 'M';
constexpr std::uint8_t kMagic1 = 'X';
constexpr std::uint8_t kVersion = 1;
constexpr std::size_t kWindowBits = 16 * 64;
constexpr std::size_t kMaximumPayload = 64 * 1024;
// Host->joiner and joiner->host nonce prefixes.
constexpr std::array<std::uint8_t, 4> kHostToJoin{ 'H', 'J', 0, 1 };
constexpr std::array<std::uint8_t, 4> kJoinToHost{ 'J', 'H', 0, 1 };

bool Succeeded(NTSTATUS status) {
    return status >= 0;
}

void PutU64(std::uint8_t* output, std::uint64_t value) {
    for (int index = 7; index >= 0; --index) {
        output[index] = static_cast<std::uint8_t>(value & 0xff);
        value >>= 8;
    }
}

std::uint64_t GetU64(const std::uint8_t* input) {
    std::uint64_t value = 0;
    for (int index = 0; index < 8; ++index) value = (value << 8) | input[index];
    return value;
}

int Base64UrlValue(char character) {
    if (character >= 'A' && character <= 'Z') return character - 'A';
    if (character >= 'a' && character <= 'z') return character - 'a' + 26;
    if (character >= '0' && character <= '9') return character - '0' + 52;
    if (character == '-') return 62;
    if (character == '_') return 63;
    return -1;
}

void* CreateKey(BCRYPT_ALG_HANDLE algorithm, std::span<const std::uint8_t> key) {
    BCRYPT_KEY_HANDLE handle = nullptr;
    if (!Succeeded(BCryptGenerateSymmetricKey(algorithm, &handle, nullptr, 0,
            const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0))) {
        return nullptr;
    }
    return handle;
}

} // namespace

PairCipher::~PairCipher() {
    reset();
}

void PairCipher::reset() {
    if (seal_key_) BCryptDestroyKey(static_cast<BCRYPT_KEY_HANDLE>(seal_key_));
    if (open_key_) BCryptDestroyKey(static_cast<BCRYPT_KEY_HANDLE>(open_key_));
    if (algorithm_) BCryptCloseAlgorithmProvider(static_cast<BCRYPT_ALG_HANDLE>(algorithm_), 0);
    seal_key_ = nullptr;
    open_key_ = nullptr;
    algorithm_ = nullptr;
}

bool PairCipher::DecodeKey(std::string_view text, std::array<std::uint8_t, 32>& key) {
    // 32 bytes are 43 base64url characters without padding.
    if (text.size() != 43) return false;
    std::uint32_t buffer = 0;
    int bits = 0;
    std::size_t written = 0;
    for (const char character : text) {
        const int value = Base64UrlValue(character);
        if (value < 0) return false;
        buffer = (buffer << 6) | static_cast<std::uint32_t>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (written >= key.size()) return false;
            key[written++] = static_cast<std::uint8_t>((buffer >> bits) & 0xff);
        }
    }
    // The two leftover bits of the last character must be zero.
    return written == key.size() && (buffer & ((1u << bits) - 1u)) == 0;
}

bool PairCipher::initialize(std::span<const std::uint8_t> key, bool is_host, std::string& error) {
    error.clear();
    reset();
    if (key.size() != 32) {
        error = "pair key must be 32 bytes";
        return false;
    }
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (!Succeeded(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_AES_ALGORITHM, nullptr, 0))) {
        error = "AES provider unavailable";
        return false;
    }
    algorithm_ = algorithm;
    if (!Succeeded(BCryptSetProperty(algorithm, BCRYPT_CHAINING_MODE,
            reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(BCRYPT_CHAIN_MODE_GCM)),
            static_cast<ULONG>(sizeof(BCRYPT_CHAIN_MODE_GCM)), 0))) {
        reset();
        error = "AES-GCM unavailable";
        return false;
    }
    // Separate handles for sealing (session thread) and opening (network thread).
    seal_key_ = CreateKey(algorithm, key);
    open_key_ = CreateKey(algorithm, key);
    if (!seal_key_ || !open_key_) {
        reset();
        error = "pair key could not be loaded";
        return false;
    }
    seal_prefix_ = is_host ? kHostToJoin : kJoinToHost;
    open_prefix_ = is_host ? kJoinToHost : kHostToJoin;
    // The pair key is derived per hunt generation (hub: per session), so a later link of the same pair (a rejoin)
    // reuses it; a counter that restarted at 1 would then reuse AES-GCM nonces. Each link starts at a random point
    // in the lower half of the counter space instead (the receiver's window accepts any first counter, so the wire
    // format and older peers are unchanged; a collision needs two links within a few million frames of each other).
    std::uint64_t start = 0;
    do {
        if (!Succeeded(BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&start), sizeof(start),
                BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            reset();
            error = "random number generator unavailable";
            return false;
        }
        start &= (std::numeric_limits<std::uint64_t>::max)() >> 1;
    } while (start == 0);
    send_counter_ = start;
    highest_received_ = 0;
    window_.fill(0);
    return true;
}

std::vector<std::uint8_t> PairCipher::seal(FrameType type, std::span<const std::uint8_t> payload) {
    if (!seal_key_ || payload.empty() || payload.size() > kMaximumPayload) return {};
    std::uint64_t counter = 0;
    {
        std::lock_guard lock(seal_mutex_);
        if (send_counter_ == (std::numeric_limits<std::uint64_t>::max)()) return {};
        counter = ++send_counter_;
    }
    std::vector<std::uint8_t> frame(kHeaderBytes + payload.size() + kTagBytes);
    frame[0] = kMagic0;
    frame[1] = kMagic1;
    frame[2] = kVersion;
    frame[3] = static_cast<std::uint8_t>(type);
    PutU64(frame.data() + 4, counter);
    std::array<std::uint8_t, 12> nonce{};
    std::copy(seal_prefix_.begin(), seal_prefix_.end(), nonce.begin());
    PutU64(nonce.data() + 4, counter);

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = nonce.data();
    info.cbNonce = static_cast<ULONG>(nonce.size());
    info.pbAuthData = frame.data();
    info.cbAuthData = static_cast<ULONG>(kHeaderBytes);
    info.pbTag = frame.data() + kHeaderBytes + payload.size();
    info.cbTag = static_cast<ULONG>(kTagBytes);
    ULONG written = 0;
    if (!Succeeded(BCryptEncrypt(static_cast<BCRYPT_KEY_HANDLE>(seal_key_), const_cast<PUCHAR>(payload.data()),
            static_cast<ULONG>(payload.size()), &info, nullptr, 0, frame.data() + kHeaderBytes,
            static_cast<ULONG>(payload.size()), &written, 0)) || written != payload.size()) {
        return {};
    }
    return frame;
}

bool PairCipher::accept_counter(std::uint64_t counter) {
    if (counter == 0) return false;
    if (counter > highest_received_) {
        const std::uint64_t shift = counter - highest_received_;
        if (shift >= kWindowBits) {
            window_.fill(0);
        } else {
            // Shift the bitmap left by `shift` bits; bit 0 of word 0 is the highest counter.
            const std::size_t words = static_cast<std::size_t>(shift / 64);
            const unsigned bits = static_cast<unsigned>(shift % 64);
            for (std::size_t index = window_.size(); index-- > 0;) {
                std::uint64_t value = index >= words ? window_[index - words] << bits : 0;
                if (bits != 0 && index >= words + 1) value |= window_[index - words - 1] >> (64 - bits);
                window_[index] = value;
            }
        }
        window_[0] |= 1;
        highest_received_ = counter;
        return true;
    }
    const std::uint64_t age = highest_received_ - counter;
    if (age >= kWindowBits) return false;
    std::uint64_t& word = window_[static_cast<std::size_t>(age / 64)];
    const std::uint64_t mask = std::uint64_t{ 1 } << (age % 64);
    if ((word & mask) != 0) return false;
    word |= mask;
    return true;
}

bool PairCipher::open(std::span<const std::uint8_t> frame, FrameType& type, std::vector<std::uint8_t>& payload) {
    payload.clear();
    if (!open_key_ || frame.size() <= kOverhead || frame.size() > kOverhead + kMaximumPayload ||
        frame[0] != kMagic0 || frame[1] != kMagic1 || frame[2] != kVersion ||
        (frame[3] != static_cast<std::uint8_t>(FrameType::Control) &&
            frame[3] != static_cast<std::uint8_t>(FrameType::Gameplay) &&
            frame[3] != static_cast<std::uint8_t>(FrameType::Fragment))) {
        return false;
    }
    const std::uint64_t counter = GetU64(frame.data() + 4);
    const std::size_t size = frame.size() - kOverhead;
    std::array<std::uint8_t, 12> nonce{};
    std::copy(open_prefix_.begin(), open_prefix_.end(), nonce.begin());
    PutU64(nonce.data() + 4, counter);

    std::lock_guard lock(open_mutex_);
    // Cheap replay check before decrypting; the window is updated only for an authentic frame.
    if (counter == 0 || (counter <= highest_received_ && highest_received_ - counter >= kWindowBits)) return false;
    std::vector<std::uint8_t> plain(size);
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = nonce.data();
    info.cbNonce = static_cast<ULONG>(nonce.size());
    info.pbAuthData = const_cast<PUCHAR>(frame.data());
    info.cbAuthData = static_cast<ULONG>(kHeaderBytes);
    info.pbTag = const_cast<PUCHAR>(frame.data() + kHeaderBytes + size);
    info.cbTag = static_cast<ULONG>(kTagBytes);
    ULONG written = 0;
    if (!Succeeded(BCryptDecrypt(static_cast<BCRYPT_KEY_HANDLE>(open_key_), const_cast<PUCHAR>(frame.data() + kHeaderBytes),
            static_cast<ULONG>(size), &info, nullptr, 0, plain.data(), static_cast<ULONG>(size), &written, 0)) ||
        written != size) {
        return false;
    }
    if (!accept_counter(counter)) return false;
    type = static_cast<FrameType>(frame[3]);
    payload = std::move(plain);
    return true;
}

} // namespace mystic::bridge
