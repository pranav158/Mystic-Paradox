// [2026-10-15] The official server's play switch (`officialPlay` of its status). Pure, so the workflow tests load it as it is.
import type { OfficialPlay } from "../api/types";

/** The note when the official server is switched off and the backend sent no message of its own. */
export const OFFICIAL_UNAVAILABLE_NOTE = "The official server is currently unavailable. Join or host a realm.";

/** True only when the official server answered that it is off. A missing answer, or an older backend, means available. */
export function officialUnavailable(play: OfficialPlay | null | undefined): boolean {
  return play?.available === false;
}

/** The note for an unavailable official server: the backend's own message (kept short), or the launcher's sentence. */
export function officialUnavailableNote(play: OfficialPlay | null | undefined): string {
  const message = play?.message?.trim().slice(0, 300);
  return message ? message : OFFICIAL_UNAVAILABLE_NOTE;
}

/** True when a server cannot be played right now: the official server while its play switch is off. */
export function serverUnavailable(server: { kind: string }, play: OfficialPlay | null | undefined): boolean {
  return server.kind === "official" && officialUnavailable(play);
}

/** The Home badge beside the selected server: the realm panel's chip tones (`chip good|warn|bad`). */
export interface ServerStatusBadge {
  text: string;
  tone: "good" | "warn" | "bad";
}

/**
 * [2026-10-15] The badge for the selected server on Home: "Online" when its backend is healthy, "Degraded" when it answers
 * but is not healthy, and a red "Unavailable" when the official play switch is off or the server cannot be reached. No
 * badge while the first check is still running.
 */
export function serverStatusBadge(input: {
  kind: string;
  health: "checking" | "online" | "degraded" | "unreachable";
  officialPlay: OfficialPlay | null | undefined;
}): ServerStatusBadge | null {
  if (serverUnavailable(input, input.officialPlay) || input.health === "unreachable") {
    return { text: "Unavailable", tone: "bad" };
  }
  if (input.health === "degraded") return { text: "Degraded", tone: "warn" };
  if (input.health === "online") return { text: "Online", tone: "good" };
  return null;
}
