/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "transport_module.hpp"

#include "pair_crypto.hpp"

#include <Windows.h>
#include <bcrypt.h>
#include <juice/juice.h>

#include <algorithm>
#include <cstring>
#include <exception>
#include <vector>

namespace mystic::bridge {

namespace {

constexpr std::size_t kMaximumDiagnostics = 256;
// A hub restart can bring up to 64 joiners (each a handful of signals) in one burst before the launcher drains.
constexpr std::size_t kMaximumSignals = 2048;
constexpr std::size_t kMaximumEvents = 256;
constexpr std::size_t kMaximumSignalBytes = 4096;
constexpr std::size_t kMaximumQueuedCommands = 256;
// Ended or stopped sessions kept readable for the launcher's last reads.
constexpr std::size_t kMaximumRetainedSessions = 8;

void Copy(char* buffer, std::uint32_t capacity, std::string_view text) {
    if (!buffer || capacity == 0) return;
    const std::size_t length = (std::min)(text.size(), static_cast<std::size_t>(capacity - 1));
    std::memcpy(buffer, text.data(), length);
    buffer[length] = '\0';
}

std::filesystem::path Utf8Path(const char* value) {
    if (!value || *value == '\0') return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, nullptr, 0);
    if (required <= 0) return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, wide.data(), required) != required) return {};
    wide.resize(static_cast<std::size_t>(required - 1));
    return std::filesystem::path(wide);
}

template <typename T>
void PushBounded(std::deque<T>& queue, T value, std::size_t maximum) {
    if (queue.size() >= maximum) queue.pop_front();
    queue.push_back(std::move(value));
}

bool SafeAccount(std::string_view value) {
    return !value.empty() && value.size() <= 64 && std::all_of(value.begin(), value.end(), [](unsigned char character) {
        return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') || character == '-';
    });
}

bool SafeSignalData(std::string_view value) {
    return value.size() <= kMaximumSignalBytes && std::all_of(value.begin(), value.end(), [](unsigned char character) {
        return (character >= 0x20 && character < 0x7f) || character == '\r' || character == '\n';
    });
}

} // namespace

TransportModule::TransportModule(AdmissionClientFactory admission_factory)
    : admission_factory_(std::move(admission_factory)) {}

TransportModule::~TransportModule() {
    shutdown();
}

bool TransportModule::initialize(std::string& error) {
    error.clear();
    // libjuice's own log lines can contain addresses; this module reports only its bounded diagnostics.
    juice_set_log_level(JUICE_LOG_LEVEL_NONE);
    if (peer_id_.load() == 0) {
        std::uint64_t value = 0;
        while (value == 0) {
            if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&value), sizeof(value),
                    BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
                error = "The co-op transport could not create its identity.";
                return false;
            }
        }
        peer_id_.store(value);
    }
    return true;
}

TransportObserver TransportModule::make_observer(Session& session) {
    TransportObserver observer;
    Session* self = &session;
    observer.ready = [self](std::string_view line) {
        std::lock_guard lock(self->mutex);
        self->ready = true;
        self->ready_line.assign(line);
        self->changed.notify_all();
    };
    observer.failure = [self](std::string_view code) {
        std::lock_guard lock(self->mutex);
        PushBounded(self->diagnostics, "SESSION_FAILURE code=" + std::string(code.substr(0, 96)), kMaximumDiagnostics);
    };
    observer.diagnostic = [self](std::string_view line) {
        std::lock_guard lock(self->mutex);
        PushBounded(self->diagnostics, std::string(line.substr(0, 1023)), kMaximumDiagnostics);
    };
    observer.signal = [self](std::string_view to, std::string_view kind, std::string_view data) {
        std::lock_guard lock(self->mutex);
        if (self->outgoing.size() >= kMaximumSignals) {
            // A dropped signal fails that joiner's attempt: say so (on the 1st, 2nd, 4th ... drop, to stay bounded).
            if ((++self->dropped_signals & (self->dropped_signals - 1)) == 0) {
                PushBounded(self->diagnostics, std::string("SIGNAL_DROPPED reason=outbox_full"), kMaximumDiagnostics);
            }
            return;
        }
        self->outgoing.push_back(OutgoingSignal{ std::string(to), std::string(kind), std::string(data) });
    };
    observer.peer_event = [self](std::string_view line) {
        std::lock_guard lock(self->mutex);
        PushBounded(self->events, std::string(line.substr(0, 255)), kMaximumEvents);
    };
    observer.take_inbound_signals = [self]() {
        std::lock_guard lock(self->mutex);
        std::vector<InboundSignal> result(std::make_move_iterator(self->incoming.begin()),
            std::make_move_iterator(self->incoming.end()));
        self->incoming.clear();
        return result;
    };
    observer.stop_requested = [self]() { return self->stop.load(); };
    observer.peers_configured = [self](std::size_t maximum_peers, const std::vector<IcePeerConfig>& peers) {
        std::lock_guard lock(self->mutex);
        self->roster_limit = maximum_peers;
        // The session's own roster is the truth, also over an AddPeerH that raced the start.
        for (const IcePeerConfig& peer : peers) self->roster[peer.account_id] = peer.peer_id;
    };
    observer.take_peer_commands = [self]() {
        std::lock_guard lock(self->mutex);
        std::vector<PeerCommand> result(std::make_move_iterator(self->commands.begin()),
            std::make_move_iterator(self->commands.end()));
        self->commands.clear();
        return result;
    };
    observer.peer_add_rejected = [self](std::string_view account_id, std::string_view reason) {
        // A refused add leaves the account off the roster, except when the session already had it (a duplicate).
        if (reason == "duplicate_account") return;
        std::lock_guard lock(self->mutex);
        self->roster.erase(std::string(account_id));
    };
    return observer;
}

