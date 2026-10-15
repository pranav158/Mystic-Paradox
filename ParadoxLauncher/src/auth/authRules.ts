// [2026-10-15] Pure helpers for the sign-in screens: the error code a refusal carries, the copy for the codes the email
// screens act on, the six-digit code field and the password rule that registration and a password reset share. No React
// and no imports here, so the workflow tests load this file as it is.

export const CODE_LENGTH = 6;

/** The address check registration and the password reset share (the server has the final word). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The launcher's error code of a refusal, when the native side sent one (`CODE: sentence`, see commands/auth.rs). */
export function authErrorCode(error: unknown): string | null {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : null;
  const match = text ? /^(AUTH_[A-Z_]+): /.exec(text) : null;
  return match ? match[1] : null;
}

/** The sentence for the codes the email screens act on. Other refusals keep the native sentence (`stripAuthCode`). */
export const AUTH_CODE_COPY: Partial<Record<string, string>> = {
  AUTH_CODE_INVALID: "That code is wrong or has expired. Check the latest email or resend the code.",
  AUTH_EMAIL_UNAVAILABLE: "Email isn't available on this server right now.",
  AUTH_EMAIL_UNVERIFIED: "Enter the 6-digit code we sent to your email.",
};

/** A refusal's sentence without its code prefix, for a screen that shows it as text. */
export function stripAuthCode(text: string): string {
  return text.replace(/^AUTH_[A-Z_]+: /, "");
}

/** What a six-digit code field keeps: digits only, at most six (paste works; letters and spaces are dropped). */
export function codeDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function isCodeComplete(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);
}

/** [2026-10-15] The sentence for a Discord link that did not complete (`mysticparadox://link/error?code=...`). */
export function discordLinkErrorText(code: string): string {
  if (code === "AUTH_DISCORD_ALREADY_LINKED") return "That Discord account is already linked to another Mystic Paradox account.";
  if (code === "AUTH_DISCORD_ACCOUNT_HAS_LINK") return "This account already has a Discord account linked.";
  return "Discord linking didn't complete. Please try again.";
}

/** The password rule registration and a password reset share. Null when the pair is acceptable. */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password !== confirmation) return "Passwords don't match.";
  return null;
}
