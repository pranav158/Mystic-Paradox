/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>

namespace mystic::bridge {

// One bounded, non-secret diagnostic line. It must never contain tickets, capabilities, keys, packet contents
// or IP addresses.
using SessionDiagnosticSink = std::function<void(std::string_view)>;
// An ICE signal for the other side of a pair: the launcher posts it to /launcher/v1/p2p/hunts/:id/signal.
using SignalSink = std::function<void(std::string_view to_account_id, std::string_view kind, std::string_view data)>;
// A peer event line (PEER_CONNECTED, PEER_ADMITTED, PEER_LOST ...), read by the launcher.
using PeerEventSink = std::function<void(std::string_view line)>;

// The central rendezvous a session is bound to; the same fields the admission ticket carries. The 64-bit peer ids
// are whatever the backend put into the ticket for the host and the joiner.
struct SessionBindings {
    std::string key_id;
    std::string session_id;
    std::string party_id;
    std::string hunt_definition_id;
    std::string bridge_instance_id;
    std::uint64_t party_revision = 0;
    std::uint64_t host_peer_id = 0;
    std::uint32_t generation = 0;
    std::uint32_t build = 0;
    std::uint16_t bridge_protocol = 1;
    std::uint16_t virtual_port = 0;
};

// Peers a hunt host may hold (the Steam bridge's cap) and a hub host may hold (session_role=HUB).
inline constexpr std::size_t kMaximumHuntPeers = 4;
inline constexpr std::size_t kMaximumHubPeers = 64;

struct SessionLimits {
    std::size_t maximum_peers = 4;
    std::chrono::seconds admission_deadline{60};
    bool force_relay = false;
    // False when the backend collects no hunt evidence: the host then publishes none of its own events.
    bool hunt_evidence = true;
    // A long-lived hub host: maximum_peers may go up to kMaximumHubPeers instead of kMaximumHuntPeers.
    bool hub = false;
    // How long a signal from an account that has not been added yet waits for add_peer (ABI 3).
    std::chrono::milliseconds held_signal_ttl{20000};
};

struct SessionStats {
    std::uint64_t connection_attempts = 0;
    std::uint64_t admitted = 0;
    std::uint64_t admission_rejected = 0;
    std::uint64_t authentication_timeouts = 0;
    std::uint64_t malformed_control = 0;
    std::uint64_t pre_admission_gameplay_dropped = 0;
    std::uint64_t disconnected = 0;
    std::uint64_t guard_publish_failures = 0;
    std::uint64_t guard_evidence_loss = 0;
    std::uint64_t signals_rejected = 0;
};

} // namespace mystic::bridge
