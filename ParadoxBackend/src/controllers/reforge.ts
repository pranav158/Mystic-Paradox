/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * Weapon reforge (weapon prestige), 1.14.7. UPlayerExperienceComponent::ServerPrestigeExperience_Implementation
 * (0x141A879C0), in order:
 *   1. pays the cost (ServerConsumeItem -> POST /inventory, e.g. CURRENCY_PJM_PRESTIGE_EMPTY x100 for the Axe);
 *   2. DELETE /progression/{acct}/ExperienceTrack_Weapon_X                        <- ReforgeReset
 *      (validator 0x140DA4790: 200-206 and a JSON object, else the game stops here and nothing more happens);
 *   3. GET /progression/{acct}/ExperienceTrack_Weapon_X (read back; if it fails the game skips 4 and 5);
 *   4. POST /progression/{acct}/PrestigeTrack_Weapon_X/1                         <- one per reforge
 *   5. 0.5 s later POST /progression/{acct}/ExperienceTrack_Weapon_X/{banked}    <- one per reforge, = progress - cap
 *   6. the Aetherheart (POST /inventory, prestige-gated in wallet.ts) and the prestige rank confirm.
 * The game guards none of 4/5 against a duplicate reforge RPC, so the backend does: the reset stores a reforge record on
 * the weapon's ExperienceTrack row, and the +1 and the banked restore are each accepted once against it, marked inside
 * the grant's own transaction. A repeated DELETE while the record is open replays without resetting again.
 * MYSTICPARADOX_REFORGE=off answers the DELETE 409 (the game stops after paying its cost - as before this route
 * existed), =log does the same and logs the request; default on.
 */

import { RecordReforgeActivity } from "../activity/activityMonitor";
import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { logger } from "../logger";
import { GetRepositories, ProgressionTrackRecord, RepositoryProvider, WeaponReforgeState } from "../persistence";
import { TrackCapXp } from "./progression";

export const REFORGE_MODE: "on" | "log" | "off" = (() => {
    const Value = (process.env.MYSTICPARADOX_REFORGE ?? "on").trim().toLowerCase();
    return Value === "off" || Value === "log" ? Value : "on";
})();

const WEAPON_EXPERIENCE_TRACK = /^ExperienceTrack_Weapon_(Axe|ChainBlades|Hammer|Repeaters|Spear|Strikers|Sword)$/;
const WEAPON_PRESTIGE_TRACK = /^PrestigeTrack_Weapon_(Axe|ChainBlades|Hammer|Repeaters|Spear|Strikers|Sword)$/;
// A banked restore that arrives again after the record closed is a duplicate reforge RPC; well past the game's 0.5 s.
const DUPLICATE_RESTORE_WINDOW_MS = 15 * 60 * 1000;
// An open record older than this was abandoned (the read-back or a follow-up never arrived): the follow-ups come within
// about a second, so the next DELETE or the next arrival's progression load finishes it (FinishStaleReforgesForUser).
const STALE_REFORGE_MS = 2 * 60 * 1000;

export function IsReforgeableTrack(progressionId: string): boolean {
    return WEAPON_EXPERIENCE_TRACK.test(progressionId);
}

export function ExperienceTrackForPrestige(progressionId: string): string | undefined {
    const Match = WEAPON_PRESTIGE_TRACK.exec(progressionId);
    return Match ? `ExperienceTrack_Weapon_${Match[1]}` : undefined;
}

function PrestigeTrackFor(experienceTrack: string): string {
    return experienceTrack.replace(/^ExperienceTrack_/, "PrestigeTrack_");
}

export type ReforgeGrantPlan =
    | { kind: "normal" }
    | { kind: "prestige"; experienceTrack: string; reforge: WeaponReforgeState }
    | { kind: "restore"; experienceTrack: string; reforge: WeaponReforgeState }
    | { kind: "refuse"; reason: string };

/**
 * Pure: how a grant relates to the weapon's reforge. `experienceRow` is the weapon's ExperienceTrack row (for a
 * PrestigeTrack grant, the same weapon's ExperienceTrack). With the reforge feature off nothing changes.
 */
