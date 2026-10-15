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
import fs from "node:fs";
import path from "node:path";
import { RecentlyActiveAccountIds } from "../activity/activityMonitor";
import { GetP2PExtension } from "../extensions/p2p";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { BuildReleaseGatesBody, CoreReleaseGates, IsLoopbackAddress, ReleaseGate } from "../observability/releaseGates";

const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"] as const;

/** True when the request came through a proxy (any forwarding header). Read only to refuse; never to grant access. */
export function HasForwardingHeader(headers: Record<string, unknown>): boolean {
    return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/** The gates in manager order: the P2P module's (if loaded), then the core's. A module that throws makes one gate not ok. */
/** [2026-10-15] How recently a game must have reported in to count as playing for the release hold. */
const ACTIVE_PLAY_WINDOW_MS = 2 * 60_000;
/** The emergency override: this file in the backend's shared folder (next to the update feed) lets a release through anyway. */
const RELEASE_DURING_PLAY_FILE = "RELEASE_DURING_PLAY.allow";

/**
 * [2026-10-15] Owner's rule: never restart the backend mid-hunt. A release (or a start) is refused while anyone played within
 * ACTIVE_PLAY_WINDOW_MS, so the running version stays up and the release is pushed again later. 15 Oct: a release pushed 1.9
 * min into a realm Escalation dropped the player to the login screen. No account is named in the detail.
 */
export function ActivePlayGate(playing: number, overridden: boolean): ReleaseGate {
    if (playing === 0) return { name: "no_active_play", ok: true, detail: "nobody in game" };
    if (overridden) return { name: "no_active_play", ok: true, detail: `${playing} in game; held release let through by ${RELEASE_DURING_PLAY_FILE}` };
    return {
        name: "no_active_play",
        ok: false,
        detail: `${playing} player(s) in game within the last ${ACTIVE_PLAY_WINDOW_MS / 60_000} minutes: release held until they stop ` +
            `(emergency override: ${RELEASE_DURING_PLAY_FILE} in the backend's shared folder)`
    };
}

function ActivePlayers(): number {
    return new Set([...sessionRegistry.onlineAccountIds(), ...RecentlyActiveAccountIds(ACTIVE_PLAY_WINDOW_MS)]).size;
}

function ReleaseDuringPlayAllowed(environment: NodeJS.ProcessEnv): boolean {
    const UpdateRoot = path.resolve(environment.LAUNCHER_UPDATE_ROOT ?? path.join(process.cwd(), "updates"));
    return fs.existsSync(path.join(path.dirname(UpdateRoot), RELEASE_DURING_PLAY_FILE));
}

export async function CollectReleaseGates(environment: NodeJS.ProcessEnv = process.env): Promise<ReleaseGate[]> {
    let moduleGates: ReleaseGate[];
    try {
        moduleGates = (await GetP2PExtension().releaseGates?.()) ?? [];
    } catch {
        moduleGates = [{ name: "p2p_module_gates", ok: false, detail: "unreadable" }];
    }
    let playGate: ReleaseGate;
    try {
        playGate = ActivePlayGate(ActivePlayers(), ReleaseDuringPlayAllowed(environment));
    } catch {
        playGate = { name: "no_active_play", ok: false, detail: "unreadable" };
    }
    return [...moduleGates, playGate, ...CoreReleaseGates(environment)];
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
