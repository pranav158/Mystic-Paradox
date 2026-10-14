import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { UsernameField, useUsernameField } from "../components/UsernameField";
import { ServerSwitcher } from "../components/ServerSwitcher";
import { LegalConsentChecks } from "../components/LegalConsentChecks";
import { LegalLinks, useLegalViewer } from "../components/LegalDocument";
import { LEGAL } from "../legal/legalMeta";
import { useServer } from "../servers/ServerContext";
import { serverNaming } from "../servers/serverNames";

interface RegisterScreenProps {
  onBackToLogin: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RegisterScreen({ onBackToLogin }: RegisterScreenProps) {
  const { register } = useAuth();
  const { selected, officialNetwork } = useServer();
  const serverName = selected && !officialNetwork ? serverNaming(selected).primary : null;
  // [2026-10-14] The official backend (the official server and Paradox realms) requires the age and the acceptance of
  // the documents. A local server keeps its own rules, so its registration is unchanged and sends no consent.
  const askConsent = officialNetwork;
  const username = useUsernameField();
  const legal = useLegalViewer();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consentReady = !askConsent || (ageConfirmed && termsAccepted);

  function validate(): string | null {
    const usernameError = username.validate();
    if (usernameError) return usernameError;
    if (!EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirmPassword) return "Passwords don't match.";
    if (!consentReady) return `Confirm that you are ${LEGAL.minimumAge} or older and accept the Terms of Use and Privacy Policy.`;
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
      await register(
        username.value,
        email,
        password,
        askConsent
          ? { termsVersion: LEGAL.termsVersion, privacyVersion: LEGAL.privacyVersion, ageConfirmed: true }
          : undefined,
      );
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <AuthCard
        title={serverName ? `Join ${serverName}` : "Become a Slayer"}
        subtitle={serverName
          ? "Create an account on this server. It is stored only on the server's own PC, it may need the host's approval, and it is not a Mystic Paradox account."
          : "Create your Mystic Paradox account. Closed-test accounts are approved by an administrator."}
      >
        <ServerSwitcher />
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {error && <Banner>{error}</Banner>}

          <UsernameField field={username} disabled={submitting} />

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
            hint="At least 8 characters."
            rightAdornment={<RevealToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />}
          />

          <TextField
            label="Confirm password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />

          {askConsent && (
            <LegalConsentChecks
              minimumAge={LEGAL.minimumAge}
              age={ageConfirmed}
              agree={termsAccepted}
              disabled={submitting}
              onAgeChange={setAgeConfirmed}
              onAgreeChange={setTermsAccepted}
              onOpen={legal.open}
            />
          )}

          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Creating account…" disabled={!consentReady}>
            Create account
          </Button>

          <p className="auth-foot">
            Already have an account?
            <button type="button" className="link" onClick={onBackToLogin}>Sign in</button>
          </p>
          <LegalLinks onOpen={legal.open} />
        </form>
      </AuthCard>
      {legal.dialog}
    </AuthLayout>
  );
}
