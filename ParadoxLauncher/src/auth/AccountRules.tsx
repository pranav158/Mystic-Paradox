/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeAuthError, useAuth } from "./AuthContext";
import { useServer } from "../servers/ServerContext";
import {
  acceptConsent,
  cancelAccountDeletion,
  getConsentStatus,
  getDeletionStatus,
  requestAccountDeletion,
  type ConsentStatus,
  type DeletionStatus,
} from "../api/tauri";

// [2026-10-14] The Terms of Use and Privacy Policy gate, and the account's deactivation. These belong to Mystic Paradox
// accounts (the official server and Paradox realms); a local server keeps its own rules, so nothing here applies to it.
// The answers are kept apart from AuthContext so sign-in itself is unchanged, and each one is tied to the account and
// server it was asked for: an answer that arrives late cannot reach another account.

/** What the app shows once a Mystic Paradox account is signed in. `open` also covers a backend without consent routes. */
export type ConsentGate = "open" | "checking" | "failed" | "accept";

interface AccountRulesValue {
  gate: ConsentGate;
  consent: ConsentStatus | null;
  /** The consent answer could not be read (the gate shows Try again). */
  consentError: string | null;
  retryConsent: () => void;
  /** Records the player's acceptance of these versions. Rejects with a readable message. */
  acceptConsent: (termsVersion: string, privacyVersion: string) => Promise<void>;
  deletion: DeletionStatus | null;
  /** The deletion state is still being read: Play waits for it, so a deactivated account is never started. */
  deletionChecking: boolean;
  /** Set while the account is deactivated: the day it is deleted (ISO 8601). */
  deactivatedUntil: string | null;
  deletionBusy: boolean;
  /** Reads the deletion state again (after a play was refused for deactivation, for one). */
  reloadDeletion: () => Promise<DeletionStatus | null>;
  /** Deactivates the account and schedules its deletion. Rejects with a readable message. */
  requestDeletion: (confirmUsername: string) => Promise<void>;
  /** Restores a deactivated account while its hold lasts. Rejects with a readable message. */
  restoreAccount: () => Promise<void>;
}

const AccountRulesContext = createContext<AccountRulesValue | null>(null);

export function useAccountRules(): AccountRulesValue {
  const value = useContext(AccountRulesContext);
  if (!value) throw new Error("useAccountRules must be used within AccountRulesProvider");
  return value;
}

interface Keyed<T> {
  /** The account and server the answer belongs to; null before anything was asked. */
  key: string | null;
  value: T | null;
  error: string | null;
}

export function AccountRulesProvider({ children }: { children: ReactNode }) {
  const { status, account, serverId } = useAuth();
  const { officialNetwork } = useServer();
  const key = status === "signedIn" && officialNetwork && account
    ? `${serverId ?? ""}|${account.userId}`
    : null;
  const keyRef = useRef<string | null>(key);
  keyRef.current = key;

  const [reads, setReads] = useState(0);
  const [consentState, setConsentState] = useState<Keyed<ConsentStatus>>({ key: null, value: null, error: null });
  const [deletionState, setDeletionState] = useState<Keyed<DeletionStatus>>({ key: null, value: null, error: null });
  const [deletionBusy, setDeletionBusy] = useState(false);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    getConsentStatus(serverId).then(
      (value) => { if (!cancelled) setConsentState({ key, value, error: null }); },
      (error) => { if (!cancelled) setConsentState({ key, value: null, error: describeAuthError(error) }); },
    );
    getDeletionStatus(serverId).then(
      (value) => { if (!cancelled) setDeletionState({ key, value, error: null }); },
      (error) => { if (!cancelled) setDeletionState({ key, value: null, error: describeAuthError(error) }); },
    );
    return () => { cancelled = true; };
  }, [key, serverId, reads]);

  const consentNow = key !== null && consentState.key === key ? consentState : null;
  const deletionNow = key !== null && deletionState.key === key ? deletionState : null;
  const consent = consentNow?.value ?? null;
  const consentError = consentNow?.error ?? null;
  const deletion = deletionNow?.value ?? null;

  const gate: ConsentGate = key === null
    ? "open"
    : consent
      ? consent.supported && !consent.upToDate ? "accept" : "open"
      : consentError ? "failed" : "checking";
  const deletionChecking = key !== null && deletionNow === null;
  const deactivatedUntil = deletion?.request?.scheduledFor ?? null;

  const retryConsent = useCallback(() => {
    setConsentState({ key: keyRef.current ?? "", value: null, error: null });
    setReads((count) => count + 1);
  }, []);

  const acceptConsentAction = useCallback(async (termsVersion: string, privacyVersion: string) => {
    const current = keyRef.current;
    const value = await acceptConsent(termsVersion, privacyVersion, serverId);
    if (current !== null && keyRef.current === current) setConsentState({ key: current, value, error: null });
  }, [serverId]);

  const reloadDeletion = useCallback(async (): Promise<DeletionStatus | null> => {
    const current = keyRef.current;
    if (current === null) return null;
    const value = await getDeletionStatus(serverId);
    if (keyRef.current === current) setDeletionState({ key: current, value, error: null });
    return value;
  }, [serverId]);

  const requestDeletion = useCallback(async (confirmUsername: string) => {
    const current = keyRef.current;
    setDeletionBusy(true);
    try {
      const value = await requestAccountDeletion(confirmUsername, serverId);
      if (current !== null && keyRef.current === current) setDeletionState({ key: current, value, error: null });
    } finally {
      setDeletionBusy(false);
    }
  }, [serverId]);

  const restoreAccount = useCallback(async () => {
    const current = keyRef.current;
    setDeletionBusy(true);
    try {
      const value = await cancelAccountDeletion(serverId);
      if (current !== null && keyRef.current === current) setDeletionState({ key: current, value, error: null });
    } finally {
      setDeletionBusy(false);
    }
  }, [serverId]);

  const value = useMemo<AccountRulesValue>(() => ({
    gate,
    consent,
    consentError,
    retryConsent,
    acceptConsent: acceptConsentAction,
    deletion,
    deletionChecking,
    deactivatedUntil,
    deletionBusy,
    reloadDeletion,
    requestDeletion,
    restoreAccount,
  }), [gate, consent, consentError, retryConsent, acceptConsentAction, deletion, deletionChecking, deactivatedUntil, deletionBusy, reloadDeletion, requestDeletion, restoreAccount]);

  return <AccountRulesContext.Provider value={value}>{children}</AccountRulesContext.Provider>;
}
