import { GetMongoDb, MongoPersistenceLifecycle } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";

function argument(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Value) => Value.startsWith(Prefix))?.slice(Prefix.length);
}

async function main(): Promise<void> {
    const Email = argument("email")?.trim().toLowerCase();
    const FromEmail = argument("from-email")?.trim().toLowerCase();
    const Username = argument("username")?.trim().toLowerCase();
    if (!Email || argument("confirm") !== "GRANT_ADMIN_ROLE") {
        throw new Error(
            "Usage: npm run admin:bootstrap -- --email=you@example.com " +
            "[--from-email=old@example.com | --username=ExistingName] " +
            "--confirm=GRANT_ADMIN_ROLE"
        );
    }

    const Lifecycle = new MongoPersistenceLifecycle();
    await Lifecycle.start();
    try {
        const Db = await GetMongoDb();
        const Accounts = Db.collection(Collections.Accounts);
        let Account = Username
            ? await Accounts.findOne({ displayNameNormalized: Username })
            : await Accounts.findOne({ email: FromEmail ?? Email });

        
        if (!Account && FromEmail && FromEmail !== Email) {
            Account = await Accounts.findOne({ email: Email });
        }
        if (!Account) {
            const Selector = Username ? `username=${Username}` : `email=${FromEmail ?? Email}`;
            throw new Error(
                `Launcher account not found by ${Selector} in database=${process.env.MONGODB_DB ?? "mysticparadox"}.`
            );
        }
        if (typeof Account.passwordHash !== "string") {
            throw new Error("Matched account is not a password-based launcher account.");
        }
        if (Account.usernameSet === false) throw new Error("The launcher account must have a username before becoming an admin.");

        const Collision = await Accounts.findOne({ email: Email, _id: { $ne: Account._id } });
        if (Collision) throw new Error(`Cannot rename account: ${Email} is already in use.`);

        await Accounts.updateOne(
            { _id: Account._id },
            {
                $addToSet: { roles: "admin" },
                $set: {
                    email: Email,
                    status: "active",
                    approvalStatus: "approved",
                    approvalUpdatedAt: new Date().toISOString(),
                    approvalUpdatedBy: "bootstrap-script",
                    approvalReason: "Initial administrator bootstrap"
                }
            }
        );
        console.log(`Administrator role granted to userId=${Account.userId}; email=${Email}.`);
    } finally {
        await Lifecycle.stop();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
