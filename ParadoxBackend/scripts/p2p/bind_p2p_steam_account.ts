import { GetPersistenceLifecycle, GetP2PRepositories, P2PSteamLinkRecord } from "../../src/p2p/persistence";
import { pathToFileURL } from "node:url";

const CONFIRMATION = "LINK_P2P_STEAM_ACCOUNT";
const STEAM_ID64_MIN = 76561197960265728n;
const STEAM_ID64_MAX = STEAM_ID64_MIN + 0xffff_ffffn;

function argument(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function ValidateSteamId64(value: string): boolean {
    if (!/^[0-9]{17}$/.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= STEAM_ID64_MIN && parsed <= STEAM_ID64_MAX;
}

async function main(): Promise<void> {
    const accountId = argument("account-id")?.trim();
    const steamId = argument("steam-id")?.trim();
    if (!accountId || !steamId || argument("confirm") !== CONFIRMATION || !ValidateSteamId64(steamId)) {
        throw new Error(
            "Usage: npm run p2p:steam-link -- --account-id=<Mystic UUID> --steam-id=<SteamID64> " +
            `--confirm=${CONFIRMATION}. Obtain SteamID64 from MysticSteamBridge steam-doctor; do not accept a client-typed claim.`
        );
    }

    const lifecycle = GetPersistenceLifecycle();
    await lifecycle.start();
    try {
        const repositories = GetP2PRepositories();
        const account = await repositories.launcherAccounts.findByUserId(accountId);
        if (!account) throw new Error(`Launcher account not found: ${accountId}.`);
        if (account.status !== "active" || account.approvalStatus !== "approved") {
            throw new Error("The launcher account must be active and explicitly approved before Steam linking.");
        }

        const current = await repositories.p2pHunts.findSteamLink(accountId);
        if (current?.status === "VERIFIED" && current.steamId === steamId) {
            console.log(`Steam link already verified for accountId=${accountId}; SteamID64=${steamId}.`);
            return;
        }
        if (current) {
            throw new Error(
                `Account already has a ${current.status.toLowerCase()} Steam link. ` +
                "Review/revoke that record manually before changing identity; this command never replaces a binding."
            );
        }

        const now = new Date().toISOString();
        const record: P2PSteamLinkRecord = {
            accountId,
            steamId,
            status: "VERIFIED",
            revision: 1,
            verifiedAt: now,
            lastUsedAt: now,
            verificationMethod: "OPERATOR_STEAM_DOCTOR"
        };
        await repositories.p2pHunts.upsertSteamLink(record);
        console.log(`Steam link created for accountId=${accountId}; SteamID64=${steamId}; method=OPERATOR_STEAM_DOCTOR.`);
    } finally {
        await lifecycle.stop();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
