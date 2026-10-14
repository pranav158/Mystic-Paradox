/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Request, RequestHandler, Response } from "express";
import { logger } from "../logger";
import { MonitorCooldownStart, MonitorSourceOf } from "../diagnostics/economyMonitor";
import { ExtensionHttpResponse, GetP2PExtension, P2PExtension } from "../extensions/p2p";
import {
    CooldownEntry,
    CooldownList,
    CooldownSaveValidationError,
    CooldownStatePayload,
    HostCooldownChanges,
    IsAuthorizedCooldownWriter,
    IsHostCooldownWriter,
    MergeCooldownState,
    MergeHostCooldownState
} from "../cooldownState";
import { CooldownStateRecord, GetRepositories } from "../persistence";
import { PerAccountQueue } from "./perAccountQueue";

const MAX_SAVE_ATTEMPTS = 8;
const SaveQueue = new PerAccountQueue();

export interface CooldownResult {
    payload: Record<string, string>;   // the wire payload (id -> ISO date map)
    list: CooldownEntry[];             // the same cooldowns as a list, for logs
}

export async function GetCooldownState(userId: string): Promise<CooldownResult & { record: CooldownStateRecord | undefined }> {
    const Record = await GetRepositories().cooldownStates.get(userId);
    return { payload: CooldownStatePayload(Record), list: CooldownList(Record), record: Record };
}

/** [2026-10-13 realms S3] `hostRules` applies MergeHostCooldownState (a cooldown may only move later) instead of the
 *  dedicated merge; the result then carries what changed, for the host-write tag. */
export interface CooldownSaveOptions {
    hostRules?: boolean;
}

export function SaveCooldowns(userId: string, body: unknown, options: CooldownSaveOptions = {}): Promise<CooldownResult & { record: CooldownStateRecord; changes?: HostCooldownChanges }> {
    return SaveQueue.run(userId, async () => {
        const Repository = GetRepositories().cooldownStates;
        for (let Attempt = 0; Attempt < MAX_SAVE_ATTEMPTS; Attempt++) {
            const Previous = await Repository.get(userId);
            let Next: CooldownStateRecord;
            let Changes: HostCooldownChanges | undefined;
            if (options.hostRules === true) ({ record: Next, changes: Changes } = MergeHostCooldownState(userId, Previous, body));
            else Next = MergeCooldownState(userId, Previous, body);
            const Saved = await Repository.saveIfVersion(Next, Previous?.updateVersion);
            if (Saved !== undefined) {
                return { payload: CooldownStatePayload(Saved), list: CooldownList(Saved), record: Saved, ...(Changes ? { changes: Changes } : {}) };
            }
        }
        throw new Error(`Cooldown save remained contended for ${userId}`);
    });
}

/*
 * PUT /cooldown/:userId/:cooldownId - StartCooldownEndpoint: start one cooldown now.
 *
 * The 1.14.7 hub sends it when a player harvests a seasonal city gatherable ("sprout"): UPlayerGatherableComponent::
 * OnGatherableHarvested (0x141A6DDE0) fills {accountid} and {cooldownid} = the node's 32-hex tracking GUID, verb PUT,
 * no body. UCooldownComponent::StartCooldown (0x141A33B30) uses the same endpoint. Both callbacks (0x141A76EB0,
 * 0x141A254A0) only check for HTTP 200-206 and parse no body. On success the gatherable one credits the Hunt Pass
 * (UHuntPassComponent::OnGatherableHarvested 0x141A1E240) and marks the node gathered; GET /cooldown serves it back
 * and the game re-opens it at its own daily respawn. Without this route every harvest got a 404 and was never saved.
 *
 * A 2xx releases the harvest reward, so an answer that stores nothing must not be a 2xx: persistence off -> 503 and
 * the INVALID sentinel -> 400. A 200 there would leave the node out of the next GET, so it would be available again
 * and pay again on every arrival. The start date is the backend's own UTC now and any body is ignored, so a caller
 * cannot backdate a cooldown.
 */
export const COOLDOWN_BATCH_SEGMENT = "batch";
const COOLDOWN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface StartCooldownOptions {
    persistence: boolean;              // MYSTICPARADOX_COOLDOWN_PERSISTENCE
    noPlayerUserId: string;            // the path sentinel a server sends for a player without an id
    now?: () => string;                // tests
    save?: (userId: string, body: unknown, saveOptions?: CooldownSaveOptions) => Promise<{ payload: Record<string, string>; record: CooldownStateRecord; changes?: HostCooldownChanges }>;
    hostWrites?: P2PExtension["hostWrites"];   // tests; defaults to GetP2PExtension().hostWrites (refuses in the dedicated-only build)
}

export interface StartCooldownResult {
    status: number;
    message: string;
    payload: Record<string, string>;   // the id -> ISO date map after the save, as GET serves it
    outcome: string;                   // the [CooldownMon] START text
    body?: unknown;                    // a response body to send as is (a host write the hooks refused)
}

/** [2026-10-13 realms S3] The two hostWrites hooks for one request, bound to its target account. */
export interface HostCooldownWrite {
    authorize(): Promise<ExtensionHttpResponse | undefined>;
    record(summary: Record<string, unknown>): Promise<void>;
}

