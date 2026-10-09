import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { UsernameField, useUsernameField } from "../components/UsernameField";

interface RegisterScreenProps {
  onBackToLogin: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RegisterScreen({ onBackToLogin }: RegisterScreenProps) {
  const { register } = useAuth();
  const username = useUsernameField();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    const usernameError = username.validate();
    if (usernameError) return usernameError;
    if (!EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirmPassword) return "Passwords don't match.";
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
      await register(username.value, email, password);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <AuthCard title="Become a Slayer" subtitle="Create your Mystic Paradox account. Closed-test accounts are approved by an administrator.">
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

          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Creating account…">
            Create account
          </Button>

          <p className="auth-foot">
            Already have an account?
            <button type="button" className="link" onClick={onBackToLogin}>Sign in</button>
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
