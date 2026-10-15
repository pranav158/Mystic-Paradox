import { useState, type FormEvent } from "react";
import { useAuth, describeAuthError } from "../auth/AuthContext";
import { RevealToggle, TextField } from "../components/TextField";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { CODE_LENGTH, EMAIL_PATTERN, codeDigits, isCodeComplete, passwordProblem } from "../auth/authRules";
import { useResendCooldown } from "../auth/useResendCooldown";

/**
 * [2026-10-15] "Forgot password?" on the sign-in card. Step one takes the account's email and sends a code; step two takes
 * the code and a new password (typed twice, under the registration rule). The answer is the same whether or not the
 * address has an account, so the notice does not say which.
 */
export function PasswordResetScreen() {
  const { sendPasswordResetCode, completePasswordReset, backToSignIn } = useAuth();
  const cooldown = useResendCooldown(false);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendCode(address: string, afterSend: () => void) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await sendPasswordResetCode(address);
      afterSend();
      cooldown.start();
      setNotice(`If an account uses ${address}, a code is on its way.`);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSendCode(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    void sendCode(address, () => {
      setSentTo(address);
      setStep("code");
    });
  }

  async function handleSetPassword(event: FormEvent) {
    event.preventDefault();
    if (!isCodeComplete(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code we sent.`);
      return;
    }
    const problem = passwordProblem(newPassword, confirmPassword);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // On success the auth context signs the account in and this screen is replaced.
      await completePasswordReset(sentTo, code, newPassword);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  const cooling = cooldown.remaining > 0;

  if (step === "email") {
    return (
      <AuthLayout>
        <AuthCard title="Reset your password" subtitle="Enter the email of your Mystic Paradox account. We send a code to it.">
          <form onSubmit={handleSendCode} className="auth-form" noValidate>
            {error && <Banner>{error}</Banner>}
            {notice && <Banner tone="success">{notice}</Banner>}

            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="slayer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />

            <Button type="submit" size="lg" block loading={busy} loadingLabel="Sending the code…" disabled={cooling}>
              Send code
            </Button>

            <p className="auth-foot">
              <button type="button" className="link" onClick={backToSignIn}>Back to sign in</button>
            </p>
          </form>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthCard title="Set a new password" subtitle={`Enter the ${CODE_LENGTH}-digit code we sent to ${sentTo}, then choose a new password.`}>
        <form onSubmit={handleSetPassword} className="auth-form" noValidate>
          {error && <Banner>{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}

          <TextField
            label={`${CODE_LENGTH}-digit code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(codeDigits(e.target.value))}
            disabled={busy}
            autoFocus
          />

          <TextField
            label="New password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={busy}
            hint="At least 8 characters."
            rightAdornment={<RevealToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />}
          />

          <TextField
            label="Confirm new password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
          />

          <Button type="submit" size="lg" block loading={busy} loadingLabel="Saving the password…">
            Set password
          </Button>

          <Button
            variant="secondary"
            block
            disabled={cooling || busy}
            onClick={() => void sendCode(sentTo, () => {})}
          >
            {cooling ? `Send a new code in ${cooldown.remaining} s` : "Send a new code"}
          </Button>

          <p className="auth-foot">
            <button type="button" className="link" onClick={backToSignIn}>Back to sign in</button>
          </p>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
