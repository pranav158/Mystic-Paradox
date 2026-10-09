import { flushSync } from "react-dom";

/** True inside the Tauri WebView (or the dev browser preview, which installs Tauri's IPC mocks). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/**
 * Runs a React state change inside a View Transition when the WebView supports it, so the page
 * cross-fades and the sidebar indicator morphs. Falls back to a plain update (and the CSS entry
 * animation) when the API is missing or motion is reduced.
 */
export function withViewTransition(update: () => void): void {
  const doc = typeof document === "undefined" ? undefined : (document as TransitionDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}
