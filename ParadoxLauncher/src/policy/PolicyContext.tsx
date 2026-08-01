import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { getPolicy } from "../api/tauri";
import type { LauncherPolicy } from "../api/types";

interface PolicyContextValue {
  policy: LauncherPolicy | null;
  refreshPolicy: () => Promise<LauncherPolicy | null>;
}

const PolicyContext = createContext<PolicyContextValue | null>(null);

export function usePolicy(): PolicyContextValue {
  const context = useContext(PolicyContext);
  if (!context) throw new Error("usePolicy must be used within PolicyProvider");
  return context;
}

export function PolicyProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [policy, setPolicy] = useState<LauncherPolicy | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshPolicy = useCallback(async () => {
    try {
      const next = await getPolicy();
      if (mountedRef.current) setPolicy(next);
      return next;
    } catch {
      // Policy is best-effort: a failed refresh keeps whatever was last known (or the
      // safe "no tester features" default) rather than blocking sign-in or Play.
      return null;
    }
  }, []);

  useEffect(() => {
    // Covers both triggers from the architecture doc that don't belong to a specific user
    // action: right after login and right after session restore both land here as
    // status flips to "signedIn".
    if (status === "signedIn") {
      void refreshPolicy();
    } else {
      setPolicy(null);
    }
  }, [status, refreshPolicy]);

  const value = useMemo(() => ({ policy, refreshPolicy }), [policy, refreshPolicy]);

  return <PolicyContext.Provider value={value}>{children}</PolicyContext.Provider>;
}
