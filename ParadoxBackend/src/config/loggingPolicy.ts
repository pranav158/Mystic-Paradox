export type OperationalDiagnosticsProfile = "PRODUCTION" | "DEVELOPMENT";

const PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const PRODUCTION_LEVELS = new Set(["info", "warn", "error", "fatal"]);

function Normalize(value: string | undefined): string {
    return value?.trim().toLowerCase() ?? "";
}

/**
 * Central operations policy owns runtime verbosity. Production can become quieter, but an
 * accidentally inherited debug/trace/silent value can never make the production profile verbose
 * or blind. Development diagnostics may opt into any real Pino level and defaults to debug.
 */
export function ResolveOperationalLogLevel(profile: OperationalDiagnosticsProfile,
    environment: NodeJS.ProcessEnv = process.env): string {
    if (profile === "DEVELOPMENT") {
        const requested = Normalize(environment.MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL);
        return PINO_LEVELS.has(requested) ? requested : "debug";
    }
    const requested = Normalize(environment.LOG_LEVEL);
    return PRODUCTION_LEVELS.has(requested) ? requested : "info";
}
