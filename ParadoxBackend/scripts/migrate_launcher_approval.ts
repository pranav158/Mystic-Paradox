import { GetMongoDb, MongoPersistenceLifecycle } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";

function argument(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Value) => Value.startsWith(Prefix))?.slice(Prefix.length);
}

async function main(): Promise<void> {
    const Apply = process.argv.includes("--apply");
    const KeepUser = argument("keep-user");
    const Confirm = argument("confirm");
    const Lifecycle = new MongoPersistenceLifecycle();
    await Lifecycle.start();

    try {
        const Db = await GetMongoDb();
        const Query = { displayNameNormalized: { $exists: true }, approvalStatus: { $exists: false } };
        const Legacy = await Db.collection(Collections.Accounts)
            .find(Query)
            .project({ userId: 1, displayName: 1, email: 1, roles: 1 })
            .sort({ createdAt: 1 })
            .toArray();

        console.log(`Legacy launcher accounts without approvalStatus: ${Legacy.length}`);
        for (const Account of Legacy.slice(0, 100)) {
            const WillKeep = Account.userId === KeepUser || (Array.isArray(Account.roles) && Account.roles.includes("admin"));
            console.log(`${WillKeep ? "APPROVE" : "PENDING"} userId=${Account.userId} username=${Account.displayName} email=${Account.email ?? ""}`);
        }

        if (!Apply) {
            console.log("Dry run only. No documents changed.");
            return;
        }
        if (!KeepUser || Confirm !== "MOVE_LEGACY_LAUNCHER_ACCOUNTS_TO_PENDING") {
            throw new Error("--apply requires --keep-user=<operator-userId> and --confirm=MOVE_LEGACY_LAUNCHER_ACCOUNTS_TO_PENDING");
        }

        const Now = new Date().toISOString();
        await Db.collection(Collections.Accounts).updateMany(
            { ...Query, userId: { $ne: KeepUser }, roles: { $ne: "admin" } },
            { $set: { approvalStatus: "pending", approvalUpdatedAt: Now, approvalUpdatedBy: "approval-migration", approvalReason: "Closed-test rollout" } }
        );
        await Db.collection(Collections.Accounts).updateMany(
            { ...Query, $or: [{ userId: KeepUser }, { roles: "admin" }] },
            { $set: { approvalStatus: "approved", approvalUpdatedAt: Now, approvalUpdatedBy: "approval-migration", approvalReason: "Operator/admin retained" } }
        );
        console.log("Approval migration applied.");
    } finally {
        await Lifecycle.stop();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
