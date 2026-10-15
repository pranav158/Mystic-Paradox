/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RenderCodeEmail } from "./codeEmail";

test("a code email carries the code, the expiry and the single-use note in its subject, text and HTML", () => {
    const mail = RenderCodeEmail("verify", "482913", 5);
    assert.equal(mail.subject, "Your Mystic Paradox code: 482913");
    assert.match(mail.text, /482913/);
    assert.match(mail.text, /expires in 5 minutes and works only once/);
    assert.match(mail.html, />482913</, "the code is one unbroken word, so a copied code pastes cleanly");
    assert.match(mail.html, /expires in 5 minutes and works only once/);
    assert.doesNotMatch(mail.html, /<img|<script|<link/i, "no images, scripts or external styles");
});

test("a reset email has its own subject and wording", () => {
    const mail = RenderCodeEmail("reset", "000017", 1);
    assert.equal(mail.subject, "Your Mystic Paradox password reset code: 000017");
    assert.match(mail.html, /Reset your password/);
    assert.match(mail.text, /expires in 1 minute and/);
});

test("an unlink email has its own subject and a warning about the password", () => {
    const mail = RenderCodeEmail("unlink", "552019", 5);
    assert.equal(mail.subject, "Your Mystic Paradox code to unlink Discord: 552019");
    assert.match(mail.html, /Unlink Discord/);
    assert.match(mail.text, /Discord stays linked/);
});

test("anything but 6 digits, or a bad expiry, is refused", () => {
    assert.throws(() => RenderCodeEmail("verify", "12345", 5));
    assert.throws(() => RenderCodeEmail("verify", "12345a", 5));
    assert.throws(() => RenderCodeEmail("verify", "<b>1</b>", 5));
    assert.throws(() => RenderCodeEmail("verify", "123456", 0));
});
