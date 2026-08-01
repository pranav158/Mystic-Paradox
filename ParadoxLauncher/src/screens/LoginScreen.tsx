import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AetherMark } from "../components/AetherMark";

interface LoginScreenProps {
  onCreateAccount: () => void;
}

export function LoginScreen({ onCreateAccount }: LoginScreenProps) {
  const { login, startDiscordLogin, authError } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [discordSubmitting, setDiscordSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A Discord flow can fail asynchronously (deep-link error, or the completion
  // exchange itself failing) after this screen has already unmounted and
  // remounted — authError from context covers that; local `error` covers
  // synchronous form-submit failures this screen caused directly.
  const displayedError = error ?? authError;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      // Entered credentials are intentionally left in state — a successful
      // login unmounts this screen, and a failed one should not lose them.
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscord() {
    setError(null);
    setDiscordSubmitting(true);

    try {
      await startDiscordLogin();
    } catch (err) {
      setError(describeAuthError(err));
      setDiscordSubmitting(false);
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <div className="aether-halo pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <AetherMark size={40} />
          <h1 className="mt-4 text-[26px] font-semibold tracking-tight text-text">Mystic Paradox</h1>
          <p className="mt-1.5 text-sm text-text-muted">The Shattered Isles are waiting, Slayer.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-2xl border border-border bg-surface/80 p-6 shadow-[0_16px_48px_-16px] shadow-black/60 backdrop-blur-sm"
        >
          {displayedError && <Banner>{displayedError}</Banner>}

          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="slayer@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />

          <TextField
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
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

          <Button type="submit" loading={submitting} className="mt-1 w-full">
            Sign in
          </Button>

          <div className="flex items-center gap-3 text-xs text-text-faint">
            <div className="h-px flex-1 bg-border" />
            or
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button type="button" variant="secondary" className="w-full" loading={discordSubmitting} onClick={handleDiscord}>
            Continue with Discord
          </Button>

          <div className="mt-1 flex items-center justify-between text-[13px]">
            <button
              type="button"
              className="rounded font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
              onClick={onCreateAccount}
            >
              Create account
            </button>
            <span className="cursor-not-allowed text-text-faint" title="Not available yet">
              Forgot password
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
