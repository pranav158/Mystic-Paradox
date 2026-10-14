import { InMemoryRealmPresenceRepository, InMemoryRealmsRepository } from "./persistence/InMemoryRealmsRepository";
import { RunRealmPresenceRepositoryContract } from "./realmPresenceRepositoryContract";
import { RunRealmsRepositoryContract } from "./realmsRepositoryContract";

// The in-memory doubles must behave exactly like the contracts say, because the service and route tests rely on them.
RunRealmsRepositoryContract("in-memory repository", async () => {
    const repo = new InMemoryRealmsRepository();
    return { repo, reset: async () => { repo.realms.clear(); repo.invites.clear(); } };
});

RunRealmPresenceRepositoryContract("in-memory presence repository", async () => {
    const repo = new InMemoryRealmPresenceRepository();
    return { repo, reset: async () => { repo.rows.clear(); } };
});
