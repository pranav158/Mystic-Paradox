/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "ice_session.hpp"

#include "control_codec.hpp"

#include <Windows.h>

#include <algorithm>
#include <stdexcept>

namespace mystic::bridge {

namespace {

constexpr std::size_t kFramesPerPump = 64;
constexpr auto kRequestInterval = std::chrono::milliseconds(750);
constexpr auto kRejectLinger = std::chrono::seconds(1);
// Signals waiting for add_peer: per account and in total (a signal is at most 4096 bytes).
constexpr std::size_t kHeldSignalsPerAccount = 16;
constexpr std::size_t kHeldAccounts = 64;

std::string Route(const IceLink& link) {
    return link.relayed() ? "relay" : "direct";
}

} // namespace

// ---- host -------------------------------------------------------------------------------------------------------

IceHostSession::IceHostSession(IceServerConfig servers, std::vector<IcePeerConfig> peers,
    std::shared_ptr<IceMessageTransport> transport, AdmissionTicketVerifier& verifier,
    IAdmissionClient& admission_client, SessionBindings bindings, SessionLimits limits,
    SignalSink signals, PeerEventSink events, SessionDiagnosticSink diagnostic)
    : servers_(std::move(servers)), transport_(std::move(transport)), verifier_(verifier),
      admission_client_(admission_client), bindings_(std::move(bindings)), limits_(limits),
      signals_(std::move(signals)), events_(std::move(events)), diagnostic_(std::move(diagnostic)) {
    if (!transport_ || bindings_.host_peer_id == 0 || bindings_.virtual_port == 0 || peers.size() > limits_.maximum_peers ||
        limits_.maximum_peers == 0 || limits_.maximum_peers > (limits_.hub ? kMaximumHubPeers : kMaximumHuntPeers)) {
        throw std::invalid_argument("invalid ICE host session configuration");
    }
    for (auto& config : peers) {
        std::string error;
        if (!validate_peer(config, error)) throw std::invalid_argument("invalid ICE host peer");
        Peer peer;
        peer.config = std::move(config);
        peers_.push_back(std::move(peer));
    }
}

IceHostSession::~IceHostSession() {
    stop();
}

void IceHostSession::diagnostic(std::string_view line) const {
    if (diagnostic_ && !line.empty()) diagnostic_(line);
}

void IceHostSession::event(std::string_view line) const {
    if (events_ && !line.empty()) events_(line);
}

IceHostSession::PeerList::iterator IceHostSession::find_peer(std::string_view account_id) {
    return std::find_if(peers_.begin(), peers_.end(),
        [account_id](const Peer& peer) { return peer.config.account_id == account_id; });
}

IceHostSession::Peer* IceHostSession::find(std::string_view account_id) {
    const auto found = find_peer(account_id);
    return found == peers_.end() ? nullptr : &*found;
}

bool IceHostSession::validate_peer(const IcePeerConfig& peer, std::string& error) const {
    error.clear();
    if (peer.account_id.empty() || peer.account_id.size() > 64 || peer.peer_id == 0 ||
        peer.peer_id == bindings_.host_peer_id) {
        error = "invalid_peer";
        return false;
    }
    for (const Peer& other : peers_) {
        if (other.config.account_id == peer.account_id) {
            error = "duplicate_account";
            return false;
        }
        if (other.config.peer_id == peer.peer_id) {
            error = "duplicate_peer";
            return false;
        }
    }
    return true;
}

std::uint32_t IceHostSession::admitted_count() const {
    return static_cast<std::uint32_t>(std::count_if(peers_.begin(), peers_.end(),
        [](const Peer& peer) { return peer.admitted; }));
}

bool IceHostSession::add_peer(IcePeerConfig peer, std::string& error) {
    if (!validate_peer(peer, error)) return false;
    if (peers_.size() >= limits_.maximum_peers) {
        error = "full";
        return false;
    }
    const std::string account = peer.account_id;
    const PeerId peer_id = peer.peer_id;
    Peer entry;
    entry.config = std::move(peer);
    peers_.push_back(std::move(entry));
    diagnostic("ROSTER_ADD peer=" + std::to_string(peer_id) + " roster=" + std::to_string(peers_.size()));
    replay_held_signals(account);
    return true;
}

bool IceHostSession::remove_peer(std::string_view account_id, std::string_view reason) {
    held_.erase(std::string(account_id));
    const auto found = find_peer(account_id);
    if (found == peers_.end()) return false;
    std::string token;
    for (const char character : reason.substr(0, 48)) {
        const auto value = static_cast<unsigned char>(character);
        const bool plain = (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
            (value >= '0' && value <= '9') || value == '_' || value == '-' || value == '.';
        token.push_back(plain ? character : '_');
    }
    if (token.empty()) token = "removed";
    const bool was_admitted = found->admitted;
    const PeerId peer_id = found->config.peer_id;
    // close_link tells the backend about an admitted peer (on the next pump) and queues its bridge slot for release.
    close_link(*found, true, token);
    event("PEER_REMOVED account=" + std::string(account_id) + " reason=" + token + " admitted=" + (was_admitted ? "1" : "0"));
    SecureZeroMemory(found->config.key.data(), found->config.key.size());
    peers_.erase(found);
    diagnostic("ROSTER_REMOVE peer=" + std::to_string(peer_id) + " roster=" + std::to_string(peers_.size()));
    return true;
}

void IceHostSession::hold_signal(std::string_view from_account_id, std::string_view kind, std::string_view data) {
    auto found = held_.find(std::string(from_account_id));
    if (found == held_.end()) {
        if (held_.size() >= kHeldAccounts) {
            ++stats_.signals_rejected;
            diagnostic("ICE_SIGNAL_REJECTED role=host reason=unknown_peer");
            return;
        }
        found = held_.emplace(std::string(from_account_id), HeldSignals{}).first;
    }
    HeldSignals& held = found->second;
    if (held.signals.size() >= kHeldSignalsPerAccount) {
        ++stats_.signals_rejected;
        if (!held.overflow_reported) {
            held.overflow_reported = true;
            diagnostic("ICE_SIGNAL_REJECTED role=host reason=held_signals_full");
        }
        return;
    }
    if (held.signals.empty()) diagnostic("ICE_SIGNAL_HELD role=host reason=unknown_peer");
    held.signals.push_back(HeldSignal{ std::string(kind), std::string(data), std::chrono::steady_clock::now() });
}

void IceHostSession::replay_held_signals(std::string_view account_id) {
    const auto found = held_.find(std::string(account_id));
    if (found == held_.end()) return;
    auto signals = std::move(found->second.signals);
    held_.erase(found);
    const auto now = std::chrono::steady_clock::now();
    std::size_t replayed = 0;
    for (const HeldSignal& signal : signals) {
        // Expired between two sweeps: treat it as the sweep would have.
        if (now - signal.at >= limits_.held_signal_ttl) {
            ++stats_.signals_rejected;
            continue;
        }
        ++replayed;
        apply_signal(account_id, signal.kind, signal.data);
    }
    if (replayed > 0) {
        const Peer* peer = find(account_id);
        diagnostic("ICE_SIGNAL_REPLAYED role=host peer=" + std::to_string(peer ? peer->config.peer_id : 0) +
            " count=" + std::to_string(replayed));
    }
}

void IceHostSession::expire_held_signals(std::chrono::steady_clock::time_point now) {
    for (auto it = held_.begin(); it != held_.end();) {
        auto& signals = it->second.signals;
        std::size_t expired = 0;
        while (!signals.empty() && now - signals.front().at >= limits_.held_signal_ttl) {
            signals.pop_front();
            ++expired;
        }
        if (expired > 0) {
            stats_.signals_rejected += expired;
            diagnostic("ICE_SIGNAL_EXPIRED role=host reason=unknown_peer count=" + std::to_string(expired));
        }
        it = signals.empty() ? held_.erase(it) : std::next(it);
    }
}

void IceHostSession::flush_backend_disconnects() {
    while (!backend_disconnects_.empty()) {
        BackendDisconnect& item = backend_disconnects_.front();
        // The link index keeps the request id unique when the same peer id leaves and rejoins.
        std::string request_id = !item.request_id.empty() ? item.request_id :
            "disc-" + std::to_string(bindings_.generation) + '-' + std::to_string(item.peer_id) + '-' +
            std::to_string(item.index);
        if (lane_ != nullptr) {
            // [2026-10-17] Through the lane: the notice is a round trip to the backend, and this thread relays packets.
            // A full lane keeps the notice for the next pump.
            if (!lane_->post([session_id = bindings_.session_id, admission_id = item.admission_id,
                    request_id = std::move(request_id)](IAdmissionClient& client) {
                    client.notify_disconnected(session_id, admission_id, request_id);
                })) {
                return;
            }
        } else {
            admission_client_.notify_disconnected(bindings_.session_id, item.admission_id, request_id);
        }
        backend_disconnects_.pop_front();
    }
}

bool IceHostSession::open_link(Peer& peer, std::string_view remote_description) {
    auto link = std::make_shared<IceLink>(servers_, limits_.force_relay, true);
    std::string error;
    ++stats_.connection_attempts;
    if (!link->start(peer.config.key, error, remote_description)) {
        diagnostic("ICE_LINK_FAILED role=host peer=" + std::to_string(peer.config.peer_id) + " reason=" + error);
        return false;
    }
    peer.link = std::move(link);
    peer.index = ++last_link_index_;
    peer.was_connected = false;
    peer.admitted = false;
    peer.closing = false;
    peer.admission_token = 0;
    peer.admission_id.clear();
    peer.admission_result.clear();
    return true;
}

void IceHostSession::close_link(Peer& peer, bool notify_backend, std::string_view reason) {
    if (peer.admitted) {
        transport_->detach(peer.config.peer_id);
        disconnected_peers_.push_back(peer.config.peer_id);
        if (notify_backend && !peer.admission_id.empty()) {
            backend_disconnects_.push_back(BackendDisconnect{ peer.config.peer_id, peer.admission_id, peer.index });
        }
        ++stats_.disconnected;
        std::string ignored;
        (void)publish_guard_event("PLAYER_LOST", peer.config.account_id, "{\"transport\":\"ice\"}", ignored);
        event("PEER_LOST account=" + peer.config.account_id + " reason=" + std::string(reason.substr(0, 48)));
    }
    if (peer.link) peer.link->stop();
    peer.link.reset();
    peer.was_connected = false;
    peer.admitted = false;
    peer.closing = false;
    // A consume still with the backend is settled when it comes back (finish_admissions): this link is gone.
    peer.admission_token = 0;
    peer.admission_id.clear();
    peer.admission_result.clear();
}

void IceHostSession::apply_signal(std::string_view from_account_id, std::string_view kind, std::string_view data) {
    Peer* peer = find(from_account_id);
    if (!peer) {
        // Not on the roster (yet): the joiner may have started before the host's launcher added it.
        hold_signal(from_account_id, kind, data);
        return;
    }
    if (kind == "DESCRIPTION") {
        // A second description means the joiner started over (relaunch, rejoin): replace the link. The new link
        // takes the joiner's description before producing its own (controlled side).
        if (peer->link) close_link(*peer, true, "restarted");
        if (!open_link(*peer, data)) ++stats_.signals_rejected;
        return;
    }
    if (!peer->link) {
        ++stats_.signals_rejected;
        return;
    }
    std::string error;
    if (!peer->link->apply_remote_signal(kind, data, error)) {
        ++stats_.signals_rejected;
        diagnostic("ICE_SIGNAL_REJECTED role=host peer=" + std::to_string(peer->config.peer_id) + " reason=" + error);
    }
}

void IceHostSession::reject(Peer& peer, std::string_view code) {
    const auto response = EncodeAdmissionResult(false, code, "");
    if (!response.empty() && peer.link) (void)peer.link->send(FrameType::Control, response);
    ++stats_.admission_rejected;
    diagnostic("ADMISSION_REJECTED role=host peer=" + std::to_string(peer.config.peer_id) +
        " code=" + std::string(code.substr(0, 64)));
    // Give the rejection a moment to leave before the link closes.
    peer.closing = true;
    peer.close_at = std::chrono::steady_clock::now() + kRejectLinger;
}

void IceHostSession::admit(Peer& peer, std::string ticket) {
    if (limits_.force_relay && !peer.link->relayed()) {
        diagnostic("ICE_ROUTE_REFUSED role=host peer=" + std::to_string(peer.config.peer_id) + " " +
            peer.link->selected_types());
        reject(peer, "transport_not_relayed");
        return;
    }
    const ExpectedAdmissionTicket expected{
        bindings_.key_id, bindings_.session_id, bindings_.party_id, bindings_.hunt_definition_id,
        peer.config.peer_id, bindings_.host_peer_id, bindings_.party_revision, bindings_.generation,
        bindings_.build, bindings_.bridge_protocol, bindings_.virtual_port
    };
    const AdmissionTicketResult verified = verifier_.verify(ticket, expected);
    if (!verified.ok) {
        std::fill(ticket.begin(), ticket.end(), '\0');
        reject(peer, verified.code);
        return;
    }
    // The pair key proves which account is on this link; the ticket must be that account's.
    if (verified.claims.account_id != peer.config.account_id) {
        std::fill(ticket.begin(), ticket.end(), '\0');
        reject(peer, "wrong_account");
        return;
    }
    auto request = std::make_shared<AdmissionConsumeRequest>(AdmissionConsumeRequest{
        bindings_.session_id,
        ticket,
        bindings_.bridge_instance_id,
        "ice" + std::to_string(peer.index),
        "adm-" + std::to_string(bindings_.generation) + "-ice" + std::to_string(peer.index),
        peer.config.peer_id
    });
    std::fill(ticket.begin(), ticket.end(), '\0');
    if (lane_ == nullptr) {
        const AdmissionConsumeResult consumed = admission_client_.consume(*request);
        std::fill(request->ticket.begin(), request->ticket.end(), '\0');
        complete_admission(peer, verified.claims.jti_bytes, consumed);
        return;
    }
    // [2026-10-17] The consume is a round trip to the backend: it goes through the lane, and the link waits for the answer
    // (pump_once -> finish_admissions) while the other players' packets keep flowing. Its repeated requests meanwhile are
    // ignored (handle_frames), so a ticket is still consumed once.
    const std::uint64_t token = ++last_admission_token_;
    const auto mailbox = consume_mailbox_;
    const bool posted = lane_->post([request, mailbox, token](IAdmissionClient& client) {
        ConsumeOutcome outcome{ token, client.consume(*request) };
        std::fill(request->ticket.begin(), request->ticket.end(), '\0');
        std::lock_guard lock(mailbox->mutex);
        mailbox->done.push_back(std::move(outcome));
    });
    if (!posted) {
        std::fill(request->ticket.begin(), request->ticket.end(), '\0');
        reject(peer, "central_consume_busy");
        return;
    }
    peer.admission_token = token;
    pending_admissions_[token] = PendingAdmission{ peer.config.account_id, peer.config.peer_id, peer.index,
        verified.claims.jti_bytes };
}

void IceHostSession::complete_admission(Peer& peer, const std::array<std::uint8_t, 16>& jti,
    const AdmissionConsumeResult& consumed) {
    if (!consumed.admitted || consumed.admission_id.size() != 64) {
        reject(peer, consumed.code.empty() ? "central_consume_failed" : consumed.code);
        return;
    }
    if (!verifier_.mark_consumed(jti)) {
        backend_disconnects_.push_back(BackendDisconnect{ peer.config.peer_id, consumed.admission_id, peer.index,
            "disc-replay-" + std::to_string(bindings_.generation) + "-ice" + std::to_string(peer.index) });
        reject(peer, "local_replay");
        return;
    }
    peer.admission_id = consumed.admission_id;
    peer.admission_result = EncodeAdmissionResult(true, "ok", consumed.admission_id);
    peer.admitted = true;
    transport_->attach(peer.config.peer_id, peer.link);
    (void)peer.link->send(FrameType::Control, peer.admission_result);
    ++stats_.admitted;
    const std::string route = Route(*peer.link);
    diagnostic("ADMISSION_ACCEPTED role=host peer=" + std::to_string(peer.config.peer_id) + " source=ice route=" + route);
    event("PEER_ADMITTED account=" + peer.config.account_id + " route=" + route);
    std::string guard_error;
    (void)publish_guard_event("PLAYER_ADMITTED", peer.config.account_id, "{\"transport\":\"ice\"}", guard_error);
}

void IceHostSession::handle_frames(Peer& peer) {
    for (auto& frame : peer.link->take_received(kFramesPerPump)) {
        if (frame.type == FrameType::Gameplay) {
            if (peer.admitted) transport_->deliver(peer.config.peer_id, std::move(frame.payload));
            else ++stats_.pre_admission_gameplay_dropped;
            continue;
        }
        std::string ticket;
        if (!DecodeAdmissionRequest(frame.payload, ticket)) {
            ++stats_.malformed_control;
            continue;
        }
        if (peer.admitted) {
            // The joiner did not see our answer yet: repeat it, never consume twice.
            std::fill(ticket.begin(), ticket.end(), '\0');
            (void)peer.link->send(FrameType::Control, peer.admission_result);
            continue;
        }
        if (peer.closing || peer.admission_token != 0) {
            // Closing, or this link's consume is still with the backend: never consume twice.
            std::fill(ticket.begin(), ticket.end(), '\0');
            continue;
        }
        admit(peer, std::move(ticket));
        if (!peer.link || peer.closing) return;
    }
}

void IceHostSession::finish_admissions() {
    std::vector<ConsumeOutcome> done;
    {
        std::lock_guard lock(consume_mailbox_->mutex);
        done.swap(consume_mailbox_->done);
    }
    for (ConsumeOutcome& outcome : done) {
        const auto pending = pending_admissions_.find(outcome.token);
        if (pending == pending_admissions_.end()) continue;
        const PendingAdmission admission = std::move(pending->second);
        pending_admissions_.erase(pending);
        Peer* peer = find(admission.account_id);
        if (peer && peer->link && peer->index == admission.link_index && peer->admission_token == outcome.token) {
            peer->admission_token = 0;
            if (!peer->closing) {
                complete_admission(*peer, admission.jti, outcome.result);
                continue;
            }
        }
        // The link closed, was replaced or was refused (its admission deadline passed) while the backend answered. Settle it
        // as the old in-place consume would have ended: admitted, then gone (the ticket is spent here too, and the backend
        // hears that the peer left).
        if (outcome.result.admitted && outcome.result.admission_id.size() == 64) {
            (void)verifier_.mark_consumed(admission.jti);
            backend_disconnects_.push_back(BackendDisconnect{ admission.peer_id, outcome.result.admission_id,
                admission.link_index, {} });
        }
    }
}

void IceHostSession::finish_after_stop() {
    lane_ = nullptr;
    finish_admissions();
    pending_admissions_.clear();
    flush_backend_disconnects();
}

void IceHostSession::pump_once() {
    const auto now = std::chrono::steady_clock::now();
    finish_admissions();
    expire_held_signals(now);
    for (Peer& peer : peers_) {
        if (!peer.link) continue;
        for (auto& signal : peer.link->take_signals()) {
            if (signals_) signals_(peer.config.account_id, signal.kind, signal.data);
        }
        if (peer.closing) {
            if (now >= peer.close_at) close_link(peer, false, "rejected");
            continue;
        }
        const LinkState state = peer.link->state();
        if (state == LinkState::Connected && !peer.was_connected) {
            peer.was_connected = true;
            peer.admission_deadline = now + limits_.admission_deadline;
            const std::string route = Route(*peer.link);
            diagnostic("ICE_ROUTE role=host peer=" + std::to_string(peer.config.peer_id) + " route=" + route);
            event("PEER_CONNECTED account=" + peer.config.account_id + " route=" + route);
        }
        if (state == LinkState::Failed) {
            close_link(peer, true, peer.was_connected ? "link_lost" : "connect_failed");
            continue;
        }
        if (!peer.was_connected) continue;
        handle_frames(peer);
        if (!peer.link || peer.closing) continue;
        if (!peer.admitted && now >= peer.admission_deadline) {
            ++stats_.authentication_timeouts;
            reject(peer, "admission_request_timeout");
        }
    }
    flush_backend_disconnects();
}

void IceHostSession::stop() {
    for (Peer& peer : peers_) {
        if (peer.link || peer.admitted) close_link(peer, true, "host_stopped");
    }
    held_.clear();
    flush_backend_disconnects();
}

std::vector<PeerId> IceHostSession::take_disconnected_peers() {
    std::vector<PeerId> result(disconnected_peers_.begin(), disconnected_peers_.end());
    disconnected_peers_.clear();
    return result;
}

bool IceHostSession::publish_guard_event(std::string_view type, std::string_view account_id,
    std::string_view payload_json, std::string& error) {
    error.clear();
    if (!limits_.hunt_evidence) return true;
    // [2026-10-17] Queued for the GuardPublisher (its own thread, in batches): this thread never waits for the backend.
    if (!guard_sink_) {
        error = "no Guard event publisher";
        return false;
    }
    if (!guard_sink_(type, account_id, payload_json)) {
        error = "the Guard event queue did not take the event";
        return false;
    }
    return true;
}

// ---- joiner -----------------------------------------------------------------------------------------------------

IceJoinSession::IceJoinSession(IceServerConfig servers, IcePeerConfig host,
    std::shared_ptr<IceMessageTransport> transport, AdmissionTicketVerifier& verifier, SessionBindings bindings,
    PeerId local_peer_id, std::string local_account_id, std::string ticket, SessionLimits limits,
    SignalSink signals, PeerEventSink events, SessionDiagnosticSink diagnostic)
    : servers_(std::move(servers)), host_(std::move(host)), transport_(std::move(transport)), verifier_(verifier),
      bindings_(std::move(bindings)), local_peer_id_(local_peer_id), local_account_id_(std::move(local_account_id)),
      ticket_(std::move(ticket)), limits_(limits), signals_(std::move(signals)), events_(std::move(events)),
      diagnostic_(std::move(diagnostic)) {
    if (!transport_ || host_.account_id.empty() || host_.peer_id == 0 || host_.peer_id != bindings_.host_peer_id ||
        local_peer_id_ == 0 || local_peer_id_ == host_.peer_id || local_account_id_.empty() || ticket_.empty() ||
        bindings_.virtual_port == 0) {
        throw std::invalid_argument("invalid ICE join session configuration");
    }
}

IceJoinSession::~IceJoinSession() {
    stop();
}

void IceJoinSession::diagnostic(std::string_view line) const {
    if (diagnostic_ && !line.empty()) diagnostic_(line);
}

void IceJoinSession::event(std::string_view line) const {
    if (events_ && !line.empty()) events_(line);
}

bool IceJoinSession::start(std::string& error) {
    error.clear();
    if (link_) return true;
    const ExpectedAdmissionTicket expected{
        bindings_.key_id, bindings_.session_id, bindings_.party_id, bindings_.hunt_definition_id,
        local_peer_id_, bindings_.host_peer_id, bindings_.party_revision, bindings_.generation,
        bindings_.build, bindings_.bridge_protocol, bindings_.virtual_port
    };
    const AdmissionTicketResult verified = verifier_.verify(ticket_, expected);
    if (!verified.ok) {
        error = "join ticket verification failed: " + verified.code;
        return false;
    }
    if (verified.claims.account_id != local_account_id_) {
        error = "join ticket belongs to another account";
        return false;
    }
    link_ = std::make_shared<IceLink>(servers_, limits_.force_relay, false);
    ++stats_.connection_attempts;
    if (!link_->start(host_.key, error)) {
        link_.reset();
        return false;
    }
    deadline_ = std::chrono::steady_clock::now() + limits_.admission_deadline;
    return true;
}

void IceJoinSession::stop() {
    if (admitted_) transport_->detach(host_.peer_id);
    if (link_) link_->stop();
    link_.reset();
    connected_ = false;
    admitted_ = false;
    if (!ticket_.empty()) std::fill(ticket_.begin(), ticket_.end(), '\0');
    ticket_.clear();
}

void IceJoinSession::fail(std::string code) {
    if (failed_) return;
    failed_ = true;
    failure_code_ = std::move(code);
    ++stats_.admission_rejected;
    diagnostic("ADMISSION_REJECTED role=join peer=" + std::to_string(host_.peer_id) + " code=" + failure_code_);
}

void IceJoinSession::apply_signal(std::string_view from_account_id, std::string_view kind, std::string_view data) {
    if (!link_ || from_account_id != host_.account_id) {
        ++stats_.signals_rejected;
        return;
    }
    if (kind == "DESCRIPTION" && link_->has_remote_description()) {
        // The host replaced its link while ours was still set up: this attempt cannot connect any more.
        if (!admitted_) fail("transport_restarted");
        return;
    }
    std::string error;
    if (!link_->apply_remote_signal(kind, data, error)) {
        ++stats_.signals_rejected;
        diagnostic("ICE_SIGNAL_REJECTED role=join reason=" + error);
    }
}

void IceJoinSession::pump_once() {
    if (!link_) return;
    for (auto& signal : link_->take_signals()) {
        if (signals_) signals_(host_.account_id, signal.kind, signal.data);
    }
    if (failed_) return;
    const auto now = std::chrono::steady_clock::now();
    const LinkState state = link_->state();
    if (state == LinkState::Failed) {
        if (admitted_) {
            transport_->detach(host_.peer_id);
            admitted_ = false;
            failed_ = true;
            failure_code_ = "connection_closed";
            ++stats_.disconnected;
            event("PEER_LOST account=" + host_.account_id + " reason=link_lost");
        } else {
            fail(connected_ ? "connection_closed_before_admission" : "transport_connect_failed");
        }
        return;
    }
    if (state == LinkState::Connected && !connected_) {
        connected_ = true;
        const std::string route = link_->relayed() ? "relay" : "direct";
        if (limits_.force_relay && route != "relay") {
            fail("transport_not_relayed");
            return;
        }
        diagnostic("ICE_ROUTE role=join peer=" + std::to_string(host_.peer_id) + " route=" + route);
        event("PEER_CONNECTED account=" + host_.account_id + " route=" + route);
    }
    for (auto& frame : link_->take_received(kFramesPerPump)) {
        if (frame.type == FrameType::Gameplay) {
            if (admitted_) transport_->deliver(host_.peer_id, std::move(frame.payload));
            else ++stats_.pre_admission_gameplay_dropped;
            continue;
        }
        if (admitted_) continue;
        bool allowed = false;
        std::string code;
        std::string admission_id;
        if (!DecodeAdmissionResult(frame.payload, allowed, code, admission_id)) {
            ++stats_.malformed_control;
            continue;
        }
        if (!allowed) {
            fail(code.empty() ? "admission_rejected" : code);
            return;
        }
        transport_->attach(host_.peer_id, link_);
        if (!ticket_.empty()) std::fill(ticket_.begin(), ticket_.end(), '\0');
        ticket_.clear();
        admitted_ = true;
        ++stats_.admitted;
        const std::string route = link_->relayed() ? "relay" : "direct";
        diagnostic("ADMISSION_ACCEPTED role=join peer=" + std::to_string(host_.peer_id) + " source=ice route=" + route);
        event("PEER_ADMITTED account=" + host_.account_id + " route=" + route);
    }
    if (admitted_) return;
    if (now >= deadline_) {
        ++stats_.authentication_timeouts;
        fail(connected_ ? "admission_response_timeout" : "transport_connect_timeout");
        return;
    }
    if (connected_ && now >= next_request_) {
        const auto request = EncodeAdmissionRequest(ticket_);
        if (request.empty()) {
            fail("admission_send_failed");
            return;
        }
        (void)link_->send(FrameType::Control, request);
        next_request_ = now + kRequestInterval;
    }
}

} // namespace mystic::bridge
