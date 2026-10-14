import type { RealmHostCapacity, RealmHostLimits, RealmHostPlace } from "./realmHostApi";

// [2026-10-14 realms hub design 6.2] Pure helpers of the "Host my realm" panel: limit validation, readable names and
// meter tones. No React and no native calls, so they are tested on their own.

export const LIMIT_RANGES = {
  maxPlayers: { min: 1, max: 64 },
  maxServers: { min: 1, max: 8 },
  afkSeconds: { min: 0, max: 7200 },
} as const;

/** Free memory below these marks is shown amber and red. A hunt server needs about 3 GB, so the host sees it coming. */
export const MEMORY_WARN_MIB = 3072;
export const MEMORY_BAD_MIB = 1024;

export interface LimitsDraft {
  maxPlayers: string;
  maxServers: string;
  /** Empty = the launcher's default, 0 = never. */
  afkSeconds: string;
}

export type LimitErrors = Partial<Record<keyof LimitsDraft, string>>;

export const EMPTY_DRAFT: LimitsDraft = { maxPlayers: "", maxServers: "", afkSeconds: "" };

export function draftFromCapacity(capacity: Pick<RealmHostCapacity, "maxPlayers" | "maxServers" | "afkSeconds">): LimitsDraft {
  return {
    maxPlayers: String(capacity.maxPlayers),
    maxServers: String(capacity.maxServers),
    afkSeconds: capacity.afkSeconds == null ? "" : String(capacity.afkSeconds),
  };
}

function parseWhole(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** The limits to send, or what is wrong with each field. Nothing is sent while any field has an error. */
export function validateLimits(draft: LimitsDraft): { limits: RealmHostLimits | null; errors: LimitErrors } {
  const errors: LimitErrors = {};
  const { maxPlayers: players, maxServers: servers, afkSeconds: afk } = LIMIT_RANGES;
  const maxPlayers = parseWhole(draft.maxPlayers, players.min, players.max);
  if (maxPlayers == null) errors.maxPlayers = `Enter a whole number from ${players.min} to ${players.max}.`;
  const maxServers = parseWhole(draft.maxServers, servers.min, servers.max);
  if (maxServers == null) errors.maxServers = `Enter a whole number from ${servers.min} to ${servers.max}.`;
  let afkSeconds: number | null = null;
  if (draft.afkSeconds.trim() !== "") {
    afkSeconds = parseWhole(draft.afkSeconds, afk.min, afk.max);
    if (afkSeconds == null) errors.afkSeconds = `Enter seconds from ${afk.min} to ${afk.max}, or leave it empty for the default.`;
  }
  if (maxPlayers == null || maxServers == null || errors.afkSeconds) return { limits: null, errors };
  return { limits: { maxPlayers, maxServers, afkSeconds }, errors };
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The hint under the AFK field (a validation error replaces it). */
export function describeAfk(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "Leave empty to use the default.";
  const seconds = parseWhole(trimmed, LIMIT_RANGES.afkSeconds.min, LIMIT_RANGES.afkSeconds.max);
  if (seconds == null) return "0 means never.";
  return seconds === 0 ? "Idle players are never removed." : `Idle players are removed after ${formatSeconds(seconds)}.`;
}

/** "HOST_READY" -> "Host ready". */
export function prettify(text: string | null | undefined): string {
  const words = (text ?? "").trim().replace(/[_\s]+/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The hunt's own id is the name until the launcher has a table of hunt names. */
export function huntName(huntId: string | null | undefined): string {
  return huntId ? `Hunt ${huntId}` : "Hunt";
}

/** Where a player is: Ramsgate, Training or a hunt. */
export function describeWhere(place: Pick<RealmHostPlace, "kind" | "huntId">): string {
  switch (place.kind) {
    case "HUB": return "Ramsgate";
    case "TRAINING": return "Training";
    default: return huntName(place.huntId);
  }
}

/** The connection route, when the launcher knows it ("DIRECT" -> "Direct"). */
export function describeRoute(route: string | null | undefined): string | null {
  const text = prettify(route);
  return text && text !== "Unknown" ? text : null;
}

export function formatMiB(mib: number): string {
  if (!Number.isFinite(mib) || mib < 0) return "unknown";
  if (mib < 1024) return `${Math.round(mib)} MB`;
  return `${Number((mib / 1024).toFixed(1))} GB`;
}

export type MeterTone = "ok" | "warn" | "bad";

export function memoryTone(freeMiB: number): MeterTone {
  if (freeMiB < MEMORY_BAD_MIB) return "bad";
  if (freeMiB < MEMORY_WARN_MIB) return "warn";
  return "ok";
}

/** 0 to 1, safe for a zero or unknown maximum. */
export function fraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}
