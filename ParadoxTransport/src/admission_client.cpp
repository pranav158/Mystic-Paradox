/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
#include "admission_client.hpp"

#include <Windows.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <regex>

namespace mystic::bridge {

namespace {

std::wstring Wide(std::string_view value) {
    if (value.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring result(static_cast<std::size_t>(needed), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), needed) != needed) return {};
    return result;
}

bool SafeToken(std::string_view value, std::size_t maximum, std::string_view extra) {
    return !value.empty() && value.size() <= maximum &&
        std::all_of(value.begin(), value.end(), [extra](unsigned char character) {
            return (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') || extra.find(static_cast<char>(character)) != std::string_view::npos;
        });
}

class Handle final {
public:
    explicit Handle(HINTERNET value = nullptr) : value_(value) {}
    ~Handle() { if (value_) WinHttpCloseHandle(value_); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    [[nodiscard]] HINTERNET get() const { return value_; }
    [[nodiscard]] explicit operator bool() const { return value_ != nullptr; }
private:
    HINTERNET value_ = nullptr;
};

} // namespace

WinHttpAdmissionClient::~WinHttpAdmissionClient() {
    reset();
}

void WinHttpAdmissionClient::reset() {
    if (session_) WinHttpCloseHandle(static_cast<HINTERNET>(session_));
    session_ = nullptr;
    if (!capability_.empty()) SecureZeroMemory(capability_.data(), capability_.size());
    capability_.clear();
    host_.clear();
    base_path_.clear();
    port_ = 0;
}

bool WinHttpAdmissionClient::initialize(std::string_view base_url,
    std::string host_capability, std::string& error) {
    reset();
    error.clear();
    if (!SafeToken(host_capability, 43, "_-") || host_capability.size() != 43) {
        error = "host capability must be a 32-byte base64url secret";
        return false;
    }
    const std::wstring url = Wide(base_url);
    if (url.empty()) {
        error = "invalid admission backend URL";
        return false;
    }
    URL_COMPONENTS components{};
    components.dwStructSize = sizeof(components);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwUserNameLength = static_cast<DWORD>(-1);
    components.dwPasswordLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &components) ||
        components.nScheme != INTERNET_SCHEME_HTTPS || components.dwHostNameLength == 0 ||
        components.dwUserNameLength != 0 || components.dwPasswordLength != 0 ||
        components.dwExtraInfoLength != 0) {
        error = "admission backend must be an HTTPS origin without credentials, query, or fragment";
        return false;
    }
    host_.assign(components.lpszHostName, components.dwHostNameLength);
    base_path_.assign(components.lpszUrlPath, components.dwUrlPathLength);
    while (!base_path_.empty() && base_path_.back() == L'/') base_path_.pop_back();
    port_ = components.nPort;
    HINTERNET opened = WinHttpOpen(L"ParadoxTransport/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!opened) {
        error = "WinHTTP session initialization failed";
        reset();
        return false;
    }
    session_ = opened;
    WinHttpSetTimeouts(opened, 5000, 5000, 5000, 5000);
    capability_ = std::move(host_capability);
    return true;
}

WinHttpAdmissionClient::HttpResult WinHttpAdmissionClient::post(std::string_view path,
    std::string_view body, std::string_view request_id) const {
    HttpResult result;
    if (!session_ || !SafeToken(path, 512, "._:/-") ||
        !SafeToken(request_id, 96, "._:-") || body.size() > 8192) {
        result.error = "invalid admission HTTP request";
        return result;
    }
    Handle connection(WinHttpConnect(static_cast<HINTERNET>(session_), host_.c_str(), port_, 0));
    const std::wstring full_path = base_path_ + Wide(path);
    Handle request(connection ? WinHttpOpenRequest(connection.get(), L"POST", full_path.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr);
    if (!connection || !request) {
        result.error = "admission backend connection setup failed";
        return result;
    }
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS;
    WinHttpSetOption(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled));
    const std::wstring headers = L"Content-Type: application/json\r\nX-Mystic-Host-Capability: " +
        Wide(capability_) + L"\r\nX-MysticParadox-Request-Id: " + Wide(request_id) + L"\r\n";
    if (!WinHttpSendRequest(request.get(), headers.c_str(), static_cast<DWORD>(headers.size()),
        const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
        static_cast<DWORD>(body.size()), 0) || !WinHttpReceiveResponse(request.get(), nullptr)) {
        result.error = "admission backend request failed";
        return result;
    }
    DWORD status_size = sizeof(result.status);
    if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &result.status, &status_size, WINHTTP_NO_HEADER_INDEX)) {
        result.error = "admission backend returned no status";
        return result;
    }
    constexpr std::size_t maximum_response = 16 * 1024;
    while (result.body.size() < maximum_response) {
        std::array<char, 2048> buffer{};
        DWORD received = 0;
        if (!WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &received)) {
            result.error = "admission backend response read failed";
            return result;
        }
        if (received == 0) break;
        if (result.body.size() + received > maximum_response) {
            result.error = "admission backend response exceeded limit";
            result.body.clear();
            return result;
        }
        result.body.append(buffer.data(), received);
    }
    return result;
}

