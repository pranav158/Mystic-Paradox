/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The SMTP settings of the one-time code mail (email verification and password reset). The owner sends through Mailgun
// over SMTP; the login is entered in the manager's env editor and is never printed or logged. A problem names its key only.

export const SMTP_HOST_ENV = "MYSTICPARADOX_SMTP_HOST";
export const SMTP_PORT_ENV = "MYSTICPARADOX_SMTP_PORT";
export const SMTP_SECURE_ENV = "MYSTICPARADOX_SMTP_SECURE";
export const SMTP_USER_ENV = "MYSTICPARADOX_SMTP_USER";
export const SMTP_PASSWORD_ENV = "MYSTICPARADOX_SMTP_PASSWORD";
export const MAIL_FROM_ENV = "MYSTICPARADOX_MAIL_FROM";
export const MAIL_FROM_DEFAULT = "Mystic Paradox <no-reply@mysticfox.dev>";

export interface SmtpSettings {
    host: string;
    port: number;
    /** true: TLS from the first byte (port 465, MYSTICPARADOX_SMTP_SECURE=tls). false: STARTTLS, which is required (port 587). */
    implicitTls: boolean;
    user: string;
    password: string;
    /** The From header, for example `Mystic Paradox <no-reply@mysticfox.dev>`. */
    from: string;
}

export type SmtpReading =
    | { configured: true; settings: SmtpSettings }
    | { configured: false; problems: string[] };

function Trimmed(environment: NodeJS.ProcessEnv, key: string): string {
    return (environment[key] ?? "").trim();
}

/**
 * Pure: the SMTP settings from the environment, or the keys that are missing or invalid (key names only, never values). Blank
 * counts as missing. The port defaults to 587 and MYSTICPARADOX_SMTP_SECURE to starttls. An unknown secure value is a problem:
 * the code mail must never fall back to a mode the owner did not choose.
 */
export function ReadSmtpSettings(environment: NodeJS.ProcessEnv = process.env): SmtpReading {
    const Problems: string[] = [];

    const Host = Trimmed(environment, SMTP_HOST_ENV);
    if (Host === "") Problems.push(SMTP_HOST_ENV);

    const PortText = Trimmed(environment, SMTP_PORT_ENV);
    const Port = PortText === "" ? 587 : Number(PortText);
    if (!Number.isInteger(Port) || Port < 1 || Port > 65535) Problems.push(`${SMTP_PORT_ENV} (a port number)`);

    const SecureText = Trimmed(environment, SMTP_SECURE_ENV).toLowerCase();
    if (!["", "starttls", "tls"].includes(SecureText)) Problems.push(`${SMTP_SECURE_ENV} (starttls or tls)`);

    const User = Trimmed(environment, SMTP_USER_ENV);
    if (User === "") Problems.push(SMTP_USER_ENV);

    const Password = environment[SMTP_PASSWORD_ENV] ?? "";
    if (Password.trim() === "") Problems.push(SMTP_PASSWORD_ENV);

    if (Problems.length > 0) return { configured: false, problems: Problems };

    const From = Trimmed(environment, MAIL_FROM_ENV) || MAIL_FROM_DEFAULT;
    return {
        configured: true,
        settings: { host: Host, port: Port, implicitTls: SecureText === "tls", user: User, password: Password, from: From }
    };
}
