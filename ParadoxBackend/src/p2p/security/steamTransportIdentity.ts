const STEAM_INDIVIDUAL_ID_MIN = 76561197960265728n;
const STEAM_INDIVIDUAL_ID_MAX = STEAM_INDIVIDUAL_ID_MIN + 0xffffffffn;

/**
 * Accept only public-universe individual SteamID64 values. This identifies the
 * current SteamNetworkingSockets endpoint; it is not an ownership assertion.
 */
export function ParseSteamTransportId(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^\d{17}$/.test(value)) return undefined;
    const numeric = BigInt(value);
    return numeric >= STEAM_INDIVIDUAL_ID_MIN && numeric <= STEAM_INDIVIDUAL_ID_MAX
        ? value
        : undefined;
}
