/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { P2PHostPresenceRecord, P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { InMemoryP2PHuntRepository } from "../persistence/memory/InMemoryP2PHuntRepository";
import { InMemoryRealmHubRepository } from "../persistence/memory/InMemoryRealmHubRepository";
import { CreateHostBootstrap, MarkLocalRouteReady } from "../controllers/p2pLauncher";
import { ConsumeAdmissionTicket, MarkHostReady } from "../controllers/p2pAdmission";
import { CreateRealmHubSession } from "../controllers/realmHubLifecycle";
import { HashHostCapabilitySecret, HubPresence } from "../security/hostCapabilities";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { UseP2POperationsPolicyForTest } from "../services/p2pOperationsPolicy";
import { RealmHostingPatch, RealmPresenceView, RealmsPort, RealmSummary, SetRealmsPort } from "./realmsPort";
import { RealmHubKind } from "./realmHubRules";
import { SetHuntManifestResolverForTest, SetSoloPartyResolverForTest } from "../controllers/p2pMatchmaking";

// [2026-10-13 realms S1] Test kit for the realm hub: runs the real controllers and routes against in-memory repositories
// (UseP2PPersistenceForTest), a fixed operations policy, a fake realms port and a throwaway admission key pair. Used by the
// hub flow tests; it touches no database and writes nothing outside the process.

export const HOST = "host-account-0001";
export const MEMBER = "member-account-0001";
export const FRIEND = "friend-account-0001";
export const STRANGER = "stranger-account-01";
export const REALM_ID = "realm-0001";

// The six artifact hashes a bootstrap lists (config/p2pHostPolicy.ts): pinned, so no update feed is read.
const ARTIFACT_PINS = ["P2P_GAME_EXE_SHA256", "P2P_INTERNAL_SERVER_SHA256", "P2P_WINMM_SHA256", "P2P_TRANSPORT_MODULE_SHA256",
    "P2P_TRANSPORT_RUNTIME_SHA256", "P2P_ADMISSION_PUBLIC_XY_SHA256"] as const;

const MANAGED_ENVIRONMENT = [
    "P2P_HUNTS_ENABLED", "MYSTICPARADOX_REALMS_HOSTING", "P2P_BACKEND_URL", "P2P_TRANSPORT_KEY_SECRET", "P2P_TURN_PROVIDER",
    "P2P_ADMISSION_KEY_ID", "P2P_ADMISSION_SIGNING_PRIVKEY_B64", "P2P_ADMISSION_VERIFY_PUBKEY_B64", "P2P_FORCE_SDR",
    "P2P_REALM_HUB_CAPABILITY_TTL_HOURS", "P2P_LAUNCHER_GUARD_REQUIRED", "MYSTICPARADOX_GUARD_MODE", "MYSTICPARADOX_HOST_POLICY",
    "LAUNCHER_UPDATE_ROOT", ...ARTIFACT_PINS
] as const;

/** Sets the environment the hub code reads (a fresh throwaway ES256 key pair for tickets); returns the function that restores it. */
export function InstallHubTestEnvironment(): () => void {
    const saved = new Map(MANAGED_ENVIRONMENT.map((name) => [name, process.env[name]]));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.P2P_HUNTS_ENABLED = "true";
    process.env.MYSTICPARADOX_REALMS_HOSTING = "on";
    process.env.P2P_BACKEND_URL = "https://backend.test";
    process.env.P2P_TRANSPORT_KEY_SECRET = "t".repeat(48);
    process.env.P2P_TURN_PROVIDER = "none";
    process.env.P2P_ADMISSION_KEY_ID = "test-key-1";
    process.env.P2P_ADMISSION_SIGNING_PRIVKEY_B64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
    process.env.P2P_ADMISSION_VERIFY_PUBKEY_B64 = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string).toString("base64");
    delete process.env.P2P_FORCE_SDR;
    delete process.env.P2P_REALM_HUB_CAPABILITY_TTL_HOURS;
    delete process.env.P2P_LAUNCHER_GUARD_REQUIRED;
    // [2026-10-14] The Guard mode is the default (observe) unless a test sets it.
    delete process.env.MYSTICPARADOX_GUARD_MODE;
    // [2026-10-16] The host policy runs in enforce here: these tests pin each rule's refusal. The live default is observe
    // (hostPolicyMode.ts), which hostPolicyObserve.gamedata.test.ts covers by setting it.
    process.env.MYSTICPARADOX_HOST_POLICY = "enforce";
    for (const pin of ARTIFACT_PINS) process.env[pin] = "a".repeat(64);
    process.env.LAUNCHER_UPDATE_ROOT = path.join(os.tmpdir(), "paradox-realm-hub-tests-no-feed");
    return () => {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    };
}

