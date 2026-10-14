/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include "pair_crypto.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

struct juice_agent;

namespace mystic::bridge {

// STUN and TURN servers for one ICE agent. libjuice relays over UDP only, so only turn:...?transport=udp (or no
// transport) entries are used.
struct IceServerConfig {
    struct Turn {
        std::string host;
        std::uint16_t port = 3478;
        std::string username;
        std::string credential;
    };
    std::string stun_host;
    std::uint16_t stun_port = 3478;
    std::vector<Turn> turn_servers;
};

// "stun:host:port" -> host/port. False for anything else.
bool ParseStunUrl(std::string_view url, std::string& host, std::uint16_t& port);
// "turn:host:port[?transport=udp]" -> host/port. False for turns:, TCP and anything else.
bool ParseTurnUdpUrl(std::string_view url, std::string& host, std::uint16_t& port);
// Keeps only relay candidates and the ICE credentials (the backend applies the same rule, iceSessionRules.ts).
// Empty when nothing deliverable is left.
std::string FilterRelayOnly(std::string_view kind, std::string_view data);

struct IceSignal {
    std::string kind;   // DESCRIPTION, CANDIDATE or GATHERING_DONE
    std::string data;
};

enum class LinkState : int {
    New = 0,
    Gathering,
    Connecting,
    Connected,
    Failed,
    Closed
};

struct LinkStats {
    std::uint64_t frames_sent = 0;
    std::uint64_t send_failures = 0;
    std::uint64_t frames_received = 0;
    std::uint64_t frames_rejected = 0;
    std::uint64_t queue_drops = 0;
};

// One ICE connection to one peer (libjuice agent) carrying sealed frames. libjuice calls back on its own thread;
// everything it produces goes through locked queues that the session thread drains.
//
// Messages above kFragmentPayload bytes travel as up to four sealed Fragment frames and are rebuilt here before
// delivery (a lost piece loses the message, as IP fragmentation would). The 13 October Cloudflare relay run lost
// every 1400- and 2000-byte datagram while 1200 bytes passed; 1100-byte pieces stay under 1280 bytes (the IPv6
// minimum MTU) with the frame, TURN and IP/UDP overhead.
class IceLink final {
public:
    static constexpr std::size_t kFragmentPayload = 1100;
    static constexpr std::size_t kMaximumFragments = 4;

    struct Received {
        FrameType type = FrameType::Gameplay;
        std::vector<std::uint8_t> payload;
    };

    IceLink(IceServerConfig servers, bool relay_only, bool is_host);
    ~IceLink();
    IceLink(const IceLink&) = delete;
    IceLink& operator=(const IceLink&) = delete;

    // Creates the agent, queues the local DESCRIPTION and starts gathering. The answering side (the host) passes
    // the other side's description here, so its agent starts as the controlled one and no role conflict follows.
    bool start(std::span<const std::uint8_t> pair_key, std::string& error, std::string_view remote_description = {});
    void stop();

    [[nodiscard]] std::vector<IceSignal> take_signals();
    // DESCRIPTION, CANDIDATE or GATHERING_DONE from the other side. A second DESCRIPTION is refused (the caller
    // replaces the link: the other side restarted).
    bool apply_remote_signal(std::string_view kind, std::string_view data, std::string& error);
    [[nodiscard]] bool has_remote_description() const;

    bool send(FrameType type, std::span<const std::uint8_t> payload);
    [[nodiscard]] std::vector<Received> take_received(std::size_t maximum);

    [[nodiscard]] LinkState state() const { return static_cast<LinkState>(state_.load()); }
    [[nodiscard]] bool connected() const;
    // True when the selected candidate pair goes through a TURN relay on either side.
    [[nodiscard]] bool relayed() const;
    // "local=host remote=relay": the types (never the addresses) of the selected pair, for diagnostics; empty before
    // a pair is selected.
    [[nodiscard]] std::string selected_types() const;
    [[nodiscard]] LinkStats stats() const;

private:
    static void OnStateChanged(juice_agent* agent, int state, void* user);
    static void OnCandidate(juice_agent* agent, const char* sdp, void* user);
    static void OnGatheringDone(juice_agent* agent, void* user);
    static void OnReceive(juice_agent* agent, const char* data, std::size_t size, void* user);

    struct Partial {
        FrameType type = FrameType::Gameplay;
        std::uint8_t count = 0;
        std::uint8_t received_mask = 0;
        std::array<std::vector<std::uint8_t>, kMaximumFragments> parts;
        std::chrono::steady_clock::time_point started{};
    };

    void push_signal(std::string kind, std::string data);
    bool send_sealed(FrameType type, std::span<const std::uint8_t> payload);
    // Called with mutex_ held. Returns true and fills `whole` when the fragment completed its message.
    bool add_fragment(std::span<const std::uint8_t> fragment, Received& whole);

    IceServerConfig servers_;
    bool relay_only_ = false;
    bool is_host_ = false;
    juice_agent* agent_ = nullptr;
    PairCipher cipher_;
    mutable std::mutex mutex_;
    std::deque<IceSignal> signals_;
    std::deque<Received> received_;
    std::vector<std::string> pending_candidates_;
    bool pending_gathering_done_ = false;
    bool remote_description_ = false;
    std::unordered_map<std::uint16_t, Partial> partials_;
    std::atomic<std::uint16_t> next_message_id_{ 0 };
    std::atomic<int> state_{ static_cast<int>(LinkState::New) };
    std::atomic<std::uint64_t> frames_sent_{ 0 };
    std::atomic<std::uint64_t> send_failures_{ 0 };
    std::atomic<std::uint64_t> frames_received_{ 0 };
    std::atomic<std::uint64_t> frames_rejected_{ 0 };
    std::atomic<std::uint64_t> queue_drops_{ 0 };
};

} // namespace mystic::bridge
