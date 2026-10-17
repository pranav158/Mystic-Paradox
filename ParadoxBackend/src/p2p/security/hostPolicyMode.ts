import { logger } from "../../logger";

// [2026-10-16] MYSTICPARADOX_HOST_POLICY=observe|enforce, for the POLICY refusals
// of a player host's writes (a realm hub or a hosted hunt):
//   - the item classes a host may not grant (hostGrantPolicy.ts: PREMIUM_CURRENCY = Platinum, HUNT_PASS, COSMETIC, ENTITLEMENT) and the
//     no-reward session of a hosted Training hunt (NO_REWARD_SESSION);
//   - the daily premium draft token's balance cap (hostDraftPremium.ts);
//   - the write kinds a hub or a hunt may not write (hubAuthorization.ts WRITE_KIND_NOT_ALLOWED_IN_HUB, hostWrites.ts
//     WRITE_KIND_NOT_ALLOWED).
// observe (the default: blank, "observe", or any unrecognised value, with a startup warning for the last) refuses none of them: each one
// is logged as [HostPolicyObserve] would refuse ... and the write goes through as a dedicated server's would. Every refusal of these
// kinds was the game's own normal flow so far (the Training tutorial, the daily draft token, town Hunt Pass XP), and a
// refused write during a player's inventory load sends that player back to the menu. enforce refuses them as before.
// Never affected (always enforced): who may write (PLAYER_HOST_AUTH_REQUIRED, HUNT_NOT_FOUND, HUNT_NOT_RUNNING, NOT_A_MEMBER,
// MEMBER_NOT_ADMITTED, MEMBER_NOT_PRESENT, the emergency stop, P2P_HOST_WRITES=off), the reforge and rank-confirm rules, the wallet's own
// balance and prestige gates, and the ledger.
// [2026-10-17] Dedicated parity: observe also lets through, logged, the host XP
// ceilings and a full player level track (controllers/progression.ts HostLimitOnlyLogs, through the extension's hostPolicy hook), and lets
// a realm server do a dedicated server's own work for a player of its session (hostWrites.authorize `parity`: the reforge repair at the
// player's load, the Slayer's Path catch-up at login). enforce keeps all of them as before.

export const HOST_POLICY_ENV = "MYSTICPARADOX_HOST_POLICY";

export type HostPolicyMode = "observe" | "enforce";

export interface HostPolicySetting {
    mode: HostPolicyMode;
    /** True when the variable is unset or blank and observe applies by default. */
    isDefault: boolean;
    /** Set when the variable held an unrecognised value (the mode is then observe). */
    warning?: string;
}

/** Pure: the mode from the environment. Only observe and enforce are recognised (trimmed, case-insensitively). */
export function ResolveHostPolicyMode(environment: NodeJS.ProcessEnv = process.env): HostPolicySetting {
    const Raw = (environment[HOST_POLICY_ENV] ?? "").trim().toLowerCase();
    if (Raw === "") return { mode: "observe", isDefault: true };
    if (Raw === "observe") return { mode: "observe", isDefault: false };
    if (Raw === "enforce") return { mode: "enforce", isDefault: false };
    return {
        mode: "observe", isDefault: false,
        warning: `${HOST_POLICY_ENV} must be observe or enforce (got ${JSON.stringify(Raw)}); it is treated as observe, so host policy refuses nothing`
    };
}

/** Whether a host policy refusal (the kinds in the header) refuses now: only in enforce mode. */
export function HostPolicyRefuses(environment: NodeJS.ProcessEnv = process.env): boolean {
    return ResolveHostPolicyMode(environment).mode === "enforce";
}

/** Logs one refusal observe mode let through. `what` names the rule (grant class, draft premium, write kind); `detail` the tags. */
export function NoteHostPolicyWouldRefuse(what: string, detail: string, sink: { warn(message: string): void } = logger): void {
    sink.warn(`[HostPolicyObserve] would refuse ${what} ${detail}`);
}

/** One startup line with the active mode (plus a warning when the value was unrecognised). */
export function LogHostPolicyMode(setting: HostPolicySetting = ResolveHostPolicyMode(),
    sink: { info(message: string): void; warn(message: string): void } = logger): void {
    if (setting.warning !== undefined) sink.warn(`[Startup] WARNING: ${setting.warning}`);
    if (setting.mode === "observe") {
        sink.info(`[Startup] ${HOST_POLICY_ENV}${setting.isDefault ? " not set (default observe)" : "=observe"}: host grant classes, the draft ` +
            "token cap and write kinds refuse nothing; would-be refusals are logged as [HostPolicyObserve]");
    } else {
        sink.info(`[Startup] ${HOST_POLICY_ENV}=enforce: host grant classes, the draft token cap and write kinds refuse as before`);
    }
}
