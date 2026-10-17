// Player-hosted (P2P) hunt module. The shared server loads it through src/extensions/p2p.ts when
// this folder is present; nothing outside this folder imports it directly.
//
// This file stays light: the hooks load their implementation on first use, so the shared code can
// ask for the module from any call site without pulling in its routes, controllers and their
// configuration, and without re-entering a module that is still initializing.

import { NextFunction, Request, Response } from "express";
import type { P2PExtension } from "../extensions/p2p";
import { logger } from "../logger";
import { GetAntiCheatExtension } from "./antiCheat";
import { LauncherApiError, SendLauncherError } from "./security/p2pErrors";

function Lazy<T>(load: () => T): () => T {
    let loaded: T | undefined;
    return () => (loaded ??= load());
}

const Policy = Lazy(() => require("./config/p2pPolicy") as typeof import("./config/p2pPolicy"));
const ReleaseGates = Lazy(() => require("./config/p2pReleaseGates") as typeof import("./config/p2pReleaseGates"));
const IcePolicy = Lazy(() => require("./config/p2pIcePolicy") as typeof import("./config/p2pIcePolicy"));
const Matchmaking = Lazy(() => require("./controllers/p2pMatchmaking") as typeof import("./controllers/p2pMatchmaking"));
const AdminOperations = Lazy(() => require("./controllers/p2pAdminOperations") as typeof import("./controllers/p2pAdminOperations"));
const Lifecycle = Lazy(() => require("./controllers/p2pHostLifecycle") as typeof import("./controllers/p2pHostLifecycle"));
const AlertDispatcher = Lazy(() => require("./services/operationsAlertDispatcher") as typeof import("./services/operationsAlertDispatcher"));
const OperationsPolicy = Lazy(() => require("./services/p2pOperationsPolicy") as typeof import("./services/p2pOperationsPolicy"));
const Indexes = Lazy(() => require("./persistence/mongo/indexes") as typeof import("./persistence/mongo/indexes"));
const HostRuntimeAuth = Lazy(() => require("./security/hostRuntimeAuth") as typeof import("./security/hostRuntimeAuth"));
const HostCapabilities = Lazy(() => require("./security/hostCapabilities") as typeof import("./security/hostCapabilities"));
const InventoryAuthorization = Lazy(() => require("./security/p2pInventoryAuthorization") as typeof import("./security/p2pInventoryAuthorization"));
const HostWrites = Lazy(() => require("./security/hostWrites") as typeof import("./security/hostWrites"));
const HostPolicyMode = Lazy(() => require("./security/hostPolicyMode") as typeof import("./security/hostPolicyMode"));
const HuntEvidence = Lazy(() => require("./config/huntEvidence") as typeof import("./config/huntEvidence"));
const RealmHubPolicy = Lazy(() => require("./realm/realmHubPolicy") as typeof import("./realm/realmHubPolicy"));
const RealmsPort = Lazy(() => require("./realm/realmsPort") as typeof import("./realm/realmsPort"));
const RealmHubLifecycle = Lazy(() => require("./controllers/realmHubLifecycle") as typeof import("./controllers/realmHubLifecycle"));
const HostRouteCensus = Lazy(() => require("./observability/hostRouteCensus") as typeof import("./observability/hostRouteCensus"));
const AccountDeletionSteps = Lazy(() => require("./persistence/mongo/accountDeletionSteps") as typeof import("./persistence/mongo/accountDeletionSteps"));
const HuntManifest = Lazy(() => require("./huntManifest/localHuntManifest") as typeof import("./huntManifest/localHuntManifest"));

/**
 * Guard manifest roles of the co-op files: the transport module, the runtime it loads and the admission key.
 * Their file names are feed data (the signed Guard and runtime manifests), never code; the launcher switches
 * co-op on only when the signed Guard manifest lists all three and they are installed.
 */
const COOP_GUARD_ROLES = ["TRANSPORT_MODULE", "TRANSPORT_RUNTIME", "ADMISSION_KEY"];

function LiteralTrue(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === "true";
}

export function P2PRuntimeSafetyIssues(environment: NodeJS.ProcessEnv): string[] {
    const production = environment.NODE_ENV === "production";
    const p2pEnabled = LiteralTrue(environment.P2P_HUNTS_ENABLED);
    if (p2pEnabled && !production && !LiteralTrue(environment.MYSTICPARADOX_ALLOW_LOCAL_P2P_DEV)) {
        throw new Error("P2P_HUNTS_ENABLED requires NODE_ENV=production (or the explicit local-only MYSTICPARADOX_ALLOW_LOCAL_P2P_DEV=true override)");
    }
    const unsafe: string[] = [];
    if (p2pEnabled && !LiteralTrue(environment.P2P_DISTRIBUTED_TRAFFIC_LIMITER)) {
        unsafe.push("P2P_DISTRIBUTED_TRAFFIC_LIMITER=true is required when P2P_HUNTS_ENABLED=true in production");
    }
    unsafe.push(...GetAntiCheatExtension().server.runtimeSafetyIssues(environment));
    return unsafe;
}

