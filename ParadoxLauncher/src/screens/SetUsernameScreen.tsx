import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { launcherApi } from "../api/client";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AetherMark } from "../components/AetherMark";

const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

type UsernameCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; reason: string };

function usernameFormatError(username: string): string | null {
  if (username.length < 3 || username.length > 16) return "Username must be 3–16 characters.";
  if (!USERNAME_PATTERN.test(username)) return "Only letters and numbers — no spaces or symbols.";
  return null;
}

// Shown when an account (typically a fresh Discord sign-in) has no username yet.
export function SetUsernameScreen() {
  const { setUsername, logout } = useAuth();

  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<UsernameCheck>({ state: "idle" });

  async function checkAvailability() {
    const username = value.trim();
    if (usernameFormatError(username)) {
      setCheck({ state: "idle" });
      return;
    }

    setCheck({ state: "checking" });
    try {
      const result = await launcherApi.checkUsername(username);
      setCheck(
        result.available ? { state: "available" } : { state: "unavailable", reason: result.reason ?? "That username is taken." },
      );
    } catch {
      setCheck({ state: "idle" });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const formatError = usernameFormatError(value.trim());
    if (formatError) {
      setError(formatError);
      return;
    }
    if (check.state === "unavailable") {
      setError(check.reason);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await setUsername(value.trim());
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hint =
    check.state === "checking"
      ? "Checking availability…"
      : check.state === "available"
        ? "✓ Available"
        : "Letters and numbers only — shown in-game and used to invite you.";

  const hintClass = check.state === "available" ? "text-online" : "text-text-faint";

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <div className="aether-halo pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <AetherMark size={40} />
          <h1 className="mt-4 text-[26px] font-semibold tracking-tight text-text">Choose your username</h1>
          <p className="mt-1.5 text-sm text-text-muted">This is your name in-game and how other Slayers invite you.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-2xl border border-border bg-surface/80 p-6 shadow-[0_16px_48px_-16px] shadow-black/60 backdrop-blur-sm"
        >
          {error && <Banner>{error}</Banner>}

          <div className="flex flex-col gap-1">
            <TextField
              label="Username"
              autoComplete="username"
              placeholder="e.g. AetherHunter7"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setCheck({ state: "idle" });
              }}
              onBlur={checkAvailability}
              disabled={submitting}
              error={check.state === "unavailable" ? check.reason : undefined}
            />
            {check.state !== "unavailable" && <p className={`text-[12px] ${hintClass}`}>{hint}</p>}
          </div>

          <Button type="submit" loading={submitting} className="mt-1 w-full">
            Set username
          </Button>

          <button
            type="button"
            className="rounded text-[13px] text-text-muted transition-colors duration-150 hover:text-text"
            onClick={() => logout()}
          >
            Cancel and sign out
          </button>
        </form>
      </div>
    </div>
  );
}