AdmissionConsumeResult WinHttpAdmissionClient::consume(const AdmissionConsumeRequest& request) {
    AdmissionConsumeResult result;
    if (!SafeToken(request.session_id, 64, "-") || !SafeToken(request.ticket, 4096, "._-") ||
        !SafeToken(request.bridge_instance_id, 96, "._:-") ||
        !SafeToken(request.connection_handle, 32, "") || request.authenticated_steam_id == 0) {
        result.code = "invalid_request";
        return result;
    }
    const std::string body = "{\"ticket\":\"" + request.ticket +
        "\",\"authenticatedSteamId\":\"" + std::to_string(request.authenticated_steam_id) +
        "\",\"bridgeInstanceId\":\"" + request.bridge_instance_id +
        "\",\"connectionHandle\":\"" + request.connection_handle + "\"}";
    const HttpResult response = post("/mystic/v1/hunts/" + request.session_id +
        "/tickets/consume", body, request.request_id);
    if (!response.error.empty()) {
        result.code = "backend_unavailable";
        return result;
    }
    if (response.status != 200) {
        result.code = "backend_http_" + std::to_string(response.status);
        return result;
    }
    static const std::regex admission_pattern("\\\"admissionId\\\":\\\"([a-f0-9]{64})\\\"");
    std::smatch match;
    if (response.body.find("\"admitted\":true") == std::string::npos ||
        !std::regex_search(response.body, match, admission_pattern)) {
        result.code = "malformed_backend_response";
        return result;
    }
    result.admitted = true;
    result.idempotent = response.body.find("\"idempotent\":true") != std::string::npos;
    result.admission_id = match[1].str();
    result.code = "ok";
    return result;
}

bool WinHttpAdmissionClient::publish_host_ready(const HostReadyRequest& request,
    std::string& error) {
    error.clear();
    if (!SafeToken(request.session_id, 64, "-") ||
        !SafeToken(request.bridge_instance_id, 96, "._:-") || request.virtual_port == 0) {
        error = "invalid host-ready request";
        return false;
    }
    const std::string body = "{\"transport\":\"ICE\",\"virtualPort\":" + std::to_string(request.virtual_port) +
        ",\"bridgeInstanceId\":\"" + request.bridge_instance_id + "\"}";
    const HttpResult response = post("/mystic/v1/hunts/" + request.session_id +
        "/host-ready", body, request.request_id);
    if (!response.error.empty()) {
        error = response.error;
        return false;
    }
    if (response.status != 200 || response.body.find("\"ready\":true") == std::string::npos) {
        error = "host-ready backend rejected the active generation (HTTP " +
            std::to_string(response.status) + ')';
        return false;
    }
    return true;
}

bool WinHttpAdmissionClient::publish_heartbeat(const HostHeartbeatRequest& request,
    std::string& error) {
    error.clear();
    // A hub host holds up to 64 peers (session_role=HUB); the backend applies the per-kind limit.
    if (!SafeToken(request.session_id, 64, "-") || request.lease_sequence == 0 ||
        request.admitted_peer_count > 64 || request.queue_pressure > 100) {
        error = "invalid host heartbeat";
        return false;
    }
    const std::string body = "{\"leaseSequence\":" + std::to_string(request.lease_sequence) +
        ",\"bridgeAlive\":" + (request.bridge_alive ? "true" : "false") +
        ",\"serverReady\":" + (request.server_ready ? "true" : "false") +
        ",\"admittedPeerCount\":" + std::to_string(request.admitted_peer_count) +
        ",\"queuePressure\":" + std::to_string(request.queue_pressure) + "}";
    const HttpResult response = post("/mystic/v1/hunts/" + request.session_id +
        "/lease", body, request.request_id);
    if (!response.error.empty()) {
        error = response.error;
        return false;
    }
    if (response.status != 200 || response.body.find("\"renewed\":true") == std::string::npos) {
        error = "host heartbeat rejected active generation (HTTP " +
            std::to_string(response.status) + ')';
        return false;
    }
    return true;
}

