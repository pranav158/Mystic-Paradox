/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include "admission_client.hpp"
#include "admission_ticket.hpp"
#include "backend_lane.hpp"
#include "ice_link.hpp"
#include "ice_transport.hpp"
#include "session_types.hpp"

#include <array>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace mystic::bridge {

// [2026-10-17] Where a host session's own Hunt Guard events go (transport_app.cpp: the GuardPublisher's queue). False when
// the event was not taken.
using GuardEventSink = std::function<bool(std::string_view type, std::string_view account_id, std::string_view payload_json)>;

// One side of a host-joiner pair as the backend described it (transport-config): the other side's account, the
// 64-bit peer id its admission ticket carries, and the pair key.
struct IcePeerConfig {
    std::string account_id;
    PeerId peer_id = 0;
    std::array<std::uint8_t, 32> key{};
};

// The host's side: one ICE link per joiner, created when that joiner's DESCRIPTION arrives (the joiner always speaks
// first, so no signal waits in a queue for a session that does not exist yet). A joiner is admitted after it sends
// its admission ticket over the sealed link, the ticket verifies, it belongs to the pair's account, and the backend
// consumes it once - the same rules as the Steam bridge.
//
// The roster (the accounts this host expects) starts with the constructor's peers and can change while the session
// runs: add_peer / remove_peer (a hub admits and loses players for days). A signal from an account that is not on
// the roster yet is held for limits.held_signal_ttl and replayed when add_peer adds that account, which removes the
// race between "the joiner started" and "the host's launcher learned about it". Everything here runs on the
// session thread.
class IceHostSession final {
public:
    IceHostSession(IceServerConfig servers, std::vector<IcePeerConfig> peers,
        std::shared_ptr<IceMessageTransport> transport, AdmissionTicketVerifier& verifier,
        IAdmissionClient& admission_client, SessionBindings bindings, SessionLimits limits,
        SignalSink signals, PeerEventSink events, SessionDiagnosticSink diagnostic);
    ~IceHostSession();
    IceHostSession(const IceHostSession&) = delete;
    IceHostSession& operator=(const IceHostSession&) = delete;

    // False with a bounded reason code in `error` (full, duplicate_account, duplicate_peer, invalid_peer). Replays the
    // signals held for the account.
    bool add_peer(IcePeerConfig peer, std::string& error);
    // Closes the peer's link (telling the backend when it was admitted), frees its roster slot and emits
    // PEER_REMOVED account=... (and PEER_LOST for an admitted peer). False when the account is not on the roster.
    bool remove_peer(std::string_view account_id, std::string_view reason);
    [[nodiscard]] std::size_t peer_count() const { return peers_.size(); }

    void apply_signal(std::string_view from_account_id, std::string_view kind, std::string_view data);
    void pump_once();
    void stop();
    [[nodiscard]] std::vector<PeerId> take_disconnected_peers();
    [[nodiscard]] const SessionStats& stats() const { return stats_; }
    [[nodiscard]] std::uint32_t admitted_count() const;

    // [2026-10-17] Hands the event to the sink (set_guard_sink); true without hunt evidence. It never waits for the network.
    bool publish_guard_event(std::string_view type, std::string_view account_id,
        std::string_view payload_json, std::string& error);
    void set_guard_sink(GuardEventSink sink) { guard_sink_ = std::move(sink); }
    // [2026-10-17] With a lane, the backend calls this session makes while it runs (an admission's ticket consume, a
    // disconnect notice) go through the lane, so pump_once never waits for the backend; without one they are made in
    // place (the unit tests). finish_after_stop, after stop() and after the lane drained: the consumes that came back
    // late are settled and the last disconnect notices are sent in place.
    void set_backend_lane(BackendLane* lane) { lane_ = lane; }
    void finish_after_stop();

private:
    struct Peer {
        IcePeerConfig config;
        // Counts links, not accounts: "ice"+index and "adm-gen-ice<index>" are unique across rejoins of one account.
        std::size_t index = 0;
        std::shared_ptr<IceLink> link;
        bool was_connected = false;
        bool admitted = false;
        std::string admission_id;
        std::vector<std::uint8_t> admission_result;
        std::chrono::steady_clock::time_point admission_deadline{};
        std::chrono::steady_clock::time_point close_at{};
        bool closing = false;
        // Non-zero while this link's ticket consume is with the backend (lane_).
        std::uint64_t admission_token = 0;
    };
    // std::list: pointers to peers stay valid while others are added and removed.
    using PeerList = std::list<Peer>;

