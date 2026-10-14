/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include "ice_link.hpp"
#include "ice_session.hpp"
#include "session_types.hpp"

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace mystic::bridge {

struct InboundSignal {
    std::string from_account_id;
    std::string kind;
    std::string data;
};

// A roster change for a running host session (ABI 3 AddPeerH / RemovePeerH). It is queued by the API thread and
// executed on the session thread, which owns every libjuice call.
struct PeerCommand {
    enum class Kind { Add, Remove };
    Kind kind = Kind::Add;
    IcePeerConfig peer;   // Add: account, peer id and pair key. Remove: the account only.
    std::string reason;   // Remove: a bounded token for the PEER_* events
};

// What a running session reports and receives. Every callback is invoked on the session thread.
struct TransportObserver {
    std::function<void(std::string_view)> ready;       // the HOST_READY / ROUTE_READY line
    std::function<void(std::string_view)> failure;     // a bounded reason code
    SessionDiagnosticSink diagnostic;
    SignalSink signal;
    PeerEventSink peer_event;
    std::function<std::vector<InboundSignal>()> take_inbound_signals;
    std::function<bool()> stop_requested;
    // Host sessions only (all optional). The roster the session starts with (the secrets file's peer= lines) and its
    // limit, reported once after the configuration was accepted; queued roster changes; and an add the session
    // refused (full, duplicate, invalid), so the API layer can drop its view of that account.
    std::function<void(std::size_t maximum_peers, const std::vector<IcePeerConfig>& peers)> peers_configured;
    std::function<std::vector<PeerCommand>()> take_peer_commands;
    std::function<void(std::string_view account_id, std::string_view reason)> peer_add_rejected;
};

// Test hook: when given, a host session talks to this client instead of connecting to backend_url over HTTPS. It is
// created after the capability file was read and receives the capability text.
using AdmissionClientFactory = std::function<std::unique_ptr<IAdmissionClient>(
    std::string_view backend_url, std::string capability, std::string& error)>;

// The ICE material of a session: STUN/TURN servers (non-secret config plus the secret TURN credential) and the
// pairs this side belongs to (the secret file).
struct IceSessionMaterial {
    IceServerConfig servers;
    std::vector<IcePeerConfig> peers;
};

// Reads ice_stun_urls / ice_turn_urls from the config text and turn_username / turn_credential / peer= lines from the
// secrets text. Exposed for the self-test.
bool ParseIceMaterial(std::string_view config_text, std::string_view secrets_text, IceSessionMaterial& material,
    std::string& error);

// Host and join runs. Return 0 after a clean stop, 2 for bad input, 3 for a setup failure, 4 for a refused
// admission and 5 when the central lease failed.
// session_role=HUB (config) lets maximum_peers go up to 64 and the roster change while the session runs;
// host_local_client=0 needs no host ticket (host_ticket_path may be empty) and starts no local bridge, so the
// HOST_READY line reports localPort=0.
int RunIceHost(const std::filesystem::path& public_key_path, const std::filesystem::path& config_path,
    const std::filesystem::path& capability_path, const std::filesystem::path& host_ticket_path,
    const std::filesystem::path& secrets_path, const TransportObserver& observer,
    const AdmissionClientFactory& admission_factory = {});
int RunIceJoin(const std::filesystem::path& public_key_path, const std::filesystem::path& config_path,
    const std::filesystem::path& ticket_path, const std::filesystem::path& secrets_path,
    const TransportObserver& observer);

} // namespace mystic::bridge
