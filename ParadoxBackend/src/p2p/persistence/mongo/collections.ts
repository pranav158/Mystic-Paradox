// Collections of the player-hosted hunt module. They are additive and stay empty while
// P2P_HUNTS_ENABLED is false.
export const P2PCollections = {
    P2PHuntSessions: "p2pHuntSessions",
    P2PSteamLinks: "p2pSteamLinks",
    P2PHostCapabilities: "p2pHostCapabilities",
    P2PAdmissionTickets: "p2pAdmissionTickets",
    P2PPeerAdmissions: "p2pPeerAdmissions",
    P2PControlSequences: "p2pControlSequences",
    P2PControlMessages: "p2pControlMessages",
    P2PHostPresences: "p2pHostPresences",
    P2PHostOffers: "p2pHostOffers",
    P2PHostReliability: "p2pHostReliability",
    P2PParticipantObservations: "p2pParticipantObservations",
    P2PHuntTransitions: "p2pHuntTransitions",
    // Fixed-window host/session request counters used by the production distributed Guard limiter.
    GuardTrafficWindows: "guardTrafficWindows",
    // [2026-10-13 realms S3] One row per accepted host write besides inventory (security/hostWrites.ts): the tag behaviour
    // analysis and reversal of a cheating host's sessions work from.
    P2PHostWrites: "p2pHostWrites",
    // [2026-10-14] One summary row per hunt and member, written when the hunt ends (observability/huntXpMonitor.ts): the per-hunt
    // XP record for behaviour analysis. _id = `${sessionId}:${member}`; kept about 400 days (ttlAt).
    P2PHuntXpSummaries: "p2pHuntXpSummaries",
    // [2026-10-13 realms S1] Who is in a realm's Ramsgate or Training hub: one row per (hub session, account), written
    // without touching the session document (contracts/RealmHubRepository.ts).
    RealmHubPresence: "realmHubPresence",
    // [2026-10-14 realms wave 2] One gate document per hub generation: the transaction that counts a hub's seats writes it first, so
    // two entries for one hub cannot both count before either writes (MongoRealmHubRepository.requestEntries). purgeAt is a week
    // after the last entry; a purged gate is created again by the next entry.
    RealmHubGates: "realmHubGates",
    // Hunt Guard evidence, verdicts and reward receipts belong to the anti-cheat module (antiCheat.ts).
    // Durable operator-facing work items. These are written transactionally with
    // economic auto-pauses and remain open until an authenticated operator
    // acknowledges them.
    OperationsAlerts: "operationsAlerts"
} as const;
