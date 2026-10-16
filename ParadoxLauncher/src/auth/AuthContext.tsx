import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LauncherApiError } from "../api/client";
import type { EmailOutcome, LauncherAccount, LauncherErrorCode, RegistrationOutcome } from "../api/types";
import type { ConsentInput } from "../api/tauri";
import { useServer } from "../servers/ServerContext";
import { AUTH_CODE_COPY, authErrorCode, discordLinkErrorText, stripAuthCode } from "./authRules";

/** [2026-10-15] How a Discord link started in Settings ended: a note under the Discord row. */
export interface DiscordLinkNotice {
  tone: "ok" | "error";
  text: string;
}

/** [2026-10-15] The unlink code went out to this address (masked, as the server gives it). */
export interface DiscordUnlinkCode {
  email: string;
}

// "needsServerConsent": the selected server is a local one whose warning has not been accepted. Nothing is sent to it
// (no session restore, no sign-in) until the player accepts.
// [2026-10-15] "awaitingEmailCode": a code was emailed (after sign-up, or a sign-in that the backend refused as unverified);
// "passwordReset": the forgot-password flow. Both keep the account's email and password in memory only.
type AuthStatus = "checking" | "restoreFailed" | "signedOut" | "awaitingDiscord" | "awaitingUsername" | "pendingApproval" | "signedIn" | "needsServerConsent" | "awaitingEmailCode" | "passwordReset";

