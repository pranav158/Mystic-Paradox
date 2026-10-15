/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The SMTP settings of the code mail: what counts as set, the defaults, and that a problem names its key and never its value.
import assert from "node:assert/strict";
import test from "node:test";
import { MAIL_FROM_DEFAULT, ReadSmtpSettings } from "./mailConfig";

const COMPLETE = {
    MYSTICPARADOX_SMTP_HOST: "smtp.example.test",
    MYSTICPARADOX_SMTP_USER: "postmaster",
    MYSTICPARADOX_SMTP_PASSWORD: "SECRET_PASSWORD_VALUE"
};

test("complete settings: port 587, STARTTLS, and the default From header", () => {
    const Reading = ReadSmtpSettings(COMPLETE);
    assert.equal(Reading.configured, true);
    if (!Reading.configured) return;
    assert.deepEqual(Reading.settings, {
        host: "smtp.example.test", port: 587, implicitTls: false, user: "postmaster",
        password: "SECRET_PASSWORD_VALUE", from: MAIL_FROM_DEFAULT
    });
    assert.equal(MAIL_FROM_DEFAULT, "Mystic Paradox <no-reply@mysticfox.dev>");
});

test("the port, the secure mode and the From header can be set", () => {
    const Reading = ReadSmtpSettings({
        ...COMPLETE, MYSTICPARADOX_SMTP_PORT: "465", MYSTICPARADOX_SMTP_SECURE: "TLS", MYSTICPARADOX_MAIL_FROM: "Ops <ops@example.test>"
    });
    assert.equal(Reading.configured, true);
    if (!Reading.configured) return;
    assert.equal(Reading.settings.port, 465);
    assert.equal(Reading.settings.implicitTls, true);
    assert.equal(Reading.settings.from, "Ops <ops@example.test>");
});

test("starttls is read as STARTTLS, not implicit TLS", () => {
    const Reading = ReadSmtpSettings({ ...COMPLETE, MYSTICPARADOX_SMTP_SECURE: " starttls " });
    assert.equal(Reading.configured && Reading.settings.implicitTls, false);
});

test("a missing or blank host, user or password is a problem, named by its key", () => {
    for (const key of ["MYSTICPARADOX_SMTP_HOST", "MYSTICPARADOX_SMTP_USER", "MYSTICPARADOX_SMTP_PASSWORD"] as const) {
        for (const value of [undefined, "", "   "]) {
            const Reading = ReadSmtpSettings({ ...COMPLETE, [key]: value });
            assert.equal(Reading.configured, false, `${key}=${JSON.stringify(value)}`);
            if (!Reading.configured) assert.deepEqual(Reading.problems, [key]);
        }
    }
});

test("an invalid port or secure mode is a problem, and no value is ever in the problem list", () => {
    const BadPort = ReadSmtpSettings({ ...COMPLETE, MYSTICPARADOX_SMTP_PORT: "SECRET_PORT_TEXT" });
    assert.equal(BadPort.configured, false);
    if (!BadPort.configured) {
        assert.match(BadPort.problems.join(), /MYSTICPARADOX_SMTP_PORT/);
        assert.doesNotMatch(BadPort.problems.join(), /SECRET_PORT_TEXT/);
    }

    const BadSecure = ReadSmtpSettings({ ...COMPLETE, MYSTICPARADOX_SMTP_SECURE: "ssl-maybe" });
    assert.equal(BadSecure.configured, false, "an unknown secure mode never falls back to plain text");
    if (!BadSecure.configured) assert.match(BadSecure.problems.join(), /MYSTICPARADOX_SMTP_SECURE/);

    for (const port of ["0", "65536", "587.5"]) {
        assert.equal(ReadSmtpSettings({ ...COMPLETE, MYSTICPARADOX_SMTP_PORT: port }).configured, false, port);
    }
});

test("the password is kept exactly as set (only blank counts as missing)", () => {
    const Reading = ReadSmtpSettings({ ...COMPLETE, MYSTICPARADOX_SMTP_PASSWORD: "  spaced  " });
    assert.equal(Reading.configured && Reading.settings.password, "  spaced  ");
});
