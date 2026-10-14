/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include "transport_app.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>

namespace mystic::bridge {

// At most this many sessions run at once in one module instance (a hub plus its hunts, or a joiner's hub and hunt).
inline constexpr int kMaximumSessions = 8;

// The module behind the ABI (paradox_transport_api.cpp is a thin C layer over one instance): a registry of sessions
// by handle, each with its own thread, queues, diagnostics and peer events. Handles are positive, never reused, and
// every call is safe from any thread. An ended or stopped session stays readable (diagnostics, events, ready line)
// until it is drained or the registry needs the room, because the launcher reads the last lines after stopping.
//
// The ABI 2 calls are wrappers over a default handle with the semantics they always had: one session at a time,
// "already running" while it lives, a new start replaces a finished one.
class TransportModule final {
public:
    // `admission_factory` is the test hook of RunIceHost (empty: the real HTTPS client).
    explicit TransportModule(AdmissionClientFactory admission_factory = {});
    ~TransportModule();
    TransportModule(const TransportModule&) = delete;
    TransportModule& operator=(const TransportModule&) = delete;

    bool initialize(std::string& error);
    [[nodiscard]] std::uint64_t peer_id() const { return peer_id_.load(); }

    // ---- ABI 3 -----------------------------------------------------------------------------------------------------
    // A handle > 0, or 0 with a message in the error buffer. The session thread starts at once; configuration
    // problems appear as WaitReady -1 plus diagnostics, as in ABI 2. `host_ticket_path` may be null for a host with
    // host_local_client=0.
    int host_open(const char* public_key_path, const char* config_path, const char* capability_path,
        const char* host_ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);
    int join_open(const char* public_key_path, const char* config_path, const char* ticket_path,
        const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);
    // 1 ready (line copied), 0 timeout, -1 ended before readiness or unknown handle.
    int wait_ready(int handle, std::uint32_t timeout_ms, char* ready_buffer, std::uint32_t ready_buffer_size);
    int session_running(int handle);
    // 1 when the handle named a session (stopped now, its thread joined), 0 for an unknown handle.
    int stop_session(int handle);
    // The session's result code (0 clean, 2 bad input, 3 setup failure, 4 refused admission, 5 lease failed), or -1.
    int last_session_result(int handle);
    int read_diagnostic(int handle, char* diagnostic_buffer, std::uint32_t diagnostic_buffer_size);
    // 1 copied, 0 none queued, -1 a buffer is too small (the signal stays queued).
    int read_signal(int handle, char* to_account_buffer, std::uint32_t to_account_size, char* kind_buffer,
        std::uint32_t kind_size, char* data_buffer, std::uint32_t data_size);
    int submit_signal(int handle, const char* from_account_id, const char* kind, const char* data);
    int read_peer_event(int handle, char* event_buffer, std::uint32_t event_buffer_size);
    // 1 queued, 0 for an unknown or ended handle, a joiner session, a full roster, a duplicate account or peer id, a
    // malformed account or key, or a full command queue. The session thread applies it (the result of a later refusal
    // is a PEER_ADD_REJECTED event).
    int add_peer(int handle, const char* account_id, std::uint64_t peer_id, const char* pair_key_base64url);
    // 1 queued, 0 when the account is not on the roster (or the handle is not a running host).
    int remove_peer(int handle, const char* account_id, const char* reason);
    // Stops every session (the module is being unloaded).
    void shutdown();

    // ---- ABI 2: the same calls on the default handle ----------------------------------------------------------------
    int start_host_v2(const char* public_key_path, const char* config_path, const char* capability_path,
        const char* host_ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);
    int start_join_v2(const char* public_key_path, const char* config_path, const char* ticket_path,
        const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);
    [[nodiscard]] int default_handle() const { return default_handle_.load(); }

private:
    struct OutgoingSignal {
        std::string to_account_id;
        std::string kind;
        std::string data;
    };

    struct Session {
        int handle = 0;
        bool host = false;
        std::mutex mutex;   // guards everything below except the atomics
        std::condition_variable changed;
        std::mutex join_mutex;
        std::thread thread;
        std::atomic_bool stop{ false };
        std::atomic_bool running{ false };
        bool ready = false;
        bool ended_before_ready = false;
        std::string ready_line;
        int last_result = 0;
        std::deque<std::string> diagnostics;
        std::deque<OutgoingSignal> outgoing;
        std::deque<InboundSignal> incoming;
        std::deque<std::string> events;
        std::deque<PeerCommand> commands;
        std::uint64_t dropped_signals = 0;
        // The roster as the API layer sees it: the session's own peers plus queued adds minus queued removes, so
        // AddPeerH can answer at once. The session thread reports its starting roster and the adds it refused.
        std::unordered_map<std::string, std::uint64_t> roster;
        std::size_t roster_limit = kMaximumHubPeers;
    };

    template <typename Run>
    int open_session(bool host, Run run, char* error_buffer, std::uint32_t error_buffer_size);
    [[nodiscard]] std::shared_ptr<Session> find(int handle);
    static TransportObserver make_observer(Session& session);
    static void join_thread(Session& session);
    static bool drained(Session& session);
    void drop_idle_sessions_locked();

    AdmissionClientFactory admission_factory_;
    std::atomic<std::uint64_t> peer_id_{ 0 };
    std::mutex mutex_;   // the registry
    std::map<int, std::shared_ptr<Session>> sessions_;
    int next_handle_ = 1;
    std::mutex default_mutex_;
    std::atomic<int> default_handle_{ 0 };
};

} // namespace mystic::bridge
