/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { GetRepositories, GetUnitOfWork, PartyInviteRecord, PartyRecord } from "../persistence";

export interface Party {
    partyId: string;
    revision: number;
    leaderPlayerId: string;
    members: string[];
    buildId: string;
    activity: PartyRecord["activity"];
    activeHuntSessionId?: string;
}

export interface PartyInvite {
    partyId: string;
    sendingPlayerId: string;
    sendingDisplayName: string;
    sendingPlatform: string;
}

const INVITE_TTL_MS = 10 * 60 * 1000;
const MAX_PARTY_SIZE = 4;

function IsRetryablePartyConflict(error: unknown): boolean {
    const candidate = error as { code?: number; message?: string };
    return candidate?.code === 11000 || candidate?.message?.includes("PARTY_REVISION_CONFLICT") === true;
}

async function WithPartyTransaction<T>(
    action: Parameters<ReturnType<typeof GetUnitOfWork>["withTransaction"]>[0]
): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await GetUnitOfWork().withTransaction(action) as T;
        } catch (error) {
            if (attempt === 3 || !IsRetryablePartyConflict(error)) throw error;
        }
    }
    throw new Error("PARTY_REVISION_CONFLICT");
}

function MakePartyId(buildId: string): string {
    return `${crypto.randomBytes(16).toString("hex")}_${Buffer.from(buildId ?? "").toString("base64")}`;
}

function ToParty(record: PartyRecord | undefined): Party | undefined {
    if (record == undefined) return undefined;
    return {
        partyId: record.partyId,
        revision: record.revision,
        leaderPlayerId: record.leaderPlayerId,
        members: record.members,
        buildId: record.buildId,
        activity: record.activity ?? "IDLE",
        activeHuntSessionId: record.activeHuntSessionId
    };
}

function ToInvite(record: PartyInviteRecord): PartyInvite {
    return {
        partyId: record.partyId,
        sendingPlayerId: record.sendingPlayerId,
        sendingDisplayName: record.sendingDisplayName,
        sendingPlatform: record.sendingPlatform
    };
}

export async function GetPartyForPlayer(playerId: string): Promise<Party | undefined> {
    return ToParty(await GetRepositories().parties.findByMember(playerId));
}

export async function GetPartyById(partyId: string): Promise<Party | undefined> {
    return ToParty(await GetRepositories().parties.findById(partyId));
}

export async function GetOrCreateParty(playerId: string, buildId: string): Promise<Party> {
    const now = new Date().toISOString();
    const record = await WithPartyTransaction<PartyRecord>((repos, session) =>
        repos.parties.getOrCreateSolo({
            accountId: playerId,
            buildId,
            newPartyId: MakePartyId(buildId),
            now
        }, session)
    );
    return ToParty(record)!;
}

export async function InviteToParty(
    senderId: string,
    recipientId: string,
    buildId: string,
    senderDisplayName: string,
    senderPlatform: string
): Promise<void> {
    if (!recipientId || recipientId === senderId) return;
    const now = new Date();
    await WithPartyTransaction<void>((repos, session) => repos.parties.createInvite({
        senderId,
        recipientId,
        buildId,
        senderDisplayName,
        senderPlatform,
        newPartyId: MakePartyId(buildId),
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString()
    }, session));
}

export async function GetInvitesForPlayer(recipientId: string): Promise<PartyInvite[]> {
    const records = await GetRepositories().parties.listPendingInvites(recipientId, new Date().toISOString());
    return records.map(ToInvite);
}

export async function LeaveParty(playerId: string): Promise<void> {
    const now = new Date().toISOString();
    await WithPartyTransaction<void>((repos, session) => repos.parties.leave(playerId, now, session));
}

export async function AcceptInvite(recipientId: string, inviterId: string, buildId: string): Promise<Party | undefined> {
    const now = new Date().toISOString();
    const record = await WithPartyTransaction<PartyRecord | undefined>((repos, session) => repos.parties.acceptInvite({
        recipientId,
        inviterId,
        buildId,
        newPartyId: MakePartyId(buildId),
        now,
        maxPartySize: MAX_PARTY_SIZE
    }, session));
    return ToParty(record);
}

export async function KickMember(actorId: string, targetId: string): Promise<void> {
    const now = new Date().toISOString();
    await WithPartyTransaction<void>((repos, session) => repos.parties.kick(actorId, targetId, now, session));
}

export async function PromoteMember(actorId: string, targetId: string): Promise<void> {
    const now = new Date().toISOString();
    await WithPartyTransaction<void>((repos, session) => repos.parties.promote(actorId, targetId, now, session));
}
