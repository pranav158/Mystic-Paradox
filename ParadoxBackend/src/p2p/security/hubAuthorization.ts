/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-13 realms S1] Which accounts a realm hub's runtime may act for (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md
// section 7.1). A hunt's runtime acts for the frozen roster; a hub has no roster, only presence, so its identity set is the
// members present in the hub plus the host.
//
// [2026-10-14 realms S4] Section 7.2: which host writes (the hostWrites hooks) a hub's runtime may make. Pure; the session
// state, generation and tagging live in security/hostWrites.ts, which calls HubWriteDenialReason after its own checks.

import type { HostWriteKind } from "../../extensions/p2p";
import type { P2PHuntSessionRecord } from "../persistence";

/**
 * The hub's runtime roster: the accounts present (ADMITTED) in the hub and the host account, which may always be the
 * runtime's own identity (a no-player request falls back to it, also before the host's own row exists). No duplicates, the
 * host first.
 */
export function HubRuntimeRoster(hostAccountId: string, presentAccountIds: readonly string[]): string[] {
    return [...new Set([hostAccountId, ...presentAccountIds])];
}

/** Whether the hub's runtime may act for `accountId`. */
export function IsHubRuntimeAccount(hostAccountId: string, presentAccountIds: readonly string[], accountId: string): boolean {
    return accountId === hostAccountId || presentAccountIds.includes(accountId);
}

export type HubKind = NonNullable<P2PHuntSessionRecord["hubKind"]>;
type SessionShape = Pick<P2PHuntSessionRecord, "sessionKind" | "hubKind">;

/** A realm hub session (the realm's Ramsgate or Training server on the host's PC), as opposed to a hunt. */
export function IsRealmHubSession(session: SessionShape | undefined): boolean {
    return session?.sessionKind === "REALM_HUB";
}

/** The realm's Ramsgate hub: the one hub whose rewards and spends reach the official account. */
export function IsRamsgateHubSession(session: SessionShape | undefined): boolean {
    return session?.sessionKind === "REALM_HUB" && session.hubKind === "RAMSGATE";
}

/**
 * Host write kinds by hub kind (hub design section 7.2). The realm's Ramsgate does what the dedicated Ramsgate does for a
 * player: bounty drafts, claims and progress, cooldowns (the daily gate and the fountain), Slayer's Path, escalation, the
 * progression report (objectives) and mastery, the weapon reforge and its rank confirms. XP is not here: a hub has no XP
 * source (decision D4). The one XP-shaped write a Ramsgate hub takes is a weapon's prestige +1, which the route authorises as
 * REFORGE (the reforge's own step, routes/progression.ts). (Until 16 Oct a Training hub wrote nothing; see below.) A hub of an
 * unknown kind allows nothing.
 * [2026-10-15] A loadout slot unlock is Ramsgate's too: the player's loadout station (the slot count stays the persisted Slayer's Path).
 * [2026-10-16] The Training hub no longer writes nothing: it writes what Ramsgate writes, except the reforge. As a no-reward
 * session the Training Grounds tutorial could not progress: the trainer's quest step ("reach the trainer", then the combos) is saved
 * through the bounty component and paid by an inventory grant, both refused, so the trainer offered the same step again
 * (BOUNTY WRITE_KIND_NOT_ALLOWED_IN_HUB, quest NOTES NO_REWARD_SESSION, nothing saved).
 */
const HUB_WRITE_KINDS: Readonly<Record<HubKind, ReadonlySet<HostWriteKind>>> = {
    // [2026-10-16] HUNT_PASS_XP: the active Hunt Pass track's XP, which the game awards in town (extensions/p2p.ts).
    // [2026-10-16] ITEM_SAVE: an owned item's itemData (the cells slotted into gear from the armoury; POST /inventory/instanceditem).
    RAMSGATE: new Set<HostWriteKind>(["BOUNTY", "COOLDOWN", "SLAYERS_PATH", "ESCALATION", "OBJECTIVES", "MASTERY", "REFORGE",
        "RANK_CONFIRM", "LOADOUT_UNLOCK", "HUNT_PASS_XP", "ITEM_SAVE"]),
    // [2026-10-16] What Ramsgate writes, except the reforge (Ramsgate's station): see the note above.
    TRAINING: new Set<HostWriteKind>(["BOUNTY", "COOLDOWN", "SLAYERS_PATH", "ESCALATION", "OBJECTIVES", "MASTERY",
        "RANK_CONFIRM", "LOADOUT_UNLOCK", "HUNT_PASS_XP", "ITEM_SAVE"])
};

/** Kinds a hunt's runtime never writes: the reforge is a hub action (a hunt has no reforge station). */
const HUNT_REFUSED_WRITE_KINDS: ReadonlySet<HostWriteKind> = new Set<HostWriteKind>(["REFORGE"]);

/** Whether a hub of `hubKind` accepts host writes of `kind`. */
export function HubAllowsWriteKind(hubKind: string | undefined, kind: HostWriteKind | undefined): boolean {
    if (kind === undefined || (hubKind !== "RAMSGATE" && hubKind !== "TRAINING")) return false;
    return HUB_WRITE_KINDS[hubKind].has(kind);
}

/** Whether a hunt's runtime may write `kind` at all (every kind but the hub-only ones; the per-write rules are the routes' own). */
export function HuntAllowsWriteKind(kind: HostWriteKind | undefined): boolean {
    return kind === undefined || !HUNT_REFUSED_WRITE_KINDS.has(kind);
}

/** The accounts present in a hub, as the context cache and the repository return them. */
export interface HubPresenceView {
    presentAccountIds: readonly string[];
}

/**
 * Why a host write of `kind` for `targetUserId` is refused in this hub session, or undefined. The session's own state,
 * generation and the runtime's identity are checked by the caller (hostWrites.ts); this is the hub's rule: the write kind
 * belongs to this kind of hub, and the target is present in it (ADMITTED; the host counts, as in the runtime roster).
 * Without a presence view only the host passes. [2026-10-16] `checkKind` false leaves the write kind out (observe mode re-checks only
 * who may write, hostWrites.ts).
 */
export function HubWriteDenialReason(
    hub: Pick<P2PHuntSessionRecord, "sessionKind" | "hubKind" | "hostAccountId">,
    kind: HostWriteKind | undefined,
    targetUserId: string,
    presence: HubPresenceView | undefined,
    checkKind = true
): string | undefined {
    if (checkKind && !HubAllowsWriteKind(hub.hubKind, kind)) return "WRITE_KIND_NOT_ALLOWED_IN_HUB";
    if (!IsHubRuntimeAccount(hub.hostAccountId, presence?.presentAccountIds ?? [], targetUserId)) return "MEMBER_NOT_PRESENT";
    return undefined;
}
