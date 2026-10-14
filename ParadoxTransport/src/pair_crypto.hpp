/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace mystic::bridge {

// What a sealed frame carries. Control frames hold admission requests and results (MPC1); gameplay frames hold one
// Unreal UDP datagram each; fragment frames hold one piece of a larger control or gameplay message (ice_link.cpp).
enum class FrameType : std::uint8_t {
    Control = 1,
    Gameplay = 2,
    Fragment = 3
};

// AES-256-GCM for one host-joiner pair, keyed by the pair key the backend derives for the hunt generation
// (ParadoxBackend src/p2p/security/iceSessionRules.ts DeriveIcePairKey). Frame: "MX", version 1, type, an 8-byte
// counter, the ciphertext and a 16-byte tag; the 12-byte header is authenticated data. Each direction has its own
// nonce prefix, so the two sides never reuse a nonce, and the receiver keeps a 1024-frame replay window. A cipher
// starts its counter at a random point (not 1), because a rejoin builds a new link with the same pair key.
class PairCipher final {
public:
    static constexpr std::size_t kHeaderBytes = 12;
    static constexpr std::size_t kTagBytes = 16;
    static constexpr std::size_t kOverhead = kHeaderBytes + kTagBytes;

    PairCipher() = default;
    ~PairCipher();
    PairCipher(const PairCipher&) = delete;
    PairCipher& operator=(const PairCipher&) = delete;

    // `is_host` picks the direction prefixes: the host seals host->joiner frames and opens joiner->host frames.
    bool initialize(std::span<const std::uint8_t> key, bool is_host, std::string& error);
    // A 32-byte key from its base64url text (no padding), as the backend sends it.
    static bool DecodeKey(std::string_view text, std::array<std::uint8_t, 32>& key);

    // Empty on failure (including an exhausted counter).
    [[nodiscard]] std::vector<std::uint8_t> seal(FrameType type, std::span<const std::uint8_t> payload);
    // False for a forged, malformed, replayed or too old frame.
    [[nodiscard]] bool open(std::span<const std::uint8_t> frame, FrameType& type, std::vector<std::uint8_t>& payload);

private:
    bool accept_counter(std::uint64_t counter);
    void reset();

    void* algorithm_ = nullptr;
    void* seal_key_ = nullptr;
    void* open_key_ = nullptr;
    std::array<std::uint8_t, 4> seal_prefix_{};
    std::array<std::uint8_t, 4> open_prefix_{};
    std::mutex seal_mutex_;
    std::uint64_t send_counter_ = 0;
    std::mutex open_mutex_;
    std::uint64_t highest_received_ = 0;
    std::array<std::uint64_t, 16> window_{};
};

} // namespace mystic::bridge
