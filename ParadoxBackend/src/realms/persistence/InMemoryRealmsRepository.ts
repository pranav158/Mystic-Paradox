/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ApplyHostingPatch, GetInviteState, HeartbeatUpdate } from "../realmRules";
import {
    RealmBan,
    RealmHostingPatch,
    RealmInviteRecord,
    RealmJoinPolicy,
    RealmJoinRequest,
    RealmMember,
    RealmPlayerInvite,
    RealmPresenceRecord,
    RealmRecord
} from "../realmTypes";
import {
    AddBanResult,
    AddJoinRequestResult,
    AddMemberResult,
    AddPlayerInviteResult,
    InsertRealmResult,
    RealmPresenceRepository,
    RealmsRepository
} from "./RealmsRepository";

// [2026-10-13 realms S2] The realms persistence contract held in memory: the test double of the service and route tests
// (no MongoDB needed), and the reference for the contract's semantics. Records are copied on the way in and out, as a
// database would, so a caller can never change a stored record by mutating what it was handed. Not used by the server.

function Copy<T>(value: T): T {
    return structuredClone(value);
}

export class InMemoryRealmsRepository implements RealmsRepository {
    readonly realms = new Map<string, RealmRecord>();
    readonly invites = new Map<string, RealmInviteRecord>();

    async findById(realmId: string): Promise<RealmRecord | undefined> {
        const realm = this.realms.get(realmId);
        return realm === undefined ? undefined : Copy(realm);
    }

    async findByName(name: string): Promise<RealmRecord | undefined> {
        for (const realm of this.realms.values()) if (realm.name === name) return Copy(realm);
        return undefined;
    }

    async findByHost(hostAccountId: string): Promise<RealmRecord | undefined> {
        for (const realm of this.realms.values()) if (realm.hostAccountId === hostAccountId) return Copy(realm);
        return undefined;
    }

