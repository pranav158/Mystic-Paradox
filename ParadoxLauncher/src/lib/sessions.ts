/** Pure helpers for the session history and status labels. No React, no native calls. */

export interface SessionSummary {
  id: string;
  startedAt: string;
  exitedAt?: string | null;
  exitCode?: number | null;
  channel: string;
}

export type SessionTone = "good" | "bad" | "warn" | "neutral" | "live";

export interface SessionOutcome {
  label: string;
  tone: SessionTone;
}

function hex(code: number): string {
  return "0x" + (code >>> 0).toString(16).toUpperCase();
}

/** Exit codes the launcher itself assigns, plus the common Windows crash codes. */
export function describeExit(code: number | null | undefined, exitedAt: string | null | undefined, running: boolean): SessionOutcome {
  if (exitedAt == null || code == null) {
    return running ? { label: "Playing now", tone: "live" } : { label: "No exit recorded", tone: "neutral" };
  }
  switch (code >>> 0) {
    case 0:
      return { label: "Closed normally", tone: "good" };
    case 0xe301:
      return { label: "Stopped by Launcher Guard", tone: "warn" };
    case 0xe302:
      return { label: "Stopped when the launcher closed", tone: "neutral" };
    case 0xe304:
      return { label: "Stopped at sign-out", tone: "neutral" };
    default:
      if (code >>> 0 >= 0xc0000000) return { label: `Crashed (${hex(code)})`, tone: "bad" };
      return { label: code >>> 0 > 0xffff ? `Exited (${hex(code)})` : `Exited (code ${code})`, tone: "neutral" };
  }
}

export function formatDuration(startedAt: string, endedAt?: string | null, now = Date.now()): string | null {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (date.getTime() >= startOfToday) return `Today, ${time}`;
  if (date.getTime() >= startOfToday - day) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const dayLabel = new Intl.DateTimeFormat(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }).format(date);
  return `${dayLabel}, ${time}`;
}

export function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

/** Changelists this launcher knows by name; anything else is shown as a bare changelist. */
const KNOWN_BUILDS: Record<number, string> = { 647472: "1.14.7" };

export function buildName(changelist: number | null | undefined): string | null {
  if (!changelist) return null;
  return KNOWN_BUILDS[changelist] ?? null;
}

export function shortHash(hash: string | null | undefined, size = 8): string | null {
  if (!hash) return null;
  return `${hash.slice(0, size)}…${hash.slice(-size)}`;
}
