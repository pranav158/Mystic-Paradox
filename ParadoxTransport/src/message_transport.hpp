/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <span>
#include <unordered_map>
#include <vector>

namespace mystic::bridge {

using PeerId = std::uint64_t;

struct TransportMessage {
    PeerId source = 0;
    std::vector<std::uint8_t> payload;
};

class IMessageTransport {
public:
    virtual ~IMessageTransport() = default;
    virtual bool send_unreliable(PeerId destination, std::span<const std::uint8_t> payload) = 0;
    virtual std::vector<TransportMessage> receive(std::size_t maximum_messages) = 0;
};

struct InMemoryTransportLimits {
    std::size_t maximum_messages_per_peer = 256;
    std::size_t maximum_bytes_per_peer = 1024 * 1024;
};

class InMemoryTransportNetwork;

class InMemoryTransportEndpoint final : public IMessageTransport {
public:
    bool send_unreliable(PeerId destination, std::span<const std::uint8_t> payload) override;
    std::vector<TransportMessage> receive(std::size_t maximum_messages) override;
    [[nodiscard]] PeerId peer_id() const { return peer_id_; }

private:
    friend class InMemoryTransportNetwork;
    InMemoryTransportEndpoint(PeerId peer_id, std::shared_ptr<InMemoryTransportNetwork> network)
        : peer_id_(peer_id), network_(std::move(network)) {}

    PeerId peer_id_;
    std::shared_ptr<InMemoryTransportNetwork> network_;
};

class InMemoryTransportNetwork final : public std::enable_shared_from_this<InMemoryTransportNetwork> {
public:
    explicit InMemoryTransportNetwork(InMemoryTransportLimits limits = {}) : limits_(limits) {}

    std::shared_ptr<InMemoryTransportEndpoint> create_endpoint(PeerId peer_id);
    bool enqueue(PeerId source, PeerId destination, std::span<const std::uint8_t> payload);
    std::vector<TransportMessage> drain(PeerId destination, std::size_t maximum_messages);

private:
    struct PeerQueue {
        std::deque<TransportMessage> messages;
        std::size_t bytes = 0;
        bool endpoint_registered = false;
    };

    std::mutex mutex_;
    std::unordered_map<PeerId, PeerQueue> queues_;
    InMemoryTransportLimits limits_;
};

} // namespace mystic::bridge
