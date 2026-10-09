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
const MAX_REQUEST_ID_LENGTH = 96;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface RequestContext {
    requestId: string;
    startedAtMs: number;
}

const RequestStorage = new AsyncLocalStorage<RequestContext>();

export function NormalizeRequestId(Value: unknown): string | undefined {
    if (typeof Value !== "string") return undefined;
    const Trimmed = Value.trim();
    if (Trimmed.length < 8 || Trimmed.length > MAX_REQUEST_ID_LENGTH) return undefined;
    return SAFE_REQUEST_ID.test(Trimmed) ? Trimmed : undefined;
}

function ReadIncomingRequestId(Request: Request): string | undefined {
    return NormalizeRequestId(Request.headers[REQUEST_ID_HEADER])
        ?? NormalizeRequestId(Request.headers["x-request-id"]);
}

export function RequestContextMiddleware(Request: Request, Response: Response, Next: NextFunction): void {
    const Context: RequestContext = {
        requestId: ReadIncomingRequestId(Request) ?? crypto.randomUUID(),
        startedAtMs: Date.now()
    };
    Response.setHeader(REQUEST_ID_HEADER, Context.requestId);
    RequestStorage.run(Context, Next);
}

export function GetRequestContext(): RequestContext | undefined {
    return RequestStorage.getStore();
}

export function GetRequestId(): string | undefined {
    return GetRequestContext()?.requestId;
}

export function RunWithRequestContext<T>(Context: RequestContext, Action: () => T): T {
    return RequestStorage.run(Context, Action);
}
