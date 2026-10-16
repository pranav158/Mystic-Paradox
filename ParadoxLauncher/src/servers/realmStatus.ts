/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-16] Whether the selected Paradox realm can be entered right now, for Home's badge and Play. Pure, so the workflow
// tests load it as it is. Home used to show our backend's health for a realm too, so a realm read "Online" while its host
// had not started it (0.1.70). A realm's own state comes from the realm directory (`serving`: the host is online AND its
// Ramsgate is running; `online` alone only means the host's launcher is reporting in) or, for the player's own realm, from
// this PC's host (the Host realm page), which knows first.

/** The selected realm: enterable, being started by its host on this PC, or not running. */
export type RealmLiveState = "serving" | "starting" | "offline";

/**
 * [2026-10-16] The signed-in player's standing in the realm (the same lookup, answered for THIS account). The realm list
 * belongs to the PC, not the account, so a second account on the same PC finds the realm already listed and never "added" it:
 * 0.1.71 then showed a ready Play to an account the host had never let in. `open`: not a member, but the realm lets anyone in
 * (Play joins it).
 */
export type RealmStanding = "own" | "member" | "open" | "invited" | "requested" | "none";

export interface RealmStatus {
  state: RealmLiveState;
  /** The player hosts this realm. */
  own: boolean;
  standing: RealmStanding;
}

/** What the realm directory says about a realm (`realm_lookup`). */
export interface RealmDirectoryAnswer {
  online: boolean;
  serving: boolean;
  own?: boolean;
  member?: boolean;
  requested?: boolean;
  invited?: boolean;
  joinPolicy?: string | null;
}

/** This PC's own realm host, when the optional hosting module is present (`realm_host_status`). */
export interface LocalRealmHost {
  realmName: string | null;
  state: "stopped" | "starting" | "online" | "restarting" | "stopping";
}

/**
 * The realm's state. For the player's own realm (the directory says so, or this PC hosts a realm of that name) this PC's
 * host decides; otherwise the directory's `serving`. Null when neither answered (unknown: no badge, Play is not held).
 */
export function realmStatus(
  realmName: string | null | undefined,
  directory: RealmDirectoryAnswer | null,
  local: LocalRealmHost | null,
): RealmStatus | null {
  const localIsThisRealm = Boolean(
    local?.realmName && realmName && local.realmName.toLowerCase() === realmName.toLowerCase(),
  );
  const own = directory?.own === true || localIsThisRealm;
  if (own && local && (localIsThisRealm || !local.realmName)) {
    const state: RealmLiveState = local.state === "online"
      ? "serving"
      : local.state === "starting" || local.state === "restarting" ? "starting" : "offline";
    return { state, own: true, standing: "own" };
  }
  if (!directory) return null;
  return { state: directory.serving ? "serving" : "offline", own, standing: realmStanding(directory, own) };
}

/** The player's standing from the lookup: an invite to answer comes before a request that waits. */
export function realmStanding(directory: RealmDirectoryAnswer, own: boolean): RealmStanding {
  if (own) return "own";
  if (directory.member) return "member";
  if (directory.invited) return "invited";
  if (directory.requested) return "requested";
  if (directory.joinPolicy === "PUBLIC") return "open";
  return "none";
}

/** [2026-10-16] Home's step for a player the realm has not let in yet: the line under Play and what its button does. */
export interface RealmJoinStep {
  line: string;
  /** The button's words. */
  button: string;
  /** "ask": send the join request; "realms": open the Realms page (the invite is answered there); null: disabled. */
  action: "ask" | "realms" | null;
}

/**
 * The step before Play for a player who is not in the realm yet, or null when Play is theirs (the host, a member, a realm
 * that lets anyone in, or a standing that is not known). `justRequested`: the request was sent from Home a moment ago.
 */
export function realmJoinStep(status: RealmStatus | null, realmName: string, justRequested = false): RealmJoinStep | null {
  if (!status) return null;
  switch (status.standing) {
    case "none":
      return {
        line: `${realmName} lets in the players its host approves. Ask to join, and you can play once the host approves it.`,
        button: "Ask to join",
        action: "ask",
      };
    case "requested":
      return {
        line: justRequested
          ? `Request sent to ${realmName}. You can play once the host approves it.`
          : `Waiting for the host of ${realmName} to approve your request.`,
        button: "Request sent",
        action: null,
      };
    case "invited":
      return { line: `You have an invite to ${realmName}. Accept it on the Realms page.`, button: "Open Realms", action: "realms" };
    default:
      return null;
  }
}

/** The line under Play while the realm cannot be entered (Play waits), or null. */
export function realmPlayBlock(status: RealmStatus | null): string | null {
  if (!status || status.state === "serving") return null;
  if (status.own) {
    return status.state === "starting"
      ? "Your realm is starting. Play opens when it is online."
      : "Your realm is not running. Start it on the Host realm page, then press Play.";
  }
  return "The realm's host hasn't started it yet. Play opens when the realm is online.";
}
