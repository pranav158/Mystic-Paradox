import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { UsernameField, useUsernameField } from "../components/UsernameField";

// Shown when an account (typically a fresh Discord sign-in) has no username yet.
export function SetUsernameScreen() {
  const { setUsername, logout } = useAuth();
  const username = useUsernameField();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationError = username.validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await setUsername(username.value);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <AuthCard title="Choose your username" subtitle="This is your name in-game and how other Slayers invite you.">
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {error && <Banner>{error}</Banner>}
          <UsernameField field={username} disabled={submitting} />
          <Button type="submit" size="lg" block loading={submitting} loadingLabel="Saving…">
            Set username
          </Button>
          <p className="auth-foot">
            <button type="button" className="link" onClick={() => void logout()}>Cancel and sign out</button>
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
