/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// ParadoxTransportTest.exe - the transport's acceptance harness (realms plan §6.1 step 3).
//   crypto                      pair cipher: round trip, tampering, replay window, direction separation
//   parse                       URL parsing, relay-only filtering, transport secrets
//   abi                         loads ParadoxTransport.dll next to this exe and checks the ABI 2 and ABI 3 exports:
//                               handles, unknown-handle answers, a failed host open, ABI 2 and ABI 3 side by side
//   ice                         two ICE links on this PC, direct, carrying UDP through the real bridges
//   ice --relay-local           the same through a TURN server started in this process, relay only
//   ice --relay-file <path>     the same through the relay named in <path> (ice_turn_urls, turn_username,
//                               turn_credential, optional ice_stun_urls), relay only - e.g. Cloudflare
//   session                     host and joiner sessions end to end with locally signed admission tickets and a
//                               fake backend: admission, one consume per joiner, a refused foreign ticket, traffic;
//                               then ABI 3 through the module: a hub and a hunt on one host, a joiner in both at
//                               once, the 8-session limit
//   hub [--relay-local]         a hub host (session_role=HUB, host_local_client=0) with six loopback joiners one
//                               after another, a remove, a rejoin of the same account, a signal before AddPeer;
//                               direct, or relay only through a TURN server started in this process
//   backend                     [2026-10-17] the host's backend calls off its packet thread: the lane, the Guard
//                               publisher (batches, the chain, retries, a refusal, a full queue, the completion), and a
//                               hosted hunt whose every backend call takes 400 ms while game traffic keeps its pace
// The admission backend is a fake in this process (the real client is HTTPS only). Files go into folders next to
// this exe (some PCs run these binaries without %TEMP% access). No line printed here contains a credential or a key.

#include "admission_client.hpp"
#include "admission_ticket.hpp"
#include "backend_lane.hpp"
#include "guard_publisher.hpp"
#include "ice_link.hpp"
#include "ice_session.hpp"
#include "ice_transport.hpp"
#include "pair_crypto.hpp"
#include "transport_app.hpp"
#include "transport_module.hpp"
#include "udp_bridge.hpp"

#include <Windows.h>
#include <bcrypt.h>
#include <juice/juice.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <functional>
#include <initializer_list>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace mystic::bridge;

