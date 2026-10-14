/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "udp_bridge.hpp"

#include <algorithm>
#include <array>
#include <stdexcept>
#include <string>
#include <vector>

namespace mystic::bridge {

namespace {

void SetNonBlocking(SOCKET socket) {
    u_long enabled = 1;
    if (ioctlsocket(socket, FIONBIO, &enabled) == SOCKET_ERROR) {
        throw std::runtime_error("failed to make UDP socket nonblocking");
    }
}

sockaddr_in LoopbackAddress(std::uint16_t port) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    return address;
}

std::uint16_t BoundPort(SOCKET socket) {
    sockaddr_in address{};
    int length = sizeof(address);
    if (getsockname(socket, reinterpret_cast<sockaddr*>(&address), &length) == SOCKET_ERROR) {
        throw std::runtime_error("getsockname failed");
    }
    return ntohs(address.sin_port);
}

bool SameEndpoint(const sockaddr_in& left, const sockaddr_in& right) {
    return left.sin_family == right.sin_family &&
        left.sin_port == right.sin_port &&
        left.sin_addr.s_addr == right.sin_addr.s_addr;
}

bool WouldBlock() {
    const int error = WSAGetLastError();
    return error == WSAEWOULDBLOCK;
}

} // namespace

WinsockRuntime::WinsockRuntime() {
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
        throw std::runtime_error("WSAStartup failed");
    }
}

WinsockRuntime::~WinsockRuntime() {
    WSACleanup();
}

