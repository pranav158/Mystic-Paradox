import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { DiscordIcon } from "../components/icons";

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
    <AuthLayout>
      <AuthCard title="Welcome back, Slayer" subtitle="Sign in to return to the Shattered Isles.">
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {displayedError && <Banner>{displayedError}</Banner>}

          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="slayer@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            autoFocus
          />

          <TextField
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            rightAdornment={<RevealToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />}
          />

          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Signing in…">
            Sign in
          </Button>

          <div className="divider">or</div>

          <Button variant="discord" size="lg" block loading={discordSubmitting} loadingLabel="Opening Discord…" onClick={handleDiscord}>
            <DiscordIcon />Continue with Discord
          </Button>

          <p className="auth-foot">
            New to Mystic Paradox?
            <button type="button" className="link" onClick={onCreateAccount}>Create an account</button>
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
