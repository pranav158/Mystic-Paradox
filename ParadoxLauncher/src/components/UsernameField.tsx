import { useState } from "react";
import { launcherApi } from "../api/client";
import { TextField } from "./TextField";

const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

export type UsernameCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; reason: string };

export function usernameFormatError(username: string): string | null {
  if (username.length < 3 || username.length > 16) return "Username must be 3–16 characters.";
  if (!USERNAME_PATTERN.test(username)) return "Only letters and numbers — no spaces or symbols.";
  return null;
}

/** Username input with the shared format rules and a best-effort availability probe on blur. */
export function useUsernameField() {
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<UsernameCheck>({ state: "idle" });

  async function probe() {
    const username = value.trim();
    if (usernameFormatError(username)) {
      setCheck({ state: "idle" });
      return;
    }
    setCheck({ state: "checking" });
    try {
      const result = await launcherApi.checkUsername(username);
      setCheck(result.available ? { state: "available" } : { state: "unavailable", reason: result.reason ?? "That username is taken." });
    } catch {
      setCheck({ state: "idle" });
    }
  }

  /** Format or availability problem to show on submit, if any. */
  function validate(): string | null {
    return usernameFormatError(value.trim()) ?? (check.state === "unavailable" ? check.reason : null);
  }

  return { value: value.trim(), raw: value, setValue, check, setCheck, probe, validate };
}

export function UsernameField({ field, disabled }: { field: ReturnType<typeof useUsernameField>; disabled?: boolean }) {
  const { raw, setValue, check, setCheck, probe } = field;
  const hint = check.state === "checking"
    ? "Checking availability…"
    : check.state === "available"
      ? "✓ Available"
      : "Letters and numbers only — shown in-game and used to invite you.";
  return (
    <TextField
      label="Username"
      autoComplete="username"
      placeholder="e.g. AetherHunter7"
      value={raw}
      onChange={(event) => {
        setValue(event.target.value);
        setCheck({ state: "idle" });
      }}
      onBlur={() => void probe()}
      disabled={disabled}
      error={check.state === "unavailable" ? check.reason : undefined}
      hint={hint}
      hintTone={check.state === "available" ? "ok" : "muted"}
    />
  );
}
