/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { useEffect, useState } from "react";
import { realmLookup } from "../api/tauri";
import { LOCAL_REALM_HOST } from "../lib/optionalRealmHost";
import { realmStatus, type RealmStatus } from "./realmStatus";

// [2026-10-16] The selected Paradox realm's state for Home (badge and Play), read while Home is shown: at once, every
// REALM_STATUS_POLL_MS and when the window gets focus. The directory lookup is a read-only GET. Only for the player's own
// realm is this PC's host asked too (it knows first; its status reads our backend at most every 10 s, so other players add
// nothing). The last answer per realm is kept, so returning to Home shows it at once while it is read again.

export const REALM_STATUS_POLL_MS = 15_000;

const lastKnown = new Map<string, RealmStatus | null>();

interface SelectedServer {
  id: string;
  kind: string;
  realmName?: string | null;
}

/** The selected realm's state, or null (not a realm, or not known yet). */
export function useRealmStatus(server: SelectedServer | null | undefined): RealmStatus | null {
  const id = server?.kind === "paradox_realm" ? server.id : null;
  const realmName = server?.realmName ?? null;
  const [status, setStatus] = useState<RealmStatus | null>(() => (id ? lastKnown.get(id) ?? null : null));

  useEffect(() => {
    if (!id) {
      setStatus(null);
      return;
    }
    setStatus(lastKnown.get(id) ?? null);
    let cancelled = false;
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const directory = await realmLookup(id).catch(() => null);
        const local = directory?.own && LOCAL_REALM_HOST ? await LOCAL_REALM_HOST().catch(() => null) : null;
        const next = realmStatus(realmName, directory, local);
        lastKnown.set(id, next);
        if (!cancelled) setStatus(next);
      } finally {
        running = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), REALM_STATUS_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [id, realmName]);

  return id ? status : null;
}
