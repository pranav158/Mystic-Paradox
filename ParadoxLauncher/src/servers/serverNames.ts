/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { ServerKind } from "../api/tauri";

// [2026-10-14] How a server is named for the player. A Paradox realm is known by its realm name (the directory name, for
// example "mysticfox"): that is what the realm directory, its host and the other players use. The name the player typed
// when adding it is only a label on this PC, so it is shown under the realm name, and only when it differs from it.

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

/** The server's names for the player. Pure, so the sign-in card, Home, the Servers page and the realm notices agree. */
export function serverNaming(server: NamedServer): ServerNaming {
  const name = (server.name ?? "").trim();
  const realm = (server.realmName ?? "").trim();
  if (server.kind !== "paradox_realm" || !realm) return { primary: name, secondary: null };
  return { primary: realm, secondary: name && !sameName(name, realm) ? name : null };
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
