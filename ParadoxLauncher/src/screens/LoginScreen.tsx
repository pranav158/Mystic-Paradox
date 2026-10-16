import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { DiscordIcon } from "../components/icons";
import { LegalLinks, useLegalViewer } from "../components/LegalDocument";
import { useServer } from "../servers/ServerContext";
import { serverNaming } from "../servers/serverNames";

interface LoginScreenProps {
  onCreateAccount: () => void;
}

export function LoginScreen({ onCreateAccount }: LoginScreenProps) {
  const { login, startDiscordLogin, authError, startPasswordReset } = useAuth();
  // [2026-10-13 realms S5] Sign-in goes to the selected server's own backend. Discord belongs to the official account
  // system, so a local server (which has its own accounts) offers email and password only.
  const { selected, officialNetwork, servers, select } = useServer();
  const serverName = selected && !officialNetwork ? serverNaming(selected).primary : null;
  const legal = useLegalViewer();

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

  // [2026-10-16] The sign-in card has no server choice. A local server chosen on the Servers page still shows its own
  // sign-in here, so this is the way back to the Mystic Paradox account (otherwise the card would be a dead end).
  async function switchToOfficialAccount() {
    const official = servers.find((server) => server.kind === "official");
    if (!official) return;
    setError(null);
    try {
      await select(official.id);
    } catch (err) {
      setError(typeof err === "string" && err.trim() ? err.trim().slice(0, 300) : "Couldn't switch to the Mystic Paradox account.");
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
      <AuthCard
        title={serverName ? `Sign in to ${serverName}` : "Welcome back, Slayer"}
        subtitle={serverName
          ? "Use your account on this server. It is not your Mystic Paradox account, and Mystic Paradox never sees it."
          : "Sign in to return to the Shattered Isles."}
      >
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

          {/* [2026-10-15] Password resets are the official backend's (a local server keeps its own accounts). */}
          {officialNetwork && (
            <p className="auth-aside">
              <button type="button" className="link" onClick={() => startPasswordReset()}>Forgot password?</button>
            </p>
          )}

          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Signing in…">
            Sign in
          </Button>

          {officialNetwork && (
            <>
              <div className="divider">or</div>

              <Button variant="discord" size="lg" block loading={discordSubmitting} loadingLabel="Opening Discord…" onClick={handleDiscord}>
                <DiscordIcon />Sign in with Discord
              </Button>
            </>
          )}

          <p className="auth-foot">
            {serverName ? "New to this server?" : "New to Mystic Paradox?"}
            <button type="button" className="link" onClick={onCreateAccount}>Create an account</button>
          </p>
          {serverName && (
            <p className="auth-foot">
              <button type="button" className="link" onClick={() => void switchToOfficialAccount()}>Use your Mystic Paradox account instead</button>
            </p>
          )}
        </form>
        {/* [2026-10-14] The documents, one click away on the sign-in screen as well as at registration. */}
        <LegalLinks onOpen={legal.open} />
      </AuthCard>
      {legal.dialog}
    </AuthLayout>
  );
}