    async findByMember(accountId: string, limit: number): Promise<RealmRecord[]> {
        return [...this.realms.values()]
            .filter((realm) => realm.members.some((member) => member.accountId === accountId))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, limit)
            .map(Copy);
    }

    async listListed(limit: number, offset: number): Promise<RealmRecord[]> {
        return [...this.realms.values()]
            .filter((realm) => realm.listed)
            .sort((a, b) => (b.onlineUntil ?? "").localeCompare(a.onlineUntil ?? "") || a.name.localeCompare(b.name))
            .slice(offset, offset + limit)
            .map(Copy);
    }

    async insertRealm(realm: RealmRecord): Promise<InsertRealmResult> {
        for (const other of this.realms.values()) {
            if (other.hostAccountId === realm.hostAccountId) return "HOST_HAS_REALM";
            if (other.name === realm.name) return "NAME_TAKEN";
        }
        this.realms.set(realm.realmId, Copy(realm));
        return "INSERTED";
    }

    async deleteRealmIfLastOnline(realmId: string, expectedLastOnlineAt: string | undefined): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined || realm.lastOnlineAt !== expectedLastOnlineAt) return false;
        this.removeRealm(realmId);
        return true;
    }

    async deleteRealmOfHost(realmId: string, hostAccountId: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined || realm.hostAccountId !== hostAccountId) return false;
        this.removeRealm(realmId);
        return true;
    }

    private removeRealm(realmId: string): void {
        this.realms.delete(realmId);
        for (const [code, invite] of this.invites) if (invite.realmId === realmId) this.invites.delete(code);
    }

    async setSettings(
        realmId: string,
        hostAccountId: string,
        settings: { joinPolicy?: RealmJoinPolicy; listed?: boolean }
    ): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined || realm.hostAccountId !== hostAccountId) return false;
        if (settings.joinPolicy !== undefined) realm.joinPolicy = settings.joinPolicy;
        if (settings.listed !== undefined) realm.listed = settings.listed;
        return true;
    }

    async recordHeartbeat(realmId: string, hostAccountId: string, update: HeartbeatUpdate): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined || realm.hostAccountId !== hostAccountId) return false;
        realm.lastOnlineAt = update.lastOnlineAt;
        realm.onlineUntil = update.onlineUntil;
        if (update.version !== undefined) realm.version = update.version;
        return true;
    }

    async patchHosting(realmId: string, patch: RealmHostingPatch, updatedAtIso: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return false;
        realm.hosting = ApplyHostingPatch(realm.hosting, patch, updatedAtIso);
        return true;
    }

    async markOffline(realmId: string, atIso: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined || realm.onlineUntil === undefined || realm.onlineUntil <= atIso) return false;
        realm.onlineUntil = atIso;
        realm.offlineNotifiedFor = atIso;
        return true;
    }

    async claimLapsedHosts(nowIso: string, sinceIso: string, limit: number): Promise<RealmRecord[]> {
        const claimed: RealmRecord[] = [];
        for (const realm of this.realms.values()) {
            if (claimed.length >= limit) break;
            const until = realm.onlineUntil;
            if (until === undefined || until <= sinceIso || until > nowIso || realm.offlineNotifiedFor === until) continue;
            realm.offlineNotifiedFor = until;
            claimed.push(Copy(realm));
        }
        return claimed;
    }

    async findByHubRoomId(hubRoomId: string): Promise<RealmRecord | undefined> {
        for (const realm of this.realms.values()) if (realm.hubRoomIds?.includes(hubRoomId)) return Copy(realm);
        return undefined;
    }

    async addMember(realmId: string, member: RealmMember, maxMembers: number): Promise<AddMemberResult> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return "NOT_FOUND";
        if (realm.bans.some((ban) => ban.accountId === member.accountId)) return "BANNED";
        if (realm.members.some((entry) => entry.accountId === member.accountId)) return "ALREADY_MEMBER";
        if (realm.members.length >= maxMembers) return "FULL";
        realm.members.push(Copy(member));
        if (realm.playerInvites !== undefined) realm.playerInvites = realm.playerInvites.filter((invite) => invite.accountId !== member.accountId);
        return "ADDED";
    }

    async removeMember(realmId: string, accountId: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return false;
        const index = realm.members.findIndex((member) => member.accountId === accountId && member.role === "MEMBER");
        if (index < 0) return false;
        realm.members.splice(index, 1);
        return true;
    }

    async addBan(realmId: string, ban: RealmBan, maxBans: number): Promise<AddBanResult> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return "NOT_FOUND";
        if (realm.bans.some((entry) => entry.accountId === ban.accountId)) return "ALREADY_BANNED";
        if (realm.bans.length >= maxBans) return "FULL";
        realm.bans.push(Copy(ban));
        realm.members = realm.members.filter((member) => !(member.accountId === ban.accountId && member.role === "MEMBER"));
        if (realm.joinRequests !== undefined) realm.joinRequests = realm.joinRequests.filter((request) => request.accountId !== ban.accountId);
        if (realm.playerInvites !== undefined) realm.playerInvites = realm.playerInvites.filter((invite) => invite.accountId !== ban.accountId);
        return "BANNED";
    }

    async removeBan(realmId: string, accountId: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return false;
        const index = realm.bans.findIndex((ban) => ban.accountId === accountId);
        if (index < 0) return false;
        realm.bans.splice(index, 1);
        return true;
    }

    async addJoinRequest(realmId: string, request: RealmJoinRequest, maxRequests: number): Promise<AddJoinRequestResult> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return "NOT_FOUND";
        const requests = realm.joinRequests ?? [];
        if (realm.bans.some((ban) => ban.accountId === request.accountId)) return "BANNED";
        if (realm.members.some((member) => member.accountId === request.accountId)) return "ALREADY_MEMBER";
        if (requests.some((entry) => entry.accountId === request.accountId)) return "ALREADY_REQUESTED";
        if (requests.length >= maxRequests) return "FULL";
        realm.joinRequests = [...requests, Copy(request)];
        return "ADDED";
    }

    async removeJoinRequest(realmId: string, accountId: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        const index = realm?.joinRequests?.findIndex((request) => request.accountId === accountId) ?? -1;
        if (realm === undefined || index < 0) return false;
        realm.joinRequests!.splice(index, 1);
        return true;
    }

    async addPlayerInvite(realmId: string, invite: RealmPlayerInvite, maxInvites: number): Promise<AddPlayerInviteResult> {
        const realm = this.realms.get(realmId);
        if (realm === undefined) return "NOT_FOUND";
        const invites = realm.playerInvites ?? [];
        if (realm.bans.some((ban) => ban.accountId === invite.accountId)) return "BANNED";
        if (realm.members.some((member) => member.accountId === invite.accountId)) return "ALREADY_MEMBER";
        if (invites.some((entry) => entry.accountId === invite.accountId)) return "ALREADY_INVITED";
        if (invites.length >= maxInvites) return "FULL";
        realm.playerInvites = [...invites, Copy(invite)];
        return "ADDED";
    }

    async removePlayerInvite(realmId: string, accountId: string): Promise<boolean> {
        const realm = this.realms.get(realmId);
        const index = realm?.playerInvites?.findIndex((invite) => invite.accountId === accountId) ?? -1;
        if (realm === undefined || index < 0) return false;
        realm.playerInvites!.splice(index, 1);
        return true;
    }

    async findByPlayerInvite(accountId: string, limit: number): Promise<RealmRecord[]> {
        return [...this.realms.values()]
            .filter((realm) => (realm.playerInvites ?? []).some((invite) => invite.accountId === accountId))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, limit)
            .map(Copy);
    }

    async insertInvite(invite: RealmInviteRecord): Promise<"INSERTED" | "DUPLICATE"> {
        if (this.invites.has(invite.code)) return "DUPLICATE";
        this.invites.set(invite.code, Copy(invite));
        return "INSERTED";
    }

    async findInvite(code: string): Promise<RealmInviteRecord | undefined> {
        const invite = this.invites.get(code);
        return invite === undefined ? undefined : Copy(invite);
    }

    async listInvites(realmId: string, limit: number): Promise<RealmInviteRecord[]> {
        return [...this.invites.values()]
            .filter((invite) => invite.realmId === realmId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit)
            .map(Copy);
    }

    async countActiveInvites(realmId: string, nowIso: string): Promise<number> {
        const nowMs = Date.parse(nowIso);
        return [...this.invites.values()].filter((invite) => invite.realmId === realmId && GetInviteState(invite, nowMs) === "USABLE").length;
    }

    async consumeInvite(code: string, nowIso: string): Promise<RealmInviteRecord | undefined> {
        const invite = this.invites.get(code);
        if (invite === undefined || GetInviteState(invite, Date.parse(nowIso)) !== "USABLE") return undefined;
        invite.uses += 1;
        return Copy(invite);
    }

    async refundInvite(code: string): Promise<void> {
        const invite = this.invites.get(code);
        if (invite !== undefined && invite.uses > 0) invite.uses -= 1;
    }

    async revokeInvite(realmId: string, code: string, atIso: string): Promise<RealmInviteRecord | undefined> {
        const invite = this.invites.get(code);
        if (invite === undefined || invite.realmId !== realmId) return undefined;
        if (invite.revokedAt === undefined) invite.revokedAt = atIso;
        return Copy(invite);
    }
}