GuardEventBatchResult WinHttpAdmissionClient::publish_guard_event(const GuardEventBatchRequest& request) {
    GuardEventBatchResult result;
    if (!SafeToken(request.session_id, 64, "-") || !SafeToken(request.batch_id, 64, "-") ||
        !SafeToken(request.previous_hash, 64, "") || request.previous_hash.size() != 64 ||
        !SafeToken(request.event_type, 64, "_") || request.sequence == 0 ||
        (!request.actor_account_id.empty() && !SafeToken(request.actor_account_id, 96, "._:-")) ||
        request.payload_json.empty() || request.payload_json.size() > 4096 ||
        request.payload_json.front() != '{' || request.payload_json.back() != '}') {
        result.error = "invalid Guard event batch";
        return result;
    }
    const std::string actor = request.actor_account_id.empty() ? "" :
        ",\"actorAccountId\":\"" + request.actor_account_id + "\"";
    const std::string body = "{\"schema\":1,\"batchId\":\"" + request.batch_id +
        "\",\"firstSequence\":" + std::to_string(request.sequence) +
        ",\"lastSequence\":" + std::to_string(request.sequence) +
        ",\"previousHash\":\"" + request.previous_hash + "\",\"events\":[{\"sequence\":" +
        std::to_string(request.sequence) + ",\"monotonicMs\":" + std::to_string(request.monotonic_ms) +
        ",\"type\":\"" + request.event_type + "\"" + actor + ",\"payload\":" + request.payload_json + "}]}";
    const HttpResult response = post("/mystic/v1/hunts/" + request.session_id +
        "/event-batches", body, request.request_id);
    if (!response.error.empty()) { result.error = response.error; return result; }
    if (response.status != 200 || response.body.find("\"accepted\":true") == std::string::npos) {
        result.error = "Guard event backend rejected active generation (HTTP " + std::to_string(response.status) + ')';
        return result;
    }
    static const std::regex hash_pattern("\\\"batchHash\\\":\\\"([a-f0-9]{64})\\\"");
    std::smatch match;
    if (!std::regex_search(response.body, match, hash_pattern)) { result.error = "malformed Guard event response"; return result; }
    result.accepted = true; result.batch_hash = match[1].str();
    return result;
}

bool WinHttpAdmissionClient::request_guard_completion(std::string_view session_id,
    std::uint64_t final_sequence, std::string_view final_hash, std::string_view request_id,
    std::string& error) {
    error.clear();
    if (!SafeToken(session_id, 64, "-") || final_sequence == 0 ||
        !SafeToken(final_hash, 64, "") || final_hash.size() != 64) {
        error = "invalid Guard completion request";
        return false;
    }
    const std::string body = "{\"finalSequence\":" + std::to_string(final_sequence) +
        ",\"finalHash\":\"" + std::string(final_hash) + "\"}";
    const HttpResult response = post("/mystic/v1/hunts/" + std::string(session_id) +
        "/completion", body, request_id);
    if (!response.error.empty()) { error = response.error; return false; }
    if (response.status != 200 || response.body.find("\"accepted\":true") == std::string::npos ||
        response.body.find("\"progressionApplied\":false") == std::string::npos) {
        error = "Guard completion backend rejected active generation (HTTP " + std::to_string(response.status) + ')';
        return false;
    }
    return true;
}

void WinHttpAdmissionClient::notify_disconnected(std::string_view session_id,
    std::string_view admission_id, std::string_view request_id) {
    if (!SafeToken(session_id, 64, "-") || !SafeToken(admission_id, 64, "") ||
        admission_id.size() != 64) return;
    (void)post("/mystic/v1/hunts/" + std::string(session_id) + "/peers/" +
        std::string(admission_id) + "/disconnect", "{}", request_id);
}

} // namespace mystic::bridge
