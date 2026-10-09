import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LauncherApiError } from "../api/client";
import type { LauncherAccount, LauncherErrorCode } from "../api/types";

type AuthStatus = "checking" | "restoreFailed" | "signedOut" | "awaitingDiscord" | "awaitingUsername" | "pendingApproval" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  account: LauncherAccount | null;
  authError: string | null;
  accountCheckedAt: number | null;
  accountRefreshing: boolean;
  accountRefreshError: string | null;
  refreshAccount: () => Promise<LauncherAccount | null>;
  login: (email: string, password: string) => Promise<void>;
  register: (displayName: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  startDiscordLogin: () => Promise<void>;
  setUsername: (username: string) => Promise<void>;
  retrySavedSession: () => Promise<void>;
  forgetSavedSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [account, setAccount] = useState<LauncherAccount | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accountSync, setAccountSync] = useState<{ checkedAt: number | null; refreshing: boolean; error: string | null }>({
    checkedAt: null,
    refreshing: false,
    error: null,
  });
  const restoreStartedRef = useRef(false);
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const restored = await invoke<LauncherAccount | null>("native_restore_session");
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
  }, [applyAccount]);

  const signedInAccountId = status === "signedIn" ? account?.userId ?? null : null;
  const refreshAccount = useCallback(async (): Promise<LauncherAccount | null> => {
    if (!signedInAccountId || accountRefreshInFlightRef.current) return null;
    accountRefreshInFlightRef.current = true;
    const operation = operationRef.current;
    setAccountSync((current) => ({ ...current, refreshing: true, error: null }));
    try {
      // Reads the account with the cached access token; it no longer rotates the refresh token
      // every two minutes. Rust still refreshes (and signs out) when the token is rejected.
      const refreshed = await invoke<LauncherAccount>("native_refresh_account");
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
  }, [applyAccount, signedInAccountId]);

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

  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void restoreSavedSession();
  }, [restoreSavedSession]);

  useEffect(() => {
    const unlistenPromise = listen<string>("discord-auth-complete", async (event) => {
      if (!discordPendingRef.current) return;
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
      if (!discordPendingRef.current) return;
      discordPendingRef.current = false;
      ++operationRef.current;
      setAuthError(describeAuthError(new LauncherApiError(event.payload as LauncherErrorCode, "Discord sign-in didn't complete.")));
      setStatus("signedOut");
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    setAuthError(null);
    const next = await invoke<LauncherAccount>("native_login", { email, password });
    if (operation === operationRef.current) applyAccount(next);
  }, [applyAccount]);

  const register = useCallback(async (displayName: string, email: string, password: string) => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    setAuthError(null);
    const pending = await invoke<LauncherAccount>("native_register", { displayName, email, password });
    if (operation !== operationRef.current) return;
    const checkedAt = Date.now();
    accountLastCheckedRef.current = checkedAt;
    setAccount(pending);
    setAccountSync({ checkedAt, refreshing: false, error: null });
    setStatus("pendingApproval");
  }, []);

  const setUsername = useCallback(async (username: string) => {
    const operation = ++operationRef.current;
    const next = await invoke<LauncherAccount>("native_set_username", { username });
    if (operation === operationRef.current) applyAccount(next);
  }, [applyAccount]);

  const logout = useCallback(async () => {
    discordPendingRef.current = false;
    const operation = ++operationRef.current;
    try {
      await invoke("native_logout");
    } catch {
      await invoke("native_forget_session").catch(() => {});
    } finally {
      if (operation === operationRef.current) {
        setAccount(null);
        setAuthError(null);
        setAccountSync({ checkedAt: null, refreshing: false, error: null });
        setStatus("signedOut");
      }
    }
  }, []);

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
    await invoke("native_forget_session").catch(() => {});
    if (operation !== operationRef.current) return;
    setAccount(null);
    setAuthError(null);
    setAccountSync({ checkedAt: null, refreshing: false, error: null });
    setStatus("signedOut");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
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
    }),
    [status, account, authError, accountSync, refreshAccount, login, register, logout, startDiscordLogin, setUsername, restoreSavedSession, forgetSavedSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function isLauncherApiError(error: unknown): error is LauncherApiError {
  return error instanceof LauncherApiError;
}

export function describeAuthError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && !(error instanceof LauncherApiError) && error.message) return error.message;
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
