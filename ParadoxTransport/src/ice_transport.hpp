/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include "ice_link.hpp"
#include "message_transport.hpp"

#include <deque>
#include <memory>
#include <unordered_map>

namespace mystic::bridge {

// The UDP bridges' view of the ICE links: one link per admitted peer. Gameplay frames from a link reach the bridges
// only after the session has attached that peer (admission), exactly like the Steam adapter registers only admitted
// connections. Used from the session thread only.
class IceMessageTransport final : public IMessageTransport {
public:
    explicit IceMessageTransport(InMemoryTransportLimits limits = {}) : limits_(limits) {}

    void attach(PeerId peer, std::shared_ptr<IceLink> link);
    void detach(PeerId peer);
    [[nodiscard]] bool attached(PeerId peer) const { return links_.contains(peer); }
    // One gameplay datagram from an attached peer, queued for the UDP bridge.
    void deliver(PeerId source, std::vector<std::uint8_t> payload);

    bool send_unreliable(PeerId destination, std::span<const std::uint8_t> payload) override;
    std::vector<TransportMessage> receive(std::size_t maximum_messages) override;

    [[nodiscard]] std::uint64_t dropped() const { return dropped_; }

private:
    InMemoryTransportLimits limits_;
    std::unordered_map<PeerId, std::shared_ptr<IceLink>> links_;
    std::deque<TransportMessage> inbox_;
    std::size_t inbox_bytes_ = 0;
    std::uint64_t dropped_ = 0;
};

} // namespace mystic::bridge
