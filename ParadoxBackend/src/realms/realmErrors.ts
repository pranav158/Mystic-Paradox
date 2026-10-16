/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-13 realms S2] Launcher API error codes of the realms module. Every module file that throws or sends these
// imports LauncherApiError from here, so the statuses are registered before first use (same pattern as the P2P module).
import { LauncherApiError, RegisterLauncherErrorStatuses } from "../security/launcherErrors";

export { LauncherApiError, SendLauncherError } from "../security/launcherErrors";

const REALM_ERROR_STATUSES = {
    REALM_VALIDATION_FAILED: 400,
    REALM_NAME_INVALID: 400,
    REALM_NAME_RESERVED: 400,
    REALM_NAME_TAKEN: 409,
    REALM_ALREADY_EXISTS: 409,
    // [2026-10-16] A realm is named after its host's username: an account without a username cannot claim one, and a name that is
    // another player's username is refused.
    REALM_USERNAME_REQUIRED: 409,
    REALM_NAME_IS_USERNAME: 409,
    REALM_NOT_FOUND: 404,
    REALM_NOT_MEMBER: 404,
    REALM_BANNED: 403,
    REALM_INVITE_REQUIRED: 403,
    REALM_INVITE_INVALID: 404,
    REALM_INVITE_EXPIRED: 410,
    REALM_INVITE_LIMIT: 409,
    REALM_FULL: 409,
    REALM_OWNER_CHANGED: 409,
    REALM_INVALID_TARGET: 400,
    REALM_HOST_CANNOT_LEAVE: 409,
    // [2026-10-15] Join requests: an invite-only realm refused a player without an invite and recorded a request (the answer to
    // a Play or join is REALM_JOIN_REQUESTED, a plain "wait" rather than a failure); the realm's request list is full; the host
    // adds or approves a player by a username nobody has, or acts on a request that is not there.
    REALM_JOIN_REQUESTED: 409,
    REALM_REQUESTS_FULL: 409,
    REALM_REQUEST_NOT_FOUND: 404,
    REALM_PLAYER_NOT_FOUND: 404,
    // [2026-10-16] Player invites: the realm holds too many unanswered invites; a cancel, accept or decline names an invite that is
    // not there.
    REALM_PLAYER_INVITES_FULL: 409,
    REALM_PLAYER_INVITE_NOT_FOUND: 404,
    // [2026-10-13 realms hub design section 2.1] Play with a realm: the host's hub is not running (the host itself is exempt), and
    // the module is switched off on this server (a request that names a realm is refused, never played as official).
    REALM_OFFLINE: 409,
    // [2026-10-16] The realm is in solo mode: only its host enters (Play, a join request and realm routing are refused for others).
    REALM_SOLO: 409,
    REALMS_DISABLED: 501
} as const;

type RealmErrorStatuses = typeof REALM_ERROR_STATUSES;

declare module "../security/launcherErrors" {
    interface ExtensionLauncherErrorCodes extends RealmErrorStatuses {}
}

RegisterLauncherErrorStatuses(REALM_ERROR_STATUSES);

/** Why an entry (Play with a realm) was refused: the codes RealmsService.authorizeEntry answers. */
export type RealmEntryErrorCode =
    | "REALM_NOT_FOUND"
    | "REALM_OWNER_CHANGED"
    | "REALM_BANNED"
    | "REALM_INVITE_REQUIRED"
    | "REALM_INVITE_INVALID"
    | "REALM_INVITE_EXPIRED"
    | "REALM_FULL"
    | "REALM_OFFLINE"
    | "REALM_SOLO"
    | "REALM_JOIN_REQUESTED"
    | "REALM_REQUESTS_FULL";

/** The readable message of each refusal, shared by the join route and the game-session route. */
export const REALM_ENTRY_MESSAGES: Readonly<Record<RealmEntryErrorCode, string>> = Object.freeze({
    REALM_NOT_FOUND: "There is no realm with that name.",
    REALM_OWNER_CHANGED: "This realm now belongs to a different host.",
    REALM_BANNED: "You cannot join this realm.",
    REALM_INVITE_REQUIRED: "This realm is invite-only. You need an invite code.",
    REALM_INVITE_INVALID: "That invite code is not valid for this realm.",
    REALM_INVITE_EXPIRED: "That invite has expired, was revoked or has been used up.",
    REALM_FULL: "This realm cannot take more members.",
    REALM_OFFLINE: "This realm is offline: its host is not running it right now.",
    REALM_SOLO: "This realm is in solo mode: its host is playing alone right now.",
    REALM_JOIN_REQUESTED: "Request sent to the host. Wait for their approval, then press Play again.",
    REALM_REQUESTS_FULL: "This realm has too many join requests waiting. Try again later."
});

export function RealmEntryError(code: RealmEntryErrorCode): LauncherApiError {
    return new LauncherApiError(code, REALM_ENTRY_MESSAGES[code]);
}
