import { InMemoryRealmHubRepository } from "./memory/InMemoryRealmHubRepository";
import { RunRealmHubRepositoryContract } from "./realmHubRepositoryContract";

// The in-memory double must behave exactly as the contract says (the MongoDB implementation runs the same cases in
// mongo/realmHubMongo.integration.test.ts).
RunRealmHubRepositoryContract("in-memory repository", async () => {
    const repo = new InMemoryRealmHubRepository();
    return { repo, reset: async () => { repo.rows.clear(); } };
});
