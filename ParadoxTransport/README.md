# ParadoxTransport - the ICE co-op transport

`ParadoxTransport.dll` carries a player-hosted hunt's Unreal UDP traffic between the host's PC and each joiner:
direct when hole punching works (ICE with STUN), otherwise through a TURN relay: Mystic Relay on the official
servers, or a self-hosted backend's own relay (Cloudflare TURN by default). It is the
public default transport; the Steam transport (`SteamBridge/`) stays private and experimental behind the admin
dashboard's "Co-op transport" switch. Plan: [SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md](../SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md)
§5.5 and §6.1 (step 2).

## Build and test

```powershell
.\ParadoxTransport\build.ps1                      # libjuice + ParadoxTransport.dll + ParadoxTransportTest.exe
.\ParadoxTransport\build\Release\ParadoxTransportTest.exe all --relay-local
.\ParadoxTransport\run-relay-selftest.ps1         # step 3: relay only, through Mystic Relay (needs the .env relay keys)
```

`prepare-dependencies.ps1` restores libjuice v1.7.4 (ICE, STUN and TURN client, MPL-2.0) from its GitHub tag,
checks the archive's SHA-256 and unpacks it into `third_party/` (git-ignored). Toolset v145, C++20, `/W4 /WX` for
our code; libjuice is a separate static library at its own warning level.

`build.ps1 [-Configuration Debug|Release]` (Release by default) finds MSBuild with `vswhere` (the newest installation that
has the MSBuild component, Build Tools included), falls back to `MSBuild.exe` on `PATH`, builds both projects for x64, and prints
the SHA-256 of `build\<Configuration>\ParadoxTransport.dll`. Exit code 0 only when every step succeeded.

### CI (GitHub-hosted Windows runner): what it needs

- **Toolset v145** in both `.vcxproj` files (`ParadoxTransport.vcxproj`, `libjuice.vcxproj`) and a Windows 10/11 SDK
  (`WindowsTargetPlatformVersion` 10.0). Check the runner image's installed MSBuild toolsets before the first run; a hosted image
  may carry only older toolsets. If it lacks v145, use a self-hosted Windows runner with the owner's Build Tools (launch plan P6.2).
- **Fallback, not applied:** retarget both projects to `v143` (Visual Studio 2022), then rebuild and re-verify on the owner's PC.
- **Network** to github.com for the pinned libjuice archive (`prepare-dependencies.ps1` checks its SHA-256 `02CCA696…78FD`). The
  download is skipped when `third_party\libjuice-1.7.4\include\juice\juice.h` exists, so a cached `third_party` folder avoids it.
- **MSBuild:** `vswhere` ships with the Visual Studio installer on hosted images; `microsoft/setup-msbuild` puts `MSBuild.exe` on
  `PATH` when it is not found otherwise.
- **Hashes are not byte-reproducible.** The PE timestamp and the PDB GUID change on every link: on 14 October 2026 a Release
  rebuild on the owner's PC changed the DLL hash from `823BBCF1…D834` to `B40F7728…2AF1` with the same sources. Compare a
  CI artifact's hash with the build that produced it, not with a rebuild elsewhere. `/Brepro` in the linker settings would make
  the output deterministic; it is not set (no project change in this step).

Self-test commands (`ParadoxTransportTest.exe`):

| Command | Checks |
|---|---|
| `crypto` | Pair cipher round trip, tampering, replay window, direction separation |
| `parse` | STUN/TURN URLs, relay-only filtering, transport secrets |
| `abi` | Loads the DLL next to the exe and checks the ABI 2 and ABI 3 exports: version 3, unknown handles, a host whose files are unusable, ABI 2 and ABI 3 sessions side by side |
| `session` | Host and joiner sessions end to end with locally signed MPT2 tickets and a fake backend: admission, one consume per joiner, a foreign ticket refused (`wrong_account`), game traffic; then through the module: a hub and a hunt on one host, one joiner in both, the 8-session limit, the ABI 3 config rules, ABI 2 on the default handle |
| `hub` | A hub host (`session_role=HUB`, `host_local_client=0`, `maximum_peers=6`) with six loopback joiners one after another, a remove, a rejoin of the same account, a restart without remove, a signal that arrives before `AddPeerH`, request ids unique across all links; plus the held-signal rules of `IceHostSession` |
| `hub --relay-local` | The same, relay only, through a TURN server started in the test on 127.0.0.2 (the agents use 127.0.0.1, so only relay-to-relay pairs exist, as with a real relay) |
| `ice` | Two links on this PC, direct, carrying UDP through the real bridges (1-2000 byte datagrams, a 300-datagram burst) |
| `ice --relay-local` | The same, relay only, through a TURN server started in the test |
| `ice --relay-file <f>` | The same through the relay named in `<f>`; both sides must select the relay |
| `--verbose` | Adds libjuice's own log (it names local and relay addresses: local debugging only) |

