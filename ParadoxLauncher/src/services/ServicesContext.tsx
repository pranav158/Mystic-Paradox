import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getServerStatus } from "../api/tauri";

export type ServiceHealth = "checking" | "online" | "degraded" | "unreachable";

export interface ServicesState {
  health: ServiceHealth;
  checkedAt: number | null;
  refreshing: boolean;
  /** The changelist the backend currently accepts, from `/launcher/v1/status`. */
  supportedChangelist: number | null;
  refresh: () => Promise<void>;
}

const IDLE: ServicesState = {
  health: "checking",
  checkedAt: null,
  refreshing: false,
  supportedChangelist: null,
  refresh: async () => {},
};

const ServicesContext = createContext<ServicesState>(IDLE);

export function useServices(): ServicesState {
  return useContext(ServicesContext);
}

/** Polls the public status endpoint every 45 s while visible, and on focus after 30 s. */
export function ServicesProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<ServiceHealth>("checking");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [supportedChangelist, setSupportedChangelist] = useState<number | null>(null);
  const inFlightRef = useRef(false);
  const checkedAtRef = useRef(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (mountedRef.current) setRefreshing(true);
    try {
      const status = await getServerStatus();
      if (!mountedRef.current) return;
      setHealth(status.online ? "online" : "degraded");
      setSupportedChangelist(status.supportedBuildChangelist ?? null);
    } catch {
      if (!mountedRef.current) return;
      setHealth("unreachable");
    } finally {
      inFlightRef.current = false;
      const now = Date.now();
      checkedAtRef.current = now;
      if (mountedRef.current) {
        setCheckedAt(now);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden" && Date.now() - checkedAtRef.current > 30_000) void refresh();
    };
    void refresh();
    const interval = window.setInterval(refreshWhenVisible, 45_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const value = useMemo<ServicesState>(
    () => ({ health, checkedAt, refreshing, supportedChangelist, refresh }),
    [health, checkedAt, refreshing, supportedChangelist, refresh],
  );
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}