JoinerUdpBridge::JoinerUdpBridge(std::shared_ptr<IMessageTransport> transport,
    PeerId host_peer, std::uint16_t local_port, BridgeLimits limits)
    : transport_(std::move(transport)), host_peer_(host_peer), limits_(limits) {
    if (!transport_ || host_peer_ == 0 || limits_.maximum_datagram_bytes == 0 ||
        limits_.maximum_datagram_bytes > 65'507 || limits_.maximum_messages_per_pump == 0) {
        throw std::invalid_argument("invalid joiner bridge configuration");
    }
    buffer_.resize(limits_.maximum_datagram_bytes + 1);
    socket_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (socket_ == INVALID_SOCKET) throw std::runtime_error("joiner UDP socket creation failed");
    try {
        SetNonBlocking(socket_);
        const sockaddr_in address = LoopbackAddress(local_port);
        if (bind(socket_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
            throw std::runtime_error("joiner loopback bind failed");
        }
        local_port_ = BoundPort(socket_);
    }
    catch (...) {
        closesocket(socket_);
        socket_ = INVALID_SOCKET;
        throw;
    }
}

JoinerUdpBridge::~JoinerUdpBridge() {
    if (socket_ != INVALID_SOCKET) closesocket(socket_);
}

void JoinerUdpBridge::pump_once() {
    for (std::size_t count = 0; count < limits_.maximum_messages_per_pump; ++count) {
        sockaddr_in source{};
        int source_size = sizeof(source);
        const int received = recvfrom(socket_, reinterpret_cast<char*>(buffer_.data()),
            static_cast<int>(buffer_.size()), 0, reinterpret_cast<sockaddr*>(&source), &source_size);
        if (received == SOCKET_ERROR) {
            if (!WouldBlock()) ++stats_.socket_errors;
            break;
        }
        if (received <= 0) continue;
        ++stats_.local_datagrams_received;
        if (static_cast<std::size_t>(received) > limits_.maximum_datagram_bytes) {
            ++stats_.oversized_datagrams_dropped;
            continue;
        }
        if (!have_client_endpoint_) {
            if (source.sin_addr.s_addr != htonl(INADDR_LOOPBACK)) {
                ++stats_.unexpected_local_sources_dropped;
                continue;
            }
            client_endpoint_ = source;
            have_client_endpoint_ = true;
        }
        else if (!SameEndpoint(source, client_endpoint_)) {
            ++stats_.unexpected_local_sources_dropped;
            continue;
        }
        if (transport_->send_unreliable(host_peer_,
            std::span<const std::uint8_t>(buffer_.data(), static_cast<std::size_t>(received)))) {
            ++stats_.transport_messages_sent;
        }
        else {
            ++stats_.transport_backpressure_drops;
        }
    }

    for (auto& message : transport_->receive(limits_.maximum_messages_per_pump)) {
        ++stats_.transport_messages_received;
        if (message.source != host_peer_) {
            ++stats_.unknown_peers_dropped;
            continue;
        }
        if (message.payload.empty() || message.payload.size() > limits_.maximum_datagram_bytes) {
            ++stats_.oversized_datagrams_dropped;
            continue;
        }
        if (!have_client_endpoint_) {
            ++stats_.unexpected_local_sources_dropped;
            continue;
        }
        const int sent = sendto(socket_, reinterpret_cast<const char*>(message.payload.data()),
            static_cast<int>(message.payload.size()), 0,
            reinterpret_cast<const sockaddr*>(&client_endpoint_), sizeof(client_endpoint_));
        if (sent == static_cast<int>(message.payload.size())) ++stats_.local_datagrams_sent;
        else ++stats_.socket_errors;
    }
}

HostUdpBridge::HostUdpBridge(std::shared_ptr<IMessageTransport> transport,
    std::uint16_t server_port, BridgeLimits limits)
    : transport_(std::move(transport)), server_port_(server_port), limits_(limits) {
    if (!transport_ || server_port_ == 0 || limits_.maximum_datagram_bytes == 0 ||
        limits_.maximum_datagram_bytes > 65'507 || limits_.maximum_messages_per_pump == 0 ||
        limits_.maximum_peers == 0) {
        throw std::invalid_argument("invalid host bridge configuration");
    }
    buffer_.resize(limits_.maximum_datagram_bytes + 1);
}

HostUdpBridge::~HostUdpBridge() {
    for (auto& [peer, value] : peers_) {
        (void)peer;
        if (value.socket != INVALID_SOCKET) closesocket(value.socket);
    }
}

bool HostUdpBridge::remove_peer(PeerId peer) {
    const auto found = peers_.find(peer);
    if (found == peers_.end()) return false;
    if (found->second.socket != INVALID_SOCKET) closesocket(found->second.socket);
    peers_.erase(found);
    return true;
}

HostUdpBridge::PeerSocket* HostUdpBridge::get_or_create_peer(PeerId peer) {
    if (const auto found = peers_.find(peer); found != peers_.end()) return &found->second;
    if (peer == 0 || peers_.size() >= limits_.maximum_peers) return nullptr;

    SOCKET peer_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (peer_socket == INVALID_SOCKET) return nullptr;
    try {
        SetNonBlocking(peer_socket);
        const sockaddr_in local = LoopbackAddress(0);
        if (bind(peer_socket, reinterpret_cast<const sockaddr*>(&local), sizeof(local)) == SOCKET_ERROR) {
            throw std::runtime_error("host peer loopback bind failed");
        }
        const sockaddr_in server = LoopbackAddress(server_port_);
        if (connect(peer_socket, reinterpret_cast<const sockaddr*>(&server), sizeof(server)) == SOCKET_ERROR) {
            throw std::runtime_error("host peer UDP connect failed");
        }
        PeerSocket value{ peer_socket, BoundPort(peer_socket) };
        return &peers_.emplace(peer, value).first->second;
    }
    catch (...) {
        closesocket(peer_socket);
        ++stats_.socket_errors;
        return nullptr;
    }
}

void HostUdpBridge::pump_once() {
    for (auto& message : transport_->receive(limits_.maximum_messages_per_pump)) {
        ++stats_.transport_messages_received;
        if (message.payload.empty() || message.payload.size() > limits_.maximum_datagram_bytes) {
            ++stats_.oversized_datagrams_dropped;
            continue;
        }
        PeerSocket* peer = get_or_create_peer(message.source);
        if (!peer) {
            ++stats_.unknown_peers_dropped;
            continue;
        }
        const int sent = send(peer->socket, reinterpret_cast<const char*>(message.payload.data()),
            static_cast<int>(message.payload.size()), 0);
        if (sent == static_cast<int>(message.payload.size())) ++stats_.local_datagrams_sent;
        else ++stats_.socket_errors;
    }

    std::size_t remaining = limits_.maximum_messages_per_pump;
    for (auto& [peer_id, peer] : peers_) {
        while (remaining > 0) {
            const int received = recv(peer.socket, reinterpret_cast<char*>(buffer_.data()),
                static_cast<int>(buffer_.size()), 0);
            if (received == SOCKET_ERROR) {
                if (!WouldBlock()) ++stats_.socket_errors;
                break;
            }
            --remaining;
            if (received <= 0) continue;
            ++stats_.local_datagrams_received;
            if (static_cast<std::size_t>(received) > limits_.maximum_datagram_bytes) {
                ++stats_.oversized_datagrams_dropped;
                continue;
            }
            if (transport_->send_unreliable(peer_id,
                std::span<const std::uint8_t>(buffer_.data(), static_cast<std::size_t>(received)))) {
                ++stats_.transport_messages_sent;
            }
            else {
                ++stats_.transport_backpressure_drops;
            }
        }
        if (remaining == 0) break;
    }
}

LocalHostUdpBridge::LocalHostUdpBridge(std::uint16_t server_port,
    std::uint16_t local_port, BridgeLimits limits,
    std::function<void(std::string_view)> diagnostic)
    : limits_(limits), diagnostic_(std::move(diagnostic)) {
    if (server_port == 0 || limits_.maximum_datagram_bytes == 0 ||
        limits_.maximum_datagram_bytes > 65'507 || limits_.maximum_messages_per_pump == 0) {
        throw std::invalid_argument("invalid local-host bridge configuration");
    }
    buffer_.resize(limits_.maximum_datagram_bytes + 1);
    client_socket_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    server_socket_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (client_socket_ == INVALID_SOCKET || server_socket_ == INVALID_SOCKET) {
        if (client_socket_ != INVALID_SOCKET) closesocket(client_socket_);
        if (server_socket_ != INVALID_SOCKET) closesocket(server_socket_);
        throw std::runtime_error("local-host UDP socket creation failed");
    }
    try {
        SetNonBlocking(client_socket_);
        SetNonBlocking(server_socket_);
        const sockaddr_in client_bind = LoopbackAddress(local_port);
        if (bind(client_socket_, reinterpret_cast<const sockaddr*>(&client_bind), sizeof(client_bind)) == SOCKET_ERROR) {
            throw std::runtime_error("local-host client loopback bind failed");
        }
        const sockaddr_in server_bind = LoopbackAddress(0);
        if (bind(server_socket_, reinterpret_cast<const sockaddr*>(&server_bind), sizeof(server_bind)) == SOCKET_ERROR) {
            throw std::runtime_error("local-host peer loopback bind failed");
        }
        const sockaddr_in server = LoopbackAddress(server_port);
        if (connect(server_socket_, reinterpret_cast<const sockaddr*>(&server), sizeof(server)) == SOCKET_ERROR) {
            throw std::runtime_error("local-host server connect failed");
        }
        local_port_ = BoundPort(client_socket_);
        server_port_ = server_port;
    }
    catch (...) {
        closesocket(client_socket_);
        closesocket(server_socket_);
        client_socket_ = INVALID_SOCKET;
        server_socket_ = INVALID_SOCKET;
        throw;
    }
}

LocalHostUdpBridge::~LocalHostUdpBridge() {
    if (client_socket_ != INVALID_SOCKET) closesocket(client_socket_);
    if (server_socket_ != INVALID_SOCKET) closesocket(server_socket_);
}

bool LocalHostUdpBridge::reopen_server_socket() {
    SOCKET fresh = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fresh == INVALID_SOCKET) return false;
    try {
        SetNonBlocking(fresh);
        const sockaddr_in bind_address = LoopbackAddress(0);
        const sockaddr_in server = LoopbackAddress(server_port_);
        if (bind(fresh, reinterpret_cast<const sockaddr*>(&bind_address), sizeof(bind_address)) == SOCKET_ERROR ||
            connect(fresh, reinterpret_cast<const sockaddr*>(&server), sizeof(server)) == SOCKET_ERROR) {
            closesocket(fresh);
            return false;
        }
    }
    catch (...) {
        closesocket(fresh);
        return false;
    }
    closesocket(server_socket_);
    server_socket_ = fresh;
    return true;
}