The admission backend is a fake in these tests (the real client speaks HTTPS only); session files go into folders
next to the exe (`selftest-*`, removed afterwards) because binaries under this checkout may not write `%TEMP%`.
`all` runs `hub` direct, and `all --relay-local` adds `hub --relay-local`.

13 October 2026: `all --relay-local` passes every check; **step 3 passed through Mystic Relay** (`run-relay-selftest.ps1`,
two runs, both sides relay-only): connected in 283-320 ms, round trip 10-13 ms for 1-2000 byte datagrams (both
endpoints on this PC, nearest relay location), 300/300 game-rate datagrams and 100/100 two-piece 1800-byte
datagrams, no authentication failure. The relay's credential API (Cloudflare TURN `generate-ice-servers`) accepts
`customIdentifier`, so the backend's per-account relay quota can be measured. The first relay run, before
fragmentation, lost every 1400- and 2000-byte datagram (1200 passed): hence the 1100-byte pieces
(`IceLink::kFragmentPayload`).

## How a session works

- **Signalling.** The joiner speaks first: its link sends a `DESCRIPTION` (ICE credentials), then `CANDIDATE`s and
  `GATHERING_DONE`. The host creates its link for that joiner only when the description arrives (so the host is the
  controlled side and no signal waits for a session that does not exist yet), then answers the same way. The launcher
  carries signals through `POST /launcher/v1/p2p/hunts/:sessionId/signal` and the `ICE_SIGNAL` control message.
- **Relay only** (`force_relay=true`): the module sends and accepts only relay candidates, and the backend strips
  every other candidate too, so neither side learns the other's IP address.
- **Encryption.** Every frame is AES-256-GCM sealed with the pair key the backend derives for that host-joiner pair
  and hunt generation (`pair_crypto.*`; 28 bytes per frame, per-direction nonces, 1024-frame replay window). A new
  link of the same pair (a rejoin, common on a hub) reuses that key, so each cipher starts its counter at a random
  point instead of 1; a counter restarting at 1 would reuse AES-GCM nonces under the same key. The frame format is
  unchanged, so older peers still read these frames (their replay window takes any first counter).
- **Large datagrams.** Messages over 1100 bytes go as up to four sealed pieces and are rebuilt before delivery (a lost
  piece loses the datagram, like IP fragmentation; reassembly waits at most 1 s). Pieces stay under 1280 bytes on the
  wire, the IPv6 minimum MTU, including TURN and IP/UDP overhead.
- **Admission.** As in the Steam bridge: once connected, the joiner sends its admission ticket (MPC1 control frame)
  every 750 ms until answered; the host verifies the ES256 ticket, requires that it belongs to the pair's account,
  consumes it centrally once (repeated requests get the stored answer), then attaches the peer to the UDP bridge.
  Gameplay frames before admission are dropped. The host's own client is admitted locally, as before.
- **Lifecycle.** Host-ready (`transport: "ICE"`, no lobby), 2-second lease heartbeats, disconnect notices and the Hunt
  Guard event relay (when `hunt_evidence` is on) are the Steam bridge's, unchanged.

Provider-neutral files copied from `SteamBridge/src` (the transport no longer needs the private tree):
`admission_ticket.*`, `admission_client.*` (host-ready names the transport instead of a lobby), `guard_event_pipe.*`,
`message_transport.*`, `udp_bridge.*`.

## ABI 2

