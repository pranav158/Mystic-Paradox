/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import { useSyncExternalStore } from "react";
import { launcherBuildKind, type BuildKind } from "../api/tauri";

// [2026-10-16] The UNOFFICIAL BUILD / DEVELOPMENT BUILD badge. The kind is compiled into the launcher
// (commands/provenance.rs `launcher_build_kind`; only the official release's build profile marks a build "official"). It is a
// courtesy label, not a security check: the source is public, so anyone can remove it. Asked once per run and kept.

export interface BuildBadge {
  /** The chip text (the tags row under the sidebar wordmark and in the sign-in header). */
  text: string;
  /** The chip's tooltip. */
  title: string;
  /** The line on the About page. */
  about: string;
  /** The chip tone (a .chip class). */
  tone: string;
}

const BADGES: Record<BuildKind, BuildBadge | null> = {
  official: null,
  unofficial: {
    text: "UNOFFICIAL BUILD",
    title: "Built from source, not by Mystic Paradox.",
    about: "Unofficial build: compiled from source, not published by Mystic Paradox.",
    tone: "bad",
  },
  development: {
    text: "DEVELOPMENT BUILD",
    title: "A debug build for development, not a release.",
    about: "Development build: a debug build for development, not a release published by Mystic Paradox.",
    tone: "",
  },
};

/** The badge for a build kind; none for the official build or an unknown answer. */
export function buildBadge(kind: BuildKind | null): BuildBadge | null {
  return kind ? BADGES[kind] ?? null : null;
}

let kind: BuildKind | null = null;
let asked = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!asked) {
    asked = true;
    // A launcher without the command (or a failed call) shows no badge.
    launcherBuildKind()
      .then((answer) => {
        kind = answer === "official" || answer === "unofficial" || answer === "development" ? answer : null;
        listeners.forEach((notify) => notify());
      })
      .catch(() => {});
  }
  return () => {
    listeners.delete(listener);
  };
}

function current(): BuildKind | null {
  return kind;
}

/** This launcher's badge, or null (official, or not known yet). */
export function useBuildBadge(): BuildBadge | null {
  return buildBadge(useSyncExternalStore(subscribe, current));
}
