import { ReadMetagameServiceRole } from "../config/serviceRole";

export interface ServiceReadinessState {
    role: ReturnType<typeof ReadMetagameServiceRole>;
    ready: boolean;
    reason: string;
    changedAt: string;
}

// The role is resolved on first use, not at import: reading it may load an optional module
// (src/extensions), which must not happen while other modules are still initializing.
let state: Omit<ServiceReadinessState, "role"> & { role?: ServiceReadinessState["role"] } = {
    ready: false,
    reason: "STARTING",
    changedAt: new Date().toISOString()
};

export function SetServiceReadiness(input: {
    ready: boolean;
    reason: string;
    role?: ServiceReadinessState["role"];
}): void {
    state = {
        role: input.role ?? state.role,
        ready: input.ready,
        reason: input.reason.slice(0, 96),
        changedAt: new Date().toISOString()
    };
}

export function GetServiceReadiness(): ServiceReadinessState {
    return { ...state, role: state.role ?? ReadMetagameServiceRole() };
}

export const ServiceReadinessInternals = { SetServiceReadiness, GetServiceReadiness };
