/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#pragma once

#include "admission_client.hpp"

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace mystic::bridge {

/// [2026-10-17] One background thread that makes a hosted session's calls to the backend, in the order they were posted.
///
/// A host session's thread relays every game packet of the session (the host's own client too). Until 17 Oct it also made
/// its backend calls itself, each a blocking HTTPS request: the lease every 2 s, an admission's ticket consume, a peer's
/// disconnect notice and every Hunt Guard event. Each call stopped every player's packets for one round trip to the
/// backend (a few hundred ms for players far from the server, more on a slow answer: up to the client's
/// 5 s timeouts per phase), and the players rubber-banded. The session thread now only posts the work here and reads the
/// results when they come back.
///
/// A job runs on this thread with the session's client (WinHTTP handles are thread-safe; each request opens its own
/// connection and request handles). Results go back through whatever the job captured, never through the session's
/// own state: a job may finish after the session moved on. The destructor stops the thread; a job that is running is
/// waited for (each request is bounded by the client's timeouts), jobs not started are dropped.
class BackendLane final {
public:
    using Job = std::function<void(IAdmissionClient&)>;

    BackendLane(IAdmissionClient& client, std::size_t maximum_pending);
    ~BackendLane();
    BackendLane(const BackendLane&) = delete;
    BackendLane& operator=(const BackendLane&) = delete;

    /// Queues a job; false when the lane is full or stopping (the job is not run).
    bool post(Job job);
    /// Jobs queued or running.
    [[nodiscard]] std::size_t pending() const;
    /// Waits up to `limit` for the queued jobs to finish, then stops the thread (jobs not started by then are dropped).
    void drain_and_stop(std::chrono::milliseconds limit);

private:
    void run();

    IAdmissionClient& client_;
    const std::size_t maximum_pending_;
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<Job> jobs_;
    bool running_job_ = false;
    bool stopping_ = false;
    std::thread thread_;
};

} // namespace mystic::bridge