void TransportModule::join_thread(Session& session) {
    std::lock_guard lock(session.join_mutex);
    if (session.thread.joinable()) session.thread.join();
    session.running.store(false);
}

bool TransportModule::drained(Session& session) {
    std::lock_guard lock(session.mutex);
    return session.diagnostics.empty() && session.outgoing.empty() && session.events.empty();
}

// Registry lock held. Ended sessions leave once drained, and only the newest few stay otherwise.
void TransportModule::drop_idle_sessions_locked() {
    std::vector<int> kept;
    for (auto it = sessions_.begin(); it != sessions_.end();) {
        Session& session = *it->second;
        if (session.running.load()) {
            ++it;
            continue;
        }
        join_thread(session);
        if (drained(session)) {
            it = sessions_.erase(it);
        } else {
            kept.push_back(it->first);
            ++it;
        }
    }
    for (std::size_t index = 0; kept.size() - index > kMaximumRetainedSessions; ++index) sessions_.erase(kept[index]);
}

std::shared_ptr<TransportModule::Session> TransportModule::find(int handle) {
    std::lock_guard lock(mutex_);
    const auto found = sessions_.find(handle);
    return found == sessions_.end() ? nullptr : found->second;
}

template <typename Run>
int TransportModule::open_session(bool host, Run run, char* error_buffer, std::uint32_t error_buffer_size) {
    auto session = std::make_shared<Session>();
    session->host = host;
    std::lock_guard lock(mutex_);
    drop_idle_sessions_locked();
    const auto live = std::count_if(sessions_.begin(), sessions_.end(),
        [](const auto& entry) { return entry.second->running.load(); });
    if (live >= kMaximumSessions) {
        Copy(error_buffer, error_buffer_size, "At most 8 co-op sessions can run at once.");
        return 0;
    }
    session->handle = next_handle_;
    session->running.store(true);
    Session* self = session.get();
    try {
        // The registry keeps the session alive until its thread is joined (see drop_idle_sessions_locked).
        self->thread = std::thread([self, run]() {
            int result = 3;
            try {
                result = run(make_observer(*self));
            } catch (const std::exception&) {
                std::lock_guard lock(self->mutex);
                PushBounded(self->diagnostics, std::string("SESSION_FAILURE code=exception"), kMaximumDiagnostics);
            } catch (...) {
                std::lock_guard lock(self->mutex);
                PushBounded(self->diagnostics, std::string("SESSION_FAILURE code=exception"), kMaximumDiagnostics);
            }
            std::lock_guard lock(self->mutex);
            self->last_result = result;
            if (!self->ready) self->ended_before_ready = true;
            self->running.store(false);
            self->changed.notify_all();
        });
    } catch (...) {
        Copy(error_buffer, error_buffer_size, "The co-op session thread could not start.");
        return 0;
    }
    ++next_handle_;
    sessions_.emplace(session->handle, session);
    return session->handle;
}