// JSON parser failures occur before a route handler can call Handle(). Keep P2P clients on the
// same bounded, machine-readable error contract instead of Express's default HTML response.
function P2PBodyErrorHandler(error: any, req: Request, res: Response, next: NextFunction): void {
    const isP2P = req.path.startsWith("/mystic/v1/hunts/") ||
        req.path === "/internal/v1/hunt-guard/shadow-comparisons";
    if (!isP2P) {
        next(error);
        return;
    }
    if (error?.type === "entity.too.large") {
        SendLauncherError(res, new LauncherApiError("GUARD_BATCH_TOO_LARGE", "The Guard request body exceeds its bounded limit."));
        return;
    }
    if (error instanceof SyntaxError && "body" in error) {
        SendLauncherError(res, new LauncherApiError("GUARD_BATCH_INVALID", "The Guard request body is not valid JSON."));
        return;
    }
    next(error);
}

export function CreateP2PExtension(): P2PExtension {
    return {
        loaded: true,
        server: {
            serviceRoles: GetAntiCheatExtension().server.serviceRoles,
            runtimeSafetyIssues: P2PRuntimeSafetyIssues,
            // Log only normalized policy values and allowlist counts. This captures the actual
            // process environment after startup loading/inheritance without exposing account IDs
            // or other environment values that may contain secrets.
            startupSummary: (serviceRole) => ({
                event: "metagame_startup_p2p_policy",
                serviceRole,
                hostSelectionEnabled: process.env.P2P_HOST_SELECTION_ENABLED === "true",
                antiCheatLoaded: GetAntiCheatExtension().loaded,
                ...Policy().P2PPolicySummary(Policy().ReadP2PPolicy()),
                // [2026-10-13] ICE co-op transport: whether STUN/TURN, the quota and the pair-key secret are set.
                ...IcePolicy().P2PIceSummary(IcePolicy().ReadP2PIceConfig()),
                // [2026-10-13 realms S1] MYSTICPARADOX_REALMS_HOSTING: realm hubs on players' PCs (needs the ICE switches above).
                realmHostingEnabled: RealmHubPolicy().IsRealmHostingEnabled(),
                // [2026-10-16] MYSTICPARADOX_HOST_POLICY: observe (default) lets host grant classes, the draft token cap and write kinds through.
                hostPolicy: HostPolicyMode().ResolveHostPolicyMode().mode,
                // [2026-10-17] MYSTICPARADOX_HUNT_EVIDENCE: hosted hunts send Hunt Guard evidence (off by default at tier 0).
                huntEvidence: HuntEvidence().HuntEvidenceEnabled()
            }),
            ensureDatabase: (db) => Indexes().EnsureP2PDatabase(db),
            // [2026-10-14] The account deletion plan's steps: this module's collections, then the anti-cheat module's.
            accountDeletionSteps: () => [
                ...AccountDeletionSteps().P2PAccountDeletionSteps(),
                ...GetAntiCheatExtension().server.accountDeletionSteps()
            ],
            start(serviceRole) {
                // [2026-10-14] Loud when hunts run without relay-only traffic (players could see each other's IP address).
                const RelayWarning = Policy().RelayOnlyWarning(process.env);
                if (RelayWarning !== undefined) logger.warn(`[P2P] ${RelayWarning}`);
                // [2026-10-16] One line: whether host policy refusals refuse (enforce) or are only logged (observe, the default).
                HostPolicyMode().LogHostPolicyMode();
                // [2026-10-17] One line: whether hosted hunts send Hunt Guard evidence (config/huntEvidence.ts).
                HuntEvidence().LogHuntEvidence();
                const { RegisterMetricsSection } = require("../observability/metrics") as typeof import("../observability/metrics");
                const { P2PMetricsSection } = require("./observability/p2pMetrics") as typeof import("./observability/p2pMetrics");
                RegisterMetricsSection(P2PMetricsSection);
                Lifecycle().p2pHuntLifecycleMonitor.start();
                // [2026-10-14 M1] One line: which source resolves player-hosted hunt manifests, and how many hunts the local tables resolve.
                // An invalid MYSTICPARADOX_HUNT_MANIFEST_SOURCE stops startup here.
                HuntManifest().LogHuntManifestSource();
                // [2026-10-13 realms S1] The realms module tells the hubs about kicks, bans and a released realm (its event sink).
                if (RealmHubPolicy().IsRealmHostingEnabled()) {
                    try {
                        RealmsPort().InstallRealmEventSink((event) => RealmHubLifecycle().HandleRealmEvent(event));
                    } catch (error) {
                        logger.warn(`[RealmHub] could not install the realm event sink: ${error}`);
                    }
                }
                GetAntiCheatExtension().server.start(serviceRole);
                // The combined local process embeds the alert dispatcher; production runs it with the reward worker.
                if (serviceRole === "combined") AlertDispatcher().operationsAlertDispatcher.start();
            },
            async stop() {
                Lifecycle().p2pHuntLifecycleMonitor.stop();
                HostRouteCensus().hostRouteCensus.stop();
                await GetAntiCheatExtension().server.stop();
                await AlertDispatcher().operationsAlertDispatcher.stop();
            }
        },
        http: {
            // The hunts router carries its own route-specific JSON limit for Guard batches.
            mountEarlyRoutes: (app) => {
                // [2026-10-14 realms wave 2] Observe-only census of the routes a player-host runtime calls (MYSTICPARADOX_HOST_ROUTE_CENSUS=off
                // unmounts it). Mounted before every router so it sees each answered request.
                const census = HostRouteCensus().hostRouteCensus;
                if (census.enabled) app.use(census.middleware());
                app.use("/", (require("./routes/p2pHunts") as typeof import("./routes/p2pHunts")).p2pHuntsRouter);
            },
            mountRoutes: (app) => {
                app.use("/", (require("./routes/p2pAdmin") as typeof import("./routes/p2pAdmin")).p2pAdminRouter);
                app.use("/", (require("./routes/p2pLauncher") as typeof import("./routes/p2pLauncher")).p2pLauncherRouter);
                // [2026-10-13 realms S1] The realm host's hub routes (start, stop, the host's peer list).
                app.use("/", (require("./routes/realmHosting") as typeof import("./routes/realmHosting")).realmHostingRouter);
            },
            mountErrorHandlers: (app) => { app.use(P2PBodyErrorHandler); },
            metricClass: (requestPath) => requestPath.startsWith("/mystic/v1/hunts/") ? "p2p" : undefined,
            requestLogTags: (req) => ` hostCap=${req.headers["x-mystic-host-capability"] ? "Y" : "N"}`,
            authenticate: (req, res, next) => HostRuntimeAuth().AuthenticateHostRuntimeRequest(req, res, next),
            // [2026-10-11 B4] A validated host capability gets its own request budget (security/rateLimit.ts).
            rateLimitBucket: async (req) => {
                const raw = req.headers["x-mystic-host-capability"];
                return raw === undefined ? undefined : HostCapabilities().ResolveHostRateLimitBucket(raw);
            }
        },
        inventory: {
            authorizeTransaction: (req, context) => InventoryAuthorization().AuthorizeP2PInventoryTransaction(req, context)
        },
        hostWrites: {
            authorize: (req, kind, targetUserId, options) => HostWrites().AuthorizeHostWrite(req, kind, targetUserId, options),
            record: (req, write) => HostWrites().RecordHostWrite(req, write)
        },
        // [2026-10-17] The host policy for the core's own host limits (the XP ceilings, a full player-level track).
        hostPolicy: {
            refuses: () => HostPolicyMode().HostPolicyRefuses(),
            noteWouldRefuse: (what, detail) => HostPolicyMode().NoteHostPolicyWouldRefuse(what, detail)
        },
        matchmaking: {
            dedicatedHuntsDisabled: () => Policy().ReadP2PPolicy().dedicatedHuntsDisabled,
            // [2026-10-11 B7] A Training request that may be hosted takes only the online party members, like ISLAND.
            filtersOfflinePartyMembers: (gameMode, huntId) => Policy().IsP2PTrainingRequest(gameMode, huntId, Policy().ReadP2PPolicy()),
            restoreCandidate: (playerId) => Matchmaking().RestoreP2PCandidate(playerId),
            candidateStatus: (playerId, current) => Matchmaking().P2PCandidateStatus(playerId, current),
            partyInstance: (partyId) => Matchmaking().P2PPartyInstance(partyId),
            routeHunt: (context) => Matchmaking().RouteP2PHunt(context),
            cancelCandidate: (playerId, current) => Matchmaking().P2PCancelCandidate(playerId, current),
            partyMemberLeft: (accountId) => Matchmaking().P2PPartyMemberLeft(accountId)
        },
        launcher: {
            policyFields: () => ({
                // Always false; kept for already-installed Launcher versions that require the field.
                p2pEmergencyStop: false,
                // The server's half of the launcher's co-op switch; the other half is the signed transport files.
                coopHunts: Policy().ReadP2PPolicy().enabled
            }),
            guardManifestRoles: COOP_GUARD_ROLES
        },
        operations: {
            policyFieldsValid: (record) => OperationsPolicy().P2PPolicyFieldsValid(record),
            overview: () => AdminOperations().P2POperationsOverview()
        },
        // [2026-10-14] The manager preflight's P2P gates (config/p2pReleaseGates.ts): env policy, durable stop, Tier 1 grants.
        releaseGates: () => ReleaseGates().CollectP2PReleaseGates(process.env)
    };
}