namespace {

int gFailures = 0;

// [2026-10-15] A deadline for the whole run. A deadlock (CI, 15 Oct: IceLink held its lock across a libjuice call, see
// ice_link.hpp) froze every link and then the run itself until the CI step timed out, and the runner's Ctrl+Break left
// PowerShell at a debugger prompt. Now the run fails with the section that hung. PARADOX_SELFTEST_TIMEOUT_SECONDS
// overrides the default; 0 turns the watchdog off.
std::atomic<const char*> gSection{ "start" };

void StartWatchdog() {
    int seconds = 300;
    char value[16]{};
    if (GetEnvironmentVariableA("PARADOX_SELFTEST_TIMEOUT_SECONDS", value, sizeof(value)) > 0) seconds = std::atoi(value);
    if (seconds <= 0) return;
    std::thread([seconds]() {
        std::this_thread::sleep_for(std::chrono::seconds(seconds));
        std::cout << "  FAIL watchdog: the self-test did not finish within " << seconds << " s (stuck in: " << gSection.load()
                  << ")\nFAIL (watchdog)\n";
        std::cout.flush();
        // Other threads may be deadlocked: end the process without running their destructors or DLL detach code.
        TerminateProcess(GetCurrentProcess(), 3);
    }).detach();
}

void Check(bool condition, const char* what) {
    std::cout << (condition ? "  ok   " : "  FAIL ") << what << '\n';
    if (!condition) ++gFailures;
}

std::array<std::uint8_t, 32> RandomKey() {
    std::array<std::uint8_t, 32> key{};
    BCryptGenRandom(nullptr, key.data(), static_cast<ULONG>(key.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    return key;
}

std::vector<std::uint8_t> Pattern(std::size_t size, std::uint8_t seed) {
    std::vector<std::uint8_t> data(size);
    for (std::size_t index = 0; index < size; ++index) data[index] = static_cast<std::uint8_t>(seed + index * 31);
    return data;
}

// ---- crypto ------------------------------------------------------------------------------------------------------

int RunCrypto() {
    std::cout << "crypto\n";
    std::array<std::uint8_t, 32> decoded{};
    // 32 zero bytes, base64url.
    Check(PairCipher::DecodeKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", decoded), "decodes a 43-character key");
    Check(!PairCipher::DecodeKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", decoded), "refuses a short key");
    Check(!PairCipher::DecodeKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+", decoded), "refuses non-base64url text");

    const auto key = RandomKey();
    PairCipher host;
    PairCipher join;
    std::string error;
    Check(host.initialize(key, true, error) && join.initialize(key, false, error), "initializes both sides");
    const auto payload = Pattern(1200, 7);
    auto frame = host.seal(FrameType::Gameplay, payload);
    Check(frame.size() == payload.size() + PairCipher::kOverhead, "adds 28 bytes");
    FrameType type{};
    std::vector<std::uint8_t> opened;
    Check(join.open(frame, type, opened) && opened == payload && type == FrameType::Gameplay, "opens host->joiner");
    Check(!join.open(frame, type, opened), "refuses a replay");
    Check(!host.open(host.seal(FrameType::Control, payload), type, opened), "refuses its own direction");
    auto tampered = host.seal(FrameType::Gameplay, payload);
    tampered[PairCipher::kHeaderBytes + 10] ^= 0x01;
    Check(!join.open(tampered, type, opened), "refuses a tampered body");
    auto retyped = host.seal(FrameType::Gameplay, payload);
    retyped[3] = static_cast<std::uint8_t>(FrameType::Control);
    Check(!join.open(retyped, type, opened), "refuses a changed header");
    PairCipher other;
    Check(other.initialize(RandomKey(), false, error) && !other.open(host.seal(FrameType::Gameplay, payload), type, opened),
        "refuses another pair's key");

    // Out of order inside the window is fine; older than the window is not.
    std::vector<std::vector<std::uint8_t>> frames;
    for (int index = 0; index < 1100; ++index) frames.push_back(host.seal(FrameType::Gameplay, payload));
    Check(join.open(frames[1099], type, opened), "accepts the newest frame");
    Check(join.open(frames[500], type, opened), "accepts an older frame inside the window");
    Check(!join.open(frames[10], type, opened), "refuses a frame older than the window");
    Check(!join.open(frames[500], type, opened), "refuses a repeated old frame");

    // A rejoin builds a new link with the same pair key: its first frames must not reuse the old link's nonces.
    const auto counter_of = [](const std::vector<std::uint8_t>& sealed) {
        std::uint64_t value = 0;
        for (int index = 0; index < 8; ++index) value = (value << 8) | sealed[4 + index];
        return value;
    };
    std::set<std::uint64_t> first_counters;
    bool all_initialized = true;
    bool all_nonzero = true;
    for (int link = 0; link < 8; ++link) {
        PairCipher again;
        all_initialized = again.initialize(key, true, error) && all_initialized;
        const std::uint64_t counter = counter_of(again.seal(FrameType::Gameplay, payload));
        all_nonzero = all_nonzero && counter != 0;
        first_counters.insert(counter);
    }
    Check(all_initialized && all_nonzero && first_counters.size() == 8,
        "eight later links with the same key start at different counters");
    PairCipher later_host;
    PairCipher later_join;
    Check(later_host.initialize(key, true, error) && later_join.initialize(key, false, error), "initializes a new pair");
    const auto later_frame = later_host.seal(FrameType::Gameplay, payload);
    Check(counter_of(later_frame) > 1 && later_join.open(later_frame, type, opened) && opened == payload,
        "a receiver takes whatever counter the new link starts at");
    return 0;
}

// ---- parse -------------------------------------------------------------------------------------------------------

int RunParse() {
    std::cout << "parse\n";
    std::string host;
    std::uint16_t port = 0;
    Check(ParseStunUrl("stun:stun.cloudflare.com:3478", host, port) && host == "stun.cloudflare.com" && port == 3478, "STUN URL");
    Check(ParseTurnUdpUrl("turn:turn.cloudflare.com:3478?transport=udp", host, port) && port == 3478, "TURN UDP URL");
    Check(ParseTurnUdpUrl("turn:turn.cloudflare.com:443", host, port) && port == 443, "TURN URL without transport");
    Check(!ParseTurnUdpUrl("turn:turn.cloudflare.com:3478?transport=tcp", host, port), "refuses TURN over TCP");
    Check(!ParseTurnUdpUrl("turns:turn.cloudflare.com:5349?transport=tcp", host, port), "refuses TURN over TLS");
    Check(!ParseStunUrl("stun:bad host:1", host, port), "refuses a bad host");

    const std::string description =
        "a=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdef0123456789\r\na=ice-options:ice2,trickle\r\n"
        "a=candidate:1 1 UDP 2122317823 192.168.1.20 50000 typ host\r\n"
        "a=candidate:3 1 UDP 41885439 104.30.1.1 3478 typ relay raddr 0.0.0.0 rport 0\r\n";
    const std::string filtered = FilterRelayOnly("DESCRIPTION", description);
    Check(filtered.find("typ host") == std::string::npos && filtered.find("typ relay") != std::string::npos &&
        filtered.find("a=ice-ufrag:abcd") != std::string::npos, "relay-only keeps relay candidates and credentials");
    Check(FilterRelayOnly("CANDIDATE", "a=candidate:1 1 UDP 1 10.0.0.2 1 typ srflx raddr 0.0.0.0 rport 0").empty(),
        "relay-only drops a server-reflexive candidate");

    IceSessionMaterial material;
    std::string error;
    const std::string config = "ice_stun_urls=stun:stun.cloudflare.com:3478\n"
        "ice_turn_urls=turn:turn.cloudflare.com:3478?transport=udp,turns:turn.cloudflare.com:5349?transport=tcp,"
        "turn:turn.cloudflare.com:443?transport=udp\n";
    const std::string secrets = "turn_username=user\nturn_credential=secret\n"
        "peer=acct-1,42,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"
        "peer=acct-2,43,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
    Check(ParseIceMaterial(config, secrets, material, error) && material.servers.turn_servers.size() == 2 &&
        material.peers.size() == 2 && material.peers[1].peer_id == 43 && material.servers.stun_port == 3478,
        "transport secrets: two UDP relays, two peers");
    Check(!ParseIceMaterial(config, "peer=acct-1,42,short\n", material, error), "refuses a malformed peer");
    Check(!ParseIceMaterial(config, secrets + "peer=acct-1,44,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", material, error),
        "refuses a duplicate peer account");

    // [2026-10-15] The host lease: a backend that is away is waited out, a refusal is not (15 Oct: a 4 s backend restart
    // ended a hosted Escalation because three failed heartbeats of any kind ended the lease).
    Check(ClassifyHeartbeatResponse(true, 200, R"({"renewed":true,"state":"RUNNING"})") == HeartbeatOutcome::Renewed,
        "lease: 200 renewed");
    Check(ClassifyHeartbeatResponse(true, 200, R"({"renewed":false})") == HeartbeatOutcome::Rejected, "lease: 200 not renewed");
    Check(ClassifyHeartbeatResponse(false, 0, "") == HeartbeatOutcome::Unavailable, "lease: no answer is unavailable");
    for (const unsigned long status : { 500ul, 502ul, 503ul, 504ul, 408ul, 429ul }) {
        Check(ClassifyHeartbeatResponse(true, status, "<html>Bad Gateway</html>") == HeartbeatOutcome::Unavailable,
            "lease: gateway and overload statuses are unavailable");
    }
    Check(ClassifyHeartbeatResponse(true, 503, R"({"error":{"code":"P2P_EMERGENCY_STOP"}})") == HeartbeatOutcome::Rejected,
        "lease: the emergency stop is a refusal");
    for (const unsigned long status : { 400ul, 401ul, 403ul, 404ul, 409ul, 410ul }) {
        Check(ClassifyHeartbeatResponse(true, status, R"({"error":{"code":"P2P_GENERATION_FENCED"}})") == HeartbeatOutcome::Rejected,
            "lease: refusals stay refusals");
    }
    {
        const auto t0 = std::chrono::steady_clock::now();
        LeaseTracker away(t0);
        bool failed = false;
        // A 4 s restart, heartbeats every 2 s, then the backend answers again: never fails.
        for (int second = 2; second <= 6; second += 2) failed |= away.record(HeartbeatOutcome::Unavailable, t0 + std::chrono::seconds(second));
        failed |= away.record(HeartbeatOutcome::Renewed, t0 + std::chrono::seconds(8));
        Check(!failed, "lease: a short backend restart is waited out");
        // Away for longer than the grace since the last renewal: fails then, not before.
        const auto renewed = t0 + std::chrono::seconds(8);
        Check(!away.record(HeartbeatOutcome::Unavailable, renewed + LeaseTracker::kUnavailableGrace - std::chrono::seconds(1)),
            "lease: still waiting just inside the grace");
        Check(away.record(HeartbeatOutcome::Unavailable, renewed + LeaseTracker::kUnavailableGrace),
            "lease: fails once the grace has passed");
        LeaseTracker fenced(t0);
        Check(!fenced.record(HeartbeatOutcome::Rejected, t0 + std::chrono::seconds(2)), "lease: one refusal is retried");
        Check(fenced.record(HeartbeatOutcome::Rejected, t0 + std::chrono::seconds(4)), "lease: two refusals in a row fail at once");
        LeaseTracker mixed(t0);
        Check(!mixed.record(HeartbeatOutcome::Rejected, t0 + std::chrono::seconds(2)) &&
            !mixed.record(HeartbeatOutcome::Renewed, t0 + std::chrono::seconds(4)) &&
            !mixed.record(HeartbeatOutcome::Rejected, t0 + std::chrono::seconds(6)), "lease: a renewal resets the refusal count");
    }
    return 0;
}

// ---- ice ---------------------------------------------------------------------------------------------------------

SOCKET LoopbackUdp() {
    SOCKET result = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    u_long enabled = 1;
    ioctlsocket(result, FIONBIO, &enabled);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind(result, reinterpret_cast<const sockaddr*>(&address), sizeof(address));
    return result;
}

std::uint16_t PortOf(SOCKET socket) {
    sockaddr_in address{};
    int length = sizeof(address);
    getsockname(socket, reinterpret_cast<sockaddr*>(&address), &length);
    return ntohs(address.sin_port);
}

void SendTo(SOCKET socket, std::uint16_t port, const std::vector<std::uint8_t>& payload) {
    sockaddr_in destination{};
    destination.sin_family = AF_INET;
    destination.sin_port = htons(port);
    destination.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sendto(socket, reinterpret_cast<const char*>(payload.data()), static_cast<int>(payload.size()), 0,
        reinterpret_cast<const sockaddr*>(&destination), sizeof(destination));
}

void PumpEcho(SOCKET server) {
    std::array<char, 4096> buffer{};
    while (true) {
        sockaddr_in source{};
        int length = sizeof(source);
        const int received = recvfrom(server, buffer.data(), static_cast<int>(buffer.size()), 0,
            reinterpret_cast<sockaddr*>(&source), &length);
        if (received <= 0) break;
        sendto(server, buffer.data(), received, 0, reinterpret_cast<const sockaddr*>(&source), length);
    }
}

void Shuttle(IceLink& from, IceLink& to) {
    std::string error;
    for (const auto& signal : from.take_signals()) (void)to.apply_remote_signal(signal.kind, signal.data, error);
}

int RunIce(int argc, char** argv) {
    bool relay_local = false;
    std::string relay_file;
    for (int index = 2; index < argc; ++index) {
        const std::string argument(argv[index]);
        if (argument == "--relay-local") relay_local = true;
        else if (argument == "--relay-file" && index + 1 < argc) relay_file = argv[++index];
    }
    const bool relay_only = relay_local || !relay_file.empty();
    std::cout << "ice " << (relay_local ? "(local relay, relay only)" : !relay_file.empty() ? "(relay file, relay only)" : "(direct)") << '\n';

    WinsockRuntime winsock;
    IceServerConfig servers;
    juice_server_t* turn_server = nullptr;
    if (relay_local) {
        juice_server_credentials_t credentials{};
        credentials.username = "paradox-selftest";
        credentials.password = "paradox-selftest-password";
        juice_server_config_t config{};
        config.credentials = &credentials;
        config.credentials_count = 1;
        config.max_allocations = 16;
        config.bind_address = "127.0.0.1";
        config.port = 0;
        config.realm = "paradox-selftest";
        turn_server = juice_server_create(&config);
        Check(turn_server != nullptr, "starts a local relay");
        if (!turn_server) return 0;
        servers.turn_servers.push_back({ "127.0.0.1", juice_server_get_port(turn_server), "paradox-selftest",
            "paradox-selftest-password" });
    } else if (!relay_file.empty()) {
        std::ifstream stream(relay_file, std::ios::binary);
        std::stringstream text;
        text << stream.rdbuf();
        IceSessionMaterial material;
        std::string error;
        Check(stream.good() || stream.eof(), "reads the relay file");
        Check(ParseIceMaterial(text.str(), text.str(), material, error) && !material.servers.turn_servers.empty(),
            "the relay file names a UDP relay with credentials");
        servers = material.servers;
        if (servers.turn_servers.empty()) return 0;
    }

    const auto key = RandomKey();
    std::string error;
    auto join = std::make_shared<IceLink>(servers, relay_only, false);
    Check(join->start(key, error), "joiner link starts");
    std::shared_ptr<IceLink> host;
    const auto started = std::chrono::steady_clock::now();
    const auto deadline = started + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline) {
        for (auto& signal : join->take_signals()) {
            if (!host && signal.kind == "DESCRIPTION") {
                host = std::make_shared<IceLink>(servers, relay_only, true);
                if (!host->start(key, error, signal.data)) break;
            } else if (host) {
                (void)host->apply_remote_signal(signal.kind, signal.data, error);
            }
        }
        if (host) Shuttle(*host, *join);
        if (host && host->connected() && join->connected()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const bool connected = host && host->connected() && join->connected();
    Check(connected, "both sides connect");
    if (!connected) {
        if (turn_server) juice_server_destroy(turn_server);
        return 0;
    }
    const auto connect_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    std::cout << "  connected in " << connect_ms << " ms, route=" << (join->relayed() ? "relay" : "direct") << '\n';
    // With a real relay, permissions are per IP, so only relay-to-relay pairs work and both sides must report the
    // relay. The in-process relay shares 127.0.0.1 with both agents, which also lets a direct socket reach the other
    // side's relay address: there one relayed side is all that can be required.
    if (relay_file.empty() && relay_local) Check(join->relayed() || host->relayed(), "the route goes through the relay");
    if (!relay_file.empty()) Check(join->relayed() && host->relayed(), "both sides use the relay");

    // Game traffic through the real bridges: client -> joiner bridge -> ICE -> host bridge -> echo server and back.
    constexpr PeerId kHost = 1;
    constexpr PeerId kJoin = 2;
    auto host_transport = std::make_shared<IceMessageTransport>();
    auto join_transport = std::make_shared<IceMessageTransport>();
    host_transport->attach(kJoin, host);
    join_transport->attach(kHost, join);
    SOCKET server = LoopbackUdp();
    SOCKET client = LoopbackUdp();
    HostUdpBridge host_bridge(host_transport, PortOf(server), BridgeLimits{ 2048, 64, 4 });
    JoinerUdpBridge join_bridge(join_transport, kHost, 0, BridgeLimits{ 2048, 64, 1 });
    const auto pump = [&]() {
        for (auto& frame : host->take_received(256)) host_transport->deliver(kJoin, std::move(frame.payload));
        for (auto& frame : join->take_received(256)) join_transport->deliver(kHost, std::move(frame.payload));
        join_bridge.pump_once();
        host_bridge.pump_once();
        PumpEcho(server);
        host_bridge.pump_once();
        join_bridge.pump_once();
    };
    const auto receive = [&]() {
        std::array<std::uint8_t, 4096> buffer{};
        const int received = recv(client, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);
        return received > 0 ? std::vector<std::uint8_t>(buffer.begin(), buffer.begin() + received) : std::vector<std::uint8_t>{};
    };

    bool sizes_ok = true;
    long long worst_rtt_ms = 0;
    for (const std::size_t size : { 1u, 64u, 512u, 1200u, 1400u, 2000u }) {
        const auto payload = Pattern(size, static_cast<std::uint8_t>(size));
        const auto sent_at = std::chrono::steady_clock::now();
        SendTo(client, join_bridge.local_port(), payload);
        std::vector<std::uint8_t> reply;
        while (reply.empty() && std::chrono::steady_clock::now() - sent_at < std::chrono::seconds(3)) {
            pump();
            reply = receive();
            if (reply.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        const auto rtt_ms = static_cast<long long>(
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - sent_at).count());
        worst_rtt_ms = (std::max)(worst_rtt_ms, rtt_ms);
        std::cout << "  " << size << " bytes: " << (reply == payload ? "ok" : "lost") << " in " << rtt_ms << " ms\n";
        if (reply != payload) {
            std::cout << "  datagram of " << size << " bytes did not come back intact\n";
            sizes_ok = false;
        }
    }
    Check(sizes_ok, "datagrams of 1 to 2000 bytes come back intact");
    std::cout << "  worst round trip " << worst_rtt_ms << " ms\n";

    // A burst at roughly game rate: 300 datagrams of 600 bytes over about 1 s.
    int echoed = 0;
    const auto burst_started = std::chrono::steady_clock::now();
    for (int index = 0; index < 300; ++index) {
        SendTo(client, join_bridge.local_port(), Pattern(600, static_cast<std::uint8_t>(index)));
        pump();
        while (!receive().empty()) ++echoed;
        std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
    while (echoed < 300 && std::chrono::steady_clock::now() - burst_started < std::chrono::seconds(5)) {
        pump();
        while (!receive().empty()) ++echoed;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::cout << "  burst: " << echoed << "/300 echoed\n";
    Check(echoed >= 297, "a game-rate burst loses at most 1%");

    // Large datagrams travel in two pieces each way.
    int large_echoed = 0;
    const auto large_started = std::chrono::steady_clock::now();
    for (int index = 0; index < 100; ++index) {
        SendTo(client, join_bridge.local_port(), Pattern(1800, static_cast<std::uint8_t>(index)));
        pump();
        while (!receive().empty()) ++large_echoed;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    while (large_echoed < 100 && std::chrono::steady_clock::now() - large_started < std::chrono::seconds(5)) {
        pump();
        while (!receive().empty()) ++large_echoed;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::cout << "  large burst (1800 bytes, 2 pieces): " << large_echoed << "/100 echoed\n";
    Check(large_echoed >= 97, "a burst of fragmented datagrams loses at most 3%");
    const auto stats = join->stats();
    std::cout << "  joiner frames sent=" << stats.frames_sent << " received=" << stats.frames_received
        << " rejected=" << stats.frames_rejected << " sendFailures=" << stats.send_failures << '\n';
    Check(stats.frames_rejected == 0 && host->stats().frames_rejected == 0, "no frame fails authentication");

    closesocket(client);
    closesocket(server);
    host->stop();
    join->stop();
    if (turn_server) juice_server_destroy(turn_server);
    return 0;
}

// ---- session -----------------------------------------------------------------------------------------------------

void PutBe(std::vector<std::uint8_t>& out, std::uint64_t value, int bytes) {
    for (int index = bytes - 1; index >= 0; --index) out.push_back(static_cast<std::uint8_t>((value >> (index * 8)) & 0xff));
}

std::string Base64Url(const std::vector<std::uint8_t>& data) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string result;
    std::uint32_t buffer = 0;
    int bits = 0;
    for (const std::uint8_t byte : data) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            result.push_back(alphabet[(buffer >> bits) & 0x3f]);
        }
    }
    if (bits > 0) result.push_back(alphabet[(buffer << (6 - bits)) & 0x3f]);
    return result;
}

// An ES256 signer for MPT2 admission tickets, the format ParadoxBackend issues (security/admissionTickets.ts).
class TicketSigner final {
public:
    TicketSigner() {
        BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0);
        BCryptGenerateKeyPair(algorithm_, &key_, 256, 0);
        BCryptFinalizeKeyPair(key_, 0);
    }
    ~TicketSigner() {
        if (key_) BCryptDestroyKey(key_);
        if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0);
    }
    TicketSigner(const TicketSigner&) = delete;
    TicketSigner& operator=(const TicketSigner&) = delete;

    bool write_public_key(const std::filesystem::path& path) const {
        ULONG size = 0;
        const NTSTATUS sized = BCryptExportKey(key_, nullptr, BCRYPT_ECCPUBLIC_BLOB, nullptr, 0, &size, 0);
        if (sized != 0) {
            std::cout << "  export size status 0x" << std::hex << static_cast<unsigned long>(sized) << std::dec
                << " key=" << (key_ ? 1 : 0) << '\n';
            return false;
        }
        std::vector<std::uint8_t> blob(size);
        if (BCryptExportKey(key_, nullptr, BCRYPT_ECCPUBLIC_BLOB, blob.data(), size, &size, 0) != 0 ||
            size != sizeof(BCRYPT_ECCKEY_BLOB) + 64) {
            std::cout << "  export size " << size << '\n';
            return false;
        }
        std::ofstream stream(path, std::ios::binary | std::ios::trunc);
        stream.write(reinterpret_cast<const char*>(blob.data() + sizeof(BCRYPT_ECCKEY_BLOB)), 64);
        return stream.good();
    }

    std::string ticket(const SessionBindings& bindings, std::string_view account, PeerId joiner) const {
        const auto now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
        std::vector<std::uint8_t> payload{ 'M', 'P', 'T', '2' };
        PutBe(payload, 2, 1);
        PutBe(payload, bindings.key_id.size(), 1);
        PutBe(payload, account.size(), 2);
        PutBe(payload, bindings.hunt_definition_id.size(), 2);
        PutBe(payload, bindings.party_id.size(), 2);
        PutBe(payload, bindings.bridge_protocol, 2);
        PutBe(payload, bindings.virtual_port, 2);
        PutBe(payload, 0, 2);
        PutBe(payload, bindings.generation, 4);
        PutBe(payload, bindings.build, 4);
        PutBe(payload, bindings.party_revision, 8);
        PutBe(payload, now, 8);
        PutBe(payload, now, 8);
        PutBe(payload, now + 120, 8);
        PutBe(payload, joiner, 8);
        PutBe(payload, bindings.host_peer_id, 8);
        std::string hex;
        for (const char character : bindings.session_id) if (character != '-') hex.push_back(character);
        for (std::size_t index = 0; index < 32; index += 2) payload.push_back(static_cast<std::uint8_t>(std::stoi(hex.substr(index, 2), nullptr, 16)));
        std::array<std::uint8_t, 16> jti{};
        BCryptGenRandom(nullptr, jti.data(), static_cast<ULONG>(jti.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
        payload.insert(payload.end(), jti.begin(), jti.end());
        payload.insert(payload.end(), bindings.key_id.begin(), bindings.key_id.end());
        payload.insert(payload.end(), account.begin(), account.end());
        payload.insert(payload.end(), bindings.hunt_definition_id.begin(), bindings.hunt_definition_id.end());
        payload.insert(payload.end(), bindings.party_id.begin(), bindings.party_id.end());
        std::array<std::uint8_t, 32> digest{};
        BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, payload.data(), static_cast<ULONG>(payload.size()),
            digest.data(), static_cast<ULONG>(digest.size()));
        ULONG size = 0;
        BCryptSignHash(key_, nullptr, digest.data(), static_cast<ULONG>(digest.size()), nullptr, 0, &size, 0);
        std::vector<std::uint8_t> signature(size);
        BCryptSignHash(key_, nullptr, digest.data(), static_cast<ULONG>(digest.size()), signature.data(), size, &size, 0);
        return "mpt1." + Base64Url(payload) + "." + Base64Url(signature);
    }

private:
    BCRYPT_ALG_HANDLE algorithm_ = nullptr;
    BCRYPT_KEY_HANDLE key_ = nullptr;
};

// What the host's central backend would see. Sessions of the module call it from their own threads, so reads of the
// counters while sessions run go through the accessors.
class FakeBackend final : public IAdmissionClient {
public:
    struct Consume {
        std::string session_id;
        std::string connection_handle;
        std::string request_id;
        std::uint64_t peer_id = 0;
    };
    int consumes = 0;
    int disconnects = 0;
    std::vector<std::uint64_t> consumed_ids;
    // [2026-10-17] A slow backend: each call (but the host-ready) waits this long first, as a far or busy backend does.
    std::atomic<int> delay_ms{ 0 };

    void delay() const {
        const int milliseconds = delay_ms.load();
        if (milliseconds > 0) std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    }

    AdmissionConsumeResult consume(const AdmissionConsumeRequest& request) override {
        delay();
        std::lock_guard lock(mutex_);
        ++consumes;
        consumed_ids.push_back(request.authenticated_steam_id);
        consume_log_.push_back(Consume{ request.session_id, request.connection_handle, request.request_id,
            request.authenticated_steam_id });
        return AdmissionConsumeResult{ true, false, std::string(64, 'a'), "ok" };
    }
    bool publish_host_ready(const HostReadyRequest& request, std::string&) override {
        std::lock_guard lock(mutex_);
        ready_sessions_.push_back(request.session_id);
        return true;
    }
    HeartbeatOutcome publish_heartbeat(const HostHeartbeatRequest& request, std::string&) override {
        delay();
        std::lock_guard lock(mutex_);
        ++heartbeats_;
        last_admitted_[request.session_id] = request.admitted_peer_count;
        return HeartbeatOutcome::Renewed;
    }
    GuardEventBatchResult publish_guard_batch(const GuardEventBatchRequest& request) override {
        delay();
        std::lock_guard lock(mutex_);
        guard_batches_.push_back(request);
        std::string hash(64, 'b');
        const std::string count = std::to_string(guard_batches_.size());
        hash.replace(hash.size() - count.size(), count.size(), count);
        return GuardEventBatchResult{ true, true, 200, hash, "" };
    }
    bool request_guard_completion(std::string_view, std::uint64_t, std::string_view, std::string_view, std::string&) override {
        delay();
        return true;
    }
    void notify_disconnected(std::string_view, std::string_view, std::string_view request_id) override {
        delay();
        std::lock_guard lock(mutex_);
        ++disconnects;
        disconnect_request_ids_.emplace_back(request_id);
    }

    [[nodiscard]] std::vector<Consume> consume_log() const {
        std::lock_guard lock(mutex_);
        return consume_log_;
    }
    [[nodiscard]] int disconnect_count() const {
        std::lock_guard lock(mutex_);
        return disconnects;
    }
    [[nodiscard]] std::vector<std::string> disconnect_request_ids() const {
        std::lock_guard lock(mutex_);
        return disconnect_request_ids_;
    }
    [[nodiscard]] std::uint32_t last_admitted(const std::string& session_id) const {
        std::lock_guard lock(mutex_);
        const auto found = last_admitted_.find(session_id);
        return found == last_admitted_.end() ? 0 : found->second;
    }
    [[nodiscard]] bool host_ready_published(const std::string& session_id) const {
        std::lock_guard lock(mutex_);
        return std::find(ready_sessions_.begin(), ready_sessions_.end(), session_id) != ready_sessions_.end();
    }
    [[nodiscard]] std::vector<GuardEventBatchRequest> guard_batches() const {
        std::lock_guard lock(mutex_);
        return guard_batches_;
    }
    [[nodiscard]] int heartbeat_count() const {
        std::lock_guard lock(mutex_);
        return heartbeats_;
    }

private:
    mutable std::mutex mutex_;
    std::vector<GuardEventBatchRequest> guard_batches_;
    std::vector<Consume> consume_log_;
    std::vector<std::string> disconnect_request_ids_;
    std::vector<std::string> ready_sessions_;
    std::map<std::string, std::uint32_t> last_admitted_;
    int heartbeats_ = 0;
};

struct SignalBox {
    std::vector<InboundSignal> to_host;
    std::vector<InboundSignal> to_join;
};

int RunSession() {
    std::cout << "session\n";
    WinsockRuntime winsock;
    const SessionBindings bindings{ "test-key", "01234567-89ab-4def-8123-456789abcdef", "party-1", "hunt-1",
        "bridge-1", 1, 1001, 3, 647472, 1, 1 };
    constexpr PeerId kJoiner = 2002;
    TicketSigner signer;
    // Next to the exe (build output): on some PCs new binaries may not write under %TEMP%.
    wchar_t exe_path[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe_path, MAX_PATH);
    const std::filesystem::path key_path = std::filesystem::path(exe_path).parent_path() /
        (L"selftest-admission-public-" + std::to_wstring(GetCurrentProcessId()) + L".xy");
    Check(signer.write_public_key(key_path), "writes the test signing key");
    AdmissionTicketVerifier host_verifier;
    AdmissionTicketVerifier join_verifier;
    std::string error;
    Check(host_verifier.load_public_key(key_path, error) && join_verifier.load_public_key(key_path, error), "loads it");

    const auto pair_key = RandomKey();
    const auto run = [&](const std::string& ticket_account, int& consumes, bool& admitted, std::string& failure,
        bool exchange_traffic) {
        FakeBackend backend;
        SignalBox box;
        auto host_transport = std::make_shared<IceMessageTransport>();
        auto join_transport = std::make_shared<IceMessageTransport>();
        const SessionLimits limits{ 4, std::chrono::seconds(20), false, false };
        IceHostSession host(IceServerConfig{}, { IcePeerConfig{ "join-account", kJoiner, pair_key } }, host_transport,
            host_verifier, backend, bindings, limits,
            [&box](std::string_view to, std::string_view kind, std::string_view data) {
                if (to == "join-account") box.to_join.push_back({ "host-account", std::string(kind), std::string(data) });
            }, {}, {});
        IceJoinSession join(IceServerConfig{}, IcePeerConfig{ "host-account", 1001, pair_key }, join_transport,
            join_verifier, bindings, kJoiner, ticket_account, signer.ticket(bindings, ticket_account, kJoiner),
            SessionLimits{ 1, std::chrono::seconds(20), false, false },
            [&box](std::string_view to, std::string_view kind, std::string_view data) {
                if (to == "host-account") box.to_host.push_back({ "join-account", std::string(kind), std::string(data) });
            }, {}, {});
        std::string start_error;
        if (!join.start(start_error)) {
            failure = "join start: " + start_error;
            return;
        }
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
        while (std::chrono::steady_clock::now() < deadline && !join.admitted() && !join.failed()) {
            join.pump_once();
            for (auto& signal : box.to_host) host.apply_signal(signal.from_account_id, signal.kind, signal.data);
            box.to_host.clear();
            host.pump_once();
            for (auto& signal : box.to_join) join.apply_signal(signal.from_account_id, signal.kind, signal.data);
            box.to_join.clear();
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        // Let the joiner's repeated requests reach the host after admission: they must not be consumed again.
        for (int index = 0; index < 600; ++index) {
            join.pump_once();
            host.pump_once();
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        admitted = join.admitted() && host.admitted_count() == 1;
        failure = std::string(join.failure_code());
        consumes = backend.consumes;
        if (admitted && exchange_traffic) {
            SOCKET server = LoopbackUdp();
            SOCKET client = LoopbackUdp();
            HostUdpBridge host_bridge(host_transport, PortOf(server), BridgeLimits{ 2048, 64, 4 });
            JoinerUdpBridge join_bridge(join_transport, 1001, 0, BridgeLimits{ 2048, 64, 1 });
            const auto payload = Pattern(900, 3);
            SendTo(client, join_bridge.local_port(), payload);
            std::vector<std::uint8_t> reply;
            const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(3);
            while (reply.empty() && std::chrono::steady_clock::now() < until) {
                join_bridge.pump_once();
                join.pump_once();
                host.pump_once();
                host_bridge.pump_once();
                PumpEcho(server);
                host_bridge.pump_once();
                host.pump_once();
                join.pump_once();
                join_bridge.pump_once();
                std::array<std::uint8_t, 4096> buffer{};
                const int received = recv(client, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);
                if (received > 0) reply.assign(buffer.begin(), buffer.begin() + received);
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            Check(reply == payload, "game traffic flows after admission");
            Check(backend.consumed_ids.size() == 1 && backend.consumed_ids[0] == kJoiner, "the consume names the joiner's peer id");
            closesocket(client);
            closesocket(server);
        }
    };

    int consumes = 0;
    bool admitted = false;
    std::string failure;
    run("join-account", consumes, admitted, failure, true);
    Check(admitted, "the joiner is admitted");
    Check(consumes == 1, "the ticket is consumed exactly once despite repeated requests");

    // A valid ticket of another account arriving over the pair the host knows as "join-account": the host must
    // refuse it (claims account != pair account) without consuming it.
    consumes = 0;
    admitted = false;
    failure.clear();
    run("other-account", consumes, admitted, failure, false);
    Check(!admitted && consumes == 0, "a ticket for another account is never consumed");
    std::cout << "  foreign ticket outcome: " << (failure.empty() ? "(none)" : failure) << '\n';
    std::error_code ignored;
    std::filesystem::remove(key_path, ignored);
    return 0;
}

// ---- module harness ----------------------------------------------------------------------------------------------
// What a launcher hands to the module: a signing key, files for each session, a (fake) central backend, and the loop
// that carries ICE signals between the sessions of two "PCs" (two module instances in this process).

std::filesystem::path ExeDirectory() {
    wchar_t exe_path[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe_path, MAX_PATH);
    return std::filesystem::path(exe_path).parent_path();
}

std::string SessionId(unsigned number) {
    char text[40]{};
    std::snprintf(text, sizeof(text), "01234567-89ab-4def-8123-%012x", number);
    return text;
}

bool Contains(std::string_view text, std::string_view needle) {
    return text.find(needle) != std::string_view::npos;
}

std::uint16_t LocalPortOf(std::string_view line) {
    const auto at = line.find("localPort=");
    if (at == std::string_view::npos) return 0;
    return static_cast<std::uint16_t>(std::strtoul(std::string(line.substr(at + 10, 8)).c_str(), nullptr, 10));
}

std::string KeyText(const std::array<std::uint8_t, 32>& key) {
    return Base64Url(std::vector<std::uint8_t>(key.begin(), key.end()));
}

// A forwarding client, so every session of one module talks to the same FakeBackend (the factory must hand each
// session an owned client).
class SharedBackendClient final : public IAdmissionClient {
public:
    explicit SharedBackendClient(FakeBackend& target) : target_(target) {}
    AdmissionConsumeResult consume(const AdmissionConsumeRequest& request) override { return target_.consume(request); }
    bool publish_host_ready(const HostReadyRequest& request, std::string& error) override {
        return target_.publish_host_ready(request, error);
    }
    HeartbeatOutcome publish_heartbeat(const HostHeartbeatRequest& request, std::string& error) override {
        return target_.publish_heartbeat(request, error);
    }
    GuardEventBatchResult publish_guard_batch(const GuardEventBatchRequest& request) override {
        return target_.publish_guard_batch(request);
    }
    bool request_guard_completion(std::string_view session_id, std::uint64_t sequence, std::string_view hash,
        std::string_view request_id, std::string& error) override {
        return target_.request_guard_completion(session_id, sequence, hash, request_id, error);
    }
    void notify_disconnected(std::string_view session_id, std::string_view admission_id,
        std::string_view request_id) override {
        target_.notify_disconnected(session_id, admission_id, request_id);
    }

private:
    FakeBackend& target_;
};

AdmissionClientFactory SharedBackend(FakeBackend& backend) {
    return [&backend](std::string_view, std::string, std::string&) -> std::unique_ptr<IAdmissionClient> {
        return std::make_unique<SharedBackendClient>(backend);
    };
}

class ModuleRig final {
public:
    // [2026-10-15] One folder per process: two self-tests running at once (a loop and a full run) shared selftest-hub, and
    // the second one's key replaced the first one's mid-run (its joiners then failed with bad_signature).
    explicit ModuleRig(const std::string& name)
        : dir_(ExeDirectory() / ("selftest-" + name + "-" + std::to_string(GetCurrentProcessId()))) {
        std::error_code ignored;
        std::filesystem::remove_all(dir_, ignored);
        std::filesystem::create_directories(dir_, ignored);
        ok_ = signer.write_public_key(dir_ / "admission-public.xy");
    }
    ~ModuleRig() {
        std::error_code ignored;
        std::filesystem::remove_all(dir_, ignored);
    }
    ModuleRig(const ModuleRig&) = delete;
    ModuleRig& operator=(const ModuleRig&) = delete;

    [[nodiscard]] bool ok() const { return ok_; }
    [[nodiscard]] std::string path(const std::string& file) const { return (dir_ / file).string(); }
    void write(const std::string& file, const std::string& text) const {
        std::ofstream stream(dir_ / file, std::ios::binary | std::ios::trunc);
        stream << text;
    }
    [[nodiscard]] std::string key_path() const { return path("admission-public.xy"); }

    TicketSigner signer;
    FakeBackend backend;

private:
    std::filesystem::path dir_;
    bool ok_ = false;
};

// Direct, or relay only through the TURN server this process started (port > 0).
struct RelaySetup {
    std::uint16_t turn_port = 0;
    [[nodiscard]] bool enabled() const { return turn_port != 0; }
};

std::string BindingText(const SessionBindings& bindings) {
    std::ostringstream text;
    text << "key_id=" << bindings.key_id << "\nsession_id=" << bindings.session_id << "\nparty_id=" << bindings.party_id
        << "\nhunt_definition_id=" << bindings.hunt_definition_id << "\nbridge_instance_id=" << bindings.bridge_instance_id
        << "\nparty_revision=" << bindings.party_revision << "\nhost_peer_id=" << bindings.host_peer_id
        << "\ngeneration=" << bindings.generation << "\nbuild=" << bindings.build
        << "\nbridge_protocol=" << bindings.bridge_protocol << "\nvirtual_port=" << bindings.virtual_port << '\n';
    return text.str();
}

std::string RelayConfigText(const RelaySetup& relay) {
    if (!relay.enabled()) return "force_relay=false\n";
    return "force_relay=true\nice_turn_urls=turn:127.0.0.2:" + std::to_string(relay.turn_port) + "?transport=udp\n";
}

std::string RelaySecretText(const RelaySetup& relay) {
    return relay.enabled() ? "turn_username=paradox-selftest\nturn_credential=paradox-selftest-password\n" : "";
}

std::string PeerLine(const std::string& account, PeerId peer_id, const std::array<std::uint8_t, 32>& key) {
    return "peer=" + account + "," + std::to_string(peer_id) + "," + KeyText(key) + "\n";
}

struct HostSpec {
    SessionBindings bindings;
    std::string role = "HUNT";
    bool local_client = true;
    std::size_t maximum_peers = 4;
    std::uint16_t server_port = 1;
    RelaySetup relay;
    std::string guard_pipe;   // hunts only
};

std::string HostConfigText(const HostSpec& spec) {
    std::ostringstream text;
    text << BindingText(spec.bindings) << "backend_url=https://127.0.0.1:9\nserver_udp_port=" << spec.server_port
        << "\nmaximum_peers=" << spec.maximum_peers << "\nsession_role=" << spec.role
        << "\nhost_local_client=" << (spec.local_client ? 1 : 0) << '\n' << RelayConfigText(spec.relay);
    if (!spec.guard_pipe.empty()) {
        text << "guard_pipe_name=" << spec.guard_pipe << "\nexpected_server_pid=" << GetCurrentProcessId() << '\n';
    }
    return text.str();
}

std::string JoinConfigText(const SessionBindings& bindings, const std::string& local_account, PeerId local_peer,
    const std::string& host_account, const RelaySetup& relay) {
    return BindingText(bindings) + "local_udp_port=0\nlocal_peer_id=" + std::to_string(local_peer) +
        "\nlocal_account_id=" + local_account + "\nhost_account_id=" + host_account + "\n" + RelayConfigText(relay);
}

// Writes the joiner's files under `tag` and opens the session; 0 when the open fails.
int OpenJoin(TransportModule& module, ModuleRig& rig, const std::string& tag, const SessionBindings& bindings,
    const std::string& account, PeerId peer_id, const std::string& host_account,
    const std::array<std::uint8_t, 32>& key, const RelaySetup& relay) {
    rig.write("join-" + tag + ".conf", JoinConfigText(bindings, account, peer_id, host_account, relay));
    rig.write("join-" + tag + ".secret", PeerLine(host_account, bindings.host_peer_id, key) + RelaySecretText(relay));
    rig.write("join-" + tag + ".ticket", rig.signer.ticket(bindings, account, peer_id));
    char error[256]{};
    const int handle = module.join_open(rig.key_path().c_str(), rig.path("join-" + tag + ".conf").c_str(),
        rig.path("join-" + tag + ".ticket").c_str(), rig.path("join-" + tag + ".secret").c_str(), error, sizeof(error));
    if (handle == 0) std::cout << "  join open failed: " << error << '\n';
    return handle;
}

// One joiner session and the host session it talks to: what the launcher's signal relay connects.
struct Route {
    TransportModule* host_module = nullptr;
    int host_handle = 0;
    std::string host_account;
    TransportModule* join_module = nullptr;
    int join_handle = 0;
    std::string join_account;
};

// The launcher's job between two PCs: every signal a session wants delivered goes into the other side's session.
// Returns how many it moved.
int CarrySignals(const std::vector<Route>& routes) {
    int moved = 0;
    char to[128];
    char kind[40];
    char data[4200];
    std::set<std::pair<TransportModule*, int>> hosts_done;
    for (const Route& route : routes) {
        while (route.join_module->read_signal(route.join_handle, to, sizeof(to), kind, sizeof(kind), data,
                   sizeof(data)) == 1) {
            ++moved;
            (void)route.host_module->submit_signal(route.host_handle, route.join_account.c_str(), kind, data);
        }
        if (!hosts_done.insert({ route.host_module, route.host_handle }).second) continue;
        // A host session has one outbox for all of its joiners; the `to` account says whose it is.
        while (route.host_module->read_signal(route.host_handle, to, sizeof(to), kind, sizeof(kind), data,
                   sizeof(data)) == 1) {
            ++moved;
            for (const Route& target : routes) {
                if (target.host_module == route.host_module && target.host_handle == route.host_handle &&
                    target.join_account == to) {
                    (void)target.join_module->submit_signal(target.join_handle, target.host_account.c_str(), kind, data);
                }
            }
        }
    }
    return moved;
}

// Everything a session reported, collected as the tests pump.
struct Feed {
    std::vector<std::string> events;
    std::vector<std::string> diagnostics;
    void drain(TransportModule& module, int handle) {
        char line[1100];
        while (module.read_peer_event(handle, line, sizeof(line)) == 1) events.emplace_back(line);
        while (module.read_diagnostic(handle, line, sizeof(line)) == 1) diagnostics.emplace_back(line);
    }
    [[nodiscard]] int count_events(std::string_view needle) const {
        return static_cast<int>(std::count_if(events.begin(), events.end(),
            [needle](const std::string& line) { return Contains(line, needle); }));
    }
    [[nodiscard]] int count_diagnostics(std::string_view needle) const {
        return static_cast<int>(std::count_if(diagnostics.begin(), diagnostics.end(),
            [needle](const std::string& line) { return Contains(line, needle); }));
    }
};

bool PumpUntil(std::chrono::milliseconds limit, const std::function<void()>& pump, const std::function<bool()>& done) {
    const auto deadline = std::chrono::steady_clock::now() + limit;
    while (std::chrono::steady_clock::now() < deadline) {
        pump();
        if (done()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    pump();
    return done();
}

// The "game server": echoes every datagram and remembers which loopback ports sent one (one per admitted peer).
class EchoServer final {
public:
    EchoServer() : socket_(LoopbackUdp()), port_(PortOf(socket_)) {}
    ~EchoServer() { closesocket(socket_); }
    EchoServer(const EchoServer&) = delete;
    EchoServer& operator=(const EchoServer&) = delete;

    [[nodiscard]] std::uint16_t port() const { return port_; }
    [[nodiscard]] const std::set<std::uint16_t>& sources() const { return sources_; }
    void pump() {
        std::array<char, 4096> buffer{};
        while (true) {
            sockaddr_in source{};
            int length = sizeof(source);
            const int received = recvfrom(socket_, buffer.data(), static_cast<int>(buffer.size()), 0,
                reinterpret_cast<sockaddr*>(&source), &length);
            if (received <= 0) break;
            sources_.insert(ntohs(source.sin_port));
            sendto(socket_, buffer.data(), received, 0, reinterpret_cast<const sockaddr*>(&source), length);
        }
    }

private:
    SOCKET socket_;
    std::uint16_t port_;
    std::set<std::uint16_t> sources_;
};

// A game client: a UDP socket that talks to a joiner session's local port.
class GameClient final {
public:
    GameClient() : socket_(LoopbackUdp()) {}
    ~GameClient() { closesocket(socket_); }
    GameClient(const GameClient&) = delete;
    GameClient& operator=(const GameClient&) = delete;

    bool roundtrip(std::uint16_t joiner_port, const std::vector<std::uint8_t>& payload,
        const std::function<void()>& pump, std::chrono::milliseconds limit = std::chrono::seconds(4)) {
        SendTo(socket_, joiner_port, payload);
        std::vector<std::uint8_t> reply;
        const bool got = PumpUntil(limit, pump, [&]() {
            std::array<std::uint8_t, 4096> buffer{};
            const int received = recv(socket_, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);
            if (received > 0) reply.assign(buffer.begin(), buffer.begin() + received);
            return !reply.empty();
        });
        return got && reply == payload;
    }

private:
    SOCKET socket_;
};

// ---- abi ---------------------------------------------------------------------------------------------------------

template <typename Function>
Function Proc(HMODULE module, const char* name) {
    return reinterpret_cast<Function>(GetProcAddress(module, name));
}

int RunAbi() {
    std::cout << "abi\n";
    const std::wstring dll = (ExeDirectory() / L"ParadoxTransport.dll").wstring();
    HMODULE module = LoadLibraryW(dll.c_str());
    Check(module != nullptr, "loads ParadoxTransport.dll");
    if (!module) return 0;
    const char* abi2_names[] = { "MysticTransport_AbiVersion", "MysticTransport_Initialize", "MysticTransport_Shutdown",
        "MysticTransport_PeerId", "MysticTransport_NetworkingReady", "MysticTransport_StartHost",
        "MysticTransport_StartJoin", "MysticTransport_StartHostV2", "MysticTransport_StartJoinV2",
        "MysticTransport_WaitReady", "MysticTransport_SessionRunning", "MysticTransport_LastSessionResult",
        "MysticTransport_StopSession", "MysticTransport_ReadDiagnostic", "MysticTransport_ReadSignal",
        "MysticTransport_SubmitSignal", "MysticTransport_ReadPeerEvent" };
    bool all = true;
    for (const char* name : abi2_names) all = all && GetProcAddress(module, name) != nullptr;
    Check(all, "exports every ABI 2 function");
    const char* abi3_names[] = { "MysticTransport_HostOpen", "MysticTransport_JoinOpen", "MysticTransport_WaitReadyH",
        "MysticTransport_SessionRunningH", "MysticTransport_StopSessionH", "MysticTransport_ReadSignalH",
        "MysticTransport_SubmitSignalH", "MysticTransport_ReadPeerEventH", "MysticTransport_ReadDiagnosticH",
        "MysticTransport_AddPeerH", "MysticTransport_RemovePeerH", "MysticTransport_LastSessionResultH" };
    all = true;
    for (const char* name : abi3_names) all = all && GetProcAddress(module, name) != nullptr;
    Check(all, "exports every ABI 3 function");

    using AbiVersion = int(__cdecl*)();
    using Initialize = int(__cdecl*)(char*, std::uint32_t);
    using Shutdown = void(__cdecl*)();
    using PeerIdFn = std::uint64_t(__cdecl*)();
    using StartHostV1 = int(__cdecl*)(const char*, const char*, const char*, const char*, char*, std::uint32_t);
    using Submit = int(__cdecl*)(const char*, const char*, const char*);
    using StartHostV2 = int(__cdecl*)(const char*, const char*, const char*, const char*, const char*, char*, std::uint32_t);
    using StartJoin = int(__cdecl*)(const char*, const char*, const char*, const char*, char*, std::uint32_t);
    using WaitReady = int(__cdecl*)(std::uint32_t, char*, std::uint32_t);
    using NoArgInt = int(__cdecl*)();
    using NoArgVoid = void(__cdecl*)();
    using ReadLine = int(__cdecl*)(char*, std::uint32_t);
    using ReadSignal = int(__cdecl*)(char*, std::uint32_t, char*, std::uint32_t, char*, std::uint32_t);
    using HandleInt = int(__cdecl*)(int);
    using WaitReadyH = int(__cdecl*)(int, std::uint32_t, char*, std::uint32_t);
    using ReadLineH = int(__cdecl*)(int, char*, std::uint32_t);
    using ReadSignalH = int(__cdecl*)(int, char*, std::uint32_t, char*, std::uint32_t, char*, std::uint32_t);
    using SubmitH = int(__cdecl*)(int, const char*, const char*, const char*);
    using AddPeerH = int(__cdecl*)(int, const char*, std::uint64_t, const char*);
    using RemovePeerH = int(__cdecl*)(int, const char*, const char*);

    const auto version = Proc<AbiVersion>(module, "MysticTransport_AbiVersion");
    const auto initialize = Proc<Initialize>(module, "MysticTransport_Initialize");
    const auto shutdown = Proc<Shutdown>(module, "MysticTransport_Shutdown");
    const auto peer = Proc<PeerIdFn>(module, "MysticTransport_PeerId");
    const auto start_v1 = Proc<StartHostV1>(module, "MysticTransport_StartHost");
    const auto submit = Proc<Submit>(module, "MysticTransport_SubmitSignal");
    const auto start_host_v2 = Proc<StartHostV2>(module, "MysticTransport_StartHostV2");
    const auto start_join_v2 = Proc<StartJoin>(module, "MysticTransport_StartJoinV2");
    const auto wait_ready = Proc<WaitReady>(module, "MysticTransport_WaitReady");
    const auto session_running = Proc<NoArgInt>(module, "MysticTransport_SessionRunning");
    const auto last_result = Proc<NoArgInt>(module, "MysticTransport_LastSessionResult");
    const auto stop_session = Proc<NoArgVoid>(module, "MysticTransport_StopSession");
    const auto read_diagnostic = Proc<ReadLine>(module, "MysticTransport_ReadDiagnostic");
    const auto read_signal = Proc<ReadSignal>(module, "MysticTransport_ReadSignal");
    const auto host_open = Proc<StartHostV2>(module, "MysticTransport_HostOpen");
    const auto join_open = Proc<StartJoin>(module, "MysticTransport_JoinOpen");
    const auto wait_ready_h = Proc<WaitReadyH>(module, "MysticTransport_WaitReadyH");
    const auto running_h = Proc<HandleInt>(module, "MysticTransport_SessionRunningH");
    const auto stop_h = Proc<HandleInt>(module, "MysticTransport_StopSessionH");
    const auto result_h = Proc<HandleInt>(module, "MysticTransport_LastSessionResultH");
    const auto read_signal_h = Proc<ReadSignalH>(module, "MysticTransport_ReadSignalH");
    const auto submit_h = Proc<SubmitH>(module, "MysticTransport_SubmitSignalH");
    const auto read_event_h = Proc<ReadLineH>(module, "MysticTransport_ReadPeerEventH");
    const auto read_diagnostic_h = Proc<ReadLineH>(module, "MysticTransport_ReadDiagnosticH");
    const auto add_peer_h = Proc<AddPeerH>(module, "MysticTransport_AddPeerH");
    const auto remove_peer_h = Proc<RemovePeerH>(module, "MysticTransport_RemovePeerH");
    if (!version || !initialize || !shutdown || !peer || !start_v1 || !submit || !start_host_v2 || !start_join_v2 ||
        !wait_ready || !session_running || !last_result || !stop_session || !read_diagnostic || !read_signal ||
        !host_open || !join_open || !wait_ready_h || !running_h || !stop_h || !result_h || !read_signal_h || !submit_h ||
        !read_event_h || !read_diagnostic_h || !add_peer_h || !remove_peer_h) {
        FreeLibrary(module);
        return 0;
    }
    char error[256]{};
    Check(version() == 3, "reports ABI 3");
    Check(initialize(error, sizeof(error)) == 1 && peer() != 0, "initializes with a peer id");
    Check(start_v1("a", "b", "c", "d", error, sizeof(error)) == 0 && std::strstr(error, "ABI 2") != nullptr,
        "refuses the version 1 host start");
    Check(submit("acct-1", "DESCRIPTION", "a=ice-ufrag:x") == 0, "refuses signals without a session");

    // Handles that do not exist answer without side effects.
    char buffer[256]{};
    char to[128]{};
    char kind[40]{};
    char data[4200]{};
    Check(wait_ready_h(999, 10, buffer, sizeof(buffer)) == -1 && running_h(999) == 0 && stop_h(999) == 0 &&
            result_h(999) == -1 && read_event_h(999, buffer, sizeof(buffer)) == 0 &&
            read_diagnostic_h(999, buffer, sizeof(buffer)) == 0 &&
            read_signal_h(999, to, sizeof(to), kind, sizeof(kind), data, sizeof(data)) == 0 &&
            submit_h(999, "acct-1", "DESCRIPTION", "a=ice-ufrag:x") == 0,
        "an unknown handle is refused everywhere");
    Check(add_peer_h(999, "acct-1", 5, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") == 0 &&
            remove_peer_h(999, "acct-1", "x") == 0,
        "AddPeerH and RemovePeerH refuse an unknown handle");
    Check(wait_ready(10, buffer, sizeof(buffer)) == 0 && session_running() == 0 && last_result() == 0 &&
            read_diagnostic(buffer, sizeof(buffer)) == 0,
        "ABI 2 reads with no session are quiet");

    // Opening: missing inputs fail at once; missing files fail on the session thread, readable through the handle.
    Check(host_open(nullptr, "c", "k", nullptr, "s", error, sizeof(error)) == 0 && Contains(error, "missing"),
        "HostOpen without a key path fails with a message");
    Check(join_open("k", "c", nullptr, "s", error, sizeof(error)) == 0 && Contains(error, "missing"),
        "JoinOpen without a ticket path fails with a message");
    ModuleRig rig("abi");
    Check(rig.ok(), "writes the test signing key");
    const int broken = host_open(rig.key_path().c_str(), rig.path("no-such.conf").c_str(), rig.path("no-such.cap").c_str(),
        nullptr, rig.path("no-such.secret").c_str(), error, sizeof(error));
    Check(broken > 0, "HostOpen returns a handle for a host whose files turn out unusable");
    Check(wait_ready_h(broken, 10000, buffer, sizeof(buffer)) == -1, "the failed host ends before readiness");
    bool saw_failure = false;
    while (read_diagnostic_h(broken, buffer, sizeof(buffer)) == 1) saw_failure = saw_failure || Contains(buffer, "HOST CONFIG FAIL");
    Check(saw_failure && running_h(broken) == 0 && result_h(broken) == 2, "its diagnostics and result code explain it");
    Check(stop_h(broken) == 1, "StopSessionH releases it");

    // ABI 2 and ABI 3 side by side, through joiner sessions (they need no backend: the host never answers).
    const SessionBindings bindings{ "test-key", SessionId(21), "party-1", "hunt-1", "bridge-1", 1, 1001, 3, 647472, 1, 1 };
    const auto key = RandomKey();
    rig.write("join.conf", JoinConfigText(bindings, "join-account", 2002, "host-account", RelaySetup{}));
    rig.write("join.secret", PeerLine("host-account", 1001, key));
    rig.write("join.ticket", rig.signer.ticket(bindings, "join-account", 2002));
    const std::string key_path = rig.key_path();
    const std::string config = rig.path("join.conf");
    const std::string ticket = rig.path("join.ticket");
    const std::string secrets = rig.path("join.secret");
    Check(start_join_v2(key_path.c_str(), config.c_str(), ticket.c_str(), secrets.c_str(), error, sizeof(error)) == 1 &&
            session_running() == 1,
        "ABI 2 StartJoinV2 starts the default session");
    bool signalled = PumpUntil(std::chrono::seconds(5), [] {}, [&]() {
        return read_signal(to, sizeof(to), kind, sizeof(kind), data, sizeof(data)) == 1;
    });
    Check(signalled && std::string_view(to) == "host-account" && std::string_view(kind) == "DESCRIPTION",
        "ABI 2 ReadSignal returns the joiner's description for the host");
    Check(start_join_v2(key_path.c_str(), config.c_str(), ticket.c_str(), secrets.c_str(), error, sizeof(error)) == 0 &&
            Contains(error, "already running"),
        "a second ABI 2 start is refused while the first runs");
    const int handle = join_open(key_path.c_str(), config.c_str(), ticket.c_str(), secrets.c_str(), error, sizeof(error));
    Check(handle > 0 && running_h(handle) == 1 && session_running() == 1, "an ABI 3 session runs beside the ABI 2 session");
    signalled = PumpUntil(std::chrono::seconds(5), [] {}, [&]() {
        return read_signal_h(handle, to, sizeof(to), kind, sizeof(kind), data, sizeof(data)) == 1;
    });
    Check(signalled && std::string_view(kind) == "DESCRIPTION", "ReadSignalH returns that session's description");
    Check(submit_h(handle, "host-account", "GATHERING_DONE", "-") == 1 && submit_h(handle, "bad account", "GATHERING_DONE", "-") == 0 &&
            submit_h(handle, "host-account", "BOGUS", "-") == 0,
        "SubmitSignalH takes a well-formed signal and refuses a malformed one");
    Check(add_peer_h(handle, "acct-1", 5, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") == 0,
        "a joiner session has no roster to add to");
    stop_session();
    Check(session_running() == 0 && running_h(handle) == 1, "StopSession stops only the default session");
    Check(stop_h(handle) == 1 && running_h(handle) == 0 && result_h(handle) == 0, "StopSessionH stops its own session");
    Check(start_join_v2(key_path.c_str(), config.c_str(), ticket.c_str(), secrets.c_str(), error, sizeof(error)) == 1 &&
            session_running() == 1,
        "a new ABI 2 start replaces the finished default session");
    shutdown();
    Check(session_running() == 0, "Shutdown stops the default session");
    // A version 2 host start is refused without a ticket path (a version 2 host always plays its own client).
    Check(start_host_v2(key_path.c_str(), config.c_str(), secrets.c_str(), nullptr, secrets.c_str(), error, sizeof(error)) == 0,
        "StartHostV2 still needs its ticket path");
    FreeLibrary(module);
    return 0;
}

// ---- session, through the module ---------------------------------------------------------------------------------

int RunModuleSessions() {
    std::cout << "session through the module (a hub and a hunt on one host, a joiner in both)\n";
    WinsockRuntime winsock;
    ModuleRig rig("modules");
    Check(rig.ok(), "writes the test signing key");
    rig.write("capability.txt", std::string(43, 'A'));
    EchoServer hub_echo;
    EchoServer hunt_echo;
    TransportModule host_module(SharedBackend(rig.backend));
    TransportModule join_module;
    const std::string host_account = "host-account";
    const std::string join_account = "join-account";
    constexpr PeerId kJoiner = 2002;
    const SessionBindings hub_bindings{ "test-key", SessionId(11), "realmhub:realm-1:ramsgate",
        "ShatteredIsles_ReturnToRamsgate", "bridge-hub", 1, 1001, 3, 647472, 1, 1 };
    const SessionBindings hunt_bindings{ "test-key", SessionId(12), "party-1", "hunt-1", "bridge-hunt", 1, 1001, 3,
        647472, 1, 1 };
    const auto hub_key = RandomKey();
    const auto hunt_key = RandomKey();

    // The hub: a HUB role without the host's own client, its joiner added at run time.
    rig.write("hub.conf", HostConfigText(HostSpec{ hub_bindings, "HUB", false, 3, hub_echo.port(), {}, {} }));
    rig.write("hub.secret", "");
    // The hunt: a HUNT role with the host's client and its joiner named in the secrets file, as ABI 2 always did.
    const std::string hunt_pipe = "selftest-guard-hunt-" + std::to_string(GetCurrentProcessId());
    rig.write("hunt.conf", HostConfigText(HostSpec{ hunt_bindings, "HUNT", true, 2, hunt_echo.port(), {}, hunt_pipe }));
    rig.write("hunt.secret", PeerLine(join_account, kJoiner, hunt_key));
    rig.write("hunt.ticket", rig.signer.ticket(hunt_bindings, host_account, hunt_bindings.host_peer_id));
    const std::string key_path = rig.key_path();
    const std::string capability = rig.path("capability.txt");
    char error[256]{};
    const int hub = host_module.host_open(key_path.c_str(), rig.path("hub.conf").c_str(), capability.c_str(), nullptr,
        rig.path("hub.secret").c_str(), error, sizeof(error));
    const int hunt = host_module.host_open(key_path.c_str(), rig.path("hunt.conf").c_str(), capability.c_str(),
        rig.path("hunt.ticket").c_str(), rig.path("hunt.secret").c_str(), error, sizeof(error));
    Check(hub > 0 && hunt > 0 && hub != hunt, "one module hosts a hub and a hunt at once");
    if (hub <= 0 || hunt <= 0) return 0;
    char hub_line[512]{};
    char hunt_line[512]{};
    Check(host_module.wait_ready(hub, 15000, hub_line, sizeof(hub_line)) == 1 && Contains(hub_line, "localPort=0 ") &&
            Contains(hub_line, "peers=0"),
        "the hub reports localPort=0 and no peers");
    Check(host_module.wait_ready(hunt, 15000, hunt_line, sizeof(hunt_line)) == 1 && LocalPortOf(hunt_line) > 0 &&
            Contains(hunt_line, "peers=1"),
        "the hunt reports its local port and its peer");
    Check(rig.backend.host_ready_published(hub_bindings.session_id) && rig.backend.host_ready_published(hunt_bindings.session_id),
        "each host announced itself to its own session");
    Check(host_module.add_peer(hub, join_account.c_str(), kJoiner, KeyText(hub_key).c_str()) == 1,
        "AddPeerH queues the joiner for the hub");
    Check(host_module.add_peer(hunt, join_account.c_str(), kJoiner, KeyText(hunt_key).c_str()) == 0,
        "AddPeerH refuses an account the secrets file already named");
    Check(host_module.add_peer(hub, "bad account!", 77, KeyText(hub_key).c_str()) == 0 &&
            host_module.add_peer(hub, "other-account", 0, KeyText(hub_key).c_str()) == 0 &&
            host_module.add_peer(hub, "other-account", 77, "short") == 0,
        "AddPeerH refuses a malformed account, peer id or key");

    // The joiner's PC: one module, a join into the hub and a join into the hunt, started together.
    const int join_hub = OpenJoin(join_module, rig, "hub", hub_bindings, join_account, kJoiner, host_account, hub_key, {});
    const int join_hunt = OpenJoin(join_module, rig, "hunt", hunt_bindings, join_account, kJoiner, host_account, hunt_key, {});
    Check(join_hub > 0 && join_hunt > 0 && join_hub != join_hunt && join_module.session_running(join_hub) == 1 &&
            join_module.session_running(join_hunt) == 1,
        "one module joins a hub and a hunt at once");
    if (join_hub <= 0 || join_hunt <= 0) return 0;
    const std::vector<Route> routes{
        Route{ &host_module, hub, host_account, &join_module, join_hub, join_account },
        Route{ &host_module, hunt, host_account, &join_module, join_hunt, join_account } };
    Feed hub_feed;
    Feed hunt_feed;
    const auto pump = [&]() {
        CarrySignals(routes);
        hub_echo.pump();
        hunt_echo.pump();
        hub_feed.drain(host_module, hub);
        hunt_feed.drain(host_module, hunt);
    };
    char hub_join_line[512]{};
    char hunt_join_line[512]{};
    const bool both_ready = PumpUntil(std::chrono::seconds(30), pump, [&]() {
        return join_module.wait_ready(join_hub, 0, hub_join_line, sizeof(hub_join_line)) == 1 &&
            join_module.wait_ready(join_hunt, 0, hunt_join_line, sizeof(hunt_join_line)) == 1;
    });
    Check(both_ready, "both joins reach ROUTE_READY");
    if (!both_ready) return 0;
    Check(Contains(hub_join_line, "session=" + hub_bindings.session_id) &&
            Contains(hunt_join_line, "session=" + hunt_bindings.session_id) &&
            LocalPortOf(hub_join_line) != LocalPortOf(hunt_join_line),
        "each join has its own session and its own local port");
    GameClient hub_client;
    GameClient hunt_client;
    Check(hub_client.roundtrip(LocalPortOf(hub_join_line), Pattern(700, 1), pump), "game traffic flows through the hub");
    Check(hunt_client.roundtrip(LocalPortOf(hunt_join_line), Pattern(900, 2), pump), "game traffic flows through the hunt");
    Check(hub_echo.sources().size() == 1 && hunt_echo.sources().size() == 1,
        "each game server saw exactly one bridged peer");
    Check(hub_feed.count_events("PEER_ADMITTED account=join-account") == 1 &&
            hunt_feed.count_events("PEER_ADMITTED account=join-account") == 1,
        "each host session reported the admission with the account");
    const auto consumes = rig.backend.consume_log();
    int hub_consumes = 0;
    int hunt_consumes = 0;
    bool host_consumed_locally = false;
    for (const auto& consume : consumes) {
        if (consume.session_id == hub_bindings.session_id) ++hub_consumes;
        if (consume.session_id == hunt_bindings.session_id) ++hunt_consumes;
        if (consume.session_id == hunt_bindings.session_id && consume.peer_id == hunt_bindings.host_peer_id &&
            consume.connection_handle == "localhost") {
            host_consumed_locally = true;
        }
    }
    Check(hub_consumes == 1 && hunt_consumes == 2 && host_consumed_locally,
        "the hub consumed the joiner only; the hunt also consumed the host's own ticket");
    Check(PumpUntil(std::chrono::seconds(8), pump, [&]() { return rig.backend.last_admitted(hub_bindings.session_id) == 1; }),
        "the hub's lease heartbeat reports one admitted peer");

    // Wrong calls.
    Check(join_module.add_peer(join_hub, "other-account", 77, KeyText(hub_key).c_str()) == 0 &&
            host_module.remove_peer(hunt, "nobody", "x") == 0 && host_module.remove_peer(999, "nobody", "x") == 0,
        "no roster change on a joiner, for an unknown account or an unknown handle");

    // The 8-session limit and what a stopped session leaves readable.
    std::vector<int> extra;
    for (int index = 0; index < 6; ++index) {
        extra.push_back(host_module.host_open(key_path.c_str(), rig.path("hub.conf").c_str(), capability.c_str(), nullptr,
            rig.path("hub.secret").c_str(), error, sizeof(error)));
    }
    Check(std::all_of(extra.begin(), extra.end(), [](int handle) { return handle > 0; }), "the host module runs 8 sessions");
    for (const int handle : extra) {
        if (handle > 0) (void)host_module.wait_ready(handle, 15000, hub_line, sizeof(hub_line));
    }
    const int ninth = host_module.host_open(key_path.c_str(), rig.path("hub.conf").c_str(), capability.c_str(), nullptr,
        rig.path("hub.secret").c_str(), error, sizeof(error));
    Check(ninth == 0 && Contains(error, "At most 8"), "a ninth concurrent session is refused with a message");
    Check(extra[0] > 0 && host_module.stop_session(extra[0]) == 1 && host_module.session_running(extra[0]) == 0,
        "StopSessionH stops one session");
    char line[1100]{};
    Check(host_module.read_diagnostic(extra[0], line, sizeof(line)) == 1, "a stopped session's diagnostics stay readable");
    const int tenth = host_module.host_open(key_path.c_str(), rig.path("hub.conf").c_str(), capability.c_str(), nullptr,
        rig.path("hub.secret").c_str(), error, sizeof(error));
    Check(tenth > 0, "a stopped session gives its place to a new one");
    for (const int handle : extra) (void)host_module.stop_session(handle);
    if (tenth > 0) (void)host_module.stop_session(tenth);

    // The host config rules of ABI 3: maximum_peers 64 only for a hub, a closed set of roles, a ticket unless the host
    // plays no client.
    int rule_number = 0;
    // 1 when the host became ready, -1 when it ended first (its diagnostics must then say the configuration failed).
    const auto try_host = [&](HostSpec spec, bool with_ticket, const std::string& from = {}, const std::string& to = {}) {
        spec.server_port = hub_echo.port();
        std::string text = HostConfigText(spec);
        if (!from.empty()) text.replace(text.find(from), from.size(), to);
        rig.write("rule.conf", text);
        const int handle = host_module.host_open(key_path.c_str(), rig.path("rule.conf").c_str(), capability.c_str(),
            with_ticket ? rig.path("hunt.ticket").c_str() : nullptr, rig.path("hub.secret").c_str(), error, sizeof(error));
        if (handle <= 0) return 0;
        char ready_line[512]{};
        const int state = host_module.wait_ready(handle, 15000, ready_line, sizeof(ready_line));
        bool config_failure = false;
        char diagnostic_line[1100]{};
        while (host_module.read_diagnostic(handle, diagnostic_line, sizeof(diagnostic_line)) == 1) {
            config_failure = config_failure || Contains(diagnostic_line, "HOST CONFIG FAIL");
        }
        (void)host_module.stop_session(handle);
        return state == 1 ? 1 : (config_failure ? -1 : -2);
    };
    const auto rule_spec = [&](const std::string& role, bool local_client, std::size_t maximum) {
        // The ticket in hunt.ticket is signed for the hunt's session.
        HostSpec spec{ role == "HUNT" ? hunt_bindings : hub_bindings, role, local_client, maximum, 1, {}, {} };
        if (local_client) spec.guard_pipe = "selftest-guard-rule-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(++rule_number);
        return spec;
    };
    Check(try_host(rule_spec("HUB", false, 64), false) == 1, "a hub may hold 64 peers");
    Check(try_host(rule_spec("HUB", false, 65), false) == -1, "a hub may not hold 65");
    Check(try_host(rule_spec("HUNT", true, 4), true) == 1, "a hunt may hold 4 peers");
    Check(try_host(rule_spec("HUNT", true, 5), true) == -1 && try_host(rule_spec("HUNT", false, 5), false) == -1,
        "a hunt may not hold 5, with or without the host's client");
    Check(try_host(rule_spec("BOGUS", false, 4), false) == -1, "an unknown session_role is refused");
    Check(try_host(rule_spec("HUB", false, 4), false, "host_local_client=0", "host_local_client=2") == -1,
        "host_local_client must be 0 or 1");
    Check(try_host(rule_spec("HUNT", true, 4), false) == -1, "a host with a local client needs its ticket");
    Check(try_host(rule_spec("HUB", false, 4), true) == 1, "a ticket given to a host without a local client is ignored");
    Check(try_host(rule_spec("HUNT", true, 4), true, "session_role=HUNT\n", "") == 1 &&
            try_host(rule_spec("HUNT", true, 5), true, "session_role=HUNT\n", "") == -1,
        "an absent session_role means HUNT");

    // ABI 2 on the default handle: one session at a time.
    rig.write("legacy.conf", HostConfigText(HostSpec{ hunt_bindings, "HUNT", true, 2, hunt_echo.port(), {},
        "selftest-guard-legacy-" + std::to_string(GetCurrentProcessId()) }));
    rig.write("legacy.secret", "");
    const auto start_legacy = [&]() {
        return host_module.start_host_v2(key_path.c_str(), rig.path("legacy.conf").c_str(), capability.c_str(),
            rig.path("hunt.ticket").c_str(), rig.path("legacy.secret").c_str(), error, sizeof(error));
    };
    Check(start_legacy() == 1 && host_module.default_handle() > 0 &&
            host_module.wait_ready(host_module.default_handle(), 15000, line, sizeof(line)) == 1 && LocalPortOf(line) > 0,
        "StartHostV2 starts the default session (the hunt shape: local client, ticket)");
    Check(start_legacy() == 0 && Contains(error, "already running"), "a second StartHostV2 is refused while it runs");
    const int first_default = host_module.default_handle();
    (void)host_module.stop_session(first_default);
    Check(start_legacy() == 1 && host_module.default_handle() != first_default,
        "a new StartHostV2 replaces the stopped default session");
    (void)host_module.stop_session(host_module.default_handle());

    // Teardown: stopping a session keeps its last events readable and tells the backend about the admitted peers.
    (void)join_module.stop_session(join_hub);
    (void)join_module.stop_session(join_hunt);
    Check(host_module.stop_session(hub) == 1 && host_module.stop_session(hunt) == 1 &&
            host_module.session_running(hub) == 0 && host_module.last_session_result(hub) == 0 &&
            host_module.last_session_result(hunt) == 0,
        "stopping the hub and the hunt ends them cleanly");
    hub_feed.drain(host_module, hub);
    hunt_feed.drain(host_module, hunt);
    Check(hub_feed.count_events("PEER_LOST account=join-account reason=host_stopped") == 1 &&
            hunt_feed.count_events("PEER_LOST account=join-account reason=host_stopped") == 1,
        "the last events are readable after the stop");
    Check(rig.backend.disconnect_count() == 2, "each admitted peer was reported disconnected once");
    return 0;
}

// ---- hub ---------------------------------------------------------------------------------------------------------

// The held-signal rules of IceHostSession on their own: the 20 s window is shortened to 400 ms for the test.
void RunHeldSignalRules() {
    std::cout << "  held signals (the session class)\n";
    FakeBackend backend;
    auto transport = std::make_shared<IceMessageTransport>();
    AdmissionTicketVerifier verifier;
    const SessionBindings bindings{ "test-key", SessionId(5), "party-1", "hunt-1", "bridge-1", 1, 1001, 3, 647472, 1, 1 };
    SessionLimits limits{ 8, std::chrono::seconds(20), false, false };
    limits.hub = true;
    limits.held_signal_ttl = std::chrono::milliseconds(400);
    std::vector<std::string> diagnostics;
    std::vector<std::pair<std::string, std::string>> sent;   // (account, kind) the host sent out
    std::vector<std::string> events;
    IceHostSession host(IceServerConfig{}, {}, transport, verifier, backend, bindings, limits,
        [&sent](std::string_view to, std::string_view kind, std::string_view) { sent.emplace_back(to, kind); },
        [&events](std::string_view line) { events.emplace_back(line); },
        [&diagnostics](std::string_view line) { diagnostics.emplace_back(line); });
    const auto diagnostic_count = [&diagnostics](std::string_view needle) {
        return static_cast<int>(std::count_if(diagnostics.begin(), diagnostics.end(),
            [needle](const std::string& line) { return Contains(line, needle); }));
    };

    // A real joiner description, so a replay can open a real link.
    const auto key = RandomKey();
    IceLink joiner(IceServerConfig{}, false, false);
    std::string error;
    Check(joiner.start(key, error), "a probe joiner link starts");
    std::string description;
    for (const auto& signal : joiner.take_signals()) {
        if (signal.kind == "DESCRIPTION") description = signal.data;
    }
    Check(!description.empty(), "the probe link produced a description");

    host.apply_signal("late-account", "DESCRIPTION", description);
    host.apply_signal("late-account", "GATHERING_DONE", "-");
    host.apply_signal("late-account", "GATHERING_DONE", "-");
    Check(host.stats().signals_rejected == 0 && diagnostic_count("ICE_SIGNAL_HELD") == 1 && sent.empty(),
        "signals from an account that is not on the roster are held, not rejected");
    Check(host.add_peer(IcePeerConfig{ "late-account", 3001, key }, error), "add_peer adds the account");
    Check(diagnostic_count("ICE_SIGNAL_REPLAYED role=host peer=3001 count=3") == 1,
        "the three held signals are replayed on add_peer");
    host.pump_once();
    Check(std::any_of(sent.begin(), sent.end(), [](const auto& entry) { return entry.first == "late-account" && entry.second == "DESCRIPTION"; }),
        "the replayed description opened a link that answers");
    Check(host.peer_count() == 1 && host.stats().signals_rejected == 0, "nothing was rejected");

    // Held signals expire, at most 16 per account are kept, and the number of waiting accounts is bounded.
    for (int index = 0; index < 20; ++index) host.apply_signal("ghost-account", "CANDIDATE", "a=candidate:x");
    Check(host.stats().signals_rejected == 4 && diagnostic_count("held_signals_full") == 1,
        "at most 16 signals are held per account");
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    host.pump_once();
    Check(diagnostic_count("ICE_SIGNAL_EXPIRED role=host reason=unknown_peer count=16") == 1 && host.stats().signals_rejected == 20,
        "held signals expire after the window and are dropped with a diagnostic");
    Check(host.add_peer(IcePeerConfig{ "ghost-account", 3002, key }, error) && diagnostic_count("peer=3002") == 1,
        "an expired signal is not replayed");
    for (int index = 0; index < 70; ++index) host.apply_signal("account-" + std::to_string(index), "CANDIDATE", "a=candidate:x");
    Check(host.stats().signals_rejected == 26, "at most 64 accounts have signals waiting");

    // The roster.
    Check(!host.remove_peer("never-added", "x"), "remove_peer says no for an unknown account");
    std::string reason;
    Check(!host.add_peer(IcePeerConfig{ "late-account", 3009, key }, reason) && reason == "duplicate_account", "duplicate account");
    Check(!host.add_peer(IcePeerConfig{ "fresh-account", 3001, key }, reason) && reason == "duplicate_peer", "duplicate peer id");
    Check(!host.add_peer(IcePeerConfig{ "fresh-account", 1001, key }, reason) && reason == "invalid_peer", "the host's own peer id");
    bool filled = true;
    for (int index = 0; index < 6; ++index) {
        filled = host.add_peer(IcePeerConfig{ "member-" + std::to_string(index), static_cast<PeerId>(4000 + index), key }, reason) && filled;
    }
    Check(filled && host.peer_count() == 8, "add_peer fills the roster up to maximum_peers");
    Check(!host.add_peer(IcePeerConfig{ "one-too-many", 4999, key }, reason) && reason == "full", "a full roster says full");
    Check(host.remove_peer("member-0", "left"), "remove_peer frees a place");
    Check(events.size() == 1 && events[0] == "PEER_REMOVED account=member-0 reason=left admitted=0",
        "removing an unconnected peer emits PEER_REMOVED");
    Check(host.add_peer(IcePeerConfig{ "member-0", 4000, key }, reason), "the same account can be added again");
    host.stop();
}

struct Member {
    std::string account;
    PeerId peer_id = 0;
    std::array<std::uint8_t, 32> key{};
    int join_handle = 0;
    std::uint16_t local_port = 0;
};

int RunHub(bool relay_local) {
    std::cout << "hub " << (relay_local ? "(local relay, relay only)" : "(direct)") << '\n';
    RunHeldSignalRules();

    WinsockRuntime winsock;
    RelaySetup relay;
    juice_server_t* turn_server = nullptr;
    if (relay_local) {
        // The relay lives on 127.0.0.2 while the agents use 127.0.0.1: TURN permissions are per IP address, so on one
        // address (as in the ice test) a direct path also works and the host may legitimately pick a non-relay pair.
        // With two addresses only relay-to-relay pairs exist, as with a real relay.
        juice_server_credentials_t credentials{};
        credentials.username = "paradox-selftest";
        credentials.password = "paradox-selftest-password";
        juice_server_config_t config{};
        config.credentials = &credentials;
        config.credentials_count = 1;
        config.max_allocations = 64;
        config.bind_address = "127.0.0.2";
        config.port = 0;
        config.realm = "paradox-selftest";
        turn_server = juice_server_create(&config);
        Check(turn_server != nullptr, "starts a local relay");
        if (!turn_server) return 0;
        relay.turn_port = juice_server_get_port(turn_server);
    }

    {
        ModuleRig rig("hub");
        Check(rig.ok(), "writes the test signing key");
        rig.write("capability.txt", std::string(43, 'A'));
        EchoServer echo;
        TransportModule host_module(SharedBackend(rig.backend));
        TransportModule join_module;
        const std::string host_account = "host-account";
        constexpr std::size_t kRoster = 6;
        const SessionBindings bindings{ "test-key", SessionId(31), "realmhub:realm-1:ramsgate",
            "ShatteredIsles_ReturnToRamsgate", "bridge-hub", 1, 1001, 3, 647472, 1, 1 };
        // maximum_peers is 6, so a seventh admitted player only works if a removed player's bridge slot was freed.
        rig.write("hub.conf", HostConfigText(HostSpec{ bindings, "HUB", false, kRoster, echo.port(), relay, {} }));
        rig.write("hub.secret", RelaySecretText(relay));
        char error[256]{};
        const std::string key_path = rig.key_path();
        const int host = host_module.host_open(key_path.c_str(), rig.path("hub.conf").c_str(),
            rig.path("capability.txt").c_str(), nullptr, rig.path("hub.secret").c_str(), error, sizeof(error));
        Check(host > 0, "HostOpen starts a hub host");
        if (host <= 0) {
            if (turn_server) juice_server_destroy(turn_server);
            return 0;
        }
        char line[512]{};
        Check(host_module.wait_ready(host, 15000, line, sizeof(line)) == 1 && Contains(line, "localPort=0 ") &&
                Contains(line, "peers=0") && Contains(line, relay.enabled() ? "routePolicy=RELAY_ONLY" : "routePolicy=AUTOMATIC"),
            "the hub is ready with no peers and no local client");

        std::vector<Route> routes;
        Feed feed;
        std::map<std::string, std::unique_ptr<GameClient>> clients;
        const auto pump = [&]() {
            CarrySignals(routes);
            echo.pump();
            feed.drain(host_module, host);
        };
        const auto make_member = [](const std::string& name, PeerId peer_id) {
            Member member;
            member.account = name;
            member.peer_id = peer_id;
            member.key = RandomKey();
            return member;
        };
        const auto add_to_host = [&](const Member& member) {
            return host_module.add_peer(host, member.account.c_str(), member.peer_id, KeyText(member.key).c_str());
        };
        // Starts the joiner's session and registers its signal route; the caller decides when the host adds it.
        const auto start_join = [&](Member& member, const std::string& tag) {
            member.join_handle = OpenJoin(join_module, rig, tag, bindings, member.account, member.peer_id, host_account,
                member.key, relay);
            if (member.join_handle > 0) {
                routes.push_back(Route{ &host_module, host, host_account, &join_module, member.join_handle, member.account });
            }
            return member.join_handle > 0;
        };
        const auto wait_joined = [&](Member& member, std::chrono::seconds limit) {
            char ready[512]{};
            const bool ok = PumpUntil(limit, pump, [&]() {
                return join_module.wait_ready(member.join_handle, 0, ready, sizeof(ready)) == 1;
            });
            if (ok) member.local_port = LocalPortOf(ready);
            if (!ok) {
                // Bounded, non-secret lines from both sides explain a join that never completed.
                std::cout << "  " << member.account << " did not reach ROUTE_READY; host diagnostics (last 12, no stats):\n";
                std::vector<std::string> shown;
                for (const auto& line : feed.diagnostics) {
                    if (!Contains(line, "UDP_STATS")) shown.push_back(line);
                }
                const std::size_t from = shown.size() > 12 ? shown.size() - 12 : 0;
                for (std::size_t index = from; index < shown.size(); ++index) std::cout << "    host: " << shown[index] << '\n';
                Feed joiner_feed;
                joiner_feed.drain(join_module, member.join_handle);
                for (const auto& line : joiner_feed.diagnostics) std::cout << "    join: " << line << '\n';
            }
            return ok && member.local_port != 0;
        };
        const auto stop_join = [&](Member& member) {
            (void)join_module.stop_session(member.join_handle);
            routes.erase(std::remove_if(routes.begin(), routes.end(),
                [&member](const Route& route) { return route.join_handle == member.join_handle; }), routes.end());
            member.join_handle = 0;
        };
        const auto echo_ok = [&](const Member& member, std::uint8_t seed) {
            auto& client = clients[member.account];
            if (!client) client = std::make_unique<GameClient>();
            return client->roundtrip(member.local_port, Pattern(500 + seed, seed), pump);
        };

        // 0. An add only the session thread can judge (the host's own peer id) is queued, then refused with an event;
        //    commands run in order, so an add followed by a remove leaves the roster as it was.
        Member probe = make_member("probe-account", bindings.host_peer_id);
        Check(add_to_host(probe) == 1, "AddPeerH queues an add the API layer cannot judge");
        Check(PumpUntil(std::chrono::seconds(5), pump, [&]() {
                  return feed.count_events("PEER_ADD_REJECTED account=probe-account reason=invalid_peer") == 1;
              }),
            "the session refused it with PEER_ADD_REJECTED");
        Check(host_module.remove_peer(host, "probe-account", "probe") == 0, "the refused account is not on the roster");
        probe.peer_id = 5900;
        Check(add_to_host(probe) == 1 && host_module.remove_peer(host, "probe-account", "probe") == 1 &&
                PumpUntil(std::chrono::seconds(5), pump, [&]() {
                    return feed.count_events("PEER_REMOVED account=probe-account reason=probe admitted=0") == 1;
                }),
            "an add and a remove queued together run in order");

        // 1. Six players join one after another: the host adds each, then the joiner connects and is admitted.
        gSection = "hub: six joiners join";
        std::vector<Member> members;
        for (std::size_t index = 1; index <= kRoster; ++index) members.push_back(make_member("member-" + std::to_string(index), 5000 + index));
        bool all_joined = true;
        for (Member& member : members) {
            const bool added = add_to_host(member) == 1;
            const bool started = added && start_join(member, member.account + "-a");
            const bool joined = started && wait_joined(member, std::chrono::seconds(30));
            if (!joined) std::cout << "  " << member.account << " did not join (added=" << added << " started=" << started << ")\n";
            all_joined = all_joined && joined;
        }
        Check(all_joined, "six loopback joiners join one after another");
        if (!all_joined) {
            if (turn_server) juice_server_destroy(turn_server);
            return 0;
        }
        for (const Member& member : members) {
            Check(feed.count_events("PEER_CONNECTED account=" + member.account) == 1 &&
                    feed.count_events("PEER_ADMITTED account=" + member.account) == 1,
                ("host events name " + member.account).c_str());
        }
        if (relay.enabled()) {
            Check(feed.count_events("route=relay") >= 12 && feed.count_events("route=direct") == 0, "every route is the relay");
        }
        bool all_echo = true;
        for (std::size_t index = 0; index < members.size(); ++index) {
            all_echo = echo_ok(members[index], static_cast<std::uint8_t>(index + 1)) && all_echo;
        }
        Check(all_echo && echo.sources().size() == kRoster, "every joiner's traffic reaches the game server through its own bridge slot");
        const auto first_log = rig.backend.consume_log();
        Check(first_log.size() == kRoster, "the host consumed six tickets and none for itself");

        // 2. The roster is full; bad adds are refused.
        Member seventh = make_member("member-7", 5007);
        Check(add_to_host(seventh) == 0, "AddPeerH refuses a seventh peer (roster full)");
        Member duplicate_account = members[0];
        duplicate_account.peer_id = 5099;
        Member duplicate_peer = make_member("member-8", members[1].peer_id);
        Check(add_to_host(duplicate_account) == 0 && add_to_host(duplicate_peer) == 0, "duplicate account and duplicate peer id are refused");

        // 3. Remove a player: the link closes, the backend hears about it, the events say who.
        gSection = "hub: removing a player";
        const int disconnects_before = rig.backend.disconnect_count();
        Check(host_module.remove_peer(host, "member-3", "kicked") == 1, "RemovePeerH queues the removal");
        Check(PumpUntil(std::chrono::seconds(5), pump, [&]() {
                  return feed.count_events("PEER_LOST account=member-3 reason=kicked") == 1 &&
                      feed.count_events("PEER_REMOVED account=member-3 reason=kicked admitted=1") == 1;
              }),
            "the host emitted PEER_LOST and PEER_REMOVED with the account");
        Check(PumpUntil(std::chrono::seconds(5), pump, [&]() { return rig.backend.disconnect_count() == disconnects_before + 1; }),
            "the backend was told the admitted peer left");
        Check(host_module.remove_peer(host, "member-3", "again") == 0, "removing the same account twice says no");
        stop_join(members[2]);

        // 4. A joiner that starts before its AddPeer: its signals are held and replayed.
        //    [2026-10-15] Counted from here and for this peer: the check used to accept any earlier ICE_SIGNAL_HELD line and
        //    waited a fixed 1.5 s, so on a slow runner it could pass before the seventh joiner's description had arrived.
        gSection = "hub: a joiner that starts before its AddPeer";
        const int held_before = feed.count_diagnostics("ICE_SIGNAL_HELD");
        Check(start_join(seventh, "member-7-a"), "the seventh joiner starts before the host knows it");
        const bool held = PumpUntil(std::chrono::seconds(10), pump, [&]() { return feed.count_diagnostics("ICE_SIGNAL_HELD") > held_before; });
        char ready[512]{};
        Check(held && join_module.wait_ready(seventh.join_handle, 0, ready, sizeof(ready)) == 0,
            "the host holds its description instead of rejecting it");
        Check(add_to_host(seventh) == 1, "AddPeerH then adds it");
        Check(wait_joined(seventh, std::chrono::seconds(30)), "the held description is replayed and the joiner connects");
        Check(feed.count_diagnostics("ICE_SIGNAL_REPLAYED role=host peer=" + std::to_string(seventh.peer_id)) == 1,
            "the host reported the replay");
        Check(echo_ok(seventh, 7) && echo.sources().size() == kRoster + 1,
            "the seventh player's traffic flows: the removed player's bridge slot was freed");

        // 5. The same account joins again after a remove (fresh link, fresh request ids).
        gSection = "hub: the same account joins again";
        const std::uint64_t second_id = members[1].peer_id;
        stop_join(members[1]);
        Check(host_module.remove_peer(host, "member-2", "rejoin") == 1, "member-2 is removed");
        Check(PumpUntil(std::chrono::seconds(5), pump, [&]() { return feed.count_events("PEER_REMOVED account=member-2") == 1; }),
            "and the host confirms it");
        Check(add_to_host(members[1]) == 1, "the same account is added again");
        Check(start_join(members[1], "member-2-b") && wait_joined(members[1], std::chrono::seconds(30)),
            "it joins again over a fresh link");
        Check(feed.count_events("PEER_ADMITTED account=member-2") == 2, "the host admitted it twice");
        Check(echo_ok(members[1], 22), "traffic flows after the rejoin");

        // 6. A joiner that restarts without being removed (a relaunch): the host replaces its link.
        gSection = "hub: a restarting joiner";
        stop_join(members[4]);
        Check(start_join(members[4], "member-5-b") && wait_joined(members[4], std::chrono::seconds(30)),
            "a restarting joiner replaces its old link");
        Check(feed.count_events("PEER_LOST account=member-5 reason=restarted") == 1 && feed.count_events("PEER_ADMITTED account=member-5") == 2,
            "the host reported the old link lost and admitted the new one");
        Check(echo_ok(members[4], 55), "traffic flows after the restart");

        // 7. Request ids stay unique across all those links, including the rejoins of one account.
        const auto log = rig.backend.consume_log();
        std::set<std::string> request_ids;
        std::set<std::string> handles;
        int member_2_consumes = 0;
        for (const auto& consume : log) {
            request_ids.insert(consume.request_id);
            handles.insert(consume.connection_handle);
            if (consume.peer_id == second_id) ++member_2_consumes;
        }
        Check(log.size() == kRoster + 3 && request_ids.size() == log.size() && handles.size() == log.size() && member_2_consumes == 2,
            "every consume has its own request id and connection handle, also for the same account twice");
        const auto disconnect_ids = rig.backend.disconnect_request_ids();
        Check(std::set<std::string>(disconnect_ids.begin(), disconnect_ids.end()).size() == disconnect_ids.size() && disconnect_ids.size() >= 2,
            "disconnect request ids are unique too");
        Check(PumpUntil(std::chrono::seconds(8), pump, [&]() { return rig.backend.last_admitted(bindings.session_id) == kRoster; }),
            "the heartbeat reports six admitted peers");

        // 8. Stopping the hub: the admitted peers are reported lost and the events stay readable.
        gSection = "hub: stopping the hub";
        for (Member& member : members) if (member.join_handle > 0) stop_join(member);
        stop_join(seventh);
        Check(host_module.stop_session(host) == 1 && host_module.session_running(host) == 0 &&
                host_module.last_session_result(host) == 0,
            "StopSessionH ends the hub cleanly");
        feed.drain(host_module, host);
        Check(feed.count_events("reason=host_stopped") == static_cast<int>(kRoster),
            "every admitted peer was reported lost at the stop");
        Check(rig.backend.disconnect_count() >= disconnects_before + 1 + static_cast<int>(kRoster),
            "and the backend heard about each");
        join_module.shutdown();
        host_module.shutdown();
    }
    if (turn_server) juice_server_destroy(turn_server);
    return 0;
}

// [2026-10-14 repro] The host's own game reconnects to a long-lived session (a realm hub after a hunt) from a new loopback
// port. The local bridge pinned the first client for life and dropped the return as foreign, so the game timed out.
void RunLocalBridge() {
    std::cout << "localbridge\n";
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);
    auto Udp = [](std::uint16_t port) {
        SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        sockaddr_in a{}; a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons(port);
        bind(s, reinterpret_cast<const sockaddr*>(&a), sizeof(a));
        u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
        return s;
    };
    auto PortOf = [](SOCKET s) { sockaddr_in a{}; int n = sizeof(a); getsockname(s, reinterpret_cast<sockaddr*>(&a), &n); return ntohs(a.sin_port); };
    auto SendTo = [](SOCKET s, std::uint16_t port, const char* text) {
        sockaddr_in a{}; a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons(port);
        sendto(s, text, static_cast<int>(std::strlen(text)), 0, reinterpret_cast<const sockaddr*>(&a), sizeof(a));
    };
    // What the game server received: the text and the bridge port it came from (0 when nothing arrived).
    auto Receive = [](SOCKET s, std::string& text) -> std::uint16_t {
        char buf[256]; sockaddr_in from{}; int n = sizeof(from);
        for (int attempt = 0; attempt < 50; ++attempt) {
            const int got = recvfrom(s, buf, sizeof(buf), 0, reinterpret_cast<sockaddr*>(&from), &n);
            if (got > 0) { text.assign(buf, static_cast<std::size_t>(got)); return ntohs(from.sin_port); }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return 0;
    };
    SOCKET server = Udp(0);
    const std::uint16_t server_port = PortOf(server);
    std::vector<std::string> diagnostics;
    mystic::bridge::LocalHostUdpBridge bridge(server_port, 0, mystic::bridge::BridgeLimits{ 2048, 64, 1 },
        [&](std::string_view line) { diagnostics.emplace_back(line); });
    SOCKET first = Udp(0);
    SOCKET second = Udp(0);
    std::string text;

    SendTo(first, bridge.local_port(), "first-1");
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    bridge.pump_once();
    const std::uint16_t first_path = Receive(server, text);
    Check(first_path != 0 && text == "first-1", "the first local client reaches the server");

    SendTo(second, bridge.local_port(), "second-early");
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    bridge.pump_once();
    text.clear();
    Check(Receive(server, text) == 0, "a second local source is dropped while the pinned client is active");
    Check(bridge.stats().unexpected_local_sources_dropped == 1, "and counted as an unexpected local source");

    std::this_thread::sleep_for(std::chrono::milliseconds(2100));
    SendTo(second, bridge.local_port(), "second-after-idle");
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    bridge.pump_once();
    text.clear();
    const std::uint16_t second_path = Receive(server, text);
    Check(second_path != 0 && text == "second-after-idle", "after 2 s of silence the returning client takes over");
    Check(second_path != first_path, "through a fresh server socket (the game server sees a new connection)");
    Check(std::find(diagnostics.begin(), diagnostics.end(), "LOCAL_CLIENT_REPINNED role=host path=local") != diagnostics.end(),
        "the take-over is reported");

    // The server's answer goes to the new client, not the old one.
    sockaddr_in back{}; back.sin_family = AF_INET; back.sin_addr.s_addr = htonl(INADDR_LOOPBACK); back.sin_port = htons(second_path);
    sendto(server, "reply", 5, 0, reinterpret_cast<const sockaddr*>(&back), sizeof(back));
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    bridge.pump_once();
    text.clear();
    Check(Receive(second, text) != 0 && text == "reply", "the server's reply reaches the returning client");
    text.clear();
    Check(Receive(first, text) == 0, "and not the old one");
    closesocket(first);
    closesocket(second);
    closesocket(server);
}

// ---- backend calls off the packet thread (17 Oct) ---------------------------------------------------------------
// Until 17 Oct a host session made every backend call on the thread that relays its packets (backend_lane.hpp): players
// far from the server rubber-banded in every hosted hunt.

// The Guard side of a backend, scripted. Every batch attempt is recorded; the scripted answers go to the next attempts
// (0 = no answer at all, 200 = taken); with no script left a batch is taken.
class ScriptedGuardBackend final : public IAdmissionClient {
public:
    std::atomic<int> delay_ms{ 0 };

    void script(std::initializer_list<unsigned long> answers) {
        std::lock_guard lock(mutex_);
        answers_.assign(answers.begin(), answers.end());
    }
    AdmissionConsumeResult consume(const AdmissionConsumeRequest&) override { return {}; }
    bool publish_host_ready(const HostReadyRequest&, std::string&) override { return true; }
    HeartbeatOutcome publish_heartbeat(const HostHeartbeatRequest&, std::string&) override { return HeartbeatOutcome::Renewed; }
    GuardEventBatchResult publish_guard_batch(const GuardEventBatchRequest& request) override {
        const int milliseconds = delay_ms.load();
        if (milliseconds > 0) std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
        std::lock_guard lock(mutex_);
        attempts_.push_back(request);
        if (!answers_.empty()) {
            const unsigned long status = answers_.front();
            answers_.pop_front();
            if (status != 200) {
                GuardEventBatchResult refused;
                refused.answered = status != 0;
                refused.status = status;
                refused.error = "scripted answer " + std::to_string(status);
                return refused;
            }
        }
        accepted_.push_back(request);
        std::string hash(64, 'c');
        const std::string count = std::to_string(accepted_.size());
        hash.replace(hash.size() - count.size(), count.size(), count);
        hashes_.push_back(hash);
        return GuardEventBatchResult{ true, true, 200, hash, "" };
    }
    bool request_guard_completion(std::string_view, std::uint64_t final_sequence, std::string_view final_hash,
        std::string_view, std::string&) override {
        std::lock_guard lock(mutex_);
        completions_.emplace_back(final_sequence, std::string(final_hash));
        return true;
    }
    void notify_disconnected(std::string_view, std::string_view, std::string_view) override {}

    [[nodiscard]] std::vector<GuardEventBatchRequest> attempts() const { std::lock_guard lock(mutex_); return attempts_; }
    [[nodiscard]] std::vector<GuardEventBatchRequest> accepted() const { std::lock_guard lock(mutex_); return accepted_; }
    [[nodiscard]] std::vector<std::string> hashes() const { std::lock_guard lock(mutex_); return hashes_; }
    [[nodiscard]] std::vector<std::pair<std::uint64_t, std::string>> completions() const {
        std::lock_guard lock(mutex_);
        return completions_;
    }

private:
    mutable std::mutex mutex_;
    std::deque<unsigned long> answers_;
    std::vector<GuardEventBatchRequest> attempts_;
    std::vector<GuardEventBatchRequest> accepted_;
    std::vector<std::string> hashes_;
    std::vector<std::pair<std::uint64_t, std::string>> completions_;
};

// The backend's Hunt Guard chain rules over the batches it took: sequences 1..n with no gap, each batch naming
// the one before, times in order, at most 128 events, a terminal event only last in its batch. `events` = how many.
bool ValidGuardChain(const std::vector<GuardEventBatchRequest>& batches, const std::vector<std::string>& hashes,
    std::uint64_t& events) {
    std::string previous(64, '0');
    std::uint64_t next = 1;
    std::uint64_t last_ms = 0;
    events = 0;
    if (batches.size() != hashes.size()) return false;
    for (std::size_t index = 0; index < batches.size(); ++index) {
        const GuardEventBatchRequest& batch = batches[index];
        if (batch.previous_hash != previous || batch.events.empty() || batch.events.size() > kMaximumGuardBatchEvents) return false;
        for (std::size_t at = 0; at < batch.events.size(); ++at) {
            const GuardEvent& event = batch.events[at];
            if (event.sequence != next++ || event.monotonic_ms < last_ms) return false;
            if ((event.type == "COMPLETION_REQUESTED" || event.type == "HUNT_ABORTED") && at + 1 != batch.events.size()) return false;
            last_ms = event.monotonic_ms;
            ++events;
        }
        previous = hashes[index];
    }
    return true;
}

// A thread-safe diagnostic sink for the publisher's own thread.
struct DiagnosticLog {
    std::mutex mutex;
    std::vector<std::string> lines;
    SessionDiagnosticSink sink() {
        return [this](std::string_view line) {
            std::lock_guard lock(mutex);
            lines.emplace_back(line);
        };
    }
    bool contains(std::string_view needle) {
        std::lock_guard lock(mutex);
        return std::any_of(lines.begin(), lines.end(), [needle](const std::string& line) { return Contains(line, needle); });
    }
};

int RunBackend() {
    std::cout << "backend calls off the packet thread (lane, Guard publisher)\n";
    using std::chrono::milliseconds;
    using Clock = std::chrono::steady_clock;
    const auto elapsed_ms = [](Clock::time_point since) {
        return std::chrono::duration_cast<milliseconds>(Clock::now() - since).count();
    };

    // The lane: posting returns at once, the jobs run in order on its own thread, a full or stopped lane says no.
    {
        ScriptedGuardBackend backend;
        BackendLane lane(backend, 3);
        std::mutex order_mutex;
        std::vector<int> order;
        const auto job = [&](int number) {
            return [&order_mutex, &order, number](IAdmissionClient&) {
                std::this_thread::sleep_for(milliseconds(150));
                std::lock_guard lock(order_mutex);
                order.push_back(number);
            };
        };
        const auto started = Clock::now();
        const bool posted = lane.post(job(1)) && lane.post(job(2)) && lane.post(job(3));
        const auto posting = elapsed_ms(started);
        Check(posted && posting < 50, "lane: posting three 150 ms jobs does not wait for them");
        Check(!lane.post(job(4)), "lane: a full lane refuses a job instead of growing");
        lane.drain_and_stop(milliseconds(5000));
        Check(order == std::vector<int>{ 1, 2, 3 }, "lane: the jobs ran in order before the stop");
        Check(!lane.post(job(5)), "lane: a stopped lane takes no job");
    }

    GuardPublisherTiming fast;
    fast.batch_window = milliseconds(200);
    fast.first_retry = milliseconds(20);
    fast.retry_ceiling = milliseconds(80);

    // Batches, an unbroken chain, and enqueue never waits for a slow backend.
    {
        ScriptedGuardBackend backend;
        backend.delay_ms = 300;
        DiagnosticLog log;
        GuardPublisher publisher(backend, SessionId(40), 3, log.sink(), fast);
        const auto started = Clock::now();
        bool taken = true;
        for (int index = 0; index < 250; ++index) {
            taken = publisher.enqueue("DAMAGE", "host-account", "{\"amount\":" + std::to_string(index) + "}") && taken;
        }
        const auto queueing = elapsed_ms(started);
        Check(taken && queueing < 50, "publisher: 250 events are queued without waiting for a 300 ms backend");
        taken = publisher.enqueue("COMPLETION_REQUESTED", "host-account", "{\"source\":\"selftest\"}") &&
            publisher.enqueue("PLAYER_LOST", "join-account", "{\"transport\":\"ice\"}");
        publisher.flush_and_stop(milliseconds(20000));
        std::uint64_t events = 0;
        const auto accepted = backend.accepted();
        const auto hashes = backend.hashes();
        Check(taken && ValidGuardChain(accepted, hashes, events) && events == 252,
            "publisher: all 252 events reached the backend in one unbroken chain");
        std::cout << "  batches=" << accepted.size() << " for 252 events\n";
        Check(accepted.size() >= 3 && accepted.size() <= 8, "publisher: in a few batches, not one request per event");
        const auto completions = backend.completions();
        bool head = false;
        for (std::size_t index = 0; index < accepted.size() && completions.size() == 1; ++index) {
            head = head || (hashes[index] == completions[0].second && accepted[index].events.back().sequence == completions[0].first);
        }
        Check(completions.size() == 1 && completions[0].first >= 251 && head,
            "publisher: the completion is requested once, with the chain's head");
        const GuardPublisherStats stats = publisher.stats();
        Check(publisher.completed() && !publisher.evidence_incomplete() && stats.events_published == 252 &&
                stats.batches_published == accepted.size() && stats.publish_failures == 0 && stats.evidence_loss == 0,
            "publisher: completed, nothing lost, nothing failed");
    }

    // A batch the backend did not take (429, no answer, 503) goes again unchanged, and the chain stays whole.
    {
        ScriptedGuardBackend backend;
        backend.script({ 429, 0, 503 });
        DiagnosticLog log;
        GuardPublisher publisher(backend, SessionId(41), 3, log.sink(), fast);
        for (int index = 0; index < 5; ++index) (void)publisher.enqueue("DAMAGE", "host-account", "{\"amount\":1}");
        publisher.flush_and_stop(milliseconds(10000));
        const auto attempts = backend.attempts();
        bool same = attempts.size() == 4;
        for (std::size_t index = 1; same && index < attempts.size(); ++index) {
            same = attempts[index].batch_id == attempts[0].batch_id && attempts[index].previous_hash == attempts[0].previous_hash &&
                attempts[index].events.size() == attempts[0].events.size() &&
                attempts[index].events.front().sequence == attempts[0].events.front().sequence;
        }
        Check(same, "publisher: a batch the backend did not take is sent again with the same id and events");
        std::uint64_t events = 0;
        const GuardPublisherStats stats = publisher.stats();
        Check(ValidGuardChain(backend.accepted(), backend.hashes(), events) && events == 5 && !publisher.evidence_incomplete() &&
                stats.publish_failures == 3 && stats.evidence_loss == 0,
            "publisher: and once it is taken the chain is whole, nothing lost");
        Check(log.contains("sending the same batch again") && log.contains("was taken after 3 failed send(s)"),
            "publisher: the retries are reported once, and the recovery");
    }

    // A refused batch (409) ends this hunt's evidence: not sent again, nothing more taken, no completion.
    {
        ScriptedGuardBackend backend;
        backend.script({ 409 });
        DiagnosticLog log;
        GuardPublisher publisher(backend, SessionId(42), 3, log.sink(), fast);
        for (int index = 0; index < 3; ++index) (void)publisher.enqueue("DAMAGE", "host-account", "{\"amount\":1}");
        (void)publisher.enqueue("COMPLETION_REQUESTED", "host-account", "{\"source\":\"selftest\"}");
        const bool refused = PumpUntil(milliseconds(5000), []() {}, [&publisher]() { return publisher.evidence_incomplete(); });
        Check(refused && !publisher.enqueue("DAMAGE", "host-account", "{\"amount\":1}"),
            "publisher: after a refusal no further event is taken");
        publisher.flush_and_stop(milliseconds(5000));
        Check(backend.attempts().size() == 1 && backend.accepted().empty() && backend.completions().empty() &&
                !publisher.completed() && publisher.stats().evidence_loss == 5,
            "publisher: the refused batch is not sent again and no completion is requested");
        Check(log.contains("GUARD_EVIDENCE_LOSS action=completion_fenced reason=batch_refused status=409"),
            "publisher: the refusal is reported");
    }

    // A full queue: refused events are counted, and the gap reaches the backend as EVIDENCE_LOSS.
    {
        GuardPublisherTiming small = fast;
        small.max_queued_events = 8;
        small.batch_window = milliseconds(10000);
        ScriptedGuardBackend backend;
        DiagnosticLog log;
        GuardPublisher publisher(backend, SessionId(43), 3, log.sink(), small);
        int taken = 0;
        for (int index = 0; index < 12; ++index) taken += publisher.enqueue("DAMAGE", "host-account", "{\"amount\":1}") ? 1 : 0;
        Check(taken == 8 && publisher.stats().evidence_loss == 4 && publisher.evidence_incomplete(),
            "publisher: a full queue refuses events and counts them as lost");
        publisher.flush_and_stop(milliseconds(5000));
        std::uint64_t events = 0;
        const auto accepted = backend.accepted();
        bool marker = false;
        for (const auto& batch : accepted) {
            for (const auto& event : batch.events) {
                marker = marker || (event.type == "EVIDENCE_LOSS" && Contains(event.payload_json, "\"droppedEvents\":4"));
            }
        }
        Check(ValidGuardChain(accepted, backend.hashes(), events) && events == 9 && marker,
            "publisher: and the gap reaches the backend as EVIDENCE_LOSS");
    }

    // A consume answered after its link was refused (the admission deadline passed meanwhile) is settled as admitted, then
    // gone: the joiner is not admitted, and the backend hears that the peer left.
    {
        WinsockRuntime winsock;
        const SessionBindings bindings{ "test-key", SessionId(44), "party-1", "hunt-1",
            "bridge-1", 1, 1001, 3, 647472, 1, 1 };
        constexpr PeerId kJoiner = 2002;
        TicketSigner signer;
        const std::filesystem::path key_path = ExeDirectory() /
            (L"selftest-late-consume-" + std::to_wstring(GetCurrentProcessId()) + L".xy");
        std::string error;
        AdmissionTicketVerifier host_verifier;
        AdmissionTicketVerifier join_verifier;
        Check(signer.write_public_key(key_path) && host_verifier.load_public_key(key_path, error) &&
                join_verifier.load_public_key(key_path, error),
            "late consume: writes and loads the test signing key");
        const auto pair_key = RandomKey();
        // 1.5 s: the answer comes while the refused link still lingers (refused at 1 s, closed at 2 s), the case that must
        // not admit it.
        FakeBackend backend;
        backend.delay_ms = 1500;
        BackendLane lane(backend, 8);
        SignalBox box;
        auto host_transport = std::make_shared<IceMessageTransport>();
        auto join_transport = std::make_shared<IceMessageTransport>();
        IceHostSession host(IceServerConfig{}, { IcePeerConfig{ "join-account", kJoiner, pair_key } }, host_transport,
            host_verifier, backend, bindings, SessionLimits{ 4, std::chrono::seconds(1), false, false },
            [&box](std::string_view to, std::string_view kind, std::string_view data) {
                if (to == "join-account") box.to_join.push_back({ "host-account", std::string(kind), std::string(data) });
            }, {}, {});
        host.set_backend_lane(&lane);
        IceJoinSession join(IceServerConfig{}, IcePeerConfig{ "host-account", 1001, pair_key }, join_transport,
            join_verifier, bindings, kJoiner, "join-account", signer.ticket(bindings, "join-account", kJoiner),
            SessionLimits{ 1, std::chrono::seconds(20), false, false },
            [&box](std::string_view to, std::string_view kind, std::string_view data) {
                if (to == "host-account") box.to_host.push_back({ "join-account", std::string(kind), std::string(data) });
            }, {}, {});
        const bool started = join.start(error);
        const bool settled = started && PumpUntil(milliseconds(12000), [&]() {
            join.pump_once();
            for (auto& signal : box.to_host) host.apply_signal(signal.from_account_id, signal.kind, signal.data);
            box.to_host.clear();
            host.pump_once();
            for (auto& signal : box.to_join) join.apply_signal(signal.from_account_id, signal.kind, signal.data);
            box.to_join.clear();
        }, [&backend]() { return backend.disconnect_count() == 1; });
        Check(settled && !join.admitted() && host.admitted_count() == 0 && backend.consume_log().size() == 1,
            "late consume: the refused link stays refused; its late consume becomes a disconnect notice");
        host.stop();
        lane.drain_and_stop(milliseconds(5000));
        host.finish_after_stop();
        std::error_code ignored;
        std::filesystem::remove(key_path, ignored);
    }
    return 0;
}

// A hosted hunt whose every backend call takes 400 ms: the lease, the consume, the Guard batches and the disconnect notice
// all happen while the game's packets keep their pace (before 17 Oct each call stopped them for its whole length).
int RunSlowBackend() {
    std::cout << "a hosted hunt whose backend answers in 400 ms\n";
    using std::chrono::milliseconds;
    using Clock = std::chrono::steady_clock;
    WinsockRuntime winsock;
    ModuleRig rig("slowbackend");
    Check(rig.ok(), "writes the test signing key");
    rig.write("capability.txt", std::string(43, 'A'));
    EchoServer echo;
    TransportModule host_module(SharedBackend(rig.backend));
    TransportModule join_module;
    const std::string host_account = "host-account";
    const std::string join_account = "join-account";
    constexpr PeerId kJoiner = 2002;
    const SessionBindings bindings{ "test-key", SessionId(21), "party-slow", "hunt-1", "bridge-slow", 1, 1001, 3, 647472, 1, 1 };
    const auto key = RandomKey();
    rig.write("hunt.conf", HostConfigText(HostSpec{ bindings, "HUNT", true, 2, echo.port(), {},
        "selftest-guard-slow-" + std::to_string(GetCurrentProcessId()) }));
    rig.write("hunt.secret", PeerLine(join_account, kJoiner, key));
    rig.write("hunt.ticket", rig.signer.ticket(bindings, host_account, bindings.host_peer_id));
    rig.backend.delay_ms = 400;
    char error[256]{};
    const int hunt = host_module.host_open(rig.key_path().c_str(), rig.path("hunt.conf").c_str(),
        rig.path("capability.txt").c_str(), rig.path("hunt.ticket").c_str(), rig.path("hunt.secret").c_str(), error, sizeof(error));
    char line[512]{};
    Check(hunt > 0 && host_module.wait_ready(hunt, 20000, line, sizeof(line)) == 1,
        "the hunt host is ready (its own ticket consume took 400 ms)");
    if (hunt <= 0) return 0;
    const int join = OpenJoin(join_module, rig, "slow", bindings, join_account, kJoiner, host_account, key, {});
    if (join <= 0) return 0;
    const std::vector<Route> routes{ Route{ &host_module, hunt, host_account, &join_module, join, join_account } };
    Feed feed;
    const auto pump = [&]() {
        CarrySignals(routes);
        echo.pump();
        feed.drain(host_module, hunt);
    };
    char join_line[512]{};
    const bool ready = PumpUntil(std::chrono::seconds(30), pump,
        [&]() { return join_module.wait_ready(join, 0, join_line, sizeof(join_line)) == 1; });
    Check(ready, "the joiner is admitted although its ticket consume takes 400 ms");
    if (!ready) return 0;

    // Five seconds of game traffic, with lease renewals (every 2 s) and Guard batches going out meanwhile.
    GameClient client;
    const int renewals_before = rig.backend.heartbeat_count();
    long long worst = 0;
    int round_trips = 0;
    bool flowed = true;
    const auto until = Clock::now() + std::chrono::seconds(5);
    while (Clock::now() < until) {
        const auto sent = Clock::now();
        flowed = client.roundtrip(LocalPortOf(join_line), Pattern(600, static_cast<std::uint8_t>(round_trips)), pump,
            std::chrono::seconds(2)) && flowed;
        worst = std::max<long long>(worst, std::chrono::duration_cast<milliseconds>(Clock::now() - sent).count());
        ++round_trips;
        std::this_thread::sleep_for(milliseconds(20));
    }
    const int renewals = rig.backend.heartbeat_count() - renewals_before;
    std::cout << "  round trips=" << round_trips << " worst=" << worst << " ms; lease renewals meanwhile=" << renewals << '\n';
    Check(flowed && round_trips >= 50, "game traffic flows the whole time");
    Check(renewals >= 2, "the lease was renewed meanwhile");
    Check(worst < 200, "no round trip waited for the backend (each backend call took 400 ms)");
    Check(PumpUntil(std::chrono::seconds(8), pump, [&]() { return rig.backend.last_admitted(bindings.session_id) == 1; }),
        "the lease reports the admitted joiner");
    Check(feed.count_events("PEER_ADMITTED account=join-account") == 1, "the admission is reported once");

    (void)join_module.stop_session(join);
    (void)host_module.stop_session(hunt);
    const auto batches = rig.backend.guard_batches();
    std::vector<std::string> hashes;
    for (std::size_t index = 1; index <= batches.size(); ++index) {
        std::string hash(64, 'b');
        const std::string count = std::to_string(index);
        hash.replace(hash.size() - count.size(), count.size(), count);
        hashes.push_back(hash);
    }
    std::uint64_t events = 0;
    const bool chain = ValidGuardChain(batches, hashes, events);
    Check(chain && !batches.empty() && batches.front().events.size() >= 2 &&
            batches.front().events[0].type == "SESSION_STARTED" && batches.front().events[1].type == "WORLD_READY",
        "the hunt's evidence went in batches; its first two events in the first one");
    Check(chain && !batches.empty() && batches.back().events.back().type == "HUNT_ABORTED",
        "the stopped hunt's last event is HUNT_ABORTED, after its PLAYER_LOST");
    std::cout << "  guard batches=" << batches.size() << " events=" << events << '\n';
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    const std::string command = argc >= 2 ? argv[1] : "";
    std::cout << std::unitbuf;
    bool verbose = false;
    bool relay_local = false;
    for (int index = 2; index < argc; ++index) {
        verbose = verbose || std::string(argv[index]) == "--verbose";
        relay_local = relay_local || std::string(argv[index]) == "--relay-local";
    }
    // --verbose prints libjuice's own log, which names local and relay addresses: local debugging only.
    juice_set_log_level(verbose ? JUICE_LOG_LEVEL_DEBUG : JUICE_LOG_LEVEL_NONE);
    if (verbose) juice_set_log_handler([](juice_log_level_t, const char* message) { std::cerr << "  [juice] " << message << '\n'; });
    StartWatchdog();
    // Names the running section for the watchdog's message.
    const auto section = [](const char* name) { gSection = name; };
    if (command == "crypto") RunCrypto();
    else if (command == "parse") RunParse();
    else if (command == "abi") RunAbi();
    else if (command == "ice") RunIce(argc, argv);
    else if (command == "session") {
        section("session");
        RunSession();
        section("session through the module");
        RunModuleSessions();
    } else if (command == "hub") {
        section(relay_local ? "hub (relay)" : "hub (direct)");
        RunHub(relay_local);
    } else if (command == "localbridge") RunLocalBridge();
    else if (command == "backend") {
        section("backend");
        RunBackend();
        section("slow backend");
        RunSlowBackend();
    } else if (command == "all") {
        section("localbridge");
        RunLocalBridge();
        section("crypto");
        RunCrypto();
        section("parse");
        RunParse();
        section("abi");
        RunAbi();
        section("ice");
        RunIce(argc, argv);
        section("session");
        RunSession();
        section("session through the module");
        RunModuleSessions();
        section("backend");
        RunBackend();
        section("slow backend");
        RunSlowBackend();
        section("hub (direct)");
        RunHub(false);
        if (relay_local) {
            section("hub (relay)");
            RunHub(true);
        }
    } else {
        std::cout << "usage: ParadoxTransportTest crypto|parse|abi|session|backend|localbridge|hub [--relay-local]|ice [--relay-local | --relay-file <path>]|all\n";
        return 2;
    }
    std::cout << (gFailures == 0 ? "PASS" : "FAIL") << " (" << gFailures << " failed)\n";
    return gFailures == 0 ? 0 : 1;
}
