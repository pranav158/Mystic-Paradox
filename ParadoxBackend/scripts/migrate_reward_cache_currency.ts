/*
 * One-time wallet migration for the 1.14.7 Reward Cache currency (2026-10-08).
 *
 * On 1.12 the Reward Cache was priced in CURRENCY_S19_COIN (the client renders it as "Elemental Coins").
 * On 1.14.7 it is priced in CURRENCY_SEASONAL_COIN - the HUD's blue-star "Cache Coins", which the live 1.14.7
 * hunt passes pay as prestige. Every balance in FROM is moved 1:1 into it. FROM also lists
 * CURRENCY_REWARDCACHE: the first run of this migration (same day) targeted that older "Cache Coin" event
 * currency by mistake, so its balances are moved on as well.
 *
 * Each wallet is updated in one atomic document update whose filter pins every balance that was read, so a
 * concurrent spend makes that wallet a reported conflict instead of a wrong amount. Re-running is a no-op:
 * migrated wallets hold 0 in every FROM currency.
 *
 * Dry-run is the default. Applying requires both --apply and the exact confirmation token.
 *   tsx --env-file=.env scripts/migrate_reward_cache_currency.ts [--user-id=<id>] [--report=<path>]
 *   tsx --env-file=.env scripts/migrate_reward_cache_currency.ts --apply --confirm=APPLY_REWARD_CACHE_COIN_MIGRATION
 */

import fs from "node:fs";
import path from "node:path";
import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";

const APPLY_CONFIRMATION = "APPLY_REWARD_CACHE_COIN_MIGRATION";
const FROM = ["CURRENCY_S19_COIN", "CURRENCY_REWARDCACHE"];
const TO = "CURRENCY_SEASONAL_COIN";

function GetArg(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Arg) => Arg.startsWith(Prefix))?.slice(Prefix.length);
}

const Apply = process.argv.includes("--apply");
const Confirm = GetArg("confirm");
const UserId = GetArg("user-id");
const ReportPath = GetArg("report");

if (Apply && Confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
}

async function Main(): Promise<void> {
    const Lifecycle = GetPersistenceLifecycle();
    const Report: any = {
        schema: 2,
        mode: Apply ? "apply" : "dry-run",
        startedAt: new Date().toISOString(),
        from: FROM,
        to: TO,
        rate: 1,
        filters: { userId: UserId ?? null },
        summary: { walletsScanned: 0, walletsWithBalance: 0, walletsMigrated: 0, conflicts: 0, coinsMoved: 0 },
        wallets: [] as any[],
    };

    try {
        // Connect directly instead of lifecycle.start(): startup runs index migrations, and a dry-run must
        // not write anything.
        const Db = await GetMongoDb();
        await Db.command({ ping: 1 });
        const Wallets = Db.collection(Collections.Wallets);
        const Query: Record<string, unknown> = { $or: FROM.map((Id) => ({ [`balances.${Id}`]: { $gt: 0 } })) };
        if (UserId) Query._id = UserId;
        Report.summary.walletsScanned = await Wallets.countDocuments(UserId ? { _id: UserId as any } : {});

        for await (const Doc of Wallets.find(Query, { projection: { _id: 1, userId: 1, balances: 1 } })) {
            const Amounts: Record<string, number> = {};
            for (const Id of FROM) {
                const Amount = Number(Doc.balances?.[Id] ?? 0);
                if (Number.isSafeInteger(Amount) && Amount > 0) Amounts[Id] = Amount;
            }
            const Total = Object.values(Amounts).reduce((Sum, Amount) => Sum + Amount, 0);
            if (Total <= 0) continue;
            const Before = Number(Doc.balances?.[TO] ?? 0);
            Report.summary.walletsWithBalance++;
            const Entry: any = { userId: Doc.userId ?? String(Doc._id), moved: Amounts, [`${TO}Before`]: Before,
                [`${TO}After`]: Before + Total, status: Apply ? "pending" : "dry-run" };

            if (Apply) {
                const Filter: Record<string, unknown> = { _id: Doc._id };
                const Inc: Record<string, number> = { [`balances.${TO}`]: Total };
                for (const [Id, Amount] of Object.entries(Amounts)) {
                    Filter[`balances.${Id}`] = Amount;
                    Inc[`balances.${Id}`] = -Amount;
                }
                const Result = await Wallets.updateOne(Filter, { $inc: Inc });
                if (Result.modifiedCount === 1) {
                    Entry.status = "migrated";
                    Report.summary.walletsMigrated++;
                    Report.summary.coinsMoved += Total;
                } else {
                    Entry.status = "conflict";
                    Report.summary.conflicts++;
                }
            }
            Report.wallets.push(Entry);
        }
    } finally {
        Report.completedAt = new Date().toISOString();
        if (ReportPath) {
            const AbsoluteReportPath = path.resolve(ReportPath);
            fs.mkdirSync(path.dirname(AbsoluteReportPath), { recursive: true });
            fs.writeFileSync(AbsoluteReportPath, JSON.stringify(Report, null, 2) + "\n", "utf8");
            console.log(`Report written: ${AbsoluteReportPath}`);
        }
        console.log(JSON.stringify(Report.summary, null, 2));
        await Lifecycle.stop();
    }
}

Main().catch((Err) => {
    console.error(Err);
    process.exitCode = 1;
});
