import { ClientSession } from "mongodb";

export interface PartyRecord {
    partyId: string;
    revision: number;
    leaderPlayerId: string;
    members: string[];
    buildId: string;
    activity: "IDLE" | "MATCHMAKING" | "HOST_SELECTING" | "STARTING_HUNT" | "IN_HUNT" | "RECOVERING";
    activeHuntSessionId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface PartyInviteRecord {
    inviteId: string;
    partyId: string;
    partyRevision: number;
    sendingPlayerId: string;
    recipientPlayerId: string;
    sendingDisplayName: string;
    sendingPlatform: string;
    status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
    createdAt: string;
    expiresAt: string;
}

export type PartyEventType =
    | "PARTY_CREATED"
    | "PARTY_INVITE_CREATED"
    | "PARTY_MEMBERSHIP_CHANGED"
    | "PARTY_LEADER_CHANGED"
    | "PARTY_ACTIVITY_CHANGED"
    | "PARTY_PRESENCE_CHANGED"
    | "PARTY_HUNT_STATUS_CHANGED";

export interface PartyOutboxRecord {
    eventId: string;
    partyId: string;
    partyRevision: number;
    eventType: PartyEventType;
    recipientAccountIds: string[];
    payload: Record<string, unknown>;
    state: "PENDING" | "PROCESSING" | "PUBLISHED";
    createdAt: string;
    claimedAt?: string;
    claimOwner?: string;
    publishedAt?: string;
}

export interface PartyRepository {
    findById(partyId: string, session?: ClientSession): Promise<PartyRecord | undefined>;
    findByMember(accountId: string, session?: ClientSession): Promise<PartyRecord | undefined>;
    getOrCreateSolo(input: {
        accountId: string;
        buildId: string;
        newPartyId: string;
        now: string;
    }, session: ClientSession): Promise<PartyRecord>;
    createInvite(input: {
        senderId: string;
        recipientId: string;
        buildId: string;
        senderDisplayName: string;
        senderPlatform: string;
        newPartyId: string;
        now: string;
        expiresAt: string;
    }, session: ClientSession): Promise<void>;
    listPendingInvites(recipientId: string, now: string, session?: ClientSession): Promise<PartyInviteRecord[]>;
    acceptInvite(input: {
        recipientId: string;
        inviterId: string;
        buildId: string;
        newPartyId: string;
        now: string;
        maxPartySize: number;
    }, session: ClientSession): Promise<PartyRecord | undefined>;
    leave(accountId: string, now: string, session: ClientSession): Promise<void>;
    kick(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void>;
    promote(actorId: string, targetId: string, now: string, session: ClientSession): Promise<void>;
    setActivity(input: {
        partyId: string;
        expectedRevision: number;
        activity: PartyRecord["activity"];
        activeHuntSessionId?: string;
        now: string;
    }, session: ClientSession): Promise<PartyRecord | undefined>;
    appendEvent(input: {
        partyId: string;
        partyRevision: number;
        eventType: PartyEventType;
        recipientAccountIds: string[];
        payload: Record<string, unknown>;
        now: string;
    }, session?: ClientSession): Promise<void>;
    claimNextOutbox(owner: string, now: string, staleBefore: string): Promise<PartyOutboxRecord | undefined>;
    markOutboxPublished(eventId: string, owner: string, publishedAt: string): Promise<boolean>;
    releaseOutbox(eventId: string, owner: string): Promise<void>;
}
