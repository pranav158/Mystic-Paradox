/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";

import {
    GetRequestId,
    NormalizeRequestId,
    REQUEST_ID_HEADER,
    RequestContextMiddleware,
    RunWithRequestContext
} from "./requestContext";

test("request IDs accept a conservative transport-safe character set", () => {
    assert.equal(NormalizeRequestId("  req-1234:child_1.test  "), "req-1234:child_1.test");
    assert.equal(NormalizeRequestId("short"), undefined);
    assert.equal(NormalizeRequestId("request id with spaces"), undefined);
    assert.equal(NormalizeRequestId("<script>alert(1)</script>"), undefined);
    assert.equal(NormalizeRequestId("a".repeat(97)), undefined);
    assert.equal(NormalizeRequestId(["request-123"]), undefined);
});

test("async request context remains available through awaited work", async () => {
    const Result = await RunWithRequestContext(
        { requestId: "request-123", startedAtMs: Date.now() },
        async () => {
            await Promise.resolve();
            return GetRequestId();
        }
    );
    assert.equal(Result, "request-123");
    assert.equal(GetRequestId(), undefined);
});

test("middleware preserves a safe caller ID and returns it on the response", () => {
    const ResponseHeaders = new Map<string, string>();
    const Request = { headers: { [REQUEST_ID_HEADER]: "upstream-request-123" } } as unknown as Request;
    const Response = {
        setHeader(Name: string, Value: string) { ResponseHeaders.set(Name, Value); }
    } as unknown as Response;
    let Observed: string | undefined;

    RequestContextMiddleware(Request, Response, (() => {
        Observed = GetRequestId();
    }) as NextFunction);

    assert.equal(Observed, "upstream-request-123");
    assert.equal(ResponseHeaders.get(REQUEST_ID_HEADER), "upstream-request-123");
});

test("middleware replaces an unsafe caller ID with a UUID", () => {
    const ResponseHeaders = new Map<string, string>();
    const Request = { headers: { [REQUEST_ID_HEADER]: "bad request\nforged" } } as unknown as Request;
    const Response = {
        setHeader(Name: string, Value: string) { ResponseHeaders.set(Name, Value); }
    } as unknown as Response;
    let Observed: string | undefined;

    RequestContextMiddleware(Request, Response, (() => {
        Observed = GetRequestId();
    }) as NextFunction);

    assert.match(Observed ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(ResponseHeaders.get(REQUEST_ID_HEADER), Observed);
});
