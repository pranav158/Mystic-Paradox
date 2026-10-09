import { ReadMetagameServiceRole } from "./serviceRole";
import { ReadMongoRuntimeConfig } from "./mongoRuntime";
import { GetP2PExtension } from "../extensions/p2p";

function LiteralTrue(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === "true";
}

function Enabled(value: string | undefined): boolean {
    return /^(1|true|on|yes)$/i.test(value?.trim() ?? "");
}

/**
 * Reject combinations that can turn local capture/auth conveniences into public-server behavior.
 * This runs before persistence or listeners start, so a bad deployment never accepts traffic.
 */
export function AssertRuntimeSafety(environment: NodeJS.ProcessEnv = process.env): void {
    // [2026-10-08] The MYSTPAX_ environment prefix was renamed to MYSTICPARADOX_. A stale key would
    // be ignored silently and quietly switch its feature off, so refuse to start until it is renamed.
    const legacyKeys = Object.keys(environment).filter((key) => key.startsWith("MYSTPAX_"));
    if (legacyKeys.length > 0) {
        throw new Error(`Rename these environment keys to the MYSTICPARADOX_ prefix: ${legacyKeys.sort().join(", ")}`);
    }
    ReadMetagameServiceRole(environment);
    const production = environment.NODE_ENV === "production";
    // An optional module checks its own settings first (src/extensions).
    const moduleIssues = GetP2PExtension().server.runtimeSafetyIssues(environment);
    if (!production) return;

    const unsafe: string[] = [...moduleIssues];
    if ((environment.AUTH_MODE ?? "").trim().toUpperCase() === "NONE") unsafe.push("AUTH_MODE=NONE");
    if (LiteralTrue(environment.ALLOW_NO_AUTH_DEV_MODE)) unsafe.push("ALLOW_NO_AUTH_DEV_MODE=true");
    if (Enabled(environment.MYSTICPARADOX_BODY_CAPTURE)) unsafe.push("MYSTICPARADOX_BODY_CAPTURE");
    if (Enabled(environment.MYSTICPARADOX_INV_CAPTURE_RAW)) unsafe.push("MYSTICPARADOX_INV_CAPTURE_RAW");
    if (environment.REALTIME_XMPP_DEV_CITY_MUC !== "false") unsafe.push("REALTIME_XMPP_DEV_CITY_MUC must be false");
    if (unsafe.length > 0) {
        throw new Error(`Unsafe production configuration: ${unsafe.join(", ")}`);
    }
    const configuredServiceRole = (environment.MYSTICPARADOX_SERVICE_ROLE ?? "").trim().toLowerCase();
    if (configuredServiceRole.length === 0) {
        const roles = ["api", ...GetP2PExtension().server.serviceRoles].join(" or ");
        throw new Error(`Unsafe production configuration: MYSTICPARADOX_SERVICE_ROLE must be explicit (${roles}).`);
    }
    if (configuredServiceRole === "combined") {
        throw new Error("Unsafe production configuration: MYSTICPARADOX_SERVICE_ROLE=combined is local-development only.");
    }
    if (configuredServiceRole === "api" && !(environment.MYSTICPARADOX_METRICS_TOKEN ?? "").trim()) {
        unsafe.push("MYSTICPARADOX_METRICS_TOKEN is required for the production API role");
    }
    if (!(environment.MONGODB_URI ?? "").trim()) {
        unsafe.push("MONGODB_URI is required for the production service");
    }
    try {
        ReadMongoRuntimeConfig(environment);
    } catch (error) {
        unsafe.push(error instanceof Error ? error.message : "Mongo runtime configuration is invalid");
    }
    const httpPort = Number(environment.PORT ?? "3000");
    const httpsPort = Number(environment.HTTPS_PORT ?? "3443");
    if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) unsafe.push("PORT must be a valid production port");
    if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65_535) unsafe.push("HTTPS_PORT must be a valid production port");
    if (unsafe.length > 0) throw new Error(`Unsafe production configuration: ${unsafe.join(", ")}`);
}

export const RuntimeSafetyInternals = { LiteralTrue, Enabled };
