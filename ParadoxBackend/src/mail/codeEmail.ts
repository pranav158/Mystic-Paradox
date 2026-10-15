/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * [2026-10-15] The one-time code email (email verification and password reset), in the launcher's look: the navy page
 * (--bg #050a12), a raised card (--bg-raise #0a1320), the Aether blue (#5ba3ff) for the code, the gold kicker (#e0c287) and the
 * serif wordmark. Mail clients ignore <style> blocks and web fonts unevenly, so every style is inline, the layout is tables,
 * and the fonts fall back to Georgia / Segoe UI / Consolas. No images: blocked images would leave holes, and the mail carries
 * no tracking. Nothing the user typed goes into the mail - only the code and fixed text.
 */

// [2026-10-15] "unlink": the code that confirms unlinking Discord from the account (owner: unlinking asks for a code).
export type CodeEmailPurpose = "verify" | "reset" | "unlink";

export interface CodeEmail {
    subject: string;
    text: string;
    html: string;
}

const COPY: Record<CodeEmailPurpose, { subject: string; kicker: string; title: string; lead: string }> = {
    verify: {
        subject: "Your Mystic Paradox code",
        kicker: "Email verification",
        title: "Confirm your email",
        lead: "Enter this code in the Mystic Paradox launcher to verify your email address."
    },
    reset: {
        subject: "Your Mystic Paradox password reset code",
        kicker: "Password reset",
        title: "Reset your password",
        lead: "Enter this code in the Mystic Paradox launcher to choose a new password."
    },
    unlink: {
        subject: "Your Mystic Paradox code to unlink Discord",
        kicker: "Discord unlink",
        title: "Unlink Discord",
        lead: "Enter this code in the Mystic Paradox launcher to unlink Discord from your account."
    }
};

const IGNORE: Record<CodeEmailPurpose, string> = {
    verify: "If you didn't create a Mystic Paradox account, ignore this email. Nothing happens without this code.",
    reset: "If you didn't ask to reset your password, ignore this email. Your password stays as it is.",
    unlink: "If you didn't ask to unlink Discord, ignore this email: Discord stays linked. Someone may know your password, so consider changing it."
};

const FONT_DISPLAY = "'Cinzel', 'Trajan Pro', Georgia, 'Times New Roman', serif";
const FONT_BODY = "'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO = "'Cascadia Mono', Consolas, 'SFMono-Regular', Menlo, monospace";

function Escape(value: string): string {
    return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * The subject, plain text and HTML of a code email. The code must be the 6 digits the caller generated; anything else is
 * refused so a caller bug can never put other text into the mail.
 */
export function RenderCodeEmail(purpose: CodeEmailPurpose, code: string, expiresInMinutes: number): CodeEmail {
    if (!/^\d{6}$/.test(code)) throw new Error("RenderCodeEmail: the code must be 6 digits");
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1) throw new Error("RenderCodeEmail: bad expiry");
    const copy = COPY[purpose];
    const minutes = `${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}`;
    const expiry = `This code expires in ${minutes} and works only once.`;
    const ignore = IGNORE[purpose];
    const footer = "Mystic Paradox is a community-run, open-source Dauntless server. It is not affiliated with Phoenix Labs.";

    const subject = `${copy.subject}: ${code}`;
    const text = [
        "MYSTIC PARADOX",
        "",
        copy.title,
        "",
        copy.lead,
        "",
        `    ${code}`,
        "",
        expiry,
        "",
        ignore,
        "",
        "--",
        footer
    ].join("\n");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${Escape(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#050a12;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#050a12;">${Escape(`${copy.title}: your code is ${code}. ${expiry}`)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#050a12;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;">
        <tr>
          <td align="center" style="padding:0 0 28px 0;">
            <div style="font-family:${FONT_DISPLAY};font-size:30px;line-height:30px;color:#8cc6ff;">&#10022;</div>
            <div style="padding-top:12px;font-family:${FONT_DISPLAY};font-size:19px;line-height:24px;letter-spacing:5px;color:#eef3fb;">MYSTIC PARADOX</div>
            <div style="padding-top:6px;font-family:${FONT_BODY};font-size:10px;line-height:14px;letter-spacing:4px;color:#8191a8;">DAUNTLESS SERVER</div>
          </td>
        </tr>
        <tr>
          <td style="background-color:#0a1320;border:1px solid #1d2b40;border-radius:22px;padding:32px 24px;">
            <div style="font-family:${FONT_BODY};font-size:11px;line-height:16px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#e0c287;">${Escape(copy.kicker)}</div>
            <div style="padding-top:10px;font-family:${FONT_DISPLAY};font-size:26px;line-height:32px;color:#eef3fb;">${Escape(copy.title)}</div>
            <div style="width:44px;height:2px;margin-top:14px;background-color:#5ba3ff;line-height:2px;font-size:2px;">&nbsp;</div>
            <div style="padding-top:18px;font-family:${FONT_BODY};font-size:15px;line-height:23px;color:#b9c5d8;">${Escape(copy.lead)}</div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px;">
              <tr>
                <td align="center" style="background-color:#0c1a2e;border:1px solid #2a4a75;border-radius:14px;padding:20px 8px;">
                  <div style="font-family:${FONT_MONO};font-size:32px;line-height:40px;font-weight:700;letter-spacing:7px;white-space:nowrap;color:#eef3fb;">${Escape(code)}</div>
                </td>
              </tr>
            </table>
            <div style="padding-top:18px;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:#8cc6ff;">${Escape(expiry)}</div>
            <div style="padding-top:22px;margin-top:22px;border-top:1px solid #16243a;font-family:${FONT_BODY};font-size:13px;line-height:20px;color:#8191a8;">${Escape(ignore)}</div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 12px 0 12px;font-family:${FONT_BODY};font-size:11px;line-height:17px;color:#5d6b82;">${Escape(footer)}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
    return { subject, text, html };
}
