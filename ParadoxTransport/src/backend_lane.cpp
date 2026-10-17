/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "backend_lane.hpp"

#include <utility>

namespace mystic::bridge {

BackendLane::BackendLane(IAdmissionClient& client, std::size_t maximum_pending)
    : client_(client), maximum_pending_(maximum_pending == 0 ? 1 : maximum_pending) {
    thread_ = std::thread([this]() { run(); });
}

BackendLane::~BackendLane() {
    drain_and_stop(std::chrono::milliseconds(0));
}

bool BackendLane::post(Job job) {
    if (!job) return false;
    {
        std::lock_guard lock(mutex_);
        if (stopping_ || jobs_.size() + (running_job_ ? 1 : 0) >= maximum_pending_) return false;
        jobs_.push_back(std::move(job));
    }
    changed_.notify_all();
    return true;
}

std::size_t BackendLane::pending() const {
    std::lock_guard lock(mutex_);
    return jobs_.size() + (running_job_ ? 1 : 0);
}

void BackendLane::drain_and_stop(std::chrono::milliseconds limit) {
    {
        std::unique_lock lock(mutex_);
        if (limit.count() > 0) {
            changed_.wait_for(lock, limit, [this]() { return jobs_.empty() && !running_job_; });
        }
        stopping_ = true;
        jobs_.clear();
    }
    changed_.notify_all();
    if (thread_.joinable()) thread_.join();
}

void BackendLane::run() {
    std::unique_lock lock(mutex_);
    while (true) {
        changed_.wait(lock, [this]() { return stopping_ || !jobs_.empty(); });
        if (stopping_) return;
        Job job = std::move(jobs_.front());
        jobs_.pop_front();
        running_job_ = true;
        lock.unlock();
        try {
            job(client_);
        } catch (...) {
            // A job reports through what it captured; one that throws reports nothing and the next one runs.
        }
        lock.lock();
        running_job_ = false;
        changed_.notify_all();
    }
}

} // namespace mystic::bridge
