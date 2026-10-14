// Persistence of the player-hosted hunt module. It extends the shared repository provider with the
// module's repositories; like the shared ones they are stateless and take the Mongo session per call,
// so they join any transaction opened through WithP2PTransaction (or GetUnitOfWork()).

import { ClientSession } from "mongodb";
import { GetRepositories, GetUnitOfWork, RepositoryProvider } from "../../persistence";
import { OperationsAlertRepository } from "./contracts/OperationsAlertRepository";
import { P2PHuntRepository } from "./contracts/P2PHuntRepository";
import { RealmHubRepository } from "./contracts/RealmHubRepository";
import { MongoOperationsAlertRepository } from "./mongo/MongoOperationsAlertRepository";
import { MongoP2PHuntRepository } from "./mongo/MongoP2PHuntRepository";
import { MongoRealmHubRepository } from "./mongo/MongoRealmHubRepository";

export * from "../../persistence";
export * from "./contracts/P2PHuntRepository";
export * from "./contracts/OperationsAlertRepository";
export * from "./contracts/RealmHubRepository";

export interface P2PRepositories {
    p2pHunts: P2PHuntRepository;
    operationsAlerts: OperationsAlertRepository;
    /** [2026-10-13 realms S1] Who is in a realm's hub (collection realmHubPresence). */
    realmHub: RealmHubRepository;
}

export type P2PRepositoryProvider = RepositoryProvider & P2PRepositories;

let CachedP2PRepositories: P2PRepositories | undefined;
let CachedProvider: { core: RepositoryProvider; combined: P2PRepositoryProvider } | undefined;
let TestProvider: P2PRepositoryProvider | undefined;

function ModuleRepositories(): P2PRepositories {
    CachedP2PRepositories ??= {
        p2pHunts: new MongoP2PHuntRepository(),
        operationsAlerts: new MongoOperationsAlertRepository(),
        realmHub: new MongoRealmHubRepository()
    };
    return CachedP2PRepositories;
}

function Combine(core: RepositoryProvider): P2PRepositoryProvider {
    // Repositories already on the provider win (a test double may supply module repositories too).
    if (CachedProvider?.core !== core) CachedProvider = { core, combined: { ...ModuleRepositories(), ...core } as P2PRepositoryProvider };
    return CachedProvider.combined;
}

export function GetP2PRepositories(): P2PRepositoryProvider {
    return TestProvider ?? Combine(GetRepositories());
}

export function WithP2PTransaction<T>(fn: (repos: P2PRepositoryProvider, session: ClientSession) => Promise<T>): Promise<T> {
    // A test provider has no transaction: the callback runs once against it, and its writes are not rolled back on a throw.
    if (TestProvider != undefined) return fn(TestProvider, {} as ClientSession);
    return GetUnitOfWork().withTransaction((repos, session) => fn(Combine(repos), session));
}

/**
 * Tests run the real controllers and routes against in-memory repositories: pass a provider whose p2pHunts and realmHub are
 * the in-memory ones (and whatever shared repositories the flow under test touches); `undefined` restores MongoDB.
 */
export function UseP2PPersistenceForTest(provider: P2PRepositoryProvider | undefined): void {
    TestProvider = provider;
}
