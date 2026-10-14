import assert from "node:assert/strict";
import test, { after } from "node:test";
import { LauncherGuardSessionRecord, LauncherGuardSignals } from "../contracts/LauncherGuardRepository";
import { RepositoryProvider } from "../contracts/UnitOfWork";
import { OpenTestRealm, Session } from "./testSupport";
import { SqliteListLauncherGuardSessions } from "./directAccess";
import { Tables } from "./tables";

// Friends, launcher Guard sessions and the durable Phoenix party (with its realtime outbox).

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });
function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

test("friendships: one directed edge per pair and direction, upsert replaces, remove is one-sided", async () => {
    const { repos } = Realm("soc-friends");
    assert.deepEqual(await repos.friendships.listForOwner("a"), []);
    assert.equal(await repos.friendships.find("a", "b"), undefined);

    await repos.friendships.upsert({ ownerId: "a", otherId: "b", status: "PENDING", direction: "OUTBOUND", created: "2026-10-01T00:00:00.000Z" });
    await repos.friendships.upsert({ ownerId: "b", otherId: "a", status: "PENDING", direction: "INBOUND", created: "2026-10-01T00:00:00.000Z" });
    await repos.friendships.upsert({ ownerId: "a", otherId: "c", status: "BLOCKED", created: "2026-10-02T00:00:00.000Z" });
    assert.deepEqual(await repos.friendships.find("a", "b"), {
        ownerId: "a", otherId: "b", status: "PENDING", direction: "OUTBOUND", created: "2026-10-01T00:00:00.000Z", favorite: false
    });
    assert.equal((await repos.friendships.find("a", "c"))?.direction, undefined);

    await repos.friendships.upsert({ ownerId: "a", otherId: "b", status: "ACCEPTED", created: "2026-10-01T00:00:00.000Z", favorite: true });
    await repos.friendships.upsert({ ownerId: "b", otherId: "a", status: "ACCEPTED", created: "2026-10-01T00:00:00.000Z" });
    const Edge = (await repos.friendships.find("a", "b"))!;
    assert.equal(Edge.status, "ACCEPTED");
    assert.equal(Edge.direction, undefined, "an accepted edge has no direction");
    assert.equal(Edge.favorite, true);
    assert.deepEqual((await repos.friendships.listForOwner("a")).map((Entry) => Entry.otherId), ["b", "c"]);
    assert.equal((await repos.friendships.listForOwner("b")).length, 1);

    await repos.friendships.remove("a", "b");
    assert.equal(await repos.friendships.find("a", "b"), undefined);
    assert.ok(await repos.friendships.find("b", "a"), "the other direction stays");
    await repos.friendships.remove("a", "nobody");
});

const Signals: LauncherGuardSignals = {
    gameProcessId: 4242, gameStartedAt: "2026-10-13T11:59:00.000Z", moduleCount: 188, moduleSetDigest: "d", privateExecutableBytes: 0,
    writableExecutableBytes: 0, unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
};

function Guard(id: string, overrides: Partial<LauncherGuardSessionRecord> = {}): LauncherGuardSessionRecord {
    return {
        guardSessionId: id, accountId: "acc-1", role: "client", publicKeyBase64: "pk", manifestId: "m1", manifestSequence: 61, channel: "stable",
        launcherVersion: "0.1.54", challenge: "ch-0", lastSequence: 0, status: "CHALLENGED", riskScore: 0,
        createdAt: "2026-10-13T11:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z", ...overrides
    };
}

const Heartbeat = (id: string, sequence: number, challenge: string, next: string, overrides: Record<string, unknown> = {}) => ({
    guardSessionId: id, accountId: "acc-1", expectedChallenge: challenge, sequence, nextChallenge: next, status: "HEALTHY" as const,
    riskScore: 0, heartbeatAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T14:00:00.000Z", signals: Signals,
    reasons: [] as string[], historyEntry: { at: "2026-10-13T12:00:00.000Z", status: "HEALTHY" as const, riskScore: 0, reasons: [] as string[] },
    ...overrides
});

