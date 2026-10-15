/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] Sends the one-time code mail (email verification and password reset) over SMTP with nodemailer. The subject, text and
// HTML come from RenderCodeEmail (codeEmail.ts), with the code's expiry taken from the one TTL constant. Sending sits behind the
// MailTransport interface: tests install a recording transport (mail/testSupport.ts), so no test touches the network.
import { createTransport } from "nodemailer";
import { RenderCodeEmail } from "./codeEmail";
import { ReadSmtpSettings, SmtpSettings } from "./mailConfig";
import { EMAIL_CODE_TTL_MINUTES } from "../security/emailCodes";
import type { EmailCodePurpose } from "../persistence/contracts/EmailCodeRepository";

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
    html: string;
}

export interface MailTransport {
    send(message: MailMessage): Promise<void>;
}

export type CreateTransportFunction = typeof createTransport;

/**
 * The SMTP transport for the settings. Port 587 starts plain and must upgrade (requireTLS), so the login never goes out in clear;
 * port 465 (MYSTICPARADOX_SMTP_SECURE=tls) speaks TLS from the first byte. The factory is a parameter so tests can see the options
 * without a connection.
 */
export function CreateSmtpTransport(settings: SmtpSettings, factory: CreateTransportFunction = createTransport): MailTransport {
    const Transporter = factory({
        host: settings.host,
        port: settings.port,
        secure: settings.implicitTls,
        requireTLS: !settings.implicitTls,
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000
    });

    return {
        async send(message: MailMessage): Promise<void> {
            await Transporter.sendMail({
                from: settings.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
                html: message.html
            });
        }
    };
}

let TransportOverride: MailTransport | undefined;
let CachedTransport: MailTransport | undefined;

/** Tests only: the transport the code mail goes through instead of SMTP (undefined restores the SMTP transport). */
export function SetMailTransportForTest(transport: MailTransport | undefined): void {
    TransportOverride = transport;
}

/** The transport in use: the test override, else the SMTP transport built once from the environment. */
export function GetMailTransport(environment: NodeJS.ProcessEnv = process.env): MailTransport {
    if (TransportOverride !== undefined) return TransportOverride;
    if (CachedTransport === undefined) {
        const Reading = ReadSmtpSettings(environment);
        if (!Reading.configured) throw new Error(`the mail transport is not configured (${Reading.problems.join(", ")})`);
        CachedTransport = CreateSmtpTransport(Reading.settings);
    }
    return CachedTransport;
}

async function SendCodeMail(purpose: EmailCodePurpose, email: string, code: string): Promise<void> {
    const Mail = RenderCodeEmail(purpose, code, EMAIL_CODE_TTL_MINUTES);
    await GetMailTransport().send({ to: email, subject: Mail.subject, text: Mail.text, html: Mail.html });
}

/** Mails the email verification code. The code is 6 digits (RenderCodeEmail refuses anything else). */
export async function SendVerificationCode(email: string, code: string): Promise<void> {
    await SendCodeMail("verify", email, code);
}

/** Mails the password reset code. */
export async function SendPasswordResetCode(email: string, code: string): Promise<void> {
    await SendCodeMail("reset", email, code);
}

/** [2026-10-15] Mails the code that confirms unlinking Discord from the account. */
export async function SendDiscordUnlinkCode(email: string, code: string): Promise<void> {
    await SendCodeMail("unlink", email, code);
}

/**
 * What may be logged about a failed send: the error's code or class name, never its text, because an SMTP reply can repeat the
 * recipient's address.
 */
export function DescribeMailError(error: unknown): string {
    const Code = (error as { code?: unknown } | null)?.code;
    if (typeof Code === "string" && Code.length > 0) return Code;
    return error instanceof Error ? error.name : "error";
}