/** The presence contract held in memory: the test double of the service and route tests. Not used by the server. */
export class InMemoryRealmPresenceRepository implements RealmPresenceRepository {
    readonly rows = new Map<string, RealmPresenceRecord>();

    async bind(row: RealmPresenceRecord): Promise<void> {
        this.rows.set(row.accountId, Copy(row));
    }

    async findActive(accountId: string, nowIso: string): Promise<RealmPresenceRecord | undefined> {
        const row = this.rows.get(accountId);
        return row !== undefined && row.expiresAt > nowIso ? Copy(row) : undefined;
    }

    async touch(accountId: string, nowIso: string, expiresAtIso: string): Promise<RealmPresenceRecord | undefined> {
        const row = this.rows.get(accountId);
        if (row === undefined || row.expiresAt <= nowIso) return undefined;
        row.lastSeenAt = nowIso;
        row.expiresAt = expiresAtIso;
        return Copy(row);
    }

    async remove(accountId: string, realmId?: string): Promise<boolean> {
        const row = this.rows.get(accountId);
        if (row === undefined || (realmId !== undefined && row.realmId !== realmId)) return false;
        this.rows.delete(accountId);
        return true;
    }

    async removeForRealm(realmId: string): Promise<number> {
        let removed = 0;
        for (const [accountId, row] of this.rows) {
            if (row.realmId !== realmId) continue;
            this.rows.delete(accountId);
            removed += 1;
        }
        return removed;
    }

    async countActiveByRealm(realmIds: string[], nowIso: string): Promise<Map<string, number>> {
        const wanted = new Set(realmIds);
        const counts = new Map<string, number>();
        for (const row of this.rows.values()) {
            if (!wanted.has(row.realmId) || row.expiresAt <= nowIso) continue;
            counts.set(row.realmId, (counts.get(row.realmId) ?? 0) + 1);
        }
        return counts;
    }
}