`paradox_transport_api.hpp`. Version 1's exports keep their names and contracts; this module refuses v1
`StartHost`/`StartJoin` because an ICE session needs its transport secrets. New:

| Export | Purpose |
|---|---|
| `MysticTransport_StartHostV2(publicKey, config, capability, hostTicket, secrets, error, size)` | Host a session |
| `MysticTransport_StartJoinV2(publicKey, config, ticket, secrets, error, size)` | Join a session |
| `MysticTransport_ReadSignal(to, size, kind, size, data, size)` | One outgoing signal (data up to 4096 bytes) |
| `MysticTransport_SubmitSignal(fromAccountId, kind, data)` | One incoming signal |
| `MysticTransport_ReadPeerEvent(line, size)` | `PEER_CONNECTED` / `PEER_ADMITTED` / `PEER_LOST account=... route=relay|direct` |

Ready lines: host `HOST_READY session=... generation=... transport=ice localHost=127.0.0.1 localPort=N
routePolicy=RELAY_ONLY|AUTOMATIC relayReady=0|1 peers=N`; joiner `ROUTE_READY localHost=127.0.0.1 localPort=N
session=... generation=... transport=ice routePolicy=... route=relay|direct`.

**Config file** (non-secret, key=value): the Steam bridge's binding keys (`key_id`, `session_id`, `party_id`,
`party_revision`, `hunt_definition_id`, `generation`, `build`, `bridge_protocol`, `virtual_port`,
`bridge_instance_id`, `host_peer_id`), `force_relay`, `ice_stun_urls`, `ice_turn_urls` (comma lists; libjuice relays
over UDP only, so `turn:...?transport=udp`). Host: `backend_url`, `server_udp_port`, `maximum_peers`,
`guard_pipe_name`, `expected_server_pid`, `hunt_evidence`. Joiner: `local_udp_port`, `local_peer_id`,
`local_account_id`, `host_account_id`.

**Secrets file** (written by the launcher with restricted access, deleted after readiness): `turn_username`,
`turn_credential`, and one `peer=<accountId>,<peerId>,<pairKey base64url>` line per pair (the host lists every
joiner, a joiner lists only the host). Both come from `POST /launcher/v1/p2p/hunts/:sessionId/transport-config`.

## ABI 3 (realms hub design §4.6, 14 October)

