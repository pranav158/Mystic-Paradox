/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include "message_transport.hpp"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <WinSock2.h>
#include <WS2tcpip.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace mystic::bridge {

struct BridgeLimits {
    std::size_t maximum_datagram_bytes = 2048;
    std::size_t maximum_messages_per_pump = 64;
    std::size_t maximum_peers = 4;
};

struct BridgeStats {
    std::uint64_t local_datagrams_received = 0;
    std::uint64_t local_datagrams_sent = 0;
    std::uint64_t transport_messages_received = 0;
    std::uint64_t transport_messages_sent = 0;
    std::uint64_t oversized_datagrams_dropped = 0;
    std::uint64_t unexpected_local_sources_dropped = 0;
    std::uint64_t unknown_peers_dropped = 0;
    std::uint64_t transport_backpressure_drops = 0;
    std::uint64_t socket_errors = 0;
};

class WinsockRuntime final {
public:
    WinsockRuntime();
    ~WinsockRuntime();
    WinsockRuntime(const WinsockRuntime&) = delete;
    WinsockRuntime& operator=(const WinsockRuntime&) = delete;
};

class JoinerUdpBridge final {
public:
    JoinerUdpBridge(std::shared_ptr<IMessageTransport> transport, PeerId host_peer,
        std::uint16_t local_port = 0, BridgeLimits limits = {});
    ~JoinerUdpBridge();
    JoinerUdpBridge(const JoinerUdpBridge&) = delete;
    JoinerUdpBridge& operator=(const JoinerUdpBridge&) = delete;

    void pump_once();
    [[nodiscard]] std::uint16_t local_port() const { return local_port_; }
    [[nodiscard]] const BridgeStats& stats() const { return stats_; }

private:
    SOCKET socket_ = INVALID_SOCKET;
    std::shared_ptr<IMessageTransport> transport_;
    PeerId host_peer_ = 0;
    BridgeLimits limits_;
    BridgeStats stats_;
    std::vector<std::uint8_t> buffer_;
    sockaddr_in client_endpoint_{};
    bool have_client_endpoint_ = false;
    std::uint16_t local_port_ = 0;
};

class HostUdpBridge final {
public:
    HostUdpBridge(std::shared_ptr<IMessageTransport> transport, std::uint16_t server_port,
        BridgeLimits limits = {});
    ~HostUdpBridge();
    HostUdpBridge(const HostUdpBridge&) = delete;
    HostUdpBridge& operator=(const HostUdpBridge&) = delete;

    void pump_once();
    bool remove_peer(PeerId peer);
    [[nodiscard]] const BridgeStats& stats() const { return stats_; }
    [[nodiscard]] std::size_t peer_count() const { return peers_.size(); }

private:
    struct PeerSocket {
        SOCKET socket = INVALID_SOCKET;
        std::uint16_t source_port = 0;
    };

    PeerSocket* get_or_create_peer(PeerId peer);

    std::shared_ptr<IMessageTransport> transport_;
    std::uint16_t server_port_ = 0;
    BridgeLimits limits_;
    BridgeStats stats_;
    std::vector<std::uint8_t> buffer_;
    std::unordered_map<PeerId, PeerSocket> peers_;
};

// Authenticated local fast path for the selected host's own normal client. It is
// constructed only after the host's self-ticket is signature-checked and atomically
// consumed by the central backend. Two loopback sockets preserve the same endpoint
// isolation as a remote Steam peer without attempting an SDR connection to self.
class LocalHostUdpBridge final {
public:
    LocalHostUdpBridge(std::uint16_t server_port, std::uint16_t local_port = 0,
        BridgeLimits limits = {}, std::function<void(std::string_view)> diagnostic = {});
    ~LocalHostUdpBridge();
    LocalHostUdpBridge(const LocalHostUdpBridge&) = delete;
    LocalHostUdpBridge& operator=(const LocalHostUdpBridge&) = delete;

    void pump_once();
    [[nodiscard]] std::uint16_t local_port() const { return local_port_; }
    [[nodiscard]] const BridgeStats& stats() const { return stats_; }

private:
    enum class SocketOperation : std::uint8_t {
        client_receive,
        client_send,
        server_receive,
        server_send
    };

    void record_socket_error(SocketOperation operation, int error);
    // A fresh loopback socket to the game server, so a new local client is a new connection there (see pump_once).
    bool reopen_server_socket();

    SOCKET client_socket_ = INVALID_SOCKET;
    SOCKET server_socket_ = INVALID_SOCKET;
    std::uint16_t server_port_ = 0;
    std::chrono::steady_clock::time_point last_client_datagram_{};
    BridgeLimits limits_;
    BridgeStats stats_;
    std::function<void(std::string_view)> diagnostic_;
    SocketOperation last_reported_operation_ = SocketOperation::client_receive;
    int last_reported_error_ = 0;
    std::size_t reported_socket_errors_ = 0;
    std::vector<std::uint8_t> buffer_;
    sockaddr_in client_endpoint_{};
    bool have_client_endpoint_ = false;
    std::uint16_t local_port_ = 0;
};

} // namespace mystic::bridge
