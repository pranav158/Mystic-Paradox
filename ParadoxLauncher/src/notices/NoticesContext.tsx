// [2026-10-15] The launcher notices, shared by the sign-in screens and the dashboard. One fetch at startup, one every five
// minutes and one when the window regains focus. The last good answer stays when the backend cannot be reached, and that
// failure is silent: notices never show an error.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getLauncherNotices } from "../api/tauri";
import type { LauncherNotices } from "../api/types";

/** How often the notices are asked for again while the launcher runs. */
export const NOTICES_REFRESH_MS = 5 * 60 * 1000;

const EMPTY: LauncherNotices = { announcements: [], tags: [] };

const NoticesContext = createContext<LauncherNotices>(EMPTY);

/** The notices to show now: none until the first answer arrives. */
export function useNotices(): LauncherNotices {
  return useContext(NoticesContext);
}

/** Whatever the native command sent, read as the notices shape. Anything else is no notices. */
function asNotices(value: unknown): LauncherNotices {
  if (!value || typeof value !== "object") return EMPTY;
  const { announcements, tags } = value as Partial<LauncherNotices>;
  return {
    announcements: Array.isArray(announcements) ? announcements : [],
    tags: Array.isArray(tags) ? tags : [],
  };
}

function sameNotices(a: LauncherNotices, b: LauncherNotices): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function NoticesProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<LauncherNotices>(EMPTY);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    // One request at a time: a focus change during a slow answer does not stack another.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = asNotices(await getLauncherNotices());
      if (mountedRef.current) setNotices((previous) => (sameNotices(previous, next) ? previous : next));
    } catch {
      // The backend cannot be reached: the last good answer stays. Silent by design.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), NOTICES_REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return <NoticesContext.Provider value={notices}>{children}</NoticesContext.Provider>;
}
