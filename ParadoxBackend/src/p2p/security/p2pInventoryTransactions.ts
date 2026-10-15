import { P2PHuntSessionRecord } from "../persistence";
import { PlayerHostRuntimeAuthData } from "./hostCapabilities";
import { HubPresenceView, IsHubRuntimeAccount, IsRealmHubSession } from "./hubAuthorization";

export interface P2PInventoryTransactionBody {
    accountId?: unknown;
    characterId?: unknown;
    transactionId?: unknown;
    addInstancedItems?: unknown;
    addStackedItems?: unknown;
    removeInstancedItems?: unknown;
    removeStackedItems?: unknown;
    saveInstancedItems?: unknown;
}

/**
 * Narrow exception to the player-host inventory deny: permits the existing native inventory
 * transaction shape only for a member and character frozen into the currently running hunt.
 * Payload semantics remain owned by the normal inventory validator/controller. Authentication
 * still comes from HasParadoxBackendAuth's live host capability check.
 *
 * [2026-10-14 realms S4] A realm hub session (hub design section 7.3) has no frozen roster or loadouts: the session is
 * RUNNING, the account is present in the hub (ADMITTED; the host counts) and the body names no other account. The character
 * is not compared with a frozen one - the caller's ownership check (the character belongs to the account) stays. `presence`
 * is the hub's present accounts and is read only for a hub (without it only the host passes). Which items a hub transaction
 * may carry is hostGrantPolicy.ts's call, as for a hunt.
 */
export function P2PInventoryTransactionDenialReason(
    auth: PlayerHostRuntimeAuthData | undefined,
    hunt: P2PHuntSessionRecord | undefined,
    body: P2PInventoryTransactionBody,
    presence?: HubPresenceView
): string | undefined {
    if (auth?.IsPlayerHostRuntime !== true || auth.IsGameserver !== false ||
        typeof auth.userId !== "string" || typeof auth.p2pSessionId !== "string" ||
        !Number.isSafeInteger(auth.p2pGeneration)) return "PLAYER_HOST_AUTH_REQUIRED";
    // [2026-10-15] A drained hunt's server still serves its players until it ends: their loot saves as in the running hunt.
    if (hunt == undefined || hunt.sessionId !== auth.p2pSessionId ||
        hunt.generation !== auth.p2pGeneration || (hunt.state !== "RUNNING" && hunt.state !== "DRAINING")) return "HUNT_NOT_RUNNING";
    if (IsRealmHubSession(hunt)) {
        if (!IsHubRuntimeAccount(hunt.hostAccountId, presence?.presentAccountIds ?? [], auth.userId)) return "PARTICIPANT_NOT_ADMITTED";
        if (body.accountId != undefined && body.accountId !== auth.userId) return "ACCOUNT_MISMATCH";
        return undefined;
    }
    const participant = hunt.roster.find((entry) => entry.accountId === auth.userId);
    if (participant == undefined || participant.admissionState !== "ADMITTED") return "PARTICIPANT_NOT_ADMITTED";
    if (body.accountId != undefined && body.accountId !== auth.userId) return "ACCOUNT_MISMATCH";
    const frozenCharacterId = hunt.frozenLoadouts?.find((entry) => entry.accountId === auth.userId)?.characterId;
    if (typeof body.characterId !== "string" || frozenCharacterId == undefined ||
        body.characterId !== frozenCharacterId) return "CHARACTER_MISMATCH";
    return undefined;
}