`MysticTransport_AbiVersion()` returns 3. A realm host's long-lived hub needs a session whose peers come and go, the
host runs several sessions at once (the hub plus its hunts), and a joiner holds a hub join and a hunt join together.
Every ABI 2 export stays and behaves as before: it is a wrapper over a *default handle* (one session at a time,
"A co-op session is already running.", a new start replaces a finished one). `MysticTransport_Shutdown` now stops
every session. **Launcher compatibility:** launcher 0.1.55's loader accepts only versions 1 to 2
(`MINIMUM_ABI_VERSION..=ICE_ABI_VERSION` in `p2p/transport.rs`) and refuses a module that reports 3; ship this module
only with a launcher that accepts 3 (the Guard manifest's minimum launcher is the gate).

| Export | Purpose |
|---|---|
| `HostOpen(publicKey, config, capability, hostTicket \| NULL, secrets, error, size)` | A handle > 0, or 0 with a message. The session thread starts at once; bad config shows as `WaitReadyH` -1 plus diagnostics, as in ABI 2 |
| `JoinOpen(publicKey, config, ticket, secrets, error, size)` | The same for a joiner |
| `WaitReadyH(h, timeoutMs, buf, size)` | 1 ready (line copied), 0 timeout, -1 ended before readiness or unknown handle |
| `SessionRunningH(h)` | 1 while the session thread runs |
| `StopSessionH(h)` | Stops the session and joins its thread: 1, or 0 for an unknown handle |
| `ReadSignalH(h, to, size, kind, size, data, size)` / `SubmitSignalH(h, from, kind, data)` | As ABI 2, per session |
| `ReadPeerEventH(h, buf, size)` / `ReadDiagnosticH(h, buf, size)` | As ABI 2, per session |
| `AddPeerH(h, accountId, peerIdU64, keyBase64url)` | Host sessions: 1 queued, 0 for a full roster, a duplicate account or peer id, a malformed account or key (43 base64url characters), peer id 0, a joiner or ended session, or a full command queue |
| `RemovePeerH(h, accountId, reason)` | 1 queued, 0 when the account is not on the roster |
| `LastSessionResultH(h)` | Not in the design's table (ABI 2 parity): 0 clean, 2 bad input, 3 setup failure, 4 refused admission, 5 lease failed, -1 unknown handle |

- **Handles and limits.** Positive, never reused. At most 8 sessions run at once per module instance ("At most 8
  co-op sessions can run at once."). A stopped or ended session stays readable (diagnostics, events, signals, ready
  line) until it is drained or the registry needs the room (the launcher reads the last lines after stopping).
  The module (`transport_module.*`) is a C++ class; `paradox_transport_api.cpp` is a thin C layer over one instance
  that is never destroyed.
- **Roster commands.** `AddPeerH` / `RemovePeerH` are queued and executed on the session thread, which owns every
  libjuice call, in order and before the signals of the same loop iteration. The API layer keeps a view of the roster
  (the secrets file's peers plus queued adds minus queued removes) so it can answer at once; an add only the session
  can refuse (the host's own peer id) comes back as `PEER_ADD_REJECTED account=... reason=...`. `RemovePeerH` closes
  that peer's link, tells the backend if it was admitted (on the next pump), releases its bridge slot and emits
  `PEER_REMOVED account=... reason=... admitted=0|1` (an admitted peer also gets `PEER_LOST account=... reason=...`).
  The same account can be added again afterwards: new link, new index.
- **Held signals.** A signal from an account that is not on the roster yet is held for 20 s (at most 16 per account,
  64 accounts) and replayed in order when `AddPeerH` adds it (`ICE_SIGNAL_HELD` / `ICE_SIGNAL_REPLAYED` /
  `ICE_SIGNAL_EXPIRED` diagnostics; expired ones count as rejected). This removes the race between a joiner that
  started and a host launcher that has not added it yet.
- **Request ids.** `Peer.index` counts *links* (a monotonic per-session counter assigned when a link is opened), so
  `connectionHandle` `ice<N>` and the `adm-<gen>-ice<N>` request id stay unique across rejoins and restarts of one
  account. The disconnect request id is `disc-<gen>-<peerId>-<N>` (it used to repeat for the same peer id).
- **Config keys** (host file): `session_role=HUNT|HUB` (absent: HUNT); `maximum_peers` 1..4 for HUNT, 1..64 for HUB;
  `host_local_client=1|0` (absent: 1; 0 needs no host ticket, starts no local bridge, the ready line says
  `localPort=0`, guard events carry no actor). A hub's `hunt_evidence` defaults to false and its `guard_pipe_name` /
  `expected_server_pid` are optional (given both, the pipe is created). `HostUdpBridge` and `BridgeLimits.maximum_peers`
  follow `maximum_peers`; the lease heartbeat may report up to 64 admitted peers (the backend decides per kind).
- **Known limit.** Admission (`consume`) is a synchronous WinHTTP call on the session thread (5 s timeouts): a slow
  call stalls that session's other links for its duration. Acceptable up to 64 peers; measure it on a real hub.

## Launcher and backend (plan step 4, in source 13 October)

The launcher loads this module through the signed Guard manifest's `TRANSPORT_MODULE` role (no `TRANSPORT_RUNTIME`),
writes `bridge.conf` and `transport.secret` from `transport-config`, and carries signals
(`ParadoxLauncher/src-tauri/src/p2p/session/ice.rs`). The backend gives every account an account-derived 64-bit peer
id for ICE hunts (`ParadoxBackend/src/p2p/security/transportPeerIds.ts`); tickets, `peer=` lines and the consume
check use it. **Step 5 prep, 13 October (local):** the module is a signed client extra of runtime feed 0.2.129
(`FCB5BA66…`, 776,704 bytes) and the `TRANSPORT_MODULE` of Guard manifest stable seq 62 (with launcher 0.1.54); not
exercised in a real hunt yet.
- `[PerfNet]` on a real hunt should still confirm Dauntless's largest datagram; up to 2048 bytes (the bridge cap) now
  travels in two pieces.
