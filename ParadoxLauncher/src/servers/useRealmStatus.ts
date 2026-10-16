/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { realmLookup } from "../api/tauri";
import { LOCAL_REALM_HOST } from "../lib/optionalRealmHost";
import { realmStatus, type RealmStatus } from "./realmStatus";

// [2026-10-16] The selected Paradox realm's state for Home (badge and Play), read while Home is shown: at once, every
// REALM_STATUS_POLL_MS and when the window gets focus. The directory lookup is a read-only GET. Only for the player's own
// realm is this PC's host asked too (it knows first; its status reads our backend at most every 10 s, so other players add
// nothing). The last answer per realm AND account is kept, so returning to Home shows it at once while it is read again; a
// different account on the same PC never sees another account's standing.

export const REALM_STATUS_POLL_MS = 15_000;

const lastKnown = new Map<string, RealmStatus | null>();

interface SelectedServer {
  id: string;
  kind: string;
  realmName?: string | null;
}

export interface RealmStatusView {
  /** The realm's state and the player's standing, or null (not a realm, or not known yet). */
  status: RealmStatus | null;
  /** Reads it again now (after a join request sent from Home). */
  refresh: () => void;
  /** Shows the standing as "requested" at once, until the next answer says otherwise. */
  markRequested: () => void;
}

/** The selected realm's state for the signed-in account (`accountId`). */
export function useRealmStatus(server: SelectedServer | null | undefined, accountId: string | null | undefined): RealmStatusView {
  const id = server?.kind === "paradox_realm" ? server.id : null;
  const realmName = server?.realmName ?? null;
  const key = id && accountId ? `${id}\u0000${accountId}` : null;
  // The answer is kept with the realm and account it belongs to, so a render for another account never shows it.
  const [entry, setEntry] = useState<{ key: string | null; status: RealmStatus | null }>(() => ({
    key,
    status: key ? lastKnown.get(key) ?? null : null,
  }));
  const checkRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!id || !key) {
      setEntry({ key: null, status: null });
      checkRef.current = () => {};
      return;
    }
    setEntry({ key, status: lastKnown.get(key) ?? null });
    let cancelled = false;
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const directory = await realmLookup(id).catch(() => null);
        const local = directory?.own && LOCAL_REALM_HOST ? await LOCAL_REALM_HOST().catch(() => null) : null;
        const next = realmStatus(realmName, directory, local);
        if (cancelled) return;
        lastKnown.set(key, next);
        setEntry({ key, status: next });
      } finally {
        running = false;
      }
    };
    checkRef.current = () => void check();
    void check();
    const timer = window.setInterval(() => void check(), REALM_STATUS_POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      checkRef.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [id, key, realmName]);

  const refresh = useCallback(() => checkRef.current(), []);
  const markRequested = useCallback(() => {
    setEntry((current) => {
      if (current.key !== key || !current.status || current.status.standing !== "none") return current;
      const next: RealmStatus = { ...current.status, standing: "requested" };
      if (key) lastKnown.set(key, next);
      return { key, status: next };
    });
  }, [key]);

  const status = !key ? null : entry.key === key ? entry.status : lastKnown.get(key) ?? null;
  return { status, refresh, markRequested };
}
