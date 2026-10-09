import { GetP2PExtension } from "../extensions/p2p";

/**
 * Process roles. An optional module (src/extensions) adds the roles that have their own entry point
 * by augmenting this interface and listing them in its `server.serviceRoles`.
 */
export interface MetagameServiceRoles {
    combined: true;
    api: true;
}

export type MetagameServiceRole = keyof MetagameServiceRoles;

const CORE_SERVICE_ROLES: readonly string[] = ["combined", "api"];

/**
 * The historical combined process remains the local-development default. Production
 * deployments should set an explicit role so an entry point cannot be accidentally
 * duplicated by starting it twice.
 */
export function ReadMetagameServiceRole(environment: NodeJS.ProcessEnv = process.env): MetagameServiceRole {
    // An unset or blank value preserves the historical local combined process. Production
    // safety separately rejects a blank value so a deployment cannot rely on that default.
    const value = (environment.MYSTICPARADOX_SERVICE_ROLE ?? "").trim().toLowerCase() || "combined";
    if (CORE_SERVICE_ROLES.includes(value)) return value as MetagameServiceRole;
    const roles = [...CORE_SERVICE_ROLES, ...GetP2PExtension().server.serviceRoles];
    if (roles.includes(value)) return value as MetagameServiceRole;
    throw new Error(`MYSTICPARADOX_SERVICE_ROLE must be ${roles.join(", ")} (received '${value || "empty"}').`);
}

export const ServiceRoleInternals = { ReadMetagameServiceRole };
