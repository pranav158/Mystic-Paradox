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

export interface RealmStatus {
  state: RealmLiveState;
  /** The player hosts this realm. */
  own: boolean;
}

/** What the realm directory says about a realm (`realm_lookup`). */
export interface RealmDirectoryAnswer {
  online: boolean;
  serving: boolean;
  own?: boolean;
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
    return { state, own: true };
  }
  if (!directory) return null;
  return { state: directory.serving ? "serving" : "offline", own };
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
