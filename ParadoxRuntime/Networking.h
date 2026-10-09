/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 */

#pragma once

#include <Windows.h>
#include "SDK.hpp"

using namespace SDK;

namespace Networking {
	extern UNetDriver* NetDriver;

	// Returns true only after InitListen succeeds and, in player-hosted mode, the
	// launcher has accepted the structured readiness message over its private pipe.
	bool Listen(UEngine* Engine, int Port);

	// [1.14.7 2026-10-03] Emit the exact MYSTICPARADOX_GAMESERVER_READY marker the DeployServer waits for,
	// for the case where the ENGINE created the listener itself (map URL carries ?listen) instead of
	// this module creating the NetDriver by hand. The manual path leaves the world context invalid on
	// 1.14.7 ("WorldContext requested with invalid context object" x28 per run), so the engine path is
	// preferred; readiness is still announced only once a listener actually exists.
	void AnnounceEngineReady(int Port);

	void TickNetworking();

	// [2026-07-25 PLAYER-ROLE PUSH DIAGNOSIS]
	// UActorChannel::ReplicateActor (1.12 RVA 0x03B7B470) can report "wrote nothing" for two very
	// different reasons, and the old bare wroteData=0 log could not tell them apart:
	//   (a) it never got to try - it returns immediately, before touching any property, when
	//       bPendingDormancy is set and the connection is not replaying, or when it is already
	//       replicating this same actor further up the stack;
	//   (b) it ran fully and neither ReplicateProperties nor ReplicateSubobjects had dirty state.
	// (a) means "retry later", (b) means "nothing to send". Treating them alike is why the
	// post-activation refresh burned its 3-attempt budget in 4.5s and declared EXHAUSTED.
	//
	// Offsets read off the 1.12 binary in Ghidra (ReplicateActor prologue):
	//   UActorChannel + 0x30 bit 0x100 = bPendingDormancy        (`*(uint*)(param_1+6)  >> 8 & 1`)
	//   UActorChannel + 0x90 bit 0x004 = bIsReplicatingActor     (`*(uint*)(param_1+0x12) & 4`)
	//   UChannel      + 0x28           = Connection              (`param_1[5]`)
	//   UNetConnection+ 0x1510         = ResendAllDataState       (`*(char*)(param_1[5]+0x1510)`)
	struct ActorChannelPushDiag {
		void* Channel = nullptr;
		bool  ExistingChannel = false;
		bool  WroteData = false;
		bool  PendingDormancy = false;
		bool  ReplicatingReentrant = false;
		int   ResendAllDataState = -1;
		bool  Valid = false;

		// The channel state made a write impossible this frame, independent of dirty properties.
		bool Blocked() const { return Valid && (PendingDormancy || ReplicatingReentrant); }
	};

	// Creates and emits the initial actor channel for a single actor/connection pair. This is a
	// narrowly-scoped bootstrap for dynamically-created owner equipment that has already been routed
	// into the native RepGraph but did not receive an initial channel. Ongoing replication remains
	// owned by the graph. OutDiag is optional and purely observational.
	int BootstrapActorChannel(AActor* Actor, UNetConnection* Connection,
	                          ActorChannelPushDiag* OutDiag = nullptr);

	// [2026-07-25 OMNICELL CHANNEL CHURN] Read-only probe: does an open UActorChannel currently
	// exist for this actor on this connection, and if so what is its ChIndex?
	//
	// Repro 10 established that the server's AArchonPlayerRole actors are STABLE - two pointers
	// (PR_ICEBORNE 1823233038128, PR_TEMPEST 1825136038496) for the entire match - while both
	// clients minted a brand new role UObject every few seconds:
	//   21:03:33.570 role=2152964842720   21:03:36.180 role=2152969074400
	//   21:03:57.635 role=2153085740288   21:04:00.402 role=2152938156720
	// every one of them arriving with gameplayEquipped=0 roleActive=0 bpEquipCalled=0. A client
	// minting a new object for a stable server actor means the actor channel closed and reopened -
	// each reopen is a fresh NetGUID->object resolve, and the HUD binds/unbinds with it. That is
	// the omnicell flicker.
	//
	// Polling channel presence per (role, connection) and logging only the transitions tells us
	// exactly when the channel drops, which is the half we have never been able to see. Returns the
	// ChIndex when a channel exists, -1 when it does not, -2 when the inputs are unusable.
	int GetActorChannelIndexForConnection(AActor* Actor, UNetConnection* Connection);
}
