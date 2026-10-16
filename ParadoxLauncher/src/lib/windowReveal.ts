/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

// [2026-10-16] The launcher window starts hidden (tauri.conf.json `visible: false`): WebView2 painted white before the page
// loaded, and the window-state plugin then moved the window to its saved place - a white flash and a jump at every start.
// The page shows the window once its first frame is drawn, so it appears finished and where it was left. If this never
// runs (a script error), the native side shows the window after a few seconds (launch::reveal_main_window_fallback).

/** How long the first reveal waits for the bundled fonts, so the titles do not swap typeface right after the window shows. */
const FONT_WAIT_MS = 300;

let revealed = false;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function fontsReady(timeoutMs: number): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts?.ready) return Promise.resolve();
  return Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Shows and focuses the launcher window after the page's first frame (and its fonts, up to FONT_WAIT_MS). Once per page;
 * nothing outside Tauri (the browser preview). Never throws.
 */
export async function revealMainWindow(): Promise<void> {
  if (revealed || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  revealed = true;
  try {
    await fontsReady(FONT_WAIT_MS);
    // Two frames: the first lays the page out, the second has painted it.
    await nextFrame();
    await nextFrame();
    const current = getCurrentWindow();
    await current.show();
    await current.setFocus();
  } catch {
    // The native fallback shows the window.
  }
}
