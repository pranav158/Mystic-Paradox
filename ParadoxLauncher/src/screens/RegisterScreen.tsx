import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { UsernameField, useUsernameField } from "../components/UsernameField";
import { LegalConsentChecks } from "../components/LegalConsentChecks";
import { LegalLinks, useLegalViewer } from "../components/LegalDocument";
import { LEGAL } from "../legal/legalMeta";
import { useServer } from "../servers/ServerContext";
import { serverNaming } from "../servers/serverNames";
import { EMAIL_PATTERN, authErrorCode, passwordProblem, stripAuthCode } from "../auth/authRules";

interface RegisterScreenProps {
  onBackToLogin: () => void;
}

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
  // [2026-10-16] Which fields the player has left: their mistakes show from then on (the button waits, so it must say why).
  const [touched, setTouched] = useState({ email: false, password: false, confirm: false });
  const consentReady = !askConsent || (ageConfirmed && termsAccepted);
  const emailError = EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
  // [2026-10-15] The password rule is shared with the password reset (auth/authRules.ts): its length, then the match.
  const passwordLengthError = passwordProblem(password, password);
  const confirmError = confirmPassword && confirmPassword !== password ? "Passwords don't match." : null;
  // [2026-10-16] Create account waits until every field is valid and the username check says Available (0.1.71: the name is
  // asked for here again; an account held for approval has no session, so it could never reach the set-username step).
  const formReady = username.ready && !emailError && !passwordProblem(password, confirmPassword) && consentReady;

  function validate(): string | null {
    const usernameError = username.validate();
    if (usernameError) return usernameError;
    if (emailError) return emailError;
    const passwordError = passwordProblem(password, confirmPassword);
    if (passwordError) return passwordError;
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
        email,
        password,
        askConsent
          ? { termsVersion: LEGAL.termsVersion, privacyVersion: LEGAL.privacyVersion, ageConfirmed: true }
          : undefined,
        username.value,
      );
    } catch (err) {
      // [2026-10-16] The server refused the name after the live check passed (someone took it meanwhile): on the field.
      if (authErrorCode(err) === "AUTH_USERNAME_REFUSED") {
        username.setRefusal(stripAuthCode(typeof err === "string" ? err : err instanceof Error ? err.message : ""));
      } else {
        setError(describeAuthError(err));
      }
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
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {error && <Banner>{error}</Banner>}

          <UsernameField field={username} disabled={submitting} />

          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, email: true }))}
            disabled={submitting}
            error={touched.email && email && emailError ? emailError : undefined}
          />

          <TextField
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, password: true }))}
            disabled={submitting}
            hint="At least 8 characters."
            error={touched.password && password && passwordLengthError ? passwordLengthError : undefined}
            rightAdornment={<RevealToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />}
          />

          <TextField
            label="Confirm password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onBlur={() => setTouched((current) => ({ ...current, confirm: true }))}
            disabled={submitting}
            error={(touched.confirm || confirmPassword.length >= password.length) && confirmError ? confirmError : undefined}
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

          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Creating account…" disabled={!formReady}>
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
