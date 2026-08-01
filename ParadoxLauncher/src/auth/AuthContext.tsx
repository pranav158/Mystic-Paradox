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
  const restoreStartedRef = useRef(false);

  const applyAccount = useCallback((next: LauncherAccount) => {
    setAccount(next);
    setStatus(next.needsUsername ? "awaitingUsername" : "signedIn");
  }, []);

  const restoreSavedSession = useCallback(async () => {
    setStatus("checking");
    setAuthError(null);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const restored = await invoke<LauncherAccount | null>("native_restore_session");
        if (restored) applyAccount(restored);
        else setStatus("signedOut");
        return;
      } catch (error) {
        const message = describeAuthError(error);
        if (/reach|connection/i.test(message) && attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
          continue;
        }
        setAuthError(message);
        setStatus(/expired|approval|approved|disabled|banned/i.test(message) ? "signedOut" : "restoreFailed");
        return;
      }
    }
  }, [applyAccount]);

  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void restoreSavedSession();
  }, [restoreSavedSession]);

  useEffect(() => {
    const unlistenPromise = listen<string>("discord-auth-complete", async (event) => {
      setStatus("checking");
      setAuthError(null);
      try {
        applyAccount(await invoke<LauncherAccount>("native_discord_complete", { code: event.payload }));
      } catch (error) {
        setAuthError(describeAuthError(error));
        setStatus("signedOut");
      }
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, [applyAccount]);

  useEffect(() => {
    const unlistenPromise = listen<string>("discord-auth-error", (event) => {
      setAuthError(describeAuthError(new LauncherApiError(event.payload as LauncherErrorCode, "Discord sign-in didn't complete.")));
      setStatus("signedOut");
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    applyAccount(await invoke<LauncherAccount>("native_login", { email, password }));
  }, [applyAccount]);

  const register = useCallback(async (displayName: string, email: string, password: string) => {
    setAuthError(null);
    const pending = await invoke<LauncherAccount>("native_register", { displayName, email, password });
    setAccount(pending);
    setStatus("pendingApproval");
  }, []);

  const setUsername = useCallback(async (username: string) => {
    applyAccount(await invoke<LauncherAccount>("native_set_username", { username }));
  }, [applyAccount]);

  const logout = useCallback(async () => {
    try {
      await invoke("native_logout");
    } catch {
      await invoke("native_forget_session").catch(() => {});
    } finally {
      setAccount(null);
      setAuthError(null);
      setStatus("signedOut");
    }
  }, []);

  const startDiscordLogin = useCallback(async () => {
    setAuthError(null);
    setStatus("awaitingDiscord");
    try {
      await invoke("native_start_discord_login");
    } catch (error) {
      setStatus("signedOut");
      throw error;
    }
  }, []);

  const forgetSavedSession = useCallback(async () => {
    await invoke("native_forget_session").catch(() => {});
    setAccount(null);
    setAuthError(null);
    setStatus("signedOut");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, account, authError, login, register, logout, startDiscordLogin, setUsername, retrySavedSession: restoreSavedSession, forgetSavedSession }),
    [status, account, authError, login, register, logout, startDiscordLogin, setUsername, restoreSavedSession, forgetSavedSession],
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