test("launcher Guard: create and find, healthy lookup by account, role and heartbeat age", async () => {
    const { repos } = Realm("soc-guard-find");
    await repos.launcherGuard.create(Guard("g1"));
    const Found = (await repos.launcherGuard.find("g1"))!;
    assert.equal(Found.guardSessionId, "g1");
    assert.equal(Found.role, "client");
    assert.equal(Found.status, "CHALLENGED");
    assert.equal(await repos.launcherGuard.find("ghost"), undefined);

    const Now = "2026-10-13T12:00:30.000Z";
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "client", Now), undefined, "still only challenged");
    assert.ok(await repos.launcherGuard.advance(Heartbeat("g1", 1, "ch-0", "ch-1")));
    assert.equal((await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "client", Now))?.status, "HEALTHY");
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-2", "g1", "client", Now), undefined, "another account");
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "host", Now), undefined, "a client session never satisfies a host check");
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "client", "2026-10-13T12:00:46.000Z"), undefined, "heartbeat older than 45 s");
    assert.ok(await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "client", "2026-10-13T12:00:44.000Z"));
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "g1", "client", "2026-10-13T14:00:01.000Z"), undefined, "expired");
});

test("launcher Guard: a legacy session without a role is a client session, a host session needs the exact role", async () => {
    const { repos, db } = Realm("soc-guard-role");
    const { guardSessionId: _a, role: _b, ...Legacy } = Guard("legacy", { status: "HEALTHY", lastHeartbeatAt: "2026-10-13T12:00:00.000Z" });
    await db.write(undefined, (c) => Tables.launcherGuardSessions.insert(c, "legacy", Legacy));
    await repos.launcherGuard.create(Guard("host-1", { role: "host", status: "HEALTHY", lastHeartbeatAt: "2026-10-13T12:00:00.000Z" }));
    const Now = "2026-10-13T12:00:10.000Z";

    assert.equal((await repos.launcherGuard.find("legacy"))?.role, "client", "normalised on read");
    assert.ok(await repos.launcherGuard.findHealthyForAccount("acc-1", "legacy", "client", Now));
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "legacy", "host", Now), undefined);
    assert.ok(await repos.launcherGuard.findHealthyForAccount("acc-1", "host-1", "host", Now));
    assert.equal(await repos.launcherGuard.findHealthyForAccount("acc-1", "host-1", "client", Now), undefined);
});

test("launcher Guard: a heartbeat applies once, in sequence, against the current challenge", async () => {
    const { repos } = Realm("soc-guard-advance");
    await repos.launcherGuard.create(Guard("g1"));

    const First = await repos.launcherGuard.advance(Heartbeat("g1", 1, "ch-0", "ch-1", { riskScore: 5 }));
    assert.equal(First?.challenge, "ch-1");
    assert.equal(First?.lastSequence, 1);
    assert.equal(First?.riskScore, 5);
    assert.equal(First?.lastSignals?.moduleCount, 188);
    assert.equal(First?.expiresAt, "2026-10-13T14:00:00.000Z");

    assert.equal(await repos.launcherGuard.advance(Heartbeat("g1", 1, "ch-0", "ch-x")), undefined, "a replay of the first heartbeat");
    assert.equal(await repos.launcherGuard.advance(Heartbeat("g1", 1, "ch-1", "ch-x")), undefined, "same sequence again");
    assert.equal(await repos.launcherGuard.advance(Heartbeat("g1", 2, "wrong", "ch-x")), undefined, "wrong challenge");
    assert.equal(await repos.launcherGuard.advance({ ...Heartbeat("g1", 2, "ch-1", "ch-x"), accountId: "acc-2" }), undefined, "another account");
    assert.equal(await repos.launcherGuard.advance(Heartbeat("g1", 2, "ch-1", "ch-x", { heartbeatAt: "2026-10-13T14:00:00.000Z" })), undefined, "already expired at the heartbeat");
    assert.equal(await repos.launcherGuard.advance(Heartbeat("ghost", 1, "ch-0", "ch-x")), undefined);
    assert.equal((await repos.launcherGuard.advance(Heartbeat("g1", 5, "ch-1", "ch-2", { status: "DEGRADED", riskScore: 50 })))?.status, "DEGRADED", "a gap in the sequence is fine, going backwards is not");
    assert.equal(await repos.launcherGuard.advance(Heartbeat("g1", 3, "ch-2", "ch-3")), undefined);

    const Racers = await Promise.all([
        repos.launcherGuard.advance(Heartbeat("g1", 6, "ch-2", "ch-a")),
        repos.launcherGuard.advance(Heartbeat("g1", 6, "ch-2", "ch-b"))
    ]);
    assert.equal(Racers.filter((Entry) => Entry !== undefined).length, 1, "two heartbeats on one challenge: one wins");
});