void LocalHostUdpBridge::record_socket_error(SocketOperation operation, int error) {
    ++stats_.socket_errors;

    // Keep per-session diagnostics bounded and collapse repeated errors of the same kind.
    constexpr std::size_t maximum_reported_errors = 8;
    if (!diagnostic_ || reported_socket_errors_ >= maximum_reported_errors ||
        (reported_socket_errors_ > 0 && operation == last_reported_operation_ && error == last_reported_error_)) {
        return;
    }

    ++reported_socket_errors_;
    last_reported_operation_ = operation;
    last_reported_error_ = error;

    const char* operation_name = "unknown";
    switch (operation) {
    case SocketOperation::client_receive: operation_name = "client_recvfrom"; break;
    case SocketOperation::client_send: operation_name = "client_send"; break;
    case SocketOperation::server_receive: operation_name = "server_recv"; break;
    case SocketOperation::server_send: operation_name = "server_sendto"; break;
    }
    try {
        const std::string line = "HOST_UDP_SOCKET_ERROR path=local op=" + std::string(operation_name) +
            " wsa=" + std::to_string(error);
        diagnostic_(line);
    }
    catch (...) {
        // Diagnostics must never change the UDP forwarding path.
    }
}

void LocalHostUdpBridge::pump_once() {
    for (std::size_t count = 0; count < limits_.maximum_messages_per_pump; ++count) {
        sockaddr_in source{};
        int source_size = sizeof(source);
        const int received = recvfrom(client_socket_, reinterpret_cast<char*>(buffer_.data()),
            static_cast<int>(buffer_.size()), 0, reinterpret_cast<sockaddr*>(&source), &source_size);
        if (received == SOCKET_ERROR) {
            const int error = WSAGetLastError();
            if (error != WSAEWOULDBLOCK) record_socket_error(SocketOperation::client_receive, error);
            break;
        }
        if (received <= 0) continue;
        ++stats_.local_datagrams_received;
        if (static_cast<std::size_t>(received) > limits_.maximum_datagram_bytes) {
            ++stats_.oversized_datagrams_dropped;
            continue;
        }
        const auto now = std::chrono::steady_clock::now();
        if (!have_client_endpoint_) {
            if (source.sin_addr.s_addr != htonl(INADDR_LOOPBACK)) {
                ++stats_.unexpected_local_sources_dropped;
                continue;
            }
            client_endpoint_ = source;
            have_client_endpoint_ = true;
        }
        else if (!SameEndpoint(source, client_endpoint_)) {
            // [2026-10-14 repro] The host's own game comes back to a long-lived session (a realm hub after a hunt) from a
            // NEW loopback source port; pinning the first endpoint for life dropped it as foreign and the game timed out.
            // A loopback sender takes over once the pinned client has been silent for kClientRepinIdle, and the server
            // socket is reopened so the game server sees a new connection rather than the one it already closed.
            constexpr auto kClientRepinIdle = std::chrono::seconds(2);
            if (source.sin_addr.s_addr != htonl(INADDR_LOOPBACK) || now - last_client_datagram_ < kClientRepinIdle ||
                !reopen_server_socket()) {
                ++stats_.unexpected_local_sources_dropped;
                continue;
            }
            client_endpoint_ = source;
            if (diagnostic_) diagnostic_("LOCAL_CLIENT_REPINNED role=host path=local");
        }
        last_client_datagram_ = now;
        const int sent = send(server_socket_, reinterpret_cast<const char*>(buffer_.data()), received, 0);
        if (sent == received) ++stats_.local_datagrams_sent;
        else record_socket_error(SocketOperation::client_send, sent == SOCKET_ERROR ? WSAGetLastError() : 0);
    }

    for (std::size_t count = 0; count < limits_.maximum_messages_per_pump; ++count) {
        const int received = recv(server_socket_, reinterpret_cast<char*>(buffer_.data()),
            static_cast<int>(buffer_.size()), 0);
        if (received == SOCKET_ERROR) {
            const int error = WSAGetLastError();
            if (error != WSAEWOULDBLOCK) record_socket_error(SocketOperation::server_receive, error);
            break;
        }
        if (received <= 0 || !have_client_endpoint_) continue;
        ++stats_.local_datagrams_received;
        if (static_cast<std::size_t>(received) > limits_.maximum_datagram_bytes) {
            ++stats_.oversized_datagrams_dropped;
            continue;
        }
        const int sent = sendto(client_socket_, reinterpret_cast<const char*>(buffer_.data()), received, 0,
            reinterpret_cast<const sockaddr*>(&client_endpoint_), sizeof(client_endpoint_));
        if (sent == received) ++stats_.local_datagrams_sent;
        else record_socket_error(SocketOperation::server_send, sent == SOCKET_ERROR ? WSAGetLastError() : 0);
    }
}

} // namespace mystic::bridge
