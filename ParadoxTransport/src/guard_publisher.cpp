/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "guard_publisher.hpp"

#include "control_codec.hpp"

#include <algorithm>
#include <utility>

namespace mystic::bridge {

namespace {

// The batch envelope and one event's fields around its strings, generously (admission_client.cpp GuardBatchBody).
constexpr std::size_t kBatchEnvelopeBytes = 256;
constexpr std::size_t kEventEnvelopeBytes = 112;

bool IsTerminal(std::string_view type) {
    return type == "COMPLETION_REQUESTED" || type == "HUNT_ABORTED";
}

std::size_t WireBytes(const GuardEvent& event) {
    return kEventEnvelopeBytes + event.type.size() + event.actor_account_id.size() + event.payload_json.size();
}

} // namespace

GuardPublisher::GuardPublisher(IAdmissionClient& client, std::string session_id, std::uint32_t generation,
    SessionDiagnosticSink diagnostic, GuardPublisherTiming timing)
    : client_(client), session_id_(std::move(session_id)), generation_(generation), diagnostic_(std::move(diagnostic)),
      timing_(timing), retry_delay_(timing.first_retry) {
    thread_ = std::thread([this]() { run(); });
}

GuardPublisher::~GuardPublisher() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    changed_.notify_all();
    if (thread_.joinable()) thread_.join();
}

void GuardPublisher::diagnostic(std::string_view line) const {
    if (diagnostic_ && !line.empty()) diagnostic_(line);
}

bool GuardPublisher::enqueue(std::string_view type, std::string_view actor_account_id, std::string_view payload_json) {
    {
        std::lock_guard lock(mutex_);
        if (stopping_) return false;
        if (refused_) {
            ++stats_.evidence_loss;
            return false;
        }
        const auto now = Clock::now();
        const auto monotonic_ms = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(now - started_).count());
        if (queue_.size() >= timing_.max_queued_events) {
            if (overflowed_events_++ == 0) {
                diagnostic("GUARD_EVIDENCE_LOSS action=completion_fenced reason=publisher_queue_full");
            }
            ++stats_.evidence_loss;
            incomplete_ = true;
            return false;
        }
        if (overflowed_events_ > 0) {
            // Where the gap is, as the bridge's own overflow is reported (transport_app.cpp).
            queue_.push_back(Queued{ GuardEvent{ 0, monotonic_ms, "EVIDENCE_LOSS", "",
                "{\"droppedEvents\":" + std::to_string(overflowed_events_) + ",\"reason\":\"publisher_queue_full\"}" }, now });
            overflowed_events_ = 0;
        }
        queue_.push_back(Queued{ GuardEvent{ 0, monotonic_ms, std::string(type), std::string(actor_account_id),
            std::string(payload_json) }, now });
        if (IsTerminal(type)) ++queued_terminal_events_;
    }
    changed_.notify_all();
    return true;
}

bool GuardPublisher::batch_due_locked(Clock::time_point now) const {
    if (queue_.empty()) return false;
    return flushing_ || queued_terminal_events_ > 0 || queue_.size() >= timing_.max_batch_events ||
        now - queue_.front().queued_at >= timing_.batch_window;
}

void GuardPublisher::build_batch_locked() {
    GuardEventBatchRequest batch;
    batch.session_id = session_id_;
    batch.previous_hash = head_hash_;
    batch.batch_id = RandomUuid();
    if (batch.batch_id.empty()) {
        // No randomness for the id: the chain cannot go on (the old per-event path ended the same way).
        refused_ = true;
        incomplete_ = true;
        stats_.evidence_loss += queue_.size();
        queue_.clear();
        queued_terminal_events_ = 0;
        diagnostic("GUARD_EVIDENCE_LOSS action=completion_fenced reason=batch_id_generation");
        return;
    }
    std::size_t bytes = kBatchEnvelopeBytes;
    batch_has_completion_ = false;
    while (!queue_.empty() && batch.events.size() < std::min(timing_.max_batch_events, kMaximumGuardBatchEvents)) {
        GuardEvent& next = queue_.front().event;
        const std::size_t size = WireBytes(next);
        if (!batch.events.empty() && bytes + size > kMaximumGuardBatchBodyBytes) break;
        bytes += size;
        next.sequence = next_sequence_ + batch.events.size();
        const bool terminal = IsTerminal(next.type);
        if (next.type == "COMPLETION_REQUESTED") batch_has_completion_ = true;
        batch.events.push_back(std::move(next));
        queue_.pop_front();
        // The backend wants a terminal event last in its batch.
        if (terminal) {
            --queued_terminal_events_;
            break;
        }
    }
    batch.request_id = "guard-" + std::to_string(generation_) + '-' + std::to_string(batch.events.front().sequence);
    batch_ = std::move(batch);
    next_attempt_ = Clock::now();
    if (overflowed_events_ > 0 && queue_.size() < timing_.max_queued_events) {
        // The queue was full and no event came since: report the gap now, so it reaches the backend without one.
        const auto now = Clock::now();
        queue_.push_back(Queued{ GuardEvent{ 0, static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(now - started_).count()), "EVIDENCE_LOSS", "",
            "{\"droppedEvents\":" + std::to_string(overflowed_events_) + ",\"reason\":\"publisher_queue_full\"}" }, now });
        overflowed_events_ = 0;
    }
}

