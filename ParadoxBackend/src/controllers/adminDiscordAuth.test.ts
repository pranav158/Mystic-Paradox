/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    AdminBootstrapDisplayName,
    AdminDiscordBindingCookie,
    BuildAdminFrontendRedirect,
    CreateBoundAdminDiscordState,
    ParseAdminDiscordAllowedIds,
    VerifyBoundAdminDiscordState
} from "./adminDiscordAuth";

function RestoreEnv(name: string, value: string | undefined): void {
    if (value == undefined) delete process.env[name];
    else process.env[name] = value;
}

test("admin Discord allow-list fails closed when absent or malformed", () => {
    assert.throws(() => ParseAdminDiscordAllowedIds(undefined), /NOT_CONFIGURED/);
    assert.throws(() => ParseAdminDiscordAllowedIds(""), /NOT_CONFIGURED/);
    assert.throws(() => ParseAdminDiscordAllowedIds("not-a-snowflake"), /INVALID/);
    assert.throws(() => ParseAdminDiscordAllowedIds("100000000000000001,123"), /INVALID/);
});

test("admin Discord allow-list trims and deduplicates valid IDs", () => {
    assert.deepEqual(
        ParseAdminDiscordAllowedIds(" 100000000000000001, 100000000000000001,123456789012345678 "),
        ["100000000000000001", "123456789012345678"]
    );
});

test("admin bootstrap display name is deterministic and launcher-valid", () => {
    const Name = AdminBootstrapDisplayName("100000000000000001");
    assert.equal(Name, AdminBootstrapDisplayName("100000000000000001"));
    assert.match(Name, /^[A-Za-z0-9]{3,16}$/);
    assert.throws(() => AdminBootstrapDisplayName("invalid"), /INVALID/);
});

test("admin Discord state is deterministic, high entropy, and browser-bound", () => {
    const BrowserBinding = Buffer.alloc(32, 0x11).toString("base64url");
    const OtherBinding = Buffer.alloc(32, 0x22).toString("base64url");
    const State = CreateBoundAdminDiscordState(BrowserBinding, "a".repeat(48));

    assert.equal(State, CreateBoundAdminDiscordState(BrowserBinding, "a".repeat(48)));
    assert.match(State, /^v1\.[a-f0-9]{48}\.[a-f0-9]{64}$/);
    assert.equal(VerifyBoundAdminDiscordState(State, BrowserBinding), true);
    assert.equal(VerifyBoundAdminDiscordState(State, OtherBinding), false);
    assert.equal(VerifyBoundAdminDiscordState(State, undefined), false);
});

test("admin Discord state rejects tampering and malformed browser bindings", () => {
    const BrowserBinding = Buffer.alloc(32, 0x33).toString("base64url");
    const State = CreateBoundAdminDiscordState(BrowserBinding, "b".repeat(48));

    assert.equal(VerifyBoundAdminDiscordState(`${State}x`, BrowserBinding), false);
    assert.equal(VerifyBoundAdminDiscordState(State.replace("v1.", "v2."), BrowserBinding), false);
    assert.throws(() => CreateBoundAdminDiscordState(BrowserBinding, "not-a-nonce"), /NONCE_INVALID/);
    assert.throws(() => CreateBoundAdminDiscordState("short", "b".repeat(48)), /BROWSER_BINDING_INVALID/);
});

test("admin Discord browser binding cookie survives OAuth redirect but is short-lived and HttpOnly", () => {
    const PreviousNodeEnv = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = "production";
        const Cookie = AdminDiscordBindingCookie(Buffer.alloc(32, 0x44).toString("base64url"));
        assert.match(Cookie, /Path=\/admin\/v1\/auth\/discord/);
        assert.match(Cookie, /HttpOnly/);
        assert.match(Cookie, /SameSite=Lax/);
        assert.match(Cookie, /Max-Age=300/);
        assert.match(Cookie, /Secure/);
        assert.match(AdminDiscordBindingCookie(), /Max-Age=0/);
    } finally {
        RestoreEnv("NODE_ENV", PreviousNodeEnv);
    }
});

test("admin frontend redirects require HTTPS in production and append safe errors", () => {
    const PreviousNodeEnv = process.env.NODE_ENV;
    const PreviousFrontend = process.env.ADMIN_FRONTEND_URL;
    try {
        process.env.NODE_ENV = "production";
        process.env.ADMIN_FRONTEND_URL = "https://pax.mysticfox.dev/";
        assert.equal(
            BuildAdminFrontendRedirect("discord_failed"),
            "https://pax.mysticfox.dev/?error=discord_failed"
        );

        process.env.ADMIN_FRONTEND_URL = "http://pax.mysticfox.dev/";
        assert.throws(() => BuildAdminFrontendRedirect(), /MUST_USE_HTTPS/);
    } finally {
        RestoreEnv("NODE_ENV", PreviousNodeEnv);
        RestoreEnv("ADMIN_FRONTEND_URL", PreviousFrontend);
    }
});
