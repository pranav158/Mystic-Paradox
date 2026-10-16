/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { ServerKind } from "../api/tauri";

// [2026-10-14] How a server is named for the player. A Paradox realm is known by its realm name (the directory name, for
// example "mysticfox"): that is what the realm directory, its host and the other players use.
// [2026-10-16, owner] Realm names are the hosts' usernames now, so a realm is shown by its label ("MysticFox's Realm") with the
// realm name under it (serverNaming).

export interface NamedServer {
  kind: ServerKind;
  name: string;
  realmName?: string | null;
}

export interface ServerNaming {
  /** The main line: a realm's realm name, otherwise the server's own name. */
  primary: string;
  /** A smaller second line: a realm's own name when it differs from its realm name (ignoring case), otherwise null. */
  secondary: string | null;
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The server's names for the player. Pure, so the sign-in card, Home, the Servers page and the realm notices agree.
 * [2026-10-16, owner] A realm is named after its host's username and labelled "MysticFox's Realm": the label is the main line and
 * the realm name ("mysticfox", what players type to add it) the smaller one. A realm whose label is its realm name shows that once.
 */
export function serverNaming(server: NamedServer): ServerNaming {
  const name = (server.name ?? "").trim();
  const realm = (server.realmName ?? "").trim();
  if (server.kind !== "paradox_realm" || !realm) return { primary: name, secondary: null };
  if (!name || sameName(name, realm)) return { primary: realm, secondary: null };
  return { primary: name, secondary: realm };
}

/**
 * [2026-10-16, owner] The realm name a host's username gives (ParadoxBackend src/realms/realmRules.ts RealmNameForUsername): lower
 * case, any other character becomes one hyphen, none at either end. "" when the result is not 3 to 24 characters.
 */
export function realmNameForUsername(username: string): string {
  const name = username.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9-]{3,24}$/.test(name) ? name : "";
}

/** [2026-10-16] "MysticFox's Realm": a realm's label from its host's username, as the host typed or spelled it. */
export function realmLabelForUsername(username: string): string {
  const name = username.trim();
  return name ? `${name}'s Realm` : "";
}

/**
 * The server an install status describes (the Play card, the Library): the selected server when it is the same one, so
 * a realm shows its realm name. Otherwise the status's own name, which is the custom name only.
 */
export function statusNaming(
  status: { serverId?: string; serverName?: string } | null | undefined,
  selected: (NamedServer & { id: string }) | null | undefined,
): ServerNaming | null {
  if (!status) return null;
  if (selected && status.serverId !== undefined && status.serverId === selected.id) return serverNaming(selected);
  const name = (status.serverName ?? "").trim();
  return name ? { primary: name, secondary: null } : null;
}