test("launcher Guard: revoking an account's sessions touches the role and the live statuses only", async () => {
    const { repos, db } = Realm("soc-guard-revoke");
    await repos.launcherGuard.create(Guard("client-live", { status: "HEALTHY" }));
    await repos.launcherGuard.create(Guard("client-done", { status: "EXPIRED" }));
    await repos.launcherGuard.create(Guard("host-live", { role: "host", status: "HEALTHY" }));
    await repos.launcherGuard.create(Guard("other", { accountId: "acc-2", status: "HEALTHY" }));

    await repos.launcherGuard.revokeForAccount("acc-1", "client", "2026-10-13T12:30:00.000Z");
    const Revoked = (await repos.launcherGuard.find("client-live"))!;
    assert.equal(Revoked.status, "REVOKED");
    assert.equal(Revoked.expiresAt, "2026-10-13T12:30:00.000Z");
    assert.equal((await repos.launcherGuard.find("client-done"))?.status, "EXPIRED");
    assert.equal((await repos.launcherGuard.find("host-live"))?.status, "HEALTHY");
    assert.equal((await repos.launcherGuard.find("other"))?.status, "HEALTHY");

    // The operations overview reads the newest sessions with a fixed set of fields.
    const Overview = await SqliteListLauncherGuardSessions(db, 3);
    assert.equal(Overview.length, 3);
    assert.deepEqual(Object.keys(Overview[0]).sort(), [
        "_id", "accountId", "expiresAt", "lastHeartbeatAt", "lastSignals", "launcherVersion", "manifestSequence", "riskScore", "status"
    ]);
    assert.equal((await SqliteListLauncherGuardSessions(db)).length, 4);
});

// ---------------------------------------------------------------------------------------------------------------------

const NOWISH = "2026-10-13T13:00:00.000Z";
const PartyInput = (id: string) => ({ accountId: id, buildId: "647472", newPartyId: `party-of-${id}`, now: "2026-10-13T12:00:00.000Z" });
const Later = "2026-10-13T12:01:00.000Z";
const Expiry = "2026-10-13T12:10:00.000Z";

async function Invite(r: ReturnType<typeof Realm>, sender: string, recipient: string, now = Later, expiresAt = Expiry, newPartyId = `party-of-${sender}`) {
    await r.uow.withTransaction((repos, session) => repos.parties.createInvite({
        senderId: sender, recipientId: recipient, buildId: "647472", senderDisplayName: sender, senderPlatform: "STEAM",
        newPartyId, now, expiresAt
    }, session));
}

async function Drain(r: ReturnType<typeof Realm>, owner = "worker"): Promise<Array<{ eventType: string; partyRevision: number; recipients: string[] }>> {
    const Seen: Array<{ eventType: string; partyRevision: number; recipients: string[] }> = [];
    for (;;) {
        const Event = await r.repos.parties.claimNextOutbox(owner, "2026-10-13T13:00:00.000Z", "2026-10-13T12:59:00.000Z");
        if (Event === undefined) return Seen;
        Seen.push({ eventType: Event.eventType, partyRevision: Event.partyRevision, recipients: Event.recipientAccountIds });
        assert.equal(await r.repos.parties.markOutboxPublished(Event.eventId, owner, "2026-10-13T13:00:01.000Z"), true);
    }
}

test("party: a solo party is created once per account and announced", async () => {
    const R = Realm("soc-party-solo");
    const First = await R.uow.withTransaction((repos, session) => repos.parties.getOrCreateSolo(PartyInput("a"), session));
    assert.equal(First.partyId, "party-of-a");
    assert.equal(First.revision, 1);
    assert.deepEqual(First.members, ["a"]);
    assert.equal(First.leaderPlayerId, "a");
    assert.equal(First.activity, "IDLE");
    const Again = await R.uow.withTransaction((repos, session) => repos.parties.getOrCreateSolo({ ...PartyInput("a"), newPartyId: "other-id" }, session));
    assert.equal(Again.partyId, "party-of-a", "the existing party is returned");

    assert.equal((await R.repos.parties.findByMember("a"))?.partyId, "party-of-a");
    assert.equal((await R.repos.parties.findById("party-of-a"))?.leaderPlayerId, "a");
    assert.equal(await R.repos.parties.findByMember("nobody"), undefined);
    assert.equal(await R.repos.parties.findById("nope"), undefined);
    assert.deepEqual(await Drain(R), [{ eventType: "PARTY_CREATED", partyRevision: 1, recipients: ["a"] }]);
});

