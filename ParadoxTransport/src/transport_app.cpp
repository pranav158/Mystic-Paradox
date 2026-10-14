/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "transport_app.hpp"

#include "admission_client.hpp"
#include "admission_ticket.hpp"
#include "guard_event_pipe.hpp"
#include "ice_transport.hpp"
#include "pair_crypto.hpp"
#include "udp_bridge.hpp"

#include <Windows.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <fstream>
#include <optional>
#include <sstream>
#include <thread>
#include <unordered_map>

namespace mystic::bridge {

namespace {

constexpr auto kTelemetryInterval = std::chrono::seconds(2);
constexpr auto kHeartbeatInterval = std::chrono::seconds(2);
constexpr auto kAdmissionDeadline = std::chrono::seconds(60);

void Notify(const std::function<void(std::string_view)>& sink, std::string_view line) {
    if (sink && !line.empty()) sink(line.substr(0, 1023));
}

bool SafeValue(std::string_view value, std::size_t maximum, std::string_view extra) {
    return !value.empty() && value.size() <= maximum &&
        std::all_of(value.begin(), value.end(), [extra](unsigned char character) {
            return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') || extra.find(static_cast<char>(character)) != std::string_view::npos;
        });
}

// Printable ASCII without spaces: TURN user names and credentials.
bool SafeCredential(std::string_view value) {
    return !value.empty() && value.size() <= 512 &&
        std::all_of(value.begin(), value.end(), [](unsigned char character) { return character > 0x20 && character < 0x7f; });
}

std::optional<std::string> ReadBoundedFile(const std::filesystem::path& path, std::uintmax_t maximum, std::string& error,
    bool allow_empty = false) {
    std::error_code code;
    const auto status = std::filesystem::symlink_status(path, code);
    if (code || !std::filesystem::is_regular_file(status) || std::filesystem::is_symlink(status)) {
        error = "input must be a regular non-symlink file";
        return std::nullopt;
    }
    const auto size = std::filesystem::file_size(path, code);
    if (code || (size == 0 && !allow_empty) || size > maximum) {
        error = "input file is empty or exceeds its size limit";
        return std::nullopt;
    }
    if (size == 0) return std::string{};
    std::ifstream stream(path, std::ios::binary);
    std::string result(static_cast<std::size_t>(size), '\0');
    stream.read(result.data(), static_cast<std::streamsize>(result.size()));
    if (!stream || stream.gcount() != static_cast<std::streamsize>(result.size())) {
        error = "input file could not be read completely";
        return std::nullopt;
    }
    while (!result.empty() && (result.back() == '\r' || result.back() == '\n')) result.pop_back();
    return result;
}

std::vector<std::string_view> SplitList(std::string_view value) {
    std::vector<std::string_view> result;
    std::size_t start = 0;
    while (start <= value.size()) {
        const auto end = value.find(',', start);
        auto item = value.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
        while (!item.empty() && item.front() == ' ') item.remove_prefix(1);
        while (!item.empty() && item.back() == ' ') item.remove_suffix(1);
        if (!item.empty()) result.push_back(item);
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return result;
}

// key=value lines; '#' starts a comment. Only `peer` may repeat (secrets file).
class KeyValues final {
public:
    bool parse(std::string_view text, std::string& error) {
        std::size_t start = 0;
        while (start <= text.size()) {
            const std::size_t end = text.find('\n', start);
            std::string_view line = text.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
            if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
            if (!line.empty() && line.front() != '#') {
                const std::size_t separator = line.find('=');
                if (separator == std::string_view::npos || separator == 0 || separator + 1 >= line.size()) {
                    error = "configuration contains a malformed line";
                    return false;
                }
                const std::string key(line.substr(0, separator));
                const std::string value(line.substr(separator + 1));
                if (!SafeValue(key, 48, "_-") || value.size() > 1024 || value.find('\0') != std::string::npos ||
                    (key != "peer" && values_.contains(key))) {
                    error = "configuration contains an unsafe or duplicate field";
                    return false;
                }
                values_[key].push_back(value);
            }
            if (end == std::string_view::npos) break;
            start = end + 1;
        }
        return true;
    }

    [[nodiscard]] std::optional<std::string> required(std::string_view key, std::size_t maximum,
        std::string_view extra, std::string& error) const {
        const auto found = values_.find(std::string(key));
        if (found == values_.end() || !SafeValue(found->second.front(), maximum, extra)) {
            error = "missing or invalid configuration field: " + std::string(key);
            return std::nullopt;
        }
        return found->second.front();
    }

    [[nodiscard]] std::optional<std::string> optional(std::string_view key) const {
        const auto found = values_.find(std::string(key));
        if (found == values_.end()) return std::nullopt;
        return found->second.front();
    }

    [[nodiscard]] std::vector<std::string> all(std::string_view key) const {
        const auto found = values_.find(std::string(key));
        return found == values_.end() ? std::vector<std::string>{} : found->second;
    }

    template <typename T>
    [[nodiscard]] std::optional<T> number(std::string_view key, T minimum, T maximum, std::string& error) const {
        const auto found = values_.find(std::string(key));
        if (found == values_.end()) {
            error = "missing numeric configuration field: " + std::string(key);
            return std::nullopt;
        }
        return ParseNumber<T>(found->second.front(), minimum, maximum, key, error);
    }

    template <typename T>
    static std::optional<T> ParseNumber(std::string_view text, T minimum, T maximum, std::string_view key,
        std::string& error) {
        T value{};
        const auto [end, code] = std::from_chars(text.data(), text.data() + text.size(), value);
        if (code != std::errc{} || end != text.data() + text.size() || value < minimum || value > maximum) {
            error = "invalid numeric configuration field: " + std::string(key);
            return std::nullopt;
        }
        return value;
    }

    [[nodiscard]] bool contains(std::string_view key) const { return values_.contains(std::string(key)); }

    [[nodiscard]] bool boolean(std::string_view key) const {
        const auto found = values_.find(std::string(key));
        return found != values_.end() && found->second.front() == "true";
    }

private:
    std::unordered_map<std::string, std::vector<std::string>> values_;
};

std::optional<SessionBindings> ReadBindings(const KeyValues& config, std::string& error) {
    auto key = config.required("key_id", 32, "._-", error);
    auto session = config.required("session_id", 36, "-", error);
    auto party = config.required("party_id", 192, "._:+/=-", error);
    auto hunt = config.required("hunt_definition_id", 128, "._:/-", error);
    auto instance = config.required("bridge_instance_id", 96, "._:-", error);
    auto party_revision = config.number<std::uint64_t>("party_revision", 1, UINT64_MAX, error);
    auto host = config.number<std::uint64_t>("host_peer_id", 1, UINT64_MAX, error);
    auto generation = config.number<std::uint32_t>("generation", 1, UINT32_MAX, error);
    auto build = config.number<std::uint32_t>("build", 1, UINT32_MAX, error);
    auto protocol = config.number<std::uint16_t>("bridge_protocol", 1, UINT16_MAX, error);
    auto port = config.number<std::uint16_t>("virtual_port", 1, 999, error);
    if (!key || !session || !party || !hunt || !instance || !party_revision || !host || !generation || !build ||
        !protocol || !port) return std::nullopt;
    return SessionBindings{ *key, *session, *party, *hunt, *instance, *party_revision, *host, *generation, *build,
        *protocol, *port };
}

std::string UdpStatsLine(std::string_view role, std::string_view path, const BridgeStats& stats,
    const SessionStats& session) {
    std::ostringstream output;
    output << "UDP_STATS role=" << role << " path=" << path
        << " localRx=" << stats.local_datagrams_received << " localTx=" << stats.local_datagrams_sent
        << " transportRx=" << stats.transport_messages_received << " transportTx=" << stats.transport_messages_sent
        << " oversized=" << stats.oversized_datagrams_dropped << " foreign=" << stats.unexpected_local_sources_dropped
        << " unknownPeers=" << stats.unknown_peers_dropped << " backpressure=" << stats.transport_backpressure_drops
        << " socketErrors=" << stats.socket_errors << " admitted=" << session.admitted
        << " rejected=" << session.admission_rejected << " disconnected=" << session.disconnected
        << " signalsRejected=" << session.signals_rejected
        << " guardPublishFailures=" << session.guard_publish_failures
        << " guardEvidenceLoss=" << session.guard_evidence_loss;
    return output.str();
}

std::string ServersLine(std::string_view role, const IceSessionMaterial& material, bool force_relay) {
    return "ICE_READY role=" + std::string(role) + " stun=" + (material.servers.stun_host.empty() ? "0" : "1") +
        " turn=" + std::to_string(material.servers.turn_servers.size()) + " relayOnly=" + (force_relay ? "1" : "0") +
        " peers=" + std::to_string(material.peers.size());
}

bool StopRequested(const TransportObserver& observer) {
    return observer.stop_requested && observer.stop_requested();
}

template <typename Session>
void ApplyInbound(const TransportObserver& observer, Session& session) {
    if (!observer.take_inbound_signals) return;
    for (const auto& signal : observer.take_inbound_signals()) {
        session.apply_signal(signal.from_account_id, signal.kind, signal.data);
    }
}

// Queued AddPeerH / RemovePeerH calls, in order, before the signals of the same iteration (so a DESCRIPTION that
// arrives together with its AddPeer finds the peer).
void ApplyPeerCommands(const TransportObserver& observer, IceHostSession& session) {
    if (!observer.take_peer_commands) return;
    for (auto& command : observer.take_peer_commands()) {
        if (command.kind == PeerCommand::Kind::Remove) {
            if (!session.remove_peer(command.peer.account_id, command.reason)) {
                Notify(observer.diagnostic, "ROSTER_REMOVE_IGNORED reason=unknown_account");
            }
            continue;
        }
        const std::string account = command.peer.account_id;
        std::string error;
        const bool added = session.add_peer(std::move(command.peer), error);
        SecureZeroMemory(command.peer.key.data(), command.peer.key.size());
        if (!added) {
            Notify(observer.diagnostic, "ROSTER_ADD_REJECTED reason=" + error);
            Notify(observer.peer_event, "PEER_ADD_REJECTED account=" + account + " reason=" + error);
            if (observer.peer_add_rejected) observer.peer_add_rejected(account, error);
        }
    }
}

} // namespace

bool ParseIceMaterial(std::string_view config_text, std::string_view secrets_text, IceSessionMaterial& material,
    std::string& error) {
    material = {};
    KeyValues config;
    KeyValues secrets;
    if (!config.parse(config_text, error) || !secrets.parse(secrets_text, error)) return false;

    if (const auto stun = config.optional("ice_stun_urls")) {
        for (const auto url : SplitList(*stun)) {
            if (ParseStunUrl(url, material.servers.stun_host, material.servers.stun_port)) break;
        }
    }
    const auto username = secrets.optional("turn_username");
    const auto credential = secrets.optional("turn_credential");
    const auto turn_urls = config.optional("ice_turn_urls");
    if (turn_urls && username && credential) {
        if (!SafeCredential(*username) || !SafeCredential(*credential)) {
            error = "invalid relay credential";
            return false;
        }
        for (const auto url : SplitList(*turn_urls)) {
            IceServerConfig::Turn turn;
            if (!ParseTurnUdpUrl(url, turn.host, turn.port)) continue;
            turn.username = *username;
            turn.credential = *credential;
            const bool duplicate = std::any_of(material.servers.turn_servers.begin(), material.servers.turn_servers.end(),
                [&turn](const IceServerConfig::Turn& other) { return other.host == turn.host && other.port == turn.port; });
            if (!duplicate && material.servers.turn_servers.size() < 4) material.servers.turn_servers.push_back(std::move(turn));
        }
    }
    for (const auto& line : secrets.all("peer")) {
        const auto parts = SplitList(line);
        IcePeerConfig peer;
        if (parts.size() != 3 || !SafeValue(parts[0], 64, "-") ||
            !KeyValues::ParseNumber<std::uint64_t>(parts[1], 1, UINT64_MAX, "peer", error).has_value() ||
            !PairCipher::DecodeKey(parts[2], peer.key)) {
            error = "invalid peer entry in the transport secrets";
            return false;
        }
        peer.account_id.assign(parts[0]);
        peer.peer_id = *KeyValues::ParseNumber<std::uint64_t>(parts[1], 1, UINT64_MAX, "peer", error);
        if (std::any_of(material.peers.begin(), material.peers.end(),
            [&peer](const IcePeerConfig& other) { return other.account_id == peer.account_id || other.peer_id == peer.peer_id; })) {
            error = "duplicate peer entry in the transport secrets";
            return false;
        }
        material.peers.push_back(std::move(peer));
    }
    return true;
}

int RunIceHost(const std::filesystem::path& public_key_path, const std::filesystem::path& config_path,
    const std::filesystem::path& capability_path, const std::filesystem::path& host_ticket_path,
    const std::filesystem::path& secrets_path, const TransportObserver& observer,
    const AdmissionClientFactory& admission_factory) {
    std::string error;
    auto config_text = ReadBoundedFile(config_path, 16 * 1024, error);
    // A solo host without a relay has an empty secrets file.
    auto secrets_text = config_text ? ReadBoundedFile(secrets_path, 16 * 1024, error, true) : std::nullopt;
    KeyValues config;
    IceSessionMaterial material;
    if (!config_text || !secrets_text || !config.parse(*config_text, error) ||
        !ParseIceMaterial(*config_text, *secrets_text, material, error)) {
        Notify(observer.diagnostic, "HOST CONFIG FAIL: " + error);
        return 2;
    }
    std::fill(secrets_text->begin(), secrets_text->end(), '\0');
    // session_role: a hunt host (default) holds up to 4 peers for one hunt; a hub host holds up to 64 and its roster
    // changes while it runs (AddPeerH / RemovePeerH work for both). host_local_client=0: the host PC's own client does
    // not play this session (a non-participating realm host), so there is no host ticket and no local bridge.
    const std::string role = config.optional("session_role").value_or("HUNT");
    if (role != "HUNT" && role != "HUB") {
        Notify(observer.diagnostic, "HOST CONFIG FAIL: invalid session_role");
        return 2;
    }
    const bool hub = role == "HUB";
    const std::string local_client_text = config.optional("host_local_client").value_or("1");
    if (local_client_text != "0" && local_client_text != "1") {
        Notify(observer.diagnostic, "HOST CONFIG FAIL: invalid host_local_client");
        return 2;
    }
    const bool host_local_client = local_client_text == "1";
    auto bindings = ReadBindings(config, error);
    auto backend = config.required("backend_url", 512, ":/._-", error);
    auto server_port = config.number<std::uint16_t>("server_udp_port", 1, UINT16_MAX, error);
    auto maximum_peers = config.number<std::size_t>("maximum_peers", 1, hub ? kMaximumHubPeers : kMaximumHuntPeers, error);
    // The Hunt Guard producer's pipe belongs to hunts; a hub (no hunt evidence) needs one only if it is given.
    const bool use_guard_pipe = !hub || config.contains("guard_pipe_name") || config.contains("expected_server_pid");
    std::optional<std::string> guard_pipe_name = std::string{};
    std::optional<std::uint32_t> expected_server_pid = std::uint32_t{ 0 };
    if (use_guard_pipe) {
        guard_pipe_name = config.required("guard_pipe_name", 96, "._-", error);
        expected_server_pid = config.number<std::uint32_t>("expected_server_pid", 1, UINT32_MAX, error);
    }
    auto capability = ReadBoundedFile(capability_path, 128, error);
    std::optional<std::string> host_ticket = std::string{};
    if (host_local_client) {
        if (host_ticket_path.empty()) {
            host_ticket.reset();
            error = "a host ticket is required unless host_local_client=0";
        } else {
            host_ticket = ReadBoundedFile(host_ticket_path, 4096, error);
        }
    }
    if (!bindings || !backend || !server_port || !maximum_peers || !guard_pipe_name || !expected_server_pid ||
        !capability || !host_ticket) {
        Notify(observer.diagnostic, "HOST CONFIG FAIL: " + error);
        return 2;
    }
    const bool force_relay = config.boolean("force_relay");
    const bool hunt_evidence = hub ? config.boolean("hunt_evidence")
                                   : (!config.contains("hunt_evidence") || config.boolean("hunt_evidence"));
    // A joiner's admission ticket carries the host's peer id; peers cannot exceed the host's announced capacity.
    if (material.peers.size() > *maximum_peers) {
        Notify(observer.diagnostic, "HOST CONFIG FAIL: more transport peers than maximum_peers");
        return 2;
    }
    // A host that starts with no peers (a hub) learns its relay need from the first joiner, so only a host that
    // already has peers can fail here.
    if (force_relay && !material.peers.empty() && material.servers.turn_servers.empty()) {
        Notify(observer.failure, "host:relay_unavailable");
        return 3;
    }

    AdmissionTicketVerifier verifier;
    if (!verifier.load_public_key(public_key_path, error)) {
        Notify(observer.diagnostic, "HOST KEY FAIL: " + error);
        return 3;
    }
    std::unique_ptr<IAdmissionClient> admission_owner;
    if (admission_factory) {
        admission_owner = admission_factory(*backend, std::move(*capability), error);
    } else {
        auto client = std::make_unique<WinHttpAdmissionClient>();
        if (client->initialize(*backend, std::move(*capability), error)) admission_owner = std::move(client);
    }
    if (!admission_owner) {
        Notify(observer.diagnostic, "HOST BACKEND FAIL: " + error);
        return 3;
    }
    IAdmissionClient& admission_client = *admission_owner;
    WinsockRuntime winsock;
    auto transport = std::make_shared<IceMessageTransport>();
    SessionLimits limits{ *maximum_peers, kAdmissionDeadline, force_relay, hunt_evidence };
    limits.hub = hub;
    std::optional<IceHostSession> session;
    try {
        session.emplace(material.servers, material.peers, transport, verifier, admission_client, *bindings, limits,
            observer.signal, observer.peer_event, observer.diagnostic);
    } catch (const std::exception&) {
        Notify(observer.diagnostic, "HOST SESSION FAIL: invalid session configuration");
        return 3;
    }
    GuardEventPipe guard_pipe;
    if (use_guard_pipe && !guard_pipe.initialize(*guard_pipe_name, *expected_server_pid, error)) {
        Notify(observer.diagnostic, "HOST GUARD PIPE FAIL: " + error);
        return 3;
    }
    HostUdpBridge udp(transport, *server_port, BridgeLimits{ 2048, 64, *maximum_peers });
    if (!admission_client.publish_host_ready({ bindings->session_id, bindings->bridge_instance_id,
            "ready-" + std::to_string(bindings->generation), bindings->virtual_port }, error)) {
        Notify(observer.diagnostic, "HOST BACKEND FAIL: " + error);
        return 3;
    }

    // The host's own client: its ticket is checked and consumed like any joiner's, then it uses a loopback bridge.
    // Without a local client there is no host account on this session (guard events then carry no actor).
    std::string host_account_id;
    if (host_local_client) {
        const ExpectedAdmissionTicket host_expected{
            bindings->key_id, bindings->session_id, bindings->party_id, bindings->hunt_definition_id,
            bindings->host_peer_id, bindings->host_peer_id, bindings->party_revision, bindings->generation,
            bindings->build, bindings->bridge_protocol, bindings->virtual_port
        };
        const AdmissionTicketResult host_verified = verifier.verify(*host_ticket, host_expected);
        if (!host_verified.ok) {
            std::fill(host_ticket->begin(), host_ticket->end(), '\0');
            Notify(observer.failure, "host:" + host_verified.code);
            return 4;
        }
        host_account_id = host_verified.claims.account_id;
        const AdmissionConsumeResult host_consumed = admission_client.consume({ bindings->session_id, *host_ticket,
            bindings->bridge_instance_id, "localhost", "host-local-" + std::to_string(bindings->generation),
            bindings->host_peer_id });
        std::fill(host_ticket->begin(), host_ticket->end(), '\0');
        if (!host_consumed.admitted) {
            Notify(observer.failure, "host:" + (host_consumed.code.empty() ? std::string("central_consume_failed") : host_consumed.code));
            return 4;
        }
        Notify(observer.diagnostic, "ADMISSION_ACCEPTED role=host peer=" + std::to_string(bindings->host_peer_id) + " source=local");
    }
    std::string guard_error;
    if (session->publish_guard_event("SESSION_STARTED", host_account_id,
            "{\"source\":\"ice_transport\"}", guard_error)) {
        (void)session->publish_guard_event("WORLD_READY", host_account_id,
            "{\"source\":\"launcher_ready_pipe\"}", guard_error);
    }
    if (!guard_error.empty()) Notify(observer.diagnostic, "HUNT GUARD OBSERVE WARN: " + guard_error);

    std::optional<LocalHostUdpBridge> local_host_udp;
    if (host_local_client) {
        local_host_udp.emplace(*server_port, std::uint16_t{ 0 }, BridgeLimits{ 2048, 64, 1 }, observer.diagnostic);
    }
    if (observer.peers_configured) observer.peers_configured(*maximum_peers, material.peers);
    Notify(observer.diagnostic, ServersLine("host", material, force_relay));
    const std::string ready_line = "HOST_READY session=" + bindings->session_id +
        " generation=" + std::to_string(bindings->generation) + " transport=ice" +
        " localHost=127.0.0.1 localPort=" + std::to_string(local_host_udp ? local_host_udp->local_port() : 0) +
        " routePolicy=" + (force_relay ? std::string("RELAY_ONLY") : std::string("AUTOMATIC")) +
        " relayReady=" + (material.servers.turn_servers.empty() ? "0" : "1") +
        " peers=" + std::to_string(material.peers.size());
    Notify(observer.ready, ready_line);

    std::uint64_t lease_sequence = 0;
    unsigned int heartbeat_failures = 0;
    bool heartbeat_failed_closed = false;
    bool guard_completed = false;
    bool guard_completion_pending = false;
    bool guard_publish_failure_reported = false;
    std::optional<LocalGuardEvent> pending_guard_event;
    auto next_guard_publish_attempt = std::chrono::steady_clock::now();
    auto next_heartbeat = std::chrono::steady_clock::now();
    auto next_telemetry = std::chrono::steady_clock::now();
    while (!StopRequested(observer)) {
        ApplyPeerCommands(observer, *session);
        ApplyInbound(observer, *session);
        session->pump_once();
        guard_pipe.pump_once();
        while (std::chrono::steady_clock::now() >= next_guard_publish_attempt) {
            if (!pending_guard_event.has_value()) {
                const std::uint64_t dropped = guard_pipe.take_dropped_count();
                if (dropped > 0) {
                    pending_guard_event = LocalGuardEvent{ "EVIDENCE_LOSS", "",
                        "{\"droppedEvents\":" + std::to_string(dropped) + ",\"reason\":\"bridge_queue_overflow\"}" };
                } else {
                    LocalGuardEvent next;
                    if (!guard_pipe.pop(next)) break;
                    pending_guard_event = std::move(next);
                }
            }
            std::string publish_error;
            if (!session->publish_guard_event(pending_guard_event->type, pending_guard_event->actor_account_id,
                    pending_guard_event->payload_json, publish_error)) {
                if (!guard_publish_failure_reported) {
                    Notify(observer.diagnostic, "HUNT GUARD OBSERVE WARN: " + publish_error +
                        " (completion fenced until this hunt ends)");
                    guard_publish_failure_reported = true;
                }
                // The same event is retried at the same chain position; later events stay queued.
                next_guard_publish_attempt = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
                break;
            }
            next_guard_publish_attempt = std::chrono::steady_clock::now();
            if (pending_guard_event->type == "COMPLETION_REQUESTED") guard_completion_pending = true;
            pending_guard_event.reset();
        }
        if (guard_completion_pending && !guard_completed) {
            std::string completion_error;
            if (session->complete_guard(completion_error)) {
                guard_completed = true;
                guard_completion_pending = false;
            } else {
                Notify(observer.diagnostic, "HUNT GUARD COMPLETION WARN: " + completion_error);
            }
        }
        // Completion is an evidence milestone, not a transport stop: result screens and travel still need the
        // connection. The central lifecycle owns the stop.
        // A peer that left or was removed gives its bridge slot back.
        for (const PeerId peer : session->take_disconnected_peers()) udp.remove_peer(peer);
        udp.pump_once();
        if (local_host_udp) local_host_udp->pump_once();
        const auto now = std::chrono::steady_clock::now();
        if (now >= next_telemetry) {
            if (local_host_udp) {
                Notify(observer.diagnostic, UdpStatsLine("host", "local", local_host_udp->stats(), session->stats()));
            }
            Notify(observer.diagnostic, UdpStatsLine("host", "remote", udp.stats(), session->stats()));
            next_telemetry = now + kTelemetryInterval;
        }
        if (now >= next_heartbeat) {
            ++lease_sequence;
            std::string heartbeat_error;
            const bool heartbeat_ok = admission_client.publish_heartbeat({ bindings->session_id,
                "lease-" + std::to_string(bindings->generation) + '-' + std::to_string(lease_sequence), lease_sequence,
                session->admitted_count(), 0, true, true }, heartbeat_error);
            if (heartbeat_ok) {
                heartbeat_failures = 0;
            } else if (++heartbeat_failures >= 3) {
                Notify(observer.diagnostic, "HOST LEASE FAIL: central authority unavailable or generation fenced");
                Notify(observer.failure, "host:lease_failed");
                heartbeat_failed_closed = true;
                break;
            } else {
                Notify(observer.diagnostic, "HOST LEASE WARN: " + heartbeat_error);
            }
            next_heartbeat = now + kHeartbeatInterval;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    guard_error.clear();
    if (!guard_completed && !session->publish_guard_event("HUNT_ABORTED", host_account_id,
            heartbeat_failed_closed ? "{\"reason\":\"LEASE_FAILED\"}" : "{\"reason\":\"HOST_STOPPED\"}", guard_error)) {
        Notify(observer.diagnostic, "HUNT GUARD OBSERVE WARN: " + guard_error);
    }
    session->stop();
    return heartbeat_failed_closed ? 5 : 0;
}

int RunIceJoin(const std::filesystem::path& public_key_path, const std::filesystem::path& config_path,
    const std::filesystem::path& ticket_path, const std::filesystem::path& secrets_path,
    const TransportObserver& observer) {
    std::string error;
    auto config_text = ReadBoundedFile(config_path, 16 * 1024, error);
    auto secrets_text = config_text ? ReadBoundedFile(secrets_path, 16 * 1024, error) : std::nullopt;
    KeyValues config;
    IceSessionMaterial material;
    if (!config_text || !secrets_text || !config.parse(*config_text, error) ||
        !ParseIceMaterial(*config_text, *secrets_text, material, error)) {
        Notify(observer.diagnostic, "JOIN CONFIG FAIL: " + error);
        return 2;
    }
    std::fill(secrets_text->begin(), secrets_text->end(), '\0');
    auto bindings = ReadBindings(config, error);
    auto local_port = config.number<std::uint16_t>("local_udp_port", 0, UINT16_MAX, error);
    auto local_peer_id = config.number<std::uint64_t>("local_peer_id", 1, UINT64_MAX, error);
    auto local_account = config.required("local_account_id", 64, "-", error);
    auto host_account = config.required("host_account_id", 64, "-", error);
    auto ticket = ReadBoundedFile(ticket_path, 4096, error);
    if (!bindings || !local_port || !local_peer_id || !local_account || !host_account || !ticket) {
        Notify(observer.diagnostic, "JOIN CONFIG FAIL: " + error);
        return 2;
    }
    const auto host = std::find_if(material.peers.begin(), material.peers.end(), [&](const IcePeerConfig& peer) {
        return peer.account_id == *host_account && peer.peer_id == bindings->host_peer_id;
    });
    if (material.peers.size() != 1 || host == material.peers.end()) {
        Notify(observer.diagnostic, "JOIN CONFIG FAIL: the transport secrets must name exactly the host");
        return 2;
    }
    const bool force_relay = config.boolean("force_relay");
    if (force_relay && material.servers.turn_servers.empty()) {
        Notify(observer.failure, "join:relay_unavailable");
        return 3;
    }
    AdmissionTicketVerifier verifier;
    if (!verifier.load_public_key(public_key_path, error)) {
        Notify(observer.diagnostic, "JOIN KEY FAIL: " + error);
        return 3;
    }
    WinsockRuntime winsock;
    auto transport = std::make_shared<IceMessageTransport>();
    const SessionLimits limits{ 1, kAdmissionDeadline, force_relay, false };
    std::optional<IceJoinSession> session;
    try {
        session.emplace(material.servers, *host, transport, verifier, *bindings, *local_peer_id, *local_account,
            std::move(*ticket), limits, observer.signal, observer.peer_event, observer.diagnostic);
    } catch (const std::exception&) {
        Notify(observer.diagnostic, "JOIN SESSION FAIL: invalid session configuration");
        return 3;
    }
    if (!session->start(error)) {
        Notify(observer.diagnostic, "JOIN SESSION FAIL: " + error);
        Notify(observer.failure, "join:transport_start_failed");
        return 3;
    }
    Notify(observer.diagnostic, ServersLine("join", material, force_relay));
    JoinerUdpBridge udp(transport, bindings->host_peer_id, *local_port, BridgeLimits{ 2048, 64, 1 });
    while (!StopRequested(observer) && !session->admitted() && !session->failed()) {
        ApplyInbound(observer, *session);
        session->pump_once();
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    if (!session->admitted()) {
        if (session->failed()) {
            Notify(observer.failure, "join:" + std::string(session->failure_code()));
            return 4;
        }
        return 0;
    }
    const std::string ready_line = "ROUTE_READY localHost=127.0.0.1 localPort=" + std::to_string(udp.local_port()) +
        " session=" + bindings->session_id + " generation=" + std::to_string(bindings->generation) +
        " transport=ice routePolicy=" + (force_relay ? std::string("RELAY_ONLY") : std::string("AUTOMATIC")) +
        " route=" + (session->relayed() ? std::string("relay") : std::string("direct"));
    Notify(observer.ready, ready_line);
    auto next_telemetry = std::chrono::steady_clock::now();
    while (!StopRequested(observer) && !session->failed()) {
        ApplyInbound(observer, *session);
        session->pump_once();
        udp.pump_once();
        const auto now = std::chrono::steady_clock::now();
        if (now >= next_telemetry) {
            Notify(observer.diagnostic, UdpStatsLine("join", "remote", udp.stats(), session->stats()));
            next_telemetry = now + kTelemetryInterval;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (session->failed()) Notify(observer.failure, "join:" + std::string(session->failure_code()));
    return session->failed() ? 5 : 0;
}

} // namespace mystic::bridge
