/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "ice_transport.hpp"

namespace mystic::bridge {

void IceMessageTransport::attach(PeerId peer, std::shared_ptr<IceLink> link) {
    if (peer == 0 || !link) return;
    links_[peer] = std::move(link);
}

void IceMessageTransport::detach(PeerId peer) {
    links_.erase(peer);
    // Datagrams from a detached peer must not reach the game after it left.
    for (auto it = inbox_.begin(); it != inbox_.end();) {
        if (it->source == peer) {
            inbox_bytes_ -= it->payload.size();
            it = inbox_.erase(it);
        } else {
            ++it;
        }
    }
}

void IceMessageTransport::deliver(PeerId source, std::vector<std::uint8_t> payload) {
    if (!links_.contains(source) || payload.empty()) {
        ++dropped_;
        return;
    }
    const std::size_t maximum_messages = limits_.maximum_messages_per_peer * (links_.size() + 1);
    const std::size_t maximum_bytes = limits_.maximum_bytes_per_peer * (links_.size() + 1);
    if (inbox_.size() >= maximum_messages || inbox_bytes_ + payload.size() > maximum_bytes) {
        ++dropped_;
        return;
    }
    inbox_bytes_ += payload.size();
    inbox_.push_back(TransportMessage{ source, std::move(payload) });
}

bool IceMessageTransport::send_unreliable(PeerId destination, std::span<const std::uint8_t> payload) {
    const auto found = links_.find(destination);
    if (found == links_.end() || payload.empty()) return false;
    return found->second->send(FrameType::Gameplay, payload);
}

std::vector<TransportMessage> IceMessageTransport::receive(std::size_t maximum_messages) {
    std::vector<TransportMessage> result;
    while (!inbox_.empty() && result.size() < maximum_messages) {
        inbox_bytes_ -= inbox_.front().payload.size();
        result.push_back(std::move(inbox_.front()));
        inbox_.pop_front();
    }
    return result;
}

} // namespace mystic::bridge