int TransportModule::host_open(const char* public_key_path, const char* config_path, const char* capability_path,
    const char* host_ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    const auto key = Utf8Path(public_key_path);
    const auto config = Utf8Path(config_path);
    const auto capability = Utf8Path(capability_path);
    const auto ticket = Utf8Path(host_ticket_path);   // empty: a host with host_local_client=0
    const auto secrets = Utf8Path(secrets_path);
    if (key.empty() || config.empty() || capability.empty() || secrets.empty()) {
        Copy(error_buffer, error_buffer_size, "A co-op host input path is missing.");
        return 0;
    }
    return open_session(true, [this, key, config, capability, ticket, secrets](const TransportObserver& observer) {
        return RunIceHost(key, config, capability, ticket, secrets, observer, admission_factory_);
    }, error_buffer, error_buffer_size);
}

int TransportModule::join_open(const char* public_key_path, const char* config_path, const char* ticket_path,
    const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    const auto key = Utf8Path(public_key_path);
    const auto config = Utf8Path(config_path);
    const auto ticket = Utf8Path(ticket_path);
    const auto secrets = Utf8Path(secrets_path);
    if (key.empty() || config.empty() || ticket.empty() || secrets.empty()) {
        Copy(error_buffer, error_buffer_size, "A co-op join input path is missing.");
        return 0;
    }
    return open_session(false, [key, config, ticket, secrets](const TransportObserver& observer) {
        return RunIceJoin(key, config, ticket, secrets, observer);
    }, error_buffer, error_buffer_size);
}

int TransportModule::wait_ready(int handle, std::uint32_t timeout_ms, char* ready_buffer,
    std::uint32_t ready_buffer_size) {
    const auto session = find(handle);
    if (!session) return -1;
    std::unique_lock lock(session->mutex);
    session->changed.wait_for(lock, std::chrono::milliseconds(timeout_ms),
        [&session]() { return session->ready || session->ended_before_ready; });
    if (session->ready) {
        Copy(ready_buffer, ready_buffer_size, session->ready_line);
        return 1;
    }
    return session->ended_before_ready ? -1 : 0;
}

int TransportModule::session_running(int handle) {
    const auto session = find(handle);
    return session && session->running.load() ? 1 : 0;
}

int TransportModule::stop_session(int handle) {
    const auto session = find(handle);
    if (!session) return 0;
    session->stop.store(true);
    join_thread(*session);
    return 1;
}

int TransportModule::last_session_result(int handle) {
    const auto session = find(handle);
    if (!session) return -1;
    std::lock_guard lock(session->mutex);
    return session->last_result;
}

int TransportModule::read_diagnostic(int handle, char* diagnostic_buffer, std::uint32_t diagnostic_buffer_size) {
    const auto session = find(handle);
    if (!session) return 0;
    std::lock_guard lock(session->mutex);
    if (session->diagnostics.empty()) return 0;
    Copy(diagnostic_buffer, diagnostic_buffer_size, session->diagnostics.front());
    session->diagnostics.pop_front();
    return 1;
}

int TransportModule::read_signal(int handle, char* to_account_buffer, std::uint32_t to_account_size,
    char* kind_buffer, std::uint32_t kind_size, char* data_buffer, std::uint32_t data_size) {
    const auto session = find(handle);
    if (!session) return 0;
    std::lock_guard lock(session->mutex);
    if (session->outgoing.empty()) return 0;
    const OutgoingSignal& signal = session->outgoing.front();
    if (!to_account_buffer || !kind_buffer || !data_buffer || to_account_size <= signal.to_account_id.size() ||
        kind_size <= signal.kind.size() || data_size <= signal.data.size()) {
        return -1;
    }
    Copy(to_account_buffer, to_account_size, signal.to_account_id);
    Copy(kind_buffer, kind_size, signal.kind);
    Copy(data_buffer, data_size, signal.data);
    session->outgoing.pop_front();
    return 1;
}

int TransportModule::submit_signal(int handle, const char* from_account_id, const char* kind, const char* data) {
    if (!from_account_id || !kind || !data) return 0;
    const std::string_view from(from_account_id);
    const std::string_view kind_text(kind);
    const std::string_view data_text(data);
    if (!SafeAccount(from) || (kind_text != "DESCRIPTION" && kind_text != "CANDIDATE" && kind_text != "GATHERING_DONE") ||
        !SafeSignalData(data_text)) {
        return 0;
    }
    const auto session = find(handle);
    if (!session || !session->running.load()) return 0;
    std::lock_guard lock(session->mutex);
    if (session->incoming.size() >= kMaximumSignals) return 0;
    session->incoming.push_back(InboundSignal{ std::string(from), std::string(kind_text), std::string(data_text) });
    return 1;
}