test("party: invite, list, accept, with the party-size cap and invite consumption", async () => {
    const R = Realm("soc-party-invite");
    await Invite(R, "a", "b");
    await Invite(R, "a", "c", "2026-10-13T12:02:00.000Z");
    await Invite(R, "z", "c", "2026-10-13T12:03:00.000Z");
    await Invite(R, "a", "a"); // an invite to yourself is dropped

    const ForC = await R.repos.parties.listPendingInvites("c", "2026-10-13T12:04:00.000Z");
    assert.deepEqual(ForC.map((Entry) => Entry.sendingPlayerId), ["z", "a"], "newest first");
    assert.equal(ForC[0].status, "PENDING");
    assert.equal(ForC[1].inviteId, "c\u001fa");
    assert.deepEqual(await R.repos.parties.listPendingInvites("c", "2026-10-13T12:11:00.000Z"), [], "expired invites are not listed");
    assert.deepEqual(await R.repos.parties.listPendingInvites("nobody", Later), []);

    const Accepted = await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "b", inviterId: "a", buildId: "647472", newPartyId: "unused", now: "2026-10-13T12:05:00.000Z", maxPartySize: 2
    }, session));
    assert.deepEqual(Accepted?.members, ["a", "b"]);
    assert.equal(Accepted?.revision, 2);
    assert.equal((await R.repos.parties.findByMember("b"))?.partyId, "party-of-a");
    assert.deepEqual(await R.repos.parties.listPendingInvites("b", Later), [], "the accepted invite is consumed");

    const Full = await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "c", inviterId: "a", buildId: "647472", newPartyId: "unused", now: "2026-10-13T12:05:30.000Z", maxPartySize: 2
    }, session));
    assert.equal(Full, undefined, "a full party refuses; c has no party of their own");
    assert.equal((await R.repos.parties.findById("party-of-a"))?.members.length, 2);

    const NoInvite = await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "b", inviterId: "stranger", buildId: "647472", newPartyId: "unused", now: Later, maxPartySize: 4
    }, session));
    assert.equal(NoInvite?.partyId, "party-of-a", "no such invite: the recipient's current party is returned");

    const Events = await Drain(R);
    assert.deepEqual(Events.map((Entry) => Entry.eventType), ["PARTY_CREATED", "PARTY_INVITE_CREATED", "PARTY_INVITE_CREATED", "PARTY_CREATED", "PARTY_INVITE_CREATED", "PARTY_MEMBERSHIP_CHANGED"]);
    assert.deepEqual(Events[5].recipients, ["a", "b"]);
});

test("party: accepting moves a member out of their old party, and an invite from a party the inviter has left is dead", async () => {
    const R = Realm("soc-party-move");
    await Invite(R, "a", "b");
    await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "b", inviterId: "a", buildId: "x", newPartyId: "n", now: "2026-10-13T12:02:00.000Z", maxPartySize: 4
    }, session));
    await Invite(R, "d", "b", "2026-10-13T12:03:00.000Z");
    await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "b", inviterId: "d", buildId: "x", newPartyId: "n", now: "2026-10-13T12:04:00.000Z", maxPartySize: 4
    }, session));
    assert.deepEqual((await R.repos.parties.findByMember("b"))?.members, ["d", "b"]);
    assert.deepEqual((await R.repos.parties.findById("party-of-a"))?.members, ["a"]);

    // d leaves their party (b stays, as leader), then d starts a fresh party; d's old invite to c must not let c in.
    await Invite(R, "d", "c", "2026-10-13T12:05:00.000Z");
    await R.uow.withTransaction((repos, session) => repos.parties.leave("d", "2026-10-13T12:06:00.000Z", session));
    assert.equal((await R.repos.parties.findById("party-of-d"))?.leaderPlayerId, "b");
    await Invite(R, "d", "e", "2026-10-13T12:07:00.000Z", Expiry, "party-of-d-2");
    assert.equal((await R.repos.parties.findByMember("d"))?.partyId, "party-of-d-2");
    const Stale = await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
        recipientId: "c", inviterId: "d", buildId: "x", newPartyId: "fresh", now: "2026-10-13T12:08:00.000Z", maxPartySize: 4
    }, session));
    assert.equal(Stale, undefined, "the old invite is not a capability for the new party");
    assert.equal(await R.repos.parties.findByMember("c"), undefined);
    assert.deepEqual((await R.repos.parties.findById("party-of-d-2"))?.members, ["d"]);
});