export function ClassifyReforgeGrant(progressionId: string, amount: number, experienceRow: ProgressionTrackRecord | undefined,
    nowMs: number, mode: typeof REFORGE_MODE = REFORGE_MODE): ReforgeGrantPlan {
    if (mode !== "on") return { kind: "normal" };
    const Reforge = experienceRow?.reforge;

    if (WEAPON_PRESTIGE_TRACK.test(progressionId)) {
        // The game grants a weapon's prestige track only from a reforge (step 4), always +1.
        if (Reforge?.status === "open" && !Reforge.prestigeGranted && amount === 1) {
            return { kind: "prestige", experienceTrack: ExperienceTrackForPrestige(progressionId)!, reforge: Reforge };
        }
        return { kind: "refuse", reason: Reforge?.status === "open"
            ? (amount === 1 ? "this reforge's +1 was already granted" : `prestige amount ${amount} is not 1`)
            : "no open reforge for this weapon" };
    }

    if (IsReforgeableTrack(progressionId) && Reforge !== undefined && Reforge.banked > 0) {
        const Remaining = Reforge.banked - Reforge.bankedRestored;
        if (Reforge.status === "open" && Remaining > 0 && amount === Remaining) {
            return { kind: "restore", experienceTrack: progressionId, reforge: Reforge };
        }
        if (Remaining === 0 && amount === Reforge.banked && nowMs - Date.parse(Reforge.openedAt) < DUPLICATE_RESTORE_WINDOW_MS) {
            return { kind: "refuse", reason: `banked ${Reforge.banked} of reforge ${Reforge.reforgeId} was already restored` };
        }
    }
    return { kind: "normal" };
}

export class ReforgeConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReforgeConflictError";
    }
}

/** The grant transaction's hook for a prestige/restore plan: marks the one-time use, or throws ReforgeConflictError. */
export function ReforgeGrantHook(userId: string, plan: ReforgeGrantPlan) {
    if (plan.kind !== "prestige" && plan.kind !== "restore") return undefined;
    return async (repos: RepositoryProvider, session: ClientSession) => {
        const R = plan.reforge;
        const Now = new Date().toISOString();
        const Expected: Partial<WeaponReforgeState> = { status: "open", prestigeGranted: R.prestigeGranted, bankedRestored: R.bankedRestored };
        const Set: Partial<WeaponReforgeState> = plan.kind === "prestige"
            ? { prestigeGranted: true }
            : { bankedRestored: R.banked };
        const PrestigeDone = plan.kind === "prestige" ? true : R.prestigeGranted;
        const BankedDone = plan.kind === "restore" ? true : R.bankedRestored >= R.banked;
        if (PrestigeDone && BankedDone) {
            Set.status = "closed";
            Set.closedAt = Now;
        }
        const Applied = await repos.progressionTracks.updateReforge(userId, plan.experienceTrack, R.reforgeId, Expected, Set, session);
        if (!Applied) throw new ReforgeConflictError(`reforge ${R.reforgeId} changed concurrently (${plan.kind})`);
        logger.info(`[Reforge] ${plan.kind === "prestige" ? "PRESTIGE" : "BANKED"} user=${userId} track=${plan.experienceTrack}`
            + ` reforge=${R.reforgeId}${plan.kind === "restore" ? ` restored=${R.banked}` : ""}${Set.status === "closed" ? " CLOSE" : ""}`);
    };
}

export type ReforgeResetResult =
    | { status: 200; outcome: "reset" | "replay"; record: ProgressionTrackRecord }
    | { status: 409; outcome: "below_cap" | "no_track" | "disabled" | "contended" | "stale_finished"; record?: ProgressionTrackRecord };

/**
 * The game's DELETE on a weapon's ExperienceTrack: reset it for a reforge. Single-document compare-and-set, so a retried
 * or duplicate DELETE never resets twice: while the reforge is open it replays (200, unchanged).
 */
export async function ReforgeReset(userId: string, experienceTrack: string, nowMs = Date.now()): Promise<ReforgeResetResult> {
    if (REFORGE_MODE !== "on") {
        logger.warn(`[Reforge] DELETE-REQ user=${userId} track=${experienceTrack} refused: MYSTICPARADOX_REFORGE=${REFORGE_MODE}`);
        return { status: 409, outcome: "disabled" };
    }
    const Tracks = GetRepositories().progressionTracks;
    const Cap = TrackCapXp(experienceTrack);
    if (Cap === undefined || Cap <= 0) return { status: 409, outcome: "no_track" };

    for (let Attempt = 0; Attempt < 4; Attempt++) {
        const Row = await Tracks.get(userId, experienceTrack);
        if (Row === undefined) return { status: 409, outcome: "no_track" };

        if (Row.reforge?.status === "open") {
            if (nowMs - Date.parse(Row.reforge.openedAt) < STALE_REFORGE_MS) {
                logger.info(`[Reforge] REPLAY user=${userId} track=${experienceTrack} reforge=${Row.reforge.reforgeId} (open; not reset again)`);
                return { status: 200, outcome: "replay", record: Row };
            }
            await FinishStaleReforge(userId, experienceTrack, Row);
            return { status: 409, outcome: "stale_finished", record: await Tracks.get(userId, experienceTrack) };
        }

        if (Row.progress < Cap) {
            logger.warn(`[Reforge] REFUSED user=${userId} track=${experienceTrack} progress=${Row.progress} below the level-20 cap ${Cap}`);
            return { status: 409, outcome: "below_cap", record: Row };
        }

        const Reforge: WeaponReforgeState = {
            reforgeId: crypto.randomUUID(),
            status: "open",
            priorProgress: Row.progress,
            cap: Cap,
            banked: Row.progress - Cap,
            bankedRestored: 0,
            prestigeGranted: false,
            openedAt: new Date(nowMs).toISOString(),
        };
        const After = await Tracks.beginReforge(userId, experienceTrack, Row.progress, Row.updateVersion, Reforge);
        if (After !== undefined) {
            logger.info(`[Reforge] RESET user=${userId} track=${experienceTrack} reforge=${Reforge.reforgeId}`
                + ` prior=${Reforge.priorProgress} cap=${Cap} banked=${Reforge.banked}`);
            RecordReforgeActivity(userId, nowMs);
            return { status: 200, outcome: "reset", record: After };
        }
    }
    logger.warn(`[Reforge] REFUSED user=${userId} track=${experienceTrack}: the row kept changing (contended)`);
    return { status: 409, outcome: "contended" };
}