int TransportModule::read_peer_event(int handle, char* event_buffer, std::uint32_t event_buffer_size) {
    const auto session = find(handle);
    if (!session) return 0;
    std::lock_guard lock(session->mutex);
    if (session->events.empty()) return 0;
    Copy(event_buffer, event_buffer_size, session->events.front());
    session->events.pop_front();
    return 1;
}

int TransportModule::add_peer(int handle, const char* account_id, std::uint64_t peer_id, const char* pair_key_base64url) {
    if (!account_id || !pair_key_base64url || peer_id == 0) return 0;
    const std::string_view account(account_id);
    IcePeerConfig peer;
    if (!SafeAccount(account) || !PairCipher::DecodeKey(pair_key_base64url, peer.key)) return 0;
    peer.account_id.assign(account);
    peer.peer_id = peer_id;
    const auto session = find(handle);
    int result = 0;
    if (session && session->host && session->running.load()) {
        std::lock_guard lock(session->mutex);
        const bool duplicate = session->roster.contains(peer.account_id) ||
            std::any_of(session->roster.begin(), session->roster.end(),
                [peer_id](const auto& entry) { return entry.second == peer_id; });
        if (!duplicate && session->roster.size() < session->roster_limit &&
            session->commands.size() < kMaximumQueuedCommands) {
            session->roster.emplace(peer.account_id, peer_id);
            session->commands.push_back(PeerCommand{ PeerCommand::Kind::Add, peer, {} });
            result = 1;
        }
    }
    SecureZeroMemory(peer.key.data(), peer.key.size());
    return result;
}

int TransportModule::remove_peer(int handle, const char* account_id, const char* reason) {
    if (!account_id) return 0;
    const std::string_view account(account_id);
    if (!SafeAccount(account)) return 0;
    const auto session = find(handle);
    if (!session || !session->host || !session->running.load()) return 0;
    std::lock_guard lock(session->mutex);
    const auto found = session->roster.find(std::string(account));
    if (found == session->roster.end() || session->commands.size() >= kMaximumQueuedCommands) return 0;
    session->roster.erase(found);
    PeerCommand command;
    command.kind = PeerCommand::Kind::Remove;
    command.peer.account_id.assign(account);
    if (reason) command.reason.assign(std::string_view(reason).substr(0, 48));
    session->commands.push_back(std::move(command));
    return 1;
}

void TransportModule::shutdown() {
    std::vector<std::shared_ptr<Session>> all;
    {
        std::lock_guard lock(mutex_);
        for (const auto& entry : sessions_) all.push_back(entry.second);
    }
    for (const auto& session : all) session->stop.store(true);
    for (const auto& session : all) join_thread(*session);
}

// ---- ABI 2 on the default handle ----------------------------------------------------------------------------------

int TransportModule::start_host_v2(const char* public_key_path, const char* config_path, const char* capability_path,
    const char* host_ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    // Version 2 hosts always play their own client, so the ticket path is required.
    if (!host_ticket_path || *host_ticket_path == '\0') {
        Copy(error_buffer, error_buffer_size, "A co-op host input path is missing.");
        return 0;
    }
    std::lock_guard default_lock(default_mutex_);
    if (const auto previous = find(default_handle_.load())) {
        if (previous->running.load()) {
            Copy(error_buffer, error_buffer_size, "A co-op session is already running.");
            return 0;
        }
        std::lock_guard lock(mutex_);
        join_thread(*previous);
        sessions_.erase(previous->handle);
    }
    const int handle = host_open(public_key_path, config_path, capability_path, host_ticket_path, secrets_path,
        error_buffer, error_buffer_size);
    if (handle == 0) return 0;
    default_handle_.store(handle);
    return 1;
}

int TransportModule::start_join_v2(const char* public_key_path, const char* config_path, const char* ticket_path,
    const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size) {
    std::lock_guard default_lock(default_mutex_);
    if (const auto previous = find(default_handle_.load())) {
        if (previous->running.load()) {
            Copy(error_buffer, error_buffer_size, "A co-op session is already running.");
            return 0;
        }
        std::lock_guard lock(mutex_);
        join_thread(*previous);
        sessions_.erase(previous->handle);
    }
    const int handle = join_open(public_key_path, config_path, ticket_path, secrets_path, error_buffer,
        error_buffer_size);
    if (handle == 0) return 0;
    default_handle_.store(handle);
    return 1;
}

} // namespace mystic::bridge
