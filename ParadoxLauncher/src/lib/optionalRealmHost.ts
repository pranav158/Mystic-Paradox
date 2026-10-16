/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import type { LocalRealmHost } from "../servers/realmStatus";

// [2026-10-16] This PC's own realm host, from the optional hosting module (src/p2p/realmHostLocal.ts), found the way
// optionalPanels.ts finds its panels. A build without that folder has none: Home then reads the player's own realm from
// the realm directory like any other realm. Public code never imports the module itself.
export const LOCAL_REALM_HOST: (() => Promise<LocalRealmHost>) | null =
  Object.values(
    import.meta.glob<{ localRealmHost: () => Promise<LocalRealmHost> }>("../p2p/realmHostLocal.ts", { eager: true }),
  )[0]?.localRealmHost ?? null;