interface AuthContextValue {
  status: AuthStatus;
  /** The server this session (or this sign-in form) belongs to: sign-in follows the selected server. */
  serverId: string | undefined;
  account: LauncherAccount | null;
  authError: string | null;
  accountCheckedAt: number | null;
  accountRefreshing: boolean;
  accountRefreshError: string | null;
  refreshAccount: () => Promise<LauncherAccount | null>;
  login: (email: string, password: string) => Promise<void>;
  /**
   * `consent` is the Terms of Use and Privacy Policy acceptance; the official server requires it, a local server never gets
   * it. [2026-10-15] `displayName` is sent only by a local server's own form: the official account names itself after sign-in.
   */
  register: (email: string, password: string, consent?: ConsentInput, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  startDiscordLogin: () => Promise<void>;
  setUsername: (username: string) => Promise<void>;
  retrySavedSession: () => Promise<void>;
  forgetSavedSession: () => Promise<void>;
  /** [2026-10-15] The email the code screen sent a code to (null when that screen is not up). */
  codeEmail: string | null;
  /** Enters the emailed code: signs in, or ends in approval pending. A wrong code rejects with AUTH_CODE_INVALID. */
  verifyEmailCode: (code: string) => Promise<void>;
  /** Sends a new code to the code screen's address. */
  resendEmailCode: () => Promise<void>;
  /** Opens the forgot-password flow from the sign-in screen. */
  startPasswordReset: () => void;
  /** Sends a reset code to an address (the first step of the forgot-password flow). */
  sendPasswordResetCode: (email: string) => Promise<void>;
  /** Sets the new password with the emailed code: signs in, or ends in approval pending. */
  completePasswordReset: (email: string, code: string, newPassword: string) => Promise<void>;
  /** Leaves the code screen or the forgot-password flow for the sign-in screen. */
  backToSignIn: () => void;
  /** [2026-10-15] The last Discord link result (`mysticparadox://link/...`), shown under the Settings Discord row. */
  discordLinkNotice: DiscordLinkNotice | null;
  /** Opens Discord's authorise page to link this account (the result comes back by deep link). */
  linkDiscord: () => Promise<void>;
  /** [2026-10-15] Unlinking step one: emails the code. Refused for an account whose only sign-in is Discord. */
  startDiscordUnlink: () => Promise<DiscordUnlinkCode>;
  /** [2026-10-15] Unlinking step two: checks the emailed code and removes the link. A wrong code rejects with AUTH_CODE_INVALID. */
  confirmDiscordUnlink: (code: string) => Promise<void>;
  dismissDiscordLinkNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // [2026-10-13 realms S5] Sign-in, the saved session and every account call belong to the SELECTED server. Each call
  // names the server it is for, and the launcher refuses it if its own selection differs, so a form typed for one
  // server can never be sent to another.
  const { ready: serversReady, serverId, needsAck, officialNetwork } = useServer();
  const officialRef = useRef(officialNetwork);
  officialRef.current = officialNetwork;
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [account, setAccount] = useState<LauncherAccount | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // [2026-10-15] The account waiting for its emailed code. The password is needed again to verify (the backend checks it
  // with the code), so it is kept here in memory only: never stored, and cleared when the code screen is left.
  const [emailCode, setEmailCode] = useState<{ email: string; password: string } | null>(null);
  // [2026-10-15] The server the link listeners act for (they read it when a deep link arrives, not when they were set up).
  const [discordLinkNotice, setDiscordLinkNotice] = useState<DiscordLinkNotice | null>(null);
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  const [accountSync, setAccountSync] = useState<{ checkedAt: number | null; refreshing: boolean; error: string | null }>({
    checkedAt: null,
    refreshing: false,
    error: null,
  });
  const restoredForRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const accountRefreshInFlightRef = useRef(false);
  const accountLastCheckedRef = useRef(0);
  // Accept a cold-start OAuth return until the user explicitly changes/cancels auth flow.
  const discordPendingRef = useRef(true);

  const applyAccount = useCallback((next: LauncherAccount) => {
    const checkedAt = Date.now();
    accountLastCheckedRef.current = checkedAt;
    setAccount(next);
    setAuthError(null);
    setAccountSync({ checkedAt, refreshing: false, error: null });
    setStatus(next.needsUsername ? "awaitingUsername" : "signedIn");
  }, []);

  const restoreSavedSession = useCallback(async () => {
    const operation = ++operationRef.current;
    setStatus("checking");
    setAuthError(null);
    // A restore starts from nothing: it may be for another server, whose screens must not show this account.
    setAccount(null);
    setEmailCode(null);
    setAccountSync({ checkedAt: null, refreshing: false, error: null });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const restored = await invoke<LauncherAccount | null>("native_restore_session", { serverId });
        if (operation !== operationRef.current) return;
        if (restored) applyAccount(restored);
        else setStatus("signedOut");
        return;
      } catch (error) {
        if (operation !== operationRef.current) return;
        const message = describeAuthError(error);
        if (/reach|connection/i.test(message) && attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
          if (operation !== operationRef.current) return;
          continue;
        }
        setAuthError(message);
        setStatus(/expired|approval|approved|disabled|banned/i.test(message) ? "signedOut" : "restoreFailed");
        return;
      }
    }
  }, [applyAccount, serverId]);

  const signedInAccountId = status === "signedIn" ? account?.userId ?? null : null;
  const refreshAccount = useCallback(async (): Promise<LauncherAccount | null> => {
    if (!signedInAccountId || accountRefreshInFlightRef.current) return null;
    accountRefreshInFlightRef.current = true;
    const operation = operationRef.current;
    setAccountSync((current) => ({ ...current, refreshing: true, error: null }));
    try {
      // Reads the account with the cached access token; it no longer rotates the refresh token
      // every two minutes. Rust still refreshes (and signs out) when the token is rejected.
      const refreshed = await invoke<LauncherAccount>("native_refresh_account", { serverId });
      if (operation !== operationRef.current) return null;
      applyAccount(refreshed);
      return refreshed;
    } catch (error) {
      if (operation !== operationRef.current) return null;
      const message = describeAuthError(error);
      if (/expired|approval|approved|disabled|banned|unauthorized|sign in again/i.test(message)) {
        setAccount(null);
        setAuthError(message);
        setStatus("signedOut");
      } else {
        const checkedAt = Date.now();
        accountLastCheckedRef.current = checkedAt;
        setAccountSync({ checkedAt, refreshing: false, error: message });
      }
      return null;
    } finally {
      accountRefreshInFlightRef.current = false;
      if (operation === operationRef.current) {
        setAccountSync((current) => current.refreshing ? { ...current, refreshing: false } : current);
      }
    }
  }, [applyAccount, signedInAccountId, serverId]);

  useEffect(() => {
    if (!signedInAccountId) return;
    const refreshIfStale = () => {
      if (document.visibilityState === "hidden" || Date.now() - accountLastCheckedRef.current < 45_000) return;
      void refreshAccount();
    };
    const interval = window.setInterval(refreshIfStale, 120_000);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [signedInAccountId, refreshAccount]);

  // A different server (or a local server whose warning was just accepted) is a different session: whatever this one
  // was doing is cancelled, and the saved session of the server now in use is looked for. A local server whose
  // warning is not accepted is not contacted at all.
  const restoreKey = !serversReady ? null : needsAck ? `${serverId ?? ""}:warning` : `${serverId ?? ""}`;
  useEffect(() => {
    if (restoreKey === null || restoredForRef.current === restoreKey) return;
    restoredForRef.current = restoreKey;
    if (needsAck) {
      ++operationRef.current;
      discordPendingRef.current = false;
      setAccount(null);
      setEmailCode(null);
      setAuthError(null);
      setAccountSync({ checkedAt: null, refreshing: false, error: null });
      setStatus("needsServerConsent");
      return;
    }
    void restoreSavedSession();
  }, [restoreKey, needsAck, restoreSavedSession]);

  useEffect(() => {
    // Discord belongs to the official account system: a return from the browser while a local server is selected is
    // not applied to it.
    const unlistenPromise = listen<string>("discord-auth-complete", async (event) => {
      if (!discordPendingRef.current || !officialRef.current) return;
      discordPendingRef.current = false;
      const operation = ++operationRef.current;
      setStatus("checking");
      setAuthError(null);
      try {
        const next = await invoke<LauncherAccount>("native_discord_complete", { code: event.payload });
        if (operation === operationRef.current) applyAccount(next);
      } catch (error) {
        if (operation !== operationRef.current) return;
        setAuthError(describeAuthError(error));
        setStatus("signedOut");
      }
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, [applyAccount]);

  useEffect(() => {
    const unlistenPromise = listen<string>("discord-auth-error", (event) => {
      if (!discordPendingRef.current || !officialRef.current) return;
      discordPendingRef.current = false;
      ++operationRef.current;
      setAuthError(describeAuthError(new LauncherApiError(event.payload as LauncherErrorCode, "Discord sign-in didn't complete.")));
      setStatus("signedOut");
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  // [2026-10-15] A verify or reset answer: signed in like login, or waiting for approval (the same screen as a registration).
  const settleEmailOutcome = useCallback((outcome: EmailOutcome) => {
    if (!outcome.approvalRequired) {
      applyAccount(outcome.account);
      return;
    }
    const checkedAt = Date.now();
    accountLastCheckedRef.current = checkedAt;
    setAccount(outcome.account);
    setAccountSync({ checkedAt, refreshing: false, error: null });
    setStatus("pendingApproval");
  }, [applyAccount]);

  // [2026-10-15] A Discord link started in Settings ends by deep link. A link is for the official account only, so a result
  // that arrives while a local server is selected is not applied. On success the account is read again (/launcher/v1/me).
  useEffect(() => {
    const unlistenDone = listen("discord-link-done", async () => {
      if (!officialRef.current) return;
      setDiscordLinkNotice({ tone: "ok", text: "Discord linked." });
      try {
        const refreshed = await invoke<LauncherAccount>("native_refresh_account", { serverId: serverIdRef.current });
        if (officialRef.current) applyAccount(refreshed);
      } catch {
        // The row keeps the account it has; the next account check reads the link again.
      }
    });
    const unlistenError = listen<string>("discord-link-error", (event) => {
      if (!officialRef.current) return;
      setDiscordLinkNotice({ tone: "error", text: discordLinkErrorText(event.payload) });
    });
    return () => {
      void unlistenDone.then((unlisten) => unlisten());
      void unlistenError.then((unlisten) => unlisten());
    };
  }, [applyAccount]);

  const login = useCallback(async (email: string, password: string) => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    setAuthError(null);
    try {
      const next = await invoke<LauncherAccount>("native_login", { serverId, email, password });
      if (operation === operationRef.current) applyAccount(next);
    } catch (error) {
      // [2026-10-15] The password was right but the email is not verified yet: the backend has just emailed a code, so the
      // code screen takes over. Any other refusal is thrown as before. Only the official server asks for codes.
      if (operation !== operationRef.current || authErrorCode(error) !== "AUTH_EMAIL_UNVERIFIED" || !officialRef.current) {
        throw error;
      }
      setEmailCode({ email, password });
      setStatus("awaitingEmailCode");
    }
  }, [applyAccount, serverId]);

  // [2026-10-15] Discord linking in Settings: the deep link answers (`link/done`, `link/error`) and the two calls.
  const linkDiscord = useCallback(async () => {
    setDiscordLinkNotice(null);
    await invoke("native_start_discord_link");
  }, []);

  // [2026-10-15] Unlinking takes the emailed code: the start mails it (and a resend starts again), the confirmation checks it.
  const startDiscordUnlink = useCallback(async () => {
    setDiscordLinkNotice(null);
    return invoke<DiscordUnlinkCode>("native_start_discord_unlink");
  }, []);

  const confirmDiscordUnlink = useCallback(async (code: string) => {
    const next = await invoke<LauncherAccount>("native_confirm_discord_unlink", { code });
    applyAccount(next);
  }, [applyAccount]);

  const dismissDiscordLinkNotice = useCallback(() => setDiscordLinkNotice(null), []);

  const register = useCallback(async (email: string, password: string, consent?: ConsentInput, displayName?: string) => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    setAuthError(null);
    // The consent key is sent only when the player accepted (official servers). [2026-10-16] The name is sent again on every
    // server (0.1.71): an account held for approval has no session, so it could not choose its name afterwards.
    const args: Record<string, unknown> = { serverId, email, password };
    if (consent) args.consent = consent;
    if (displayName !== undefined) args.displayName = displayName;
    const registered = await invoke<RegistrationOutcome>("native_register", args);
    if (operation !== operationRef.current) return;
    if (registered.verificationRequired) {
      // [2026-10-15] A code was emailed: the account is not signed in yet, so the code screen comes next.
      setEmailCode({ email, password });
      setStatus("awaitingEmailCode");
      return;
    }
    const checkedAt = Date.now();
    accountLastCheckedRef.current = checkedAt;
    setAccount(registered.account);
    setAccountSync({ checkedAt, refreshing: false, error: null });
    setStatus("pendingApproval");
  }, [serverId]);

  // ---- [2026-10-15] email codes and password resets (the official server) -------------------------------------------

  const verifyEmailCode = useCallback(async (code: string) => {
    const held = emailCode;
    if (!held) return;
    const operation = ++operationRef.current;
    setAuthError(null);
    const outcome = await invoke<EmailOutcome>("native_verify_email", { serverId, email: held.email, password: held.password, code });
    if (operation !== operationRef.current) return;
    setEmailCode(null);
    settleEmailOutcome(outcome);
  }, [emailCode, serverId, settleEmailOutcome]);

  const resendEmailCode = useCallback(async () => {
    const held = emailCode;
    if (!held) return;
    await invoke("native_resend_email_code", { serverId, email: held.email });
  }, [emailCode, serverId]);

  const startPasswordReset = useCallback(() => {
    discordPendingRef.current = false;
    ++operationRef.current;
    setEmailCode(null);
    setAuthError(null);
    setStatus("passwordReset");
  }, []);

  const sendPasswordResetCode = useCallback(async (email: string) => {
    await invoke("native_forgot_password", { serverId, email });
  }, [serverId]);

  const completePasswordReset = useCallback(async (email: string, code: string, newPassword: string) => {
    const operation = ++operationRef.current;
    const outcome = await invoke<EmailOutcome>("native_reset_password", { serverId, email, code, newPassword });
    if (operation !== operationRef.current) return;
    settleEmailOutcome(outcome);
  }, [serverId, settleEmailOutcome]);

  const backToSignIn = useCallback(() => {
    ++operationRef.current;
    setEmailCode(null);
    setAuthError(null);
    setStatus("signedOut");
  }, []);

  const setUsername = useCallback(async (username: string) => {
    const operation = ++operationRef.current;
    const next = await invoke<LauncherAccount>("native_set_username", { serverId, username });
    if (operation === operationRef.current) applyAccount(next);
  }, [applyAccount, serverId]);

  const logout = useCallback(async () => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    try {
      await invoke("native_logout", { serverId });
    } catch {
      await invoke("native_forget_session", { serverId }).catch(() => {});
    } finally {
      if (operation === operationRef.current) {
        setAccount(null);
        setAuthError(null);
        setAccountSync({ checkedAt: null, refreshing: false, error: null });
        setStatus("signedOut");
      }
    }
  }, [serverId]);

  const startDiscordLogin = useCallback(async () => {
    discordPendingRef.current = true;
    const operation = ++operationRef.current;
    setAuthError(null);
    setStatus("awaitingDiscord");
    try {
      await invoke("native_start_discord_login");
    } catch (error) {
      if (operation === operationRef.current) {
        discordPendingRef.current = false;
        setStatus("signedOut");
      }
      throw error;
    }
  }, []);

  const forgetSavedSession = useCallback(async () => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    await invoke("native_forget_session", { serverId }).catch(() => {});
    if (operation !== operationRef.current) return;
    setAccount(null);
    setAuthError(null);
    setAccountSync({ checkedAt: null, refreshing: false, error: null });
    setStatus("signedOut");
  }, [serverId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      serverId,
      account,
      authError,
      accountCheckedAt: accountSync.checkedAt,
      accountRefreshing: accountSync.refreshing,
      accountRefreshError: accountSync.error,
      refreshAccount,
      login,
      register,
      logout,
      startDiscordLogin,
      setUsername,
      retrySavedSession: restoreSavedSession,
      forgetSavedSession,
      codeEmail: emailCode?.email ?? null,
      verifyEmailCode,
      resendEmailCode,
      startPasswordReset,
      sendPasswordResetCode,
      completePasswordReset,
      backToSignIn,
      discordLinkNotice,
      linkDiscord,
      startDiscordUnlink,
      confirmDiscordUnlink,
      dismissDiscordLinkNotice,
    }),
    [status, serverId, account, authError, accountSync, refreshAccount, login, register, logout, startDiscordLogin, setUsername, restoreSavedSession, forgetSavedSession, emailCode, verifyEmailCode, resendEmailCode, startPasswordReset, sendPasswordResetCode, completePasswordReset, backToSignIn, discordLinkNotice, linkDiscord, startDiscordUnlink, confirmDiscordUnlink, dismissDiscordLinkNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function isLauncherApiError(error: unknown): error is LauncherApiError {
  return error instanceof LauncherApiError;
}

export function describeAuthError(error: unknown): string {
  // [2026-10-15] A coded refusal the email screens act on reads as its copy; any other code is left out of the sentence.
  const copy = AUTH_CODE_COPY[authErrorCode(error) ?? ""];
  if (copy) return copy;
  if (typeof error === "string" && error.trim()) return stripAuthCode(error);
  if (error instanceof Error && !(error instanceof LauncherApiError) && error.message) return stripAuthCode(error.message);
  if (isLauncherApiError(error)) {
    const known: Partial<Record<LauncherErrorCode, string>> = {
      SERVER_UNAVAILABLE: "Can't reach the Mystic Paradox server right now. Check your connection and try again.",
      AUTH_VALIDATION_FAILED: "Check the highlighted fields and try again.",
      AUTH_INVALID_CREDENTIALS: "The email or password is incorrect.",
      AUTH_EMAIL_TAKEN: "That email is already registered.",
      AUTH_DISPLAY_NAME_TAKEN: "That display name is already taken.",
      AUTH_ACCOUNT_DISABLED: "This account has been disabled.",
      AUTH_ACCOUNT_BANNED: "This account has been banned.",
      AUTH_APPROVAL_PENDING: "Your closed-test access request is waiting for approval.",
      AUTH_APPROVAL_REJECTED: "Your closed-test access request was not approved.",
      // [2026-10-15] The sign-in deep link for a Discord user with no Mystic Paradox account (sign-in never creates one).
      AUTH_DISCORD_NOT_LINKED: "Your Discord isn't linked to a Mystic Paradox account. Register with your email, then link Discord on the Account page.",
      AUTH_USERNAME_REQUIRED: "Choose your launcher username before playing.",
      AUTH_REFRESH_INVALID: "Your session has expired. Please sign in again.",
      AUTH_UNAUTHORIZED: "Please sign in again.",
      AUTH_RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
      AUTH_DISCORD_NOT_CONFIGURED: "Discord sign-in isn't available right now.",
      AUTH_DISCORD_CANCELLED: "Discord sign-in was cancelled.",
      AUTH_DISCORD_ALREADY_LINKED: "That Discord account is already linked to another Mystic Paradox account.",
      GAME_BUILD_UNSUPPORTED: "This Dauntless build isn't supported. Verify or repair your installation.",
    };
    return known[error.code] ?? error.message;
  }
  return "Something went wrong.";
}