/**
 * The banked re-grant (step 5) arrives as POST /progression/purchase/{acct}/{track}/{amount}
 * (GrantProgressionPurchaseEndPoint, service vtable +0x38 0x140E61B00; captured live 11 Oct 13:57:34 as
 * /progression/purchase/<acct>/ExperienceTrack_Weapon_Axe/3500, with no grant id). It is accepted only as the open
 * reforge's banked restore, with a grant id derived from the reforge so a retry replays through the grant ledger.
 */
export function PlanPurchaseRestore(progressionId: string, amount: number, experienceRow: ProgressionTrackRecord | undefined,
    nowMs: number): { plan: ReforgeGrantPlan; grantId?: string } {
    if (REFORGE_MODE !== "on" || !IsReforgeableTrack(progressionId)) {
        return { plan: { kind: "refuse", reason: "not a reforge banked restore" } };
    }
    const Reforge = experienceRow?.reforge;
    if (Reforge === undefined) return { plan: { kind: "refuse", reason: "no reforge for this weapon" } };
    const GrantId = `reforge-${Reforge.reforgeId}-banked`;
    const Plan = ClassifyReforgeGrant(progressionId, amount, experienceRow, nowMs);
    if (Plan.kind === "restore") return { plan: Plan, grantId: GrantId };
    // Already restored by this same reforge: let the ledger replay it rather than refusing a retry.
    if (Reforge.bankedRestored >= Reforge.banked && amount === Reforge.banked) return { plan: { kind: "normal" }, grantId: GrantId };
    return { plan: { kind: "refuse", reason: Plan.kind === "refuse" ? Plan.reason : `amount ${amount} is not the banked ${Reforge.banked - Reforge.bankedRestored}` } };
}

/**
 * Called on each arrival's progression load: finishes this player's abandoned weapon reforges (see FinishStaleReforge).
 * [2026-10-17] Returns the weapon tracks it finished (a realm server's load tags and logs them, routes/progression.ts).
 */
export async function FinishStaleReforgesForUser(userId: string, nowMs = Date.now()): Promise<string[]> {
    if (REFORGE_MODE !== "on") return [];
    const Finished: string[] = [];
    const Rows = await GetRepositories().progressionTracks.getAllForUser(userId);
    for (const Row of Rows) {
        if (!IsReforgeableTrack(Row.progressionId) || Row.reforge?.status !== "open") continue;
        if (nowMs - Date.parse(Row.reforge.openedAt) < STALE_REFORGE_MS) continue;
        if (await FinishStaleReforge(userId, Row.progressionId, Row)) Finished.push(Row.progressionId);
    }
    return Finished;
}

// A reforge whose follow-ups never arrived (the read-back failed, the hub went away): give the player what the reforge
// owed - the banked XP back and the +1 - exactly once, then close it. True when this call closed it.
async function FinishStaleReforge(userId: string, experienceTrack: string, row: ProgressionTrackRecord): Promise<boolean> {
    const R = row.reforge!;
    const Tracks = GetRepositories().progressionTracks;
    const Closed = await Tracks.updateReforge(userId, experienceTrack, R.reforgeId,
        { status: "open", prestigeGranted: R.prestigeGranted, bankedRestored: R.bankedRestored },
        { status: "closed", closedAt: new Date().toISOString(), prestigeGranted: true, bankedRestored: R.banked });
    if (!Closed) return false;
    const Owed = R.banked - R.bankedRestored;
    if (Owed > 0) await Tracks.increment(userId, experienceTrack, Owed);
    if (!R.prestigeGranted) await Tracks.increment(userId, PrestigeTrackFor(experienceTrack), 1);
    logger.warn(`[Reforge] RECOVER user=${userId} track=${experienceTrack} reforge=${R.reforgeId} stale since ${R.openedAt}:`
        + ` restored ${Owed}, prestige ${R.prestigeGranted ? "already granted" : "+1"}`);
    return true;
}
