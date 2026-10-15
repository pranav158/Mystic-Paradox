import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { CODE_LENGTH, codeDigits, isCodeComplete } from "../auth/authRules";
import { useResendCooldown } from "../auth/useResendCooldown";

interface EmailCodeScreenProps {
  /** Back to the sign-in card (the registration card is closed too). */
  onBack: () => void;
}

/**
 * [2026-10-15] The emailed code, after a sign-up or a sign-in the backend refused as unverified. The password typed before
 * is held by the auth context in memory only, because the backend checks it together with the code. The first code was
 * just sent, so the resend wait starts now.
 */
export function EmailCodeScreen({ onBack }: EmailCodeScreenProps) {
  const { codeEmail, verifyEmailCode, resendEmailCode } = useAuth();
  const cooldown = useResendCooldown(true);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const address = codeEmail ?? "your email";

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    if (!isCodeComplete(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code we sent.`);
      return;
    }
    setError(null);
    setNotice(null);
    setVerifying(true);
    try {
      // On success the auth context moves on and this screen is replaced.
      await verifyEmailCode(code);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await resendEmailCode();
      cooldown.start();
      setNotice(`A new code was sent to ${address}.`);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setResending(false);
    }
  }

  const cooling = cooldown.remaining > 0;

  return (
    <AuthLayout>
      <AuthCard title="Check your email" subtitle={`Enter the ${CODE_LENGTH}-digit code we sent to ${address}.`}>
        <form onSubmit={handleVerify} className="auth-form" noValidate>
          {error && <Banner>{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}

          <TextField
            label={`${CODE_LENGTH}-digit code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(codeDigits(e.target.value))}
            disabled={verifying}
            autoFocus
          />

          <Button type="submit" size="lg" block loading={verifying} loadingLabel="Checking the code…">
            Verify
          </Button>

          <Button
            variant="secondary"
            block
            disabled={cooling || resending}
            loading={resending}
            loadingLabel="Sending a new code…"
            onClick={() => void handleResend()}
          >
            {cooling ? `Resend code in ${cooldown.remaining} s` : "Resend code"}
          </Button>

          <p className="auth-foot">
            <button type="button" className="link" onClick={onBack}>Back to sign in</button>
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