    struct HeldSignal {
        std::string kind;
        std::string data;
        std::chrono::steady_clock::time_point at;
    };
    struct HeldSignals {
        std::deque<HeldSignal> signals;
        bool overflow_reported = false;
    };
    struct BackendDisconnect {
        PeerId peer_id = 0;
        std::string admission_id;
        std::size_t index = 0;
        // The notice's request id when it is not the usual disc-<generation>-<peer>-<link>.
        std::string request_id;
    };
    // A ticket consume sent through the lane: what the answer is for, and where the lane puts it.
    struct PendingAdmission {
        std::string account_id;
        PeerId peer_id = 0;
        std::size_t link_index = 0;
        std::array<std::uint8_t, 16> jti{};
    };
    struct ConsumeOutcome {
        std::uint64_t token = 0;
        AdmissionConsumeResult result;
    };
    struct ConsumeMailbox {
        std::mutex mutex;
        std::vector<ConsumeOutcome> done;
    };

    PeerList::iterator find_peer(std::string_view account_id);
    Peer* find(std::string_view account_id);
    bool validate_peer(const IcePeerConfig& peer, std::string& error) const;
    bool open_link(Peer& peer, std::string_view remote_description);
    void close_link(Peer& peer, bool notify_backend, std::string_view reason);
    void handle_frames(Peer& peer);
    void admit(Peer& peer, std::string ticket);
    void complete_admission(Peer& peer, const std::array<std::uint8_t, 16>& jti, const AdmissionConsumeResult& consumed);
    void finish_admissions();
    void reject(Peer& peer, std::string_view code);
    void hold_signal(std::string_view from_account_id, std::string_view kind, std::string_view data);
    void replay_held_signals(std::string_view account_id);
    void expire_held_signals(std::chrono::steady_clock::time_point now);
    void flush_backend_disconnects();
    void diagnostic(std::string_view line) const;
    void event(std::string_view line) const;

    IceServerConfig servers_;
    PeerList peers_;
    std::size_t last_link_index_ = 0;
    std::unordered_map<std::string, HeldSignals> held_;
    std::shared_ptr<IceMessageTransport> transport_;
    AdmissionTicketVerifier& verifier_;
    IAdmissionClient& admission_client_;
    SessionBindings bindings_;
    SessionLimits limits_;
    SignalSink signals_;
    PeerEventSink events_;
    SessionDiagnosticSink diagnostic_;
    SessionStats stats_;
    std::deque<PeerId> disconnected_peers_;
    std::deque<BackendDisconnect> backend_disconnects_;
    GuardEventSink guard_sink_;
    BackendLane* lane_ = nullptr;
    std::shared_ptr<ConsumeMailbox> consume_mailbox_ = std::make_shared<ConsumeMailbox>();
    std::unordered_map<std::uint64_t, PendingAdmission> pending_admissions_;
    std::uint64_t last_admission_token_ = 0;
};

// The joiner's side: one link to the host. It sends its DESCRIPTION first, then (once connected) its admission
// ticket every 750 ms until the host answers or the deadline passes.
class IceJoinSession final {
public:
    IceJoinSession(IceServerConfig servers, IcePeerConfig host, std::shared_ptr<IceMessageTransport> transport,
        AdmissionTicketVerifier& verifier, SessionBindings bindings, PeerId local_peer_id,
        std::string local_account_id, std::string ticket, SessionLimits limits,
        SignalSink signals, PeerEventSink events, SessionDiagnosticSink diagnostic);
    ~IceJoinSession();
    IceJoinSession(const IceJoinSession&) = delete;
    IceJoinSession& operator=(const IceJoinSession&) = delete;

    bool start(std::string& error);
    void apply_signal(std::string_view from_account_id, std::string_view kind, std::string_view data);
    void pump_once();
    void stop();

    [[nodiscard]] bool admitted() const { return admitted_; }
    [[nodiscard]] bool failed() const { return failed_; }
    [[nodiscard]] std::string_view failure_code() const { return failure_code_; }
    [[nodiscard]] bool relayed() const { return link_ && link_->relayed(); }
    [[nodiscard]] const SessionStats& stats() const { return stats_; }

private:
    void fail(std::string code);
    void diagnostic(std::string_view line) const;
    void event(std::string_view line) const;

    IceServerConfig servers_;
    IcePeerConfig host_;
    std::shared_ptr<IceMessageTransport> transport_;
    AdmissionTicketVerifier& verifier_;
    SessionBindings bindings_;
    PeerId local_peer_id_ = 0;
    std::string local_account_id_;
    std::string ticket_;
    SessionLimits limits_;
    SignalSink signals_;
    PeerEventSink events_;
    SessionDiagnosticSink diagnostic_;
    SessionStats stats_;
    std::shared_ptr<IceLink> link_;
    std::chrono::steady_clock::time_point deadline_{};
    std::chrono::steady_clock::time_point next_request_{};
    bool connected_ = false;
    bool admitted_ = false;
    bool failed_ = false;
    std::string failure_code_;
};

} // namespace mystic::bridge
