/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "message_transport.hpp"

#include <algorithm>
#include <stdexcept>

namespace mystic::bridge {

bool InMemoryTransportEndpoint::send_unreliable(
    PeerId destination, std::span<const std::uint8_t> payload) {
    return network_->enqueue(peer_id_, destination, payload);
}

std::vector<TransportMessage> InMemoryTransportEndpoint::receive(std::size_t maximum_messages) {
    return network_->drain(peer_id_, maximum_messages);
}

std::shared_ptr<InMemoryTransportEndpoint> InMemoryTransportNetwork::create_endpoint(PeerId peer_id) {
    if (peer_id == 0) throw std::invalid_argument("peer ID zero is reserved");
    {
        std::scoped_lock lock(mutex_);
        auto& queue = queues_[peer_id];
        if (queue.endpoint_registered) throw std::invalid_argument("duplicate peer endpoint");
        queue.endpoint_registered = true;
    }
    return std::shared_ptr<InMemoryTransportEndpoint>(
        new InMemoryTransportEndpoint(peer_id, shared_from_this()));
}

bool InMemoryTransportNetwork::enqueue(
    PeerId source, PeerId destination, std::span<const std::uint8_t> payload) {
    if (source == 0 || destination == 0 || payload.empty()) return false;
    std::scoped_lock lock(mutex_);
    const auto target = queues_.find(destination);
    if (target == queues_.end() || !target->second.endpoint_registered) return false;
    auto& queue = target->second;
    if (queue.messages.size() >= limits_.maximum_messages_per_peer) return false;
    if (payload.size() > limits_.maximum_bytes_per_peer -
        std::min(queue.bytes, limits_.maximum_bytes_per_peer)) return false;

    TransportMessage message;
    message.source = source;
    message.payload.assign(payload.begin(), payload.end());
    queue.bytes += message.payload.size();
    queue.messages.push_back(std::move(message));
    return true;
}

std::vector<TransportMessage> InMemoryTransportNetwork::drain(
    PeerId destination, std::size_t maximum_messages) {
    std::vector<TransportMessage> result;
    if (maximum_messages == 0) return result;
    std::scoped_lock lock(mutex_);
    const auto target = queues_.find(destination);
    if (target == queues_.end()) return result;
    auto& queue = target->second;
    const std::size_t count = std::min(maximum_messages, queue.messages.size());
    result.reserve(count);
    for (std::size_t index = 0; index < count; ++index) {
        queue.bytes -= queue.messages.front().payload.size();
        result.push_back(std::move(queue.messages.front()));
        queue.messages.pop_front();
    }
    return result;
}

} // namespace mystic::bridge
