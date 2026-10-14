/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] GET /health/release-gates: the manager's preflight (observability/releaseGates.ts). Mounted on the app, so it is served by
// the plain HTTP listener and by the HTTPS one alike. No auth: it answers only to the socket peer on loopback, and it refuses (404, the
// same answer as an unknown route) anything else, including any request that carries a forwarding header. A reverse proxy on the same
// host reaches the backend from loopback, so the forwarding-header refusal is what keeps a proxied request out. The proxy site should
// also not forward this path at all (P4.1 nginx site).

import express, { Request, Response } from "express";
import { GetP2PExtension } from "../extensions/p2p";
import { BuildReleaseGatesBody, CoreReleaseGates, IsLoopbackAddress, ReleaseGate } from "../observability/releaseGates";

const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"] as const;

/** True when the request came through a proxy (any forwarding header). Read only to refuse; never to grant access. */
export function HasForwardingHeader(headers: Record<string, unknown>): boolean {
    return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/** The gates in manager order: the P2P module's (if loaded), then the core's. A module that throws makes one gate not ok. */
export async function CollectReleaseGates(environment: NodeJS.ProcessEnv = process.env): Promise<ReleaseGate[]> {
    let moduleGates: ReleaseGate[];
    try {
        moduleGates = (await GetP2PExtension().releaseGates?.()) ?? [];
    } catch {
        moduleGates = [{ name: "p2p_module_gates", ok: false, detail: "unreadable" }];
    }
    return [...moduleGates, ...CoreReleaseGates(environment)];
}

type GateCollector = () => Promise<ReleaseGate[]>;

/**
 * The route handler. A non-loopback peer, or a request with a forwarding header, gets 404 and the collector is not called. Otherwise
 * the body is the aggregate: 200 when every gate is ok, 503 when not (the same shape either way). A collector that throws is a 503
 * with one generic gate; the error text is never sent.
 */
export function CreateReleaseGatesHandler(collect: GateCollector = () => CollectReleaseGates()) {
    return async (req: Request, res: Response): Promise<void> => {
        if (!IsLoopbackAddress(req.socket?.remoteAddress) || HasForwardingHeader(req.headers)) {
            res.status(404).send();
            return;
        }
        let gates: ReleaseGate[];
        try {
            gates = await collect();
        } catch {
            gates = [{ name: "release_gates", ok: false, detail: "check failed" }];
        }
        const body = BuildReleaseGatesBody(gates);
        res.status(body.ok ? 200 : 503).json(body);
    };
}

/** A router with the route on it, using the given collector (tests pass plain gates; the app uses the default). */
export function CreateReleaseGatesRouter(collect?: GateCollector): express.Router {
    const router = express.Router();
    router.get("/health/release-gates", CreateReleaseGatesHandler(collect));
    return router;
}

export const releaseGatesRouter = CreateReleaseGatesRouter();
