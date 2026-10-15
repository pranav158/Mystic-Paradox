/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "ice_link.hpp"

#include <juice/juice.h>

#include <algorithm>
#include <array>
#include <charconv>

namespace mystic::bridge {

namespace {

constexpr std::size_t kMaximumReceivedFrames = 512;
constexpr std::size_t kMaximumPendingCandidates = 32;
constexpr std::size_t kMaximumSignalBytes = 4096;

bool StartsWith(std::string_view text, std::string_view prefix) {
    return text.size() >= prefix.size() && text.substr(0, prefix.size()) == prefix;
}

bool IsCandidateLine(std::string_view line) {
    return StartsWith(line, "a=candidate:") || StartsWith(line, "candidate:");
}

bool IsRelayCandidate(std::string_view line) {
    const auto at = line.find(" typ relay");
    return at != std::string_view::npos &&
        (at + 10 == line.size() || line[at + 10] == ' ');
}

bool KeepInRelayOnlyDescription(std::string_view line) {
    return StartsWith(line, "a=ice-ufrag:") || StartsWith(line, "a=ice-pwd:") ||
        StartsWith(line, "a=ice-options:") || line == "a=end-of-candidates";
}

bool ParseHostPort(std::string_view rest, std::string& host, std::uint16_t& port) {
    const auto colon = rest.rfind(':');
    std::string_view host_part = colon == std::string_view::npos ? rest : rest.substr(0, colon);
    std::uint16_t parsed = 3478;
    if (colon != std::string_view::npos) {
        const auto digits = rest.substr(colon + 1);
        const auto [end, code] = std::from_chars(digits.data(), digits.data() + digits.size(), parsed);
        if (code != std::errc{} || end != digits.data() + digits.size() || parsed == 0) return false;
    }
    if (host_part.empty() || host_part.size() > 253 ||
        !std::all_of(host_part.begin(), host_part.end(), [](unsigned char character) {
            return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') || character == '.' || character == '-';
        })) {
        return false;
    }
    host.assign(host_part);
    port = parsed;
    return true;
}

} // namespace

bool ParseStunUrl(std::string_view url, std::string& host, std::uint16_t& port) {
    if (!StartsWith(url, "stun:")) return false;
    return ParseHostPort(url.substr(5), host, port);
}

bool ParseTurnUdpUrl(std::string_view url, std::string& host, std::uint16_t& port) {
    if (!StartsWith(url, "turn:")) return false;
    std::string_view rest = url.substr(5);
    const auto query = rest.find('?');
    if (query != std::string_view::npos) {
        if (rest.substr(query) != "?transport=udp") return false;
        rest = rest.substr(0, query);
    }
    return ParseHostPort(rest, host, port);
}

std::string FilterRelayOnly(std::string_view kind, std::string_view data) {
    if (kind == "GATHERING_DONE") return std::string(data.empty() ? std::string_view("-") : data);
    std::vector<std::string_view> kept;
    std::size_t start = 0;
    while (start <= data.size()) {
        const auto end = data.find('\n', start);
        std::string_view line = data.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.remove_suffix(1);
        while (!line.empty() && line.front() == ' ') line.remove_prefix(1);
        if (!line.empty()) {
            if (IsCandidateLine(line)) {
                if (IsRelayCandidate(line)) kept.push_back(line);
            } else if (kind == "DESCRIPTION" && KeepInRelayOnlyDescription(line)) {
                kept.push_back(line);
            }
        }
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    if (kind == "CANDIDATE") return kept.size() == 1 ? std::string(kept.front()) : std::string{};
    if (std::none_of(kept.begin(), kept.end(), [](std::string_view line) { return StartsWith(line, "a=ice-ufrag:"); })) {
        return {};
    }
    std::string result;
    for (const auto line : kept) {
        result.append(line);
        result.append("\r\n");
    }
    return result;
}

IceLink::IceLink(IceServerConfig servers, bool relay_only, bool is_host)
    : servers_(std::move(servers)), relay_only_(relay_only), is_host_(is_host) {}

IceLink::~IceLink() {
    stop();
}

bool IceLink::start(std::span<const std::uint8_t> pair_key, std::string& error, std::string_view remote_description) {
    error.clear();
    if (agent_) return true;
    if (!cipher_.initialize(pair_key, is_host_, error)) return false;

    std::vector<juice_turn_server_t> turn(servers_.turn_servers.size());
    for (std::size_t index = 0; index < turn.size(); ++index) {
        turn[index].host = servers_.turn_servers[index].host.c_str();
        turn[index].port = servers_.turn_servers[index].port;
        turn[index].username = servers_.turn_servers[index].username.c_str();
        turn[index].password = servers_.turn_servers[index].credential.c_str();
    }
    if (relay_only_ && turn.empty()) {
        error = "relay-only needs a relay server";
        return false;
    }
    juice_config_t config{};
    config.concurrency_mode = JUICE_CONCURRENCY_MODE_POLL;
    config.stun_server_host = servers_.stun_host.empty() ? nullptr : servers_.stun_host.c_str();
    config.stun_server_port = servers_.stun_port;
    config.turn_servers = turn.empty() ? nullptr : turn.data();
    config.turn_servers_count = static_cast<int>(turn.size());
    config.cb_state_changed = [](juice_agent_t* agent, juice_state_t state, void* user) {
        OnStateChanged(agent, static_cast<int>(state), user);
    };
    config.cb_candidate = [](juice_agent_t* agent, const char* sdp, void* user) { OnCandidate(agent, sdp, user); };
    config.cb_gathering_done = [](juice_agent_t* agent, void* user) { OnGatheringDone(agent, user); };
    config.cb_recv = [](juice_agent_t* agent, const char* data, size_t size, void* user) {
        OnReceive(agent, data, size, user);
    };
    config.user_ptr = this;

    agent_ = juice_create(&config);
    if (!agent_) {
        error = "ICE agent creation failed";
        return false;
    }
    if (!remote_description.empty()) {
        std::string remote(remote_description);
        if (relay_only_) remote = FilterRelayOnly("DESCRIPTION", remote);
        if (remote.empty() || remote.size() > kMaximumSignalBytes ||
            juice_set_remote_description(agent_, remote.c_str()) != JUICE_ERR_SUCCESS) {
            stop();
            error = "remote description rejected";
            return false;
        }
        std::lock_guard lock(remote_mutex_);
        remote_description_ = true;
    }
    // The description (credentials only) goes out before gathering; candidates follow one by one.
    std::array<char, JUICE_MAX_SDP_STRING_LEN> description{};
    if (juice_get_local_description(agent_, description.data(), description.size()) != JUICE_ERR_SUCCESS) {
        stop();
        error = "ICE local description unavailable";
        return false;
    }
    std::string local(description.data());
    if (relay_only_) local = FilterRelayOnly("DESCRIPTION", local);
    if (local.empty()) {
        stop();
        error = "ICE local description is empty";
        return false;
    }
    push_signal("DESCRIPTION", std::move(local));
    state_.store(static_cast<int>(LinkState::Gathering));
    if (juice_gather_candidates(agent_) != JUICE_ERR_SUCCESS) {
        stop();
        error = "ICE candidate gathering failed to start";
        return false;
    }
    return true;
}

void IceLink::stop() {
    if (agent_) {
        // juice_destroy returns after the agent's callbacks have stopped.
        juice_destroy(agent_);
        agent_ = nullptr;
    }
    state_.store(static_cast<int>(LinkState::Closed));
}

void IceLink::push_signal(std::string kind, std::string data) {
    std::lock_guard lock(mutex_);
    if (signals_.size() >= 64) return;
    signals_.push_back(IceSignal{ std::move(kind), std::move(data) });
}

std::vector<IceSignal> IceLink::take_signals() {
    std::lock_guard lock(mutex_);
    std::vector<IceSignal> result(std::make_move_iterator(signals_.begin()), std::make_move_iterator(signals_.end()));
    signals_.clear();
    return result;
}

bool IceLink::has_remote_description() const {
    std::lock_guard lock(remote_mutex_);
    return remote_description_;
}

bool IceLink::apply_remote_signal(std::string_view kind, std::string_view data, std::string& error) {
    error.clear();
    if (!agent_) {
        error = "link is closed";
        return false;
    }
    if (data.size() > kMaximumSignalBytes) {
        error = "signal too large";
        return false;
    }
    std::string text(data);
    if (relay_only_ && kind != "GATHERING_DONE") {
        text = FilterRelayOnly(kind, data);
        // A non-relay candidate is not an error: it is simply never used.
        if (text.empty()) return kind == "CANDIDATE";
    }
    // remote_mutex_, never mutex_: the juice_* calls below take libjuice's registry lock (see ice_link.hpp).
    std::lock_guard lock(remote_mutex_);
    if (kind == "DESCRIPTION") {
        if (remote_description_) {
            error = "remote description already set";
            return false;
        }
        if (juice_set_remote_description(agent_, text.c_str()) != JUICE_ERR_SUCCESS) {
            error = "remote description rejected";
            return false;
        }
        remote_description_ = true;
        for (const auto& candidate : pending_candidates_) (void)juice_add_remote_candidate(agent_, candidate.c_str());
        pending_candidates_.clear();
        if (pending_gathering_done_) (void)juice_set_remote_gathering_done(agent_);
        pending_gathering_done_ = false;
        return true;
    }
    if (kind == "CANDIDATE") {
        if (!remote_description_) {
            if (pending_candidates_.size() >= kMaximumPendingCandidates) {
                error = "too many early candidates";
                return false;
            }
            pending_candidates_.push_back(std::move(text));
            return true;
        }
        if (juice_add_remote_candidate(agent_, text.c_str()) != JUICE_ERR_SUCCESS) {
            error = "remote candidate rejected";
            return false;
        }
        return true;
    }
    if (kind == "GATHERING_DONE") {
        if (!remote_description_) pending_gathering_done_ = true;
        else (void)juice_set_remote_gathering_done(agent_);
        return true;
    }
    error = "unknown signal kind";
    return false;
}

bool IceLink::send(FrameType type, std::span<const std::uint8_t> payload) {
    if (!agent_ || !connected() || type == FrameType::Fragment || payload.empty()) {
        ++send_failures_;
        return false;
    }
    if (payload.size() <= kFragmentPayload) return send_sealed(type, payload);
    const std::size_t count = (payload.size() + kFragmentPayload - 1) / kFragmentPayload;
    if (count > kMaximumFragments) {
        ++send_failures_;
        return false;
    }
    // Piece: inner type, message id (big-endian), index, count, then the bytes - all inside the sealed frame.
    const std::uint16_t message = next_message_id_.fetch_add(1);
    bool all_sent = true;
    std::vector<std::uint8_t> piece;
    for (std::size_t index = 0; index < count; ++index) {
        const std::size_t offset = index * kFragmentPayload;
        const std::size_t size = (std::min)(kFragmentPayload, payload.size() - offset);
        piece.assign({ static_cast<std::uint8_t>(type), static_cast<std::uint8_t>(message >> 8),
            static_cast<std::uint8_t>(message & 0xff), static_cast<std::uint8_t>(index), static_cast<std::uint8_t>(count) });
        piece.insert(piece.end(), payload.begin() + static_cast<std::ptrdiff_t>(offset),
            payload.begin() + static_cast<std::ptrdiff_t>(offset + size));
        all_sent = send_sealed(FrameType::Fragment, piece) && all_sent;
    }
    return all_sent;
}

bool IceLink::send_sealed(FrameType type, std::span<const std::uint8_t> payload) {
    const auto frame = cipher_.seal(type, payload);
    if (frame.empty() ||
        juice_send(agent_, reinterpret_cast<const char*>(frame.data()), frame.size()) != JUICE_ERR_SUCCESS) {
        ++send_failures_;
        return false;
    }
    ++frames_sent_;
    return true;
}

std::vector<IceLink::Received> IceLink::take_received(std::size_t maximum) {
    std::lock_guard lock(mutex_);
    std::vector<Received> result;
    while (!received_.empty() && result.size() < maximum) {
        result.push_back(std::move(received_.front()));
        received_.pop_front();
    }
    return result;
}

bool IceLink::connected() const {
    const auto state = this->state();
    return state == LinkState::Connected;
}

bool IceLink::relayed() const {
    if (!agent_ || !connected()) return false;
    std::array<char, JUICE_MAX_CANDIDATE_SDP_STRING_LEN> local{};
    std::array<char, JUICE_MAX_CANDIDATE_SDP_STRING_LEN> remote{};
    if (juice_get_selected_candidates(agent_, local.data(), local.size(), remote.data(), remote.size()) !=
        JUICE_ERR_SUCCESS) {
        return false;
    }
    return IsRelayCandidate(local.data()) || IsRelayCandidate(remote.data());
}

std::string IceLink::selected_types() const {
    if (!agent_ || !connected()) return {};
    std::array<char, JUICE_MAX_CANDIDATE_SDP_STRING_LEN> local{};
    std::array<char, JUICE_MAX_CANDIDATE_SDP_STRING_LEN> remote{};
    if (juice_get_selected_candidates(agent_, local.data(), local.size(), remote.data(), remote.size()) !=
        JUICE_ERR_SUCCESS) {
        return {};
    }
    const auto type_of = [](std::string_view line) {
        const auto at = line.find(" typ ");
        if (at == std::string_view::npos) return std::string("unknown");
        const auto rest = line.substr(at + 5);
        return std::string(rest.substr(0, rest.find(' ')));
    };
    return "local=" + type_of(local.data()) + " remote=" + type_of(remote.data());
}

LinkStats IceLink::stats() const {
    return LinkStats{ frames_sent_.load(), send_failures_.load(), frames_received_.load(),
        frames_rejected_.load(), queue_drops_.load() };
}

void IceLink::OnStateChanged(juice_agent* agent, int state, void* user) {
    (void)agent;
    auto* self = static_cast<IceLink*>(user);
    LinkState mapped = LinkState::Connecting;
    switch (static_cast<juice_state_t>(state)) {
    case JUICE_STATE_GATHERING: mapped = LinkState::Gathering; break;
    case JUICE_STATE_CONNECTING: mapped = LinkState::Connecting; break;
    case JUICE_STATE_CONNECTED:
    case JUICE_STATE_COMPLETED: mapped = LinkState::Connected; break;
    case JUICE_STATE_FAILED: mapped = LinkState::Failed; break;
    // DISCONNECTED is libjuice's initial state; a lost connection is reported as FAILED.
    case JUICE_STATE_DISCONNECTED: return;
    default: break;
    }
    self->state_.store(static_cast<int>(mapped));
}

void IceLink::OnCandidate(juice_agent* agent, const char* sdp, void* user) {
    (void)agent;
    auto* self = static_cast<IceLink*>(user);
    if (!sdp) return;
    std::string candidate(sdp);
    if (self->relay_only_) candidate = FilterRelayOnly("CANDIDATE", candidate);
    if (!candidate.empty()) self->push_signal("CANDIDATE", std::move(candidate));
}

void IceLink::OnGatheringDone(juice_agent* agent, void* user) {
    (void)agent;
    static_cast<IceLink*>(user)->push_signal("GATHERING_DONE", "-");
}

void IceLink::OnReceive(juice_agent* agent, const char* data, std::size_t size, void* user) {
    (void)agent;
    auto* self = static_cast<IceLink*>(user);
    FrameType type = FrameType::Gameplay;
    std::vector<std::uint8_t> payload;
    if (!data || !self->cipher_.open(std::span(reinterpret_cast<const std::uint8_t*>(data), size), type, payload)) {
        ++self->frames_rejected_;
        return;
    }
    ++self->frames_received_;
    std::lock_guard lock(self->mutex_);
    Received message{ type, std::move(payload) };
    if (type == FrameType::Fragment) {
        Received whole;
        if (!self->add_fragment(message.payload, whole)) return;
        message = std::move(whole);
    }
    if (self->received_.size() >= kMaximumReceivedFrames) {
        ++self->queue_drops_;
        return;
    }
    self->received_.push_back(std::move(message));
}

bool IceLink::add_fragment(std::span<const std::uint8_t> fragment, Received& whole) {
    constexpr std::size_t kHeader = 5;
    constexpr std::size_t kMaximumPartials = 32;
    constexpr auto kReassemblyWindow = std::chrono::seconds(1);
    if (fragment.size() <= kHeader) return false;
    const std::uint8_t inner = fragment[0];
    const std::uint16_t message = static_cast<std::uint16_t>((fragment[1] << 8) | fragment[2]);
    const std::uint8_t index = fragment[3];
    const std::uint8_t count = fragment[4];
    if ((inner != static_cast<std::uint8_t>(FrameType::Control) && inner != static_cast<std::uint8_t>(FrameType::Gameplay)) ||
        count < 2 || count > kMaximumFragments || index >= count) {
        ++frames_rejected_;
        return false;
    }
    const auto now = std::chrono::steady_clock::now();
    for (auto it = partials_.begin(); it != partials_.end();) {
        it = now - it->second.started > kReassemblyWindow ? partials_.erase(it) : std::next(it);
    }
    auto found = partials_.find(message);
    if (found == partials_.end()) {
        if (partials_.size() >= kMaximumPartials) {
            const auto oldest = std::min_element(partials_.begin(), partials_.end(),
                [](const auto& left, const auto& right) { return left.second.started < right.second.started; });
            partials_.erase(oldest);
            ++queue_drops_;
        }
        Partial partial;
        partial.type = static_cast<FrameType>(inner);
        partial.count = count;
        partial.started = now;
        found = partials_.emplace(message, std::move(partial)).first;
    } else if (found->second.count != count || found->second.type != static_cast<FrameType>(inner)) {
        // A reused id from an abandoned message: start over with this one.
        found->second = Partial{ static_cast<FrameType>(inner), count, 0, {}, now };
    }
    Partial& partial = found->second;
    const auto bit = static_cast<std::uint8_t>(1u << index);
    if ((partial.received_mask & bit) != 0) return false;
    partial.received_mask = static_cast<std::uint8_t>(partial.received_mask | bit);
    partial.parts[index].assign(fragment.begin() + kHeader, fragment.end());
    if (partial.received_mask != static_cast<std::uint8_t>((1u << count) - 1u)) return false;
    whole.type = partial.type;
    whole.payload.clear();
    for (std::size_t part = 0; part < count; ++part) {
        whole.payload.insert(whole.payload.end(), partial.parts[part].begin(), partial.parts[part].end());
    }
    partials_.erase(found);
    return true;
}

} // namespace mystic::bridge
