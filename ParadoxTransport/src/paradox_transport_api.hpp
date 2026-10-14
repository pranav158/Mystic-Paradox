/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <cstdint>

#if defined(PARADOX_TRANSPORT_EXPORTS)
#define MYSTIC_TRANSPORT_API extern "C" __declspec(dllexport)
#else
#define MYSTIC_TRANSPORT_API extern "C" __declspec(dllimport)
#endif

// Co-op transport module ABI, version 3 (SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md §5.5, §6.1;
// SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md §4.6).
// Version 1's exports keep their names and contracts; this module refuses the v1 StartHost/StartJoin because an
// ICE session also needs its transport secrets (relay credential and pair keys). Version 2 adds:
// - StartHostV2 / StartJoinV2: v1's arguments plus the path of the transport secrets file;
// - ReadSignal / SubmitSignal: ICE descriptions and candidates to and from the other side (the launcher carries
//   them through /launcher/v1/p2p/hunts/:sessionId/signal and the ICE_SIGNAL control message);
// - ReadPeerEvent: PEER_CONNECTED / PEER_ADMITTED / PEER_LOST lines.
// Version 3 (below) runs several sessions at once, each named by a handle, and lets a host session's peers be added
// and removed while it runs. Every version 2 function keeps its meaning as a wrapper over a "default" handle (one
// session at a time), so a launcher built for version 2 works unchanged.
// Every function is safe to call from any thread; each session runs on its own thread.

MYSTIC_TRANSPORT_API int __cdecl MysticTransport_AbiVersion();
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_Initialize(char* error_buffer, std::uint32_t error_buffer_size);
MYSTIC_TRANSPORT_API void __cdecl MysticTransport_Shutdown();
// A random, non-zero identity of this module instance (ICE has no platform identity).
MYSTIC_TRANSPORT_API std::uint64_t __cdecl MysticTransport_PeerId();
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_NetworkingReady();

// Version 1 entry points: always 0 with an explanation in the error buffer.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_StartHost(const char* public_key_path, const char* config_path,
    const char* capability_path, const char* host_ticket_path, char* error_buffer, std::uint32_t error_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_StartJoin(const char* public_key_path, const char* config_path,
    const char* ticket_path, char* error_buffer, std::uint32_t error_buffer_size);

MYSTIC_TRANSPORT_API int __cdecl MysticTransport_StartHostV2(const char* public_key_path, const char* config_path,
    const char* capability_path, const char* host_ticket_path, const char* secrets_path,
    char* error_buffer, std::uint32_t error_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_StartJoinV2(const char* public_key_path, const char* config_path,
    const char* ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);

// 1 when the HOST_READY / ROUTE_READY line was copied, 0 on timeout, -1 when the session ended before readiness.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_WaitReady(std::uint32_t timeout_ms, char* ready_buffer,
    std::uint32_t ready_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_SessionRunning();
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_LastSessionResult();
MYSTIC_TRANSPORT_API void __cdecl MysticTransport_StopSession();
// 1 when one bounded, non-secret line was copied, 0 when none is queued.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadDiagnostic(char* diagnostic_buffer,
    std::uint32_t diagnostic_buffer_size);

// One outgoing signal: 1 copied, 0 none queued, -1 a buffer is too small (the signal stays queued; data needs up to
// 4097 bytes).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadSignal(char* to_account_buffer, std::uint32_t to_account_size,
    char* kind_buffer, std::uint32_t kind_size, char* data_buffer, std::uint32_t data_size);
// One incoming signal from the other side: 1 queued for the session, 0 refused (no session, malformed, queue full).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_SubmitSignal(const char* from_account_id, const char* kind,
    const char* data);
// 1 when one peer event line was copied, 0 when none is queued.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadPeerEvent(char* event_buffer, std::uint32_t event_buffer_size);

// ---- Version 3: sessions by handle ---------------------------------------------------------------------------------
// At most 8 sessions run at once per module instance. A handle is a positive int, never reused; 0 means failure. A
// stopped or ended session stays readable (diagnostics, events, signals, ready line) until it is drained, so read
// the last lines after StopSessionH. Config keys added to the host's file: session_role=HUNT|HUB (absent: HUNT;
// maximum_peers may go up to 64 only for HUB, otherwise 1..4) and host_local_client=1|0 (absent: 1; 0 needs no host
// ticket, starts no local bridge and reports localPort=0 in the HOST_READY line). A hub's hunt_evidence defaults to
// false and its guard pipe keys are optional.

// A handle > 0, or 0 with a message in the error buffer. The session thread starts at once; bad configuration
// shows as WaitReadyH -1 plus diagnostics. `host_ticket_path` may be null when the config says host_local_client=0.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_HostOpen(const char* public_key_path, const char* config_path,
    const char* capability_path, const char* host_ticket_path, const char* secrets_path,
    char* error_buffer, std::uint32_t error_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_JoinOpen(const char* public_key_path, const char* config_path,
    const char* ticket_path, const char* secrets_path, char* error_buffer, std::uint32_t error_buffer_size);

// 1 when the HOST_READY / ROUTE_READY line was copied, 0 on timeout, -1 when the session ended before readiness (or
// the handle is unknown).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_WaitReadyH(int handle, std::uint32_t timeout_ms, char* ready_buffer,
    std::uint32_t ready_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_SessionRunningH(int handle);
// Stops the session and joins its thread: 1, or 0 for an unknown handle.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_StopSessionH(int handle);
// Not in the design's table: the version 2 LastSessionResult for a handle (0 clean, 2 bad input, 3 setup failure,
// 4 refused admission, 5 lease failed; -1 for an unknown handle).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_LastSessionResultH(int handle);

// 1 copied, 0 none queued (or unknown handle), -1 a buffer is too small (the signal stays queued).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadSignalH(int handle, char* to_account_buffer,
    std::uint32_t to_account_size, char* kind_buffer, std::uint32_t kind_size, char* data_buffer,
    std::uint32_t data_size);
// 1 queued for the session, 0 refused (unknown or ended handle, malformed, queue full). A host holds a signal from an
// account that is not on its roster yet for 20 seconds (at most 16 per account) and replays it on AddPeerH.
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_SubmitSignalH(int handle, const char* from_account_id,
    const char* kind, const char* data);
// Peer event lines; a host's include account=<accountId>: PEER_CONNECTED, PEER_ADMITTED, PEER_LOST reason=...,
// PEER_REMOVED reason=... admitted=0|1 (the answer to RemovePeerH) and PEER_ADD_REJECTED reason=... (a queued add the
// session refused).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadPeerEventH(int handle, char* event_buffer,
    std::uint32_t event_buffer_size);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_ReadDiagnosticH(int handle, char* diagnostic_buffer,
    std::uint32_t diagnostic_buffer_size);

// Host sessions only. AddPeerH: 1 queued, 0 for a full roster (maximum_peers), a duplicate account or peer id, a
// malformed account or key (43 base64url characters), peer id 0, a joiner or ended session. RemovePeerH: 1 queued, 0
// when the account is not on the roster; the session closes that peer's link, tells the backend if it was admitted,
// frees its bridge slot and emits PEER_REMOVED. The same account can be added again afterwards (fresh link).
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_AddPeerH(int handle, const char* account_id, std::uint64_t peer_id,
    const char* pair_key_base64url);
MYSTIC_TRANSPORT_API int __cdecl MysticTransport_RemovePeerH(int handle, const char* account_id, const char* reason);
