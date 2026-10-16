import { useCallback, useEffect, useRef, useState } from "react";
import { checkUsername } from "../api/tauri";
import { useServer } from "../servers/ServerContext";
import { TextField } from "./TextField";

// [2026-10-16] The username on the sign-up form (0.1.71) and on the set-username screen: letters and digits only. The local
// rules mirror the backend's ValidateUsername (ParadoxBackend/src/security/usernamePolicy.ts) in its order and words, for
// instant feedback; the backend alone decides the rest through the live check (taken ignoring case, reserved staff or project
// words, vulgar or abusive names), whose reason is shown as it is. No word list lives in the launcher: the server judges. The
// form waits until the name passes both.

const USERNAME_CHARACTERS = /^[A-Za-z0-9]+$/;

/** The help line under the field. */
export const USERNAME_HELP = "3–16 letters or numbers. This is your in-game name and how friends invite you.";

/** How long typing must pause before the name is checked with the server. */
export const USERNAME_CHECK_DELAY_MS = 400;

/** The first local rule the name breaks, in the backend's words, or null. */
export function usernameFormatError(raw: string): string | null {
  const username = raw.trim();
  if (username.length < 3 || username.length > 16) return "Username must be 3–16 characters.";
  if (!USERNAME_CHARACTERS.test(username)) return "Username can only contain letters and numbers (no spaces or symbols).";
  if (!/[A-Za-z]/.test(username)) return "Username needs at least one letter.";
  return null;
}

/**
 * Whether a rule is shown while the player is still typing. A wrong character or too many characters cannot become right
 * by typing on; "too short" and "needs a letter" can, so those wait until the field is left.
 */
function showsWhileTyping(raw: string): boolean {
  const username = raw.trim();
  return username.length > 16 || !USERNAME_CHARACTERS.test(username);
}

export type UsernameCheck =
  | { state: "idle" }
  | { state: "checking"; name: string }
  | { state: "available"; name: string }
  | { state: "unavailable"; name: string; reason: string }
  | { state: "failed"; name: string };

/** Username input state: the local rules, the live check with the server, and a refusal the server gave at submit. */
export function useUsernameField() {
  // The check is answered by the selected server's own backend.
  const { serverId } = useServer();
  const [raw, setRaw] = useState("");
  const [touched, setTouched] = useState(false);
  const [check, setCheck] = useState<UsernameCheck>({ state: "idle" });
  // A refusal from register or set-username (a race the live check could not see), for the name it was given for.
  const [refusal, setRefusalState] = useState<{ name: string; reason: string } | null>(null);
  // Every new value or check takes a new ticket: an answer that arrives for an older one is stale and ignored.
  const ticketRef = useRef(0);
  const value = raw.trim();
  const formatError = value ? usernameFormatError(value) : null;

  const runCheck = useCallback(async (name: string) => {
    const ticket = ++ticketRef.current;
    setCheck({ state: "checking", name });
    try {
      const result = await checkUsername(name, serverId);
      if (ticket !== ticketRef.current) return;
      setCheck(result.available
        ? { state: "available", name }
        : { state: "unavailable", name, reason: result.reason?.trim() || "That username is already taken." });
    } catch {
      if (ticket !== ticketRef.current) return;
      setCheck({ state: "failed", name });
    }
  }, [serverId]);

  useEffect(() => {
    ticketRef.current += 1;
    if (!value || formatError) {
      setCheck({ state: "idle" });
      return;
    }
    setCheck({ state: "checking", name: value });
    const timer = window.setTimeout(() => void runCheck(value), USERNAME_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [value, formatError, runCheck]);

  const refused = refusal && refusal.name === value ? refusal.reason : null;
  const unavailable = check.state === "unavailable" && check.name === value ? check.reason : null;
  const ready = Boolean(value) && !formatError && !refused && check.state === "available" && check.name === value;

  const error = refused
    ?? unavailable
    ?? (formatError && (touched || showsWhileTyping(value)) ? formatError : null);
  const hint = check.state === "checking" && check.name === value
    ? "Checking…"
    : ready
      ? "Available"
      : check.state === "failed" && check.name === value
        ? "Couldn't check this username right now. It is checked again when you leave the field."
        : USERNAME_HELP;

  function onBlur() {
    setTouched(true);
    if (check.state === "failed" && check.name === value) void runCheck(value);
  }

  /** The reason the name cannot be sent yet, or null when it is ready. */
  function validate(): string | null {
    if (!value) return "Choose a username.";
    return formatError ?? refused ?? unavailable ?? (ready ? null : "Wait until the username shows Available.");
  }

  /** Shows the server's refusal of the current name on the field (register or set-username lost a race). */
  function setRefusal(reason: string) {
    setRefusalState({ name: value, reason });
  }

  return { value, raw, setValue: setRaw, check, ready, error, hint, onBlur, validate, setRefusal };
}

export function UsernameField({ field, disabled }: { field: ReturnType<typeof useUsernameField>; disabled?: boolean }) {
  return (
    <TextField
      label="Username"
      autoComplete="username"
      placeholder="e.g. AetherHunter"
      value={field.raw}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={field.onBlur}
      disabled={disabled}
      error={field.error ?? undefined}
      hint={field.hint}
      hintTone={field.ready ? "ok" : "muted"}
    />
  );
}