void GuardPublisher::batch_result_locked(const GuardEventBatchResult& result, Clock::time_point now) {
    if (result.accepted && result.batch_hash.size() == 64) {
        if (failures_in_a_row_ > 0) {
            diagnostic("HUNT GUARD OBSERVE: the batch was taken after " + std::to_string(failures_in_a_row_) + " failed send(s)");
        }
        failures_in_a_row_ = 0;
        retry_delay_ = timing_.first_retry;
        next_sequence_ = batch_->events.back().sequence + 1;
        head_hash_ = result.batch_hash;
        stats_.events_published += batch_->events.size();
        ++stats_.batches_published;
        if (batch_has_completion_) {
            completion_due_ = true;
            completion_attempts_ = 0;
            next_completion_attempt_ = now;
        }
        batch_.reset();
        return;
    }
    ++stats_.publish_failures;
    const std::string error = result.error.empty() ? "Guard event batch was rejected" : result.error;
    if (IsRetryableGuardAnswer(result.answered, result.status)) {
        if (failures_in_a_row_++ == 0) {
            diagnostic("HUNT GUARD OBSERVE WARN: " + error + " (sending the same batch again)");
        }
        next_attempt_ = now + retry_delay_;
        retry_delay_ = std::min(retry_delay_ * 2, timing_.retry_ceiling);
        return;
    }
    // Refused: this hunt's evidence ends here (resending the batch, or the next one after it, only repeats the refusal).
    refused_ = true;
    incomplete_ = true;
    stats_.evidence_loss += batch_->events.size() + queue_.size();
    batch_.reset();
    queue_.clear();
    queued_terminal_events_ = 0;
    completion_due_ = false;
    diagnostic("GUARD_EVIDENCE_LOSS action=completion_fenced reason=batch_refused status=" + std::to_string(result.status));
    diagnostic("HUNT GUARD OBSERVE WARN: " + error + " (no more evidence is sent for this hunt)");
}

bool GuardPublisher::idle_locked() const {
    return refused_ || (queue_.empty() && !batch_.has_value() && !completion_due_);
}

void GuardPublisher::run() {
    std::unique_lock lock(mutex_);
    while (!stopping_) {
        const auto now = Clock::now();
        if (!refused_ && !batch_.has_value() && batch_due_locked(now)) build_batch_locked();
        if (batch_.has_value() && now >= next_attempt_) {
            const GuardEventBatchRequest request = *batch_;
            lock.unlock();
            const GuardEventBatchResult result = client_.publish_guard_batch(request);
            lock.lock();
            batch_result_locked(result, Clock::now());
            changed_.notify_all();
            continue;
        }
        if (!batch_.has_value() && completion_due_ && now >= next_completion_attempt_) {
            if (incomplete_) {
                completion_due_ = false;
                diagnostic("HUNT GUARD COMPLETION WARN: Guard evidence is incomplete; completion is not requested");
                changed_.notify_all();
                continue;
            }
            const std::uint64_t final_sequence = next_sequence_ - 1;
            const std::string final_hash = head_hash_;
            lock.unlock();
            std::string error;
            const bool accepted = client_.request_guard_completion(session_id_, final_sequence, final_hash,
                "complete-" + std::to_string(generation_) + '-' + std::to_string(final_sequence), error);
            lock.lock();
            if (accepted) {
                completed_ = true;
                completion_due_ = false;
            } else if (++completion_attempts_ >= timing_.completion_attempts) {
                completion_due_ = false;
                diagnostic("HUNT GUARD COMPLETION WARN: " + error + " (gave up after " +
                    std::to_string(completion_attempts_) + " attempts)");
            } else {
                if (completion_attempts_ == 1) diagnostic("HUNT GUARD COMPLETION WARN: " + error + " (trying again)");
                next_completion_attempt_ = Clock::now() + std::chrono::seconds(1) * (1u << (completion_attempts_ - 1));
            }
            changed_.notify_all();
            continue;
        }
        // Sleep until the next thing is due, or until enqueue / flush / stop says so.
        std::optional<Clock::time_point> wake;
        const auto earliest = [&wake](Clock::time_point at) { if (!wake || at < *wake) wake = at; };
        if (batch_.has_value()) earliest(next_attempt_);
        else if (!refused_ && !queue_.empty()) earliest(queue_.front().queued_at + timing_.batch_window);
        if (!batch_.has_value() && completion_due_) earliest(next_completion_attempt_);
        if (wake) changed_.wait_until(lock, *wake);
        else changed_.wait(lock);
    }
}

void GuardPublisher::flush_and_stop(std::chrono::milliseconds limit) {
    {
        std::unique_lock lock(mutex_);
        flushing_ = true;
        changed_.notify_all();
        if (limit.count() > 0) changed_.wait_for(lock, limit, [this]() { return idle_locked(); });
        stopping_ = true;
    }
    changed_.notify_all();
    if (thread_.joinable()) thread_.join();
}

GuardPublisherStats GuardPublisher::stats() const {
    std::lock_guard lock(mutex_);
    return stats_;
}

bool GuardPublisher::completed() const {
    std::lock_guard lock(mutex_);
    return completed_;
}

bool GuardPublisher::evidence_incomplete() const {
    std::lock_guard lock(mutex_);
    return incomplete_;
}

} // namespace mystic::bridge