test("party: leaving, kicking and promoting follow the leader rules; the last member disbands", async () => {
    const R = Realm("soc-party-lifecycle");
    const Join = async (inviter: string, recipient: string, now: string) => {
        await Invite(R, inviter, recipient, now);
        await R.uow.withTransaction((repos, session) => repos.parties.acceptInvite({
            recipientId: recipient, inviterId: inviter, buildId: "x", newPartyId: `unused-${recipient}`, now, maxPartySize: 4
        }, session));
    };
    await Join("a", "b", "2026-10-13T12:01:00.000Z");
    await Join("a", "c", "2026-10-13T12:02:00.000Z");

    const Do = <T>(fn: (repos: RepositoryProvider, session: Session) => Promise<T>) => R.uow.withTransaction(fn);

    await Do((r, s) => r.parties.kick("b", "c", "2026-10-13T12:03:00.000Z", s)); // not the leader
    await Do((r, s) => r.parties.kick("a", "a", "2026-10-13T12:03:00.000Z", s)); // not yourself
    await Do((r, s) => r.parties.kick("a", "zed", "2026-10-13T12:03:00.000Z", s)); // not a member
    assert.deepEqual((await R.repos.parties.findById("party-of-a"))?.members, ["a", "b", "c"]);

    await Do((r, s) => r.parties.kick("a", "c", "2026-10-13T12:04:00.000Z", s));
    assert.deepEqual((await R.repos.parties.findById("party-of-a"))?.members, ["a", "b"]);
    assert.equal(await R.repos.parties.findByMember("c"), undefined);

    await Do((r, s) => r.parties.promote("b", "a", "2026-10-13T12:05:00.000Z", s)); // not the leader
    await Do((r, s) => r.parties.promote("a", "a", "2026-10-13T12:05:00.000Z", s)); // already the leader
    await Do((r, s) => r.parties.promote("a", "b", "2026-10-13T12:05:00.000Z", s));
    assert.equal((await R.repos.parties.findById("party-of-a"))?.leaderPlayerId, "b");

    await Do((r, s) => r.parties.leave("b", "2026-10-13T12:06:00.000Z", s)); // the leader leaves: a takes over
    const Left = (await R.repos.parties.findById("party-of-a"))!;
    assert.deepEqual(Left.members, ["a"]);
    assert.equal(Left.leaderPlayerId, "a");
    await Do((r, s) => r.parties.leave("nobody", "2026-10-13T12:06:30.000Z", s));

    await Do((r, s) => r.parties.leave("a", "2026-10-13T12:07:00.000Z", s));
    assert.equal(await R.repos.parties.findById("party-of-a"), undefined, "the last member disbands the party");
    assert.equal(await R.repos.parties.findByMember("a"), undefined);

    const Events = await Drain(R);
    const Kinds = Events.map((Entry) => Entry.eventType);
    assert.equal(Kinds.filter((Kind) => Kind === "PARTY_LEADER_CHANGED").length, 1, "only the real promotion is announced");
    assert.equal(Kinds.filter((Kind) => Kind === "PARTY_MEMBERSHIP_CHANGED").length, 5, "2 joins + kick + a leave + the disband");
});

