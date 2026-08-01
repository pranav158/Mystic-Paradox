import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { launcherApi } from "../api/client";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AetherMark } from "../components/AetherMark";

interface RegisterScreenProps {
  onBackToLogin: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

export function RegisterScreen({ onBackToLogin }: RegisterScreenProps) {
  const { register } = useAuth();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameCheck, setUsernameCheck] = useState<UsernameCheck>({ state: "idle" });

  // Availability probe on blur — best-effort; the authoritative uniqueness check is on submit.
  async function checkAvailability() {
    const value = username.trim();
    if (usernameFormatError(value)) {
      setUsernameCheck({ state: "idle" });
      return;
    }

    setUsernameCheck({ state: "checking" });
    try {
      const result = await launcherApi.checkUsername(value);
      setUsernameCheck(
        result.available ? { state: "available" } : { state: "unavailable", reason: result.reason ?? "That username is taken." },
      );
    } catch {
      setUsernameCheck({ state: "idle" });
    }
  }

  function validate(): string | null {
    const formatError = usernameFormatError(username.trim());
    if (formatError) return formatError;

    if (usernameCheck.state === "unavailable") {
      return usernameCheck.reason;
    }

    if (!EMAIL_PATTERN.test(email)) {
      return "Enter a valid email address.";
    }

    if (password.length < 8) {
      return "Password must be at least 8 characters.";
    }

    if (password !== confirmPassword) {
      return "Passwords don't match.";
    }

    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await register(username.trim(), email, password);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hint =
    usernameCheck.state === "checking"
      ? "Checking availability…"
      : usernameCheck.state === "available"
        ? "✓ Available"
        : "Letters and numbers only — shown in-game and used to invite you.";

  const hintClass =
    usernameCheck.state === "available" ? "text-online" : "text-text-faint";

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <div className="aether-halo pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <AetherMark size={40} />
          <h1 className="mt-4 text-[26px] font-semibold tracking-tight text-text">Become a Slayer</h1>
          <p className="mt-1.5 text-sm text-text-muted">Create your Mystic Paradox account</p>
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
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameCheck({ state: "idle" });
              }}
              onBlur={checkAvailability}
              disabled={submitting}
              error={usernameCheck.state === "unavailable" ? usernameCheck.reason : undefined}
            />
            {usernameCheck.state !== "unavailable" && <p className={`text-[12px] ${hintClass}`}>{hint}</p>}
          </div>

          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />

          <TextField
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            rightAdornment={
              <button
                type="button"
                className="rounded px-1.5 py-1 text-xs font-medium text-text-muted transition-colors duration-150 hover:text-text"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            }
          />

          <TextField
            label="Confirm password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />

          <Button type="submit" loading={submitting} className="mt-1 w-full">
            Create account
          </Button>

          <button
            type="button"
            className="rounded text-[13px] text-text-muted transition-colors duration-150 hover:text-text"
            onClick={onBackToLogin}
          >
            Already have an account? <span className="font-medium text-accent">Sign in</span>
          </button>
        </form>
      </div>
    </div>
  );
}