export function IsValidCooldownId(id: unknown): id is string {
    return typeof id === "string" && COOLDOWN_ID_PATTERN.test(id);
}

export async function StartSingleCooldown(authData: any, userId: string, cooldownId: string, options: StartCooldownOptions, host?: HostCooldownWrite): Promise<StartCooldownResult> {
    const Refuse = (status: number, message: string, outcome: string): StartCooldownResult => ({ status, message, payload: {}, outcome });
    // [2026-10-13 realms S3] A player-host runtime may start a cooldown too, but only when the caller passes its hooks
    // (the handler does, for IsHostCooldownWriter requests) and only later than the stored date (MergeHostCooldownState).
    const IsHostWrite = !IsAuthorizedCooldownWriter(authData) && host !== undefined && IsHostCooldownWriter(authData);
    if (!IsAuthorizedCooldownWriter(authData) && !IsHostWrite) return Refuse(403, "Forbidden", "REFUSED without gameserver authority");
    if (!IsValidCooldownId(cooldownId)) return Refuse(400, "Bad Request", "REJECTED malformed cooldown id");
    if (userId === options.noPlayerUserId) return Refuse(400, "Bad Request", "REFUSED no-player sentinel, not stored");
    if (!options.persistence) return Refuse(503, "Service Unavailable", "REFUSED persistence off, not stored");
    if (IsHostWrite) {
        const Denied = await host!.authorize();
        if (Denied !== undefined) return { ...Refuse(Denied.status, "Forbidden", `REFUSED host write (${Denied.status})`), body: Denied.body };
    }

    const StartedDate = (options.now ?? (() => new Date().toISOString()))();
    try {
        const Save = options.save ?? SaveCooldowns;
        const Body = { cooldowns: [{ cooldown_id: cooldownId, cooldown_started_date: StartedDate }] };
        const { payload, record, changes } = await (IsHostWrite ? Save(userId, Body, { hostRules: true }) : Save(userId, Body));
        if (IsHostWrite) await host!.record({ route: "start", id: cooldownId, startedAt: StartedDate, ...(changes ?? {}) });
        // [2026-10-13 realms S3 limits] The start date here is the backend's own now, so it is never "too far ahead"; the note is
        // only for a caller that injects another clock (tests) or a future change of the date.
        const Kept = (changes !== undefined && changes.keptLaterCount > 0 ? " (kept the stored later date: a host cannot move a cooldown earlier)" : "")
            + (changes !== undefined && changes.refusedFutureCount > 0 ? " (refused: a host cannot start a cooldown that far ahead)" : "");
        return { status: 200, message: "OK", payload, outcome: `stored @${StartedDate} -> ${record.entries.length} cooldown(s) version=${record.updateVersion}${Kept}` };
    }
    catch (Err) {
        if (Err instanceof CooldownSaveValidationError) return Refuse(400, "Bad Request", `REJECTED ${Err.message}`);
        throw Err;
    }
}

/** The single-id route's handlers, for systemRouter.put("/cooldown/:userId/:cooldownId", ...). */
export function StartCooldownHandlers(auth: RequestHandler, options: StartCooldownOptions): RequestHandler[] {
    return [
        // "/cooldown/batch/<uid>" fits this path too. Leave it to the batch route before auth runs, whichever route is
        // registered first.
        (req, res, next) => {
            if (req.params.userId === COOLDOWN_BATCH_SEGMENT) next("route");
            else next();
        },
        auth,
        async (req: Request, res: Response) => {
            const AuthData = (req as any).AuthData;
            const UserId = String(req.params.userId);
            const CooldownId = String(req.params.cooldownId);
            let Result: StartCooldownResult;
            try {
                // [2026-10-13 realms S3] The hooks are looked up only for a host runtime (a dedicated or player request
                // never touches the P2P extension).
                let Host: HostCooldownWrite | undefined;
                if (!IsAuthorizedCooldownWriter(AuthData) && IsHostCooldownWriter(AuthData)) {
                    const Hooks = options.hostWrites ?? GetP2PExtension().hostWrites;
                    Host = {
                        authorize: () => Hooks.authorize(req, "COOLDOWN", UserId),
                        record: (summary) => Hooks.record(req, { kind: "COOLDOWN", targetUserId: UserId, summary })
                    };
                }
                Result = await StartSingleCooldown(AuthData, UserId, CooldownId, options, Host);
            }
            catch (Err) {
                // A store failure answers 500 (no 2xx, so no harvest reward); the monitor still records the harvest.
                MonitorCooldownStart(UserId, MonitorSourceOf(AuthData), CooldownId, `ERROR ${Err instanceof Error ? Err.message : String(Err)}`);
                throw Err;
            }
            MonitorCooldownStart(UserId, MonitorSourceOf(AuthData), CooldownId, Result.outcome);
            if (Result.body !== undefined) {
                logger.warn(`Rejected host cooldown write actor=${AuthData?.userId ?? "unknown"} target=${UserId}`);
                res.status(Result.status).json(Result.body);
                return;
            }
            if (Result.status === 403) {
                logger.warn(`Rejected cooldown write without gameserver authority actor=${AuthData?.userId ?? "unknown"} target=${UserId}`);
                res.status(403).send();
                return;
            }
            res.status(Result.status).json({ code: null, message: Result.message, payload: Result.payload });
        }
    ];
}
