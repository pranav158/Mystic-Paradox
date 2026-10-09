import { useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Layout and motion choices from Settings → Interface. Per-PC conveniences only. */
export type SidebarMode = "auto" | "expanded" | "compact";
export type MotionMode = "full" | "reduced";

/** Interface size, applied as the WebView zoom factor (crisp, unlike a CSS transform). */
export const UI_SCALES = [0.85, 0.92, 1] as const;
export type UiScale = (typeof UI_SCALES)[number];

export interface UiPrefs {
  sidebar: SidebarMode;
  motion: MotionMode;
  scale: UiScale;
}

const STORAGE_KEY = "mysticparadox.ui.v1";
// 85% matches the density of the launcher before the 0.1.45 redesign.
const DEFAULTS: UiPrefs = { sidebar: "auto", motion: "full", scale: 0.85 };

function read(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      sidebar: parsed.sidebar === "expanded" || parsed.sidebar === "compact" ? parsed.sidebar : "auto",
      motion: parsed.motion === "reduced" ? "reduced" : "full",
      scale: UI_SCALES.find((value) => value === parsed.scale) ?? DEFAULTS.scale,
    };
  } catch {
    return DEFAULTS;
  }
}

let current: UiPrefs = typeof window === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();

function apply(prefs: UiPrefs) {
  if (typeof document !== "undefined") document.documentElement.dataset.motion = prefs.motion;
}
apply(current);

/** Sets the WebView zoom to the saved interface size. Safe to call outside Tauri. */
export async function applyUiScale(scale: UiScale = current.scale): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    // Never hold the first render on this for more than a moment.
    await Promise.race([
      getCurrentWebview().setZoom(scale),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
  } catch {
    // An older runtime without the zoom permission keeps 100%.
  }
}

export function setUiPrefs(patch: Partial<UiPrefs>): void {
  const scaleChanged = patch.scale !== undefined && patch.scale !== current.scale;
  current = { ...current, ...patch };
  apply(current);
  if (scaleChanged) void applyUiScale(current.scale);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage can be unavailable; the choice still applies for this run.
  }
  listeners.forEach((listener) => listener());
}

export function useUiPrefs(): UiPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => DEFAULTS,
  );
}

/** Live window-width query, used by the auto sidebar mode. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}
