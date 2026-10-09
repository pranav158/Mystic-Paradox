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
  const { status, account } = useAuth();
  const [policy, setPolicy] = useState<LauncherPolicy | null>(null);
  const mountedRef = useRef(true);
  const accountKey = status === "signedIn" ? account?.userId ?? null : null;
  const identityRef = useRef({ key: accountKey, generation: 0 });
  if (identityRef.current.key !== accountKey) {
    identityRef.current = { key: accountKey, generation: identityRef.current.generation + 1 };
  }
  const pendingRef = useRef<{ generation: number; promise: Promise<LauncherPolicy | null> } | null>(null);
  const [policyGeneration, setPolicyGeneration] = useState(-1);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshPolicy = useCallback((): Promise<LauncherPolicy | null> => {
    const identity = identityRef.current;
    if (!identity.key) return Promise.resolve(null);
    if (pendingRef.current?.generation === identity.generation) return pendingRef.current.promise;
    const promise = getPolicy().then((next) => {
      if (!mountedRef.current || identityRef.current !== identity) return null;
      setPolicy(next);
      setPolicyGeneration(identity.generation);
      return next;
    }).catch(() => null).finally(() => {
      if (pendingRef.current?.promise === promise) pendingRef.current = null;
    });
    pendingRef.current = { generation: identity.generation, promise };
    return promise;
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
  }, [status, accountKey, refreshPolicy]);

  const visiblePolicy = accountKey && policyGeneration === identityRef.current.generation ? policy : null;
  const value = useMemo(() => ({ policy: visiblePolicy, refreshPolicy }), [visiblePolicy, refreshPolicy]);

  return <PolicyContext.Provider value={value}>{children}</PolicyContext.Provider>;
}