test("party: activity changes are revision-guarded, and a failed unit of work leaves neither the change nor its event", async () => {
    const R = Realm("soc-party-activity");
    const Solo = await R.uow.withTransaction((repos, session) => repos.parties.getOrCreateSolo(PartyInput("a"), session));
    await Drain(R);

    const Set = (revision: number, activity: "IDLE" | "IN_HUNT", hunt?: string) => R.uow.withTransaction((repos, session) => repos.parties.setActivity({
        partyId: Solo.partyId, expectedRevision: revision, activity, activeHuntSessionId: hunt, now: "2026-10-13T12:02:00.000Z"
    }, session));
    assert.equal(await Set(7, "IN_HUNT"), undefined, "stale revision");
    assert.equal(await R.uow.withTransaction((repos, session) => repos.parties.setActivity({
        partyId: "nope", expectedRevision: 1, activity: "IN_HUNT", now: Later
    }, session)), undefined);
    const Active = await Set(1, "IN_HUNT", "hunt-1");
    assert.equal(Active?.revision, 2);
    assert.equal(Active?.activity, "IN_HUNT");
    assert.equal((await R.repos.parties.findById(Solo.partyId))?.activeHuntSessionId, "hunt-1");

    await assert.rejects(R.uow.withTransaction(async (repos, session) => {
        await repos.parties.setActivity({ partyId: Solo.partyId, expectedRevision: 2, activity: "IDLE", now: Later }, session);
        await repos.parties.appendEvent({
            partyId: Solo.partyId, partyRevision: 3, eventType: "PARTY_PRESENCE_CHANGED", recipientAccountIds: ["a", "a"], payload: { p: 1 }, now: Later
        }, session);
        throw new Error("crash");
    }), /crash/);
    assert.equal((await R.repos.parties.findById(Solo.partyId))?.revision, 2);
    assert.deepEqual((await Drain(R)).map((Entry) => Entry.eventType), ["PARTY_ACTIVITY_CHANGED"], "no event for the rolled-back work");

    await R.repos.parties.appendEvent({
        partyId: Solo.partyId, partyRevision: 2, eventType: "PARTY_PRESENCE_CHANGED", recipientAccountIds: ["a", "a", "b"], payload: { p: 1 }, now: Later
    });
    assert.deepEqual((await Drain(R)).map((Entry) => Entry.recipients), [["a", "b"]], "recipients are de-duplicated");
});

test("party outbox: oldest first, claimed by one worker, released or reclaimed when stale, published once", async () => {
    const R = Realm("soc-party-outbox");
    for (let Index = 1; Index <= 3; Index++) {
        await R.repos.parties.appendEvent({
            partyId: "p", partyRevision: Index, eventType: "PARTY_PRESENCE_CHANGED", recipientAccountIds: ["a"], payload: { Index },
            now: `2026-10-13T12:0${Index}:00.000Z`
        });
    }
    const Claim = (owner: string, now: string, staleBefore: string) => R.repos.parties.claimNextOutbox(owner, now, staleBefore);

    const First = (await Claim("w1", "2026-10-13T12:10:00.000Z", "2026-10-13T12:00:00.000Z"))!;
    assert.equal(First.partyRevision, 1);
    assert.equal(First.state, "PROCESSING");
    assert.equal(First.claimOwner, "w1");
    const Second = (await Claim("w2", "2026-10-13T12:10:01.000Z", "2026-10-13T12:00:00.000Z"))!;
    assert.equal(Second.partyRevision, 2, "a claimed event is not handed out again");

    assert.equal(await R.repos.parties.markOutboxPublished(First.eventId, "w2", NOWISH), false, "only the claiming worker may publish");
    assert.equal(await R.repos.parties.markOutboxPublished(First.eventId, "w1", NOWISH), true);
    assert.equal(await R.repos.parties.markOutboxPublished(First.eventId, "w1", NOWISH), false, "published once");
    assert.equal(await R.repos.parties.markOutboxPublished("ghost", "w1", NOWISH), false);

    await R.repos.parties.releaseOutbox(Second.eventId, "w1"); // not the owner: nothing
    assert.equal((await Claim("w3", "2026-10-13T12:10:02.000Z", "2026-10-13T12:00:00.000Z"))?.partyRevision, 3);
    await R.repos.parties.releaseOutbox(Second.eventId, "w2");
    const Again = (await Claim("w4", "2026-10-13T12:10:03.000Z", "2026-10-13T12:00:00.000Z"))!;
    assert.equal(Again.eventId, Second.eventId, "a released event is available again, oldest first");
    assert.equal(Again.claimOwner, "w4");

    // Nothing left unclaimed; a stale claim (older than the cut-off) is taken over.
    assert.equal(await Claim("w5", "2026-10-13T12:10:04.000Z", "2026-10-13T12:00:00.000Z"), undefined);
    const Takeover = await Claim("w5", "2026-10-13T12:20:00.000Z", "2026-10-13T12:10:02.500Z");
    assert.equal(Takeover?.partyRevision, 3, "the claim at 12:10:02 is stale against a 12:10:02.5 cut-off; the older 12:10:03 one is not");
    assert.equal(Takeover?.claimOwner, "w5");
});