/** A realms port that keeps its realms, members, bans and presence in memory and records what the p2p module wrote into it. */
export class FakeRealms implements RealmsPort {
    readonly realms = new Map<string, RealmSummary>();
    readonly members = new Set<string>();
    readonly bans = new Set<string>();
    readonly presences = new Map<string, RealmPresenceView>();
    readonly names = new Map<string, string>();
    readonly hostingPatches: Array<{ realmId: string; patch: RealmHostingPatch }> = [];
    readonly offline: string[] = [];
    failSetHosting = false;

    /** A realm that is online and serving (its hub running) unless the test says otherwise. */
    addRealm(realm: RealmSummary, members: string[] = []): void {
        this.realms.set(realm.realmId, { online: true, serving: true, ...realm });
        this.members.add(`${realm.realmId}:${realm.hostAccountId}`);
        for (const member of members) this.members.add(`${realm.realmId}:${member}`);
    }

    /** Changes what the directory says about a realm's online and serving state. */
    setServing(realmId: string, online: boolean, serving: boolean): void {
        const realm = this.realms.get(realmId)!;
        this.realms.set(realmId, { ...realm, online, serving });
    }

    /** The account's realm context (what the game login bound), as presenceOf answers it. */
    bindPresence(accountId: string, realmId: string): void {
        const at = new Date().toISOString();
        this.presences.set(accountId, { realmId, boundAt: at, lastSeenAt: at, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    }

    async findHostedRealm(hostAccountId: string): Promise<RealmSummary | undefined> {
        return [...this.realms.values()].find((realm) => realm.hostAccountId === hostAccountId);
    }
    async findRealm(realmId: string): Promise<RealmSummary | undefined> { return this.realms.get(realmId); }
    async memberDisplayNames(hostAccountId: string): Promise<Map<string, string>> {
        const hosted = await this.findHostedRealm(hostAccountId);
        const names = new Map<string, string>();
        for (const member of this.members) {
            const [realmId, accountId] = member.split(":");
            if (hosted?.realmId === realmId && this.names.has(accountId)) names.set(accountId, this.names.get(accountId)!);
        }
        return names;
    }
    async presenceOf(accountId: string): Promise<RealmPresenceView | undefined> {
        const presence = this.presences.get(accountId);
        return presence != undefined && Date.parse(presence.expiresAt) > Date.now() ? { ...presence } : undefined;
    }
    async isMember(realmId: string, accountId: string): Promise<boolean> { return this.members.has(`${realmId}:${accountId}`); }
    async isBanned(realmId: string, accountId: string): Promise<boolean> { return this.bans.has(`${realmId}:${accountId}`); }
    async setHosting(realmId: string, patch: RealmHostingPatch): Promise<void> {
        if (this.failSetHosting) throw new Error("realms unavailable");
        this.hostingPatches.push({ realmId, patch: { ...patch } });
    }
    async markOffline(realmId: string): Promise<void> { this.offline.push(realmId); }
    async findByHubRoomId(hubRoomId: string): Promise<RealmSummary | undefined> {
        return [...this.realms.values()].find((realm) => this.hubRoomId(realm.realmId, "RAMSGATE") === hubRoomId || this.hubRoomId(realm.realmId, "TRAINING") === hubRoomId);
    }
    hubRoomId(realmId: string, hubKind: RealmHubKind): string {
        const hex = crypto.createHash("sha256").update(`test-hub:${realmId}:${hubKind}`).digest("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }

    /** The hub fields the realm directory would show now, folded from every patch in order. */
    shown(realmId: string): RealmHostingPatch {
        return this.hostingPatches.filter((entry) => entry.realmId === realmId).reduce<RealmHostingPatch>((sum, entry) => ({ ...sum, ...entry.patch }), {});
    }
}

export interface HubKit {
    hunts: InMemoryP2PHuntRepository;
    presence: InMemoryRealmHubRepository;
    realms: FakeRealms;
    /** The parties of the in-memory directory (a party's revision moves on each activity change, as the database's does). */
    parties: Map<string, { partyId: string; revision: number; members: string[]; activeHuntSessionId?: string }>;
    addParty(partyId: string, members: string[], revision?: number): void;
    /** A launcher Guard session of the account that is healthy for `role` (what a presence report's Guard check reads). */
    healthyGuard(accountId: string, guardSessionId: string, role: "client" | "host"): void;
    /** The host's PC reports in as an eligible host. */
    seedHostPresence(accountId?: string, overrides?: Partial<P2PHostPresenceRecord>): void;
    /** The account has a verified transport link, as every launcher that reported in has. */
    linkAccount(accountId: string): void;
    dispose(): void;
}

/** The hunt launch manifest the test kit hands to hunt creation (the DeployServer's answer, without DeployServer). */
function TestHuntManifest(huntId: string) {
    return {
        huntId,
        matchmakerHuntId: `CR19_MatchmakerHunt_${huntId}`,
        mapPath: "/Game/Maps/islands/1705/dia_moss_triforce",
        behemothPath: "/Game/Characters/Behemoth/Embermane",
        expectedPlayerString: "NO_EXPECTED_PLAYERS",
        guardCompletionMode: "FIRST_DEFEAT" as const
    };
}

/** Installs the in-memory persistence, the operations policy and the fake realms port. Call dispose() when done. */
export function CreateHubKit(options: { operations?: { p2pEmergencyStop?: boolean; coopTransport?: "ICE" | "STEAM_EXPERIMENTAL" } } = {}): HubKit {
    const hunts = new InMemoryP2PHuntRepository(() => Date.now());
    const presence = new InMemoryRealmHubRepository();
    const realms = new FakeRealms();
    realms.addRealm({ realmId: REALM_ID, hostAccountId: HOST, name: "friends" }, [MEMBER, FRIEND]);
    const parties = new Map<string, { partyId: string; revision: number; members: string[]; activeHuntSessionId?: string }>();
    const guards = new Map<string, { guardSessionId: string; accountId: string; role: string; manifestSequence: number; lastSequence: number;
        riskScore: number; status: string }>();
    const provider = {
        p2pHunts: hunts,
        realmHub: presence,
        operationsAlerts: {},
        // The shared repositories the hunt paths of these flows touch: parties (revision-checked), characters and loadouts
        // (no characters, so every frozen loadout is the empty one).
        parties: {
            findById: async (partyId: string) => {
                const party = parties.get(partyId);
                return party == undefined ? undefined : structuredClone(party);
            },
            setActivity: async (input: { partyId: string; expectedRevision: number; activity: string; activeHuntSessionId?: string }) => {
                const party = parties.get(input.partyId);
                if (party == undefined || party.revision !== input.expectedRevision) return undefined;
                party.revision += 1;
                if (input.activity === "IDLE") delete party.activeHuntSessionId;
                else party.activeHuntSessionId = input.activeHuntSessionId;
                return structuredClone(party);
            },
            appendEvent: async () => undefined
        },
        characters: { findManyByUserId: async () => [] },
        loadouts: { findByCharacterIdAndUserId: async () => undefined },
        // The launcher Guard sessions a presence report verifies (healthyGuard below marks one healthy).
        launcherGuard: {
            findHealthyForAccount: async (accountId: string, guardSessionId: string, role: string) =>
                guards.get(`${accountId}:${guardSessionId}:${role}`)
        }
    } as unknown as P2PRepositoryProvider;
    UseP2PPersistenceForTest(provider);
    UseP2POperationsPolicyForTest({ p2pEmergencyStop: options.operations?.p2pEmergencyStop ?? false, coopTransport: options.operations?.coopTransport ?? "ICE" });
    SetRealmsPort(realms);
    SetHuntManifestResolverForTest(async (huntId) => TestHuntManifest(huntId));
    // [2026-10-14 realms S5] A request with no party state gets a solo party in the kit's parties (what POST /party makes).
    SetSoloPartyResolverForTest(async (accountId) => {
        const existing = [...parties.values()].find((party) => party.members.includes(accountId));
        if (existing != undefined) return { partyId: existing.partyId, revision: existing.revision };
        const partyId = `solo-${accountId}`;
        parties.set(partyId, { partyId, revision: 1, members: [accountId] });
        return { partyId, revision: 1 };
    });
    HubPresence.clear();
    const kit: HubKit = {
        hunts, presence, realms, parties,
        addParty(partyId, members, revision = 1) {
            parties.set(partyId, { partyId, revision, members: [...members] });
        },
        healthyGuard(accountId, guardSessionId, role) {
            guards.set(`${accountId}:${guardSessionId}:${role}`, { guardSessionId, accountId, role, manifestSequence: 1, lastSequence: 1,
                riskScore: 0, status: "HEALTHY" });
        },
        seedHostPresence(accountId = HOST, overrides = {}) {
            const hash = "a".repeat(64);
            void hunts.upsertHostPresence({
                accountId, revision: 1, consentToHost: true, observedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 25_000).toISOString(), freePhysicalMemoryMiB: 16384, commitHeadroomMiB: 16384,
                logicalCpuCount: 8, cpuLoadPercent: 15, powerSaver: false, runtimeSupported: true, steamRuntimeReady: true,
                steamId: DeriveIcePeerId(accountId), backendRttMs: 30, worstPeerRttMs: 30, jitterMs: 4, packetLossPercent: 0,
                artifacts: { gameExe: hash, internalServer: hash, winmmProxy: hash, steamBridge: hash, steamRuntime: hash, admissionPublicKey: hash },
                artifactsVerified: true, launcherVersion: "0.1.55", guardVerified: true, ...overrides
            });
        },
        linkAccount(accountId) {
            void hunts.upsertSteamLink({
                accountId, steamId: DeriveIcePeerId(accountId), status: "VERIFIED", revision: 1, verifiedAt: new Date().toISOString(),
                lastUsedAt: new Date().toISOString(), verificationMethod: "ICE_ACCOUNT_DERIVED"
            });
        },
        dispose() {
            UseP2PPersistenceForTest(undefined);
            UseP2POperationsPolicyForTest(undefined);
            SetRealmsPort(undefined);
            SetHuntManifestResolverForTest(undefined);
            SetSoloPartyResolverForTest(undefined);
            HubPresence.clear();
        }
    };
    kit.seedHostPresence();
    kit.linkAccount(HOST);
    return kit;
}

export interface RunningHub {
    sessionId: string;
    generation: number;
    /** The raw host capability (what the launcher gets) and its record. */
    capabilitySecret: string;
    capabilityId: string;
    bridgeInstanceId: string;
    bootstrap: Awaited<ReturnType<typeof CreateHostBootstrap>>;
}

export const LOCAL_BRIDGE_PORT = 55123;

/** Creates a hub and takes it through bootstrap, host-ready and the host's route-ready to RUNNING, as the host's launcher does. */
export async function StartRunningHub(kit: HubKit, options: { hubKind?: RealmHubKind; maxPlayers?: number } = {}): Promise<RunningHub> {
    const started = await CreateRealmHubSession(HOST, { hubKind: options.hubKind ?? "RAMSGATE", maxPlayers: options.maxPlayers });
    const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
    const capability = await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability));
    if (capability == undefined) throw new Error("the bootstrap stored no capability");
    await MarkHostReady({
        sessionId: started.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability
    });
    // Then the host's transport consumes the host's own ticket (ParadoxTransport transport_app.cpp: host-ready, then the
    // local client's consume), before the launcher's route-ready (14 Oct repro: this step was missing here, and the real
    // hub start failed on it with host:backend_http_409).
    if (bootstrap.hostTicket) {
        await ConsumeAdmissionTicket({
            sessionId: started.sessionId, ticket: bootstrap.hostTicket, authenticatedSteamId: DeriveIcePeerId(HOST),
            bridgeInstanceId: bootstrap.bridgeInstanceId, connectionHandle: "host-local", requestId: crypto.randomUUID(), capability
        });
    }
    await MarkLocalRouteReady(HOST, started.sessionId, {
        generation: started.generation, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT
    });
    return { sessionId: started.sessionId, generation: started.generation, capabilitySecret: bootstrap.capability,
        capabilityId: capability.capabilityId, bridgeInstanceId: bootstrap.bridgeInstanceId, bootstrap };
}
