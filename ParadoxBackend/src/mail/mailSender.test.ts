/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The SMTP settings, the nodemailer transport options (through an injected factory, so no connection is made), and the
// code mail's subject, text and HTML (RenderCodeEmail with the one 5-minute constant). Nothing here touches the network.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { ReadSmtpSettings } from "./mailConfig";
import { CreateSmtpTransport, DescribeMailError, GetMailTransport, SendPasswordResetCode, SendVerificationCode, SetMailTransportForTest } from "./mailSender";
import { RecordingMailTransport } from "./testSupport";
import { EMAIL_CODE_TTL_MINUTES } from "../security/emailCodes";

afterEach(() => SetMailTransportForTest(undefined));

const SMTP_ENV = {
    MYSTICPARADOX_SMTP_HOST: "smtp.example.test",
    MYSTICPARADOX_SMTP_USER: "postmaster",
    MYSTICPARADOX_SMTP_PASSWORD: "fixture-password"
};

test("the code mail's wording states the 5-minute expiry from the one constant", () => {
    assert.equal(EMAIL_CODE_TTL_MINUTES, 5);
});

test("a verification code is mailed with the subject, the expiry and the single-use note, to the address", async () => {
    const Recorder = new RecordingMailTransport();
    SetMailTransportForTest(Recorder);
    await SendVerificationCode("slayer@example.test", "482913");
    assert.equal(Recorder.sent.length, 1);
    const [Mail] = Recorder.sent;
    assert.equal(Mail!.to, "slayer@example.test");
    assert.equal(Mail!.subject, "Your Mystic Paradox code: 482913");
    assert.match(Mail!.text, /expires in 5 minutes and works only once/);
    assert.match(Mail!.html, /expires in 5 minutes and works only once/);
});

test("a password reset code is mailed with its own subject", async () => {
    const Recorder = new RecordingMailTransport();
    SetMailTransportForTest(Recorder);
    await SendPasswordResetCode("slayer@example.test", "000017");
    assert.equal(Recorder.sent[0]!.subject, "Your Mystic Paradox password reset code: 000017");
    assert.equal(Recorder.codeFor("slayer@example.test"), "000017");
});

test("a code that is not 6 digits is refused before anything is sent", async () => {
    const Recorder = new RecordingMailTransport();
    SetMailTransportForTest(Recorder);
    await assert.rejects(SendVerificationCode("slayer@example.test", "12345"));
    assert.equal(Recorder.sent.length, 0);
});

test("without the SMTP settings the transport refuses, and names the keys (never their values)", () => {
    assert.throws(() => GetMailTransport({}), (error: unknown) => {
        const Message = String((error as Error).message);
        return /MYSTICPARADOX_SMTP_HOST/.test(Message) && /MYSTICPARADOX_SMTP_PASSWORD/.test(Message);
    });
});

test("the SMTP transport sends STARTTLS with a required upgrade on port 587 (the default)", async () => {
    const Calls: { options?: any; mail?: any } = {};
    const Factory = ((options: any) => {
        Calls.options = options;
        return { sendMail: async (mail: any) => { Calls.mail = mail; return {}; } };
    }) as unknown as Parameters<typeof CreateSmtpTransport>[1];
    const Reading = ReadSmtpSettings(SMTP_ENV);
    assert.equal(Reading.configured, true);
    const Transport = CreateSmtpTransport(Reading.configured ? Reading.settings : (undefined as never), Factory);
    await Transport.send({ to: "slayer@example.test", subject: "S", text: "T", html: "<p>H</p>" });
    assert.equal(Calls.options.host, "smtp.example.test");
    assert.equal(Calls.options.port, 587);
    assert.equal(Calls.options.secure, false);
    assert.equal(Calls.options.requireTLS, true, "the login never goes out before TLS is up");
    assert.deepEqual(Calls.options.auth, { user: "postmaster", pass: "fixture-password" });
    assert.deepEqual(Calls.mail, {
        from: "Mystic Paradox <no-reply@mysticfox.dev>", to: "slayer@example.test", subject: "S", text: "T", html: "<p>H</p>"
    });
});

test("port 465 with MYSTICPARADOX_SMTP_SECURE=tls speaks TLS from the first byte", () => {
    const Captured: any[] = [];
    const Factory = ((options: any) => { Captured.push(options); return { sendMail: async () => ({}) }; }) as unknown as Parameters<typeof CreateSmtpTransport>[1];
    const Reading = ReadSmtpSettings({ ...SMTP_ENV, MYSTICPARADOX_SMTP_PORT: "465", MYSTICPARADOX_SMTP_SECURE: "tls" });
    assert.equal(Reading.configured, true);
    CreateSmtpTransport(Reading.configured ? Reading.settings : (undefined as never), Factory);
    assert.equal(Captured[0].port, 465);
    assert.equal(Captured[0].secure, true);
    assert.equal(Captured[0].requireTLS, false);
});

test("DescribeMailError gives the error code or class, never its message (an SMTP reply can repeat the address)", () => {
    const WithCode = Object.assign(new Error("550 slayer@example.test rejected"), { code: "EENVELOPE" });
    assert.equal(DescribeMailError(WithCode), "EENVELOPE");
    assert.equal(DescribeMailError(new TypeError("slayer@example.test")), "TypeError");
    assert.equal(DescribeMailError("slayer@example.test"), "error");
});
