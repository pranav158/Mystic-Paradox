/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include "admission_client.hpp"
#include "session_types.hpp"

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

namespace mystic::bridge {

struct GuardPublisherTiming {
    /// How long the first queued event waits for more before its batch goes (a terminal event, a full batch or a flush
    /// send at once). 2 s keeps a hunt under 30 batches a minute: the backend allows 120 a minute per hunt session and
    /// 4,096 per hunt.
    std::chrono::milliseconds batch_window{ 2000 };
    /// A batch the backend did not take (no answer, 408, 429, 5xx) is sent again unchanged after this, doubling up to
    /// retry_ceiling.
    std::chrono::milliseconds first_retry{ 250 };
    std::chrono::milliseconds retry_ceiling{ 4000 };
    std::size_t max_batch_events = 96;
    std::size_t max_queued_events = 4096;
    /// Attempts at the completion request after COMPLETION_REQUESTED was taken (1 s apart, doubling).
    unsigned completion_attempts = 6;
};

struct GuardPublisherStats {
    /// Failed sends (each attempt).
    std::uint64_t publish_failures = 0;
    /// Events that will never reach the backend (a full queue, a refused batch).
    std::uint64_t evidence_loss = 0;
    std::uint64_t events_published = 0;
    std::uint64_t batches_published = 0;
};

/// [2026-10-17] A hosted hunt's Hunt Guard evidence, sent to the backend from its own thread in batches.
///
/// The host session's thread used to send every event itself, one blocking HTTPS request per event, and every request
/// stopped the hunt's packets for a round trip to the backend (backend_lane.hpp). A fight queued events faster than they
/// went, and the players rubber-banded; the events also used up the hunt's request budget. Now the session thread only
/// queues an event (enqueue never waits for the network) and this thread sends them, many per request.
///
/// The chain is the backend's Hunt Guard chain: consecutive sequences from 1, each batch naming the hash of the
/// one before. A batch the backend did not take is sent again with the same id and the same events, so the backend can
/// answer it idempotently if the first send did arrive; a batch it refused (any other answer) ends the evidence of this
/// hunt (evidence_incomplete: completion is then never requested). Once a batch holding COMPLETION_REQUESTED is taken,
/// the completion is requested with the chain's head.
class GuardPublisher final {
public:
    GuardPublisher(IAdmissionClient& client, std::string session_id, std::uint32_t generation,
        SessionDiagnosticSink diagnostic, GuardPublisherTiming timing = {});
    ~GuardPublisher();
    GuardPublisher(const GuardPublisher&) = delete;
    GuardPublisher& operator=(const GuardPublisher&) = delete;

    /// Queues one event, stamped now. False when it was not queued: the queue is full (the loss is reported to the backend
    /// as EVIDENCE_LOSS once there is room), the evidence ended after a refusal, or the publisher is stopping.
    bool enqueue(std::string_view type, std::string_view actor_account_id, std::string_view payload_json);
    /// Sends what is queued without waiting for the batch window, waits up to `limit` for it (and a due completion), then
    /// stops the thread.
    void flush_and_stop(std::chrono::milliseconds limit);

    [[nodiscard]] GuardPublisherStats stats() const;
    /// The backend accepted the completion request.
    [[nodiscard]] bool completed() const;
    [[nodiscard]] bool evidence_incomplete() const;

private:
    using Clock = std::chrono::steady_clock;
    struct Queued {
        GuardEvent event;
        Clock::time_point queued_at;
    };

    void run();
    [[nodiscard]] bool batch_due_locked(Clock::time_point now) const;
    void build_batch_locked();
    void batch_result_locked(const GuardEventBatchResult& result, Clock::time_point now);
    [[nodiscard]] bool idle_locked() const;
    void diagnostic(std::string_view line) const;

    IAdmissionClient& client_;
    const std::string session_id_;
    const std::uint32_t generation_;
    const SessionDiagnosticSink diagnostic_;
    const GuardPublisherTiming timing_;
    const Clock::time_point started_ = Clock::now();

    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<Queued> queue_;
    std::size_t queued_terminal_events_ = 0;
    std::uint64_t overflowed_events_ = 0;
    std::optional<GuardEventBatchRequest> batch_;
    bool batch_has_completion_ = false;
    Clock::time_point next_attempt_{};
    std::chrono::milliseconds retry_delay_;
    unsigned failures_in_a_row_ = 0;
    std::uint64_t next_sequence_ = 1;
    std::string head_hash_ = std::string(64, '0');
    bool completion_due_ = false;
    unsigned completion_attempts_ = 0;
    Clock::time_point next_completion_attempt_{};
    bool completed_ = false;
    bool refused_ = false;
    bool incomplete_ = false;
    bool flushing_ = false;
    bool stopping_ = false;
    GuardPublisherStats stats_;
    std::thread thread_;
};

} // namespace mystic::bridge
