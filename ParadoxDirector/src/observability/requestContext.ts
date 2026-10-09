/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-mysticparadox-request-id";
const RequestStorage = new AsyncLocalStorage<{ requestId: string }>();
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/;

function NormalizeRequestId(Value: unknown): string | undefined {
    if (typeof Value !== "string") return undefined;
    const Trimmed = Value.trim();
    return SAFE_REQUEST_ID.test(Trimmed) ? Trimmed : undefined;
}

export function RequestContextMiddleware(Request: Request, Response: Response, Next: NextFunction): void {
    const RequestId = NormalizeRequestId(Request.headers[REQUEST_ID_HEADER])
        ?? NormalizeRequestId(Request.headers["x-request-id"])
        ?? crypto.randomUUID();
    Response.setHeader(REQUEST_ID_HEADER, RequestId);
    RequestStorage.run({ requestId: RequestId }, Next);
}

export function GetRequestId(): string | undefined {
    return RequestStorage.getStore()?.requestId;
}
