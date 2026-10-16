import assert from "node:assert/strict";
import test from "node:test";
import { ParseSettingsBody } from "./realmInput";
import { DecideJoin } from "./realmRules";
import { Rejects, SetupRealms, T0 } from "./realmsTestKit";

// [2026-10-16] SOLO join policy (the host realm page's "Solo mode"): only the host enters. Members, invites and join requests wait
// until the host picks another policy; others see the realm as not serving and the directory does not list it for them.

test("[2026-10-16] DecideJoin: in a SOLO realm only the host is let in; a ban still comes first; other policies are unchanged", () => {
    const realm = { realmId: "realm-1", hostAccountId: "host-1", joinPolicy: "SOLO" as const,
        members: [{ accountId: "host-1", role: "HOST" }, { accountId: "friend-1", role: "MEMBER" }] as any, bans: [] as any[] };
    assert.deepEqual(DecideJoin(realm, "host-1", undefined, T0), { allow: true, via: "MEMBER" });
    assert.deepEqual(DecideJoin(realm, "friend-1", undefined, T0), { allow: false, reason: "SOLO" }, "a member waits too");
    assert.deepEqual(DecideJoin(realm, "stranger", undefined, T0), { allow: false, reason: "SOLO" });
    assert.deepEqual(DecideJoin({ ...realm, bans: [{ accountId: "friend-1", at: new Date(T0).toISOString() }] }, "friend-1", undefined, T0), { allow: false, reason: "BANNED" });
    assert.deepEqual(DecideJoin({ ...realm, joinPolicy: "PUBLIC" }, "stranger", undefined, T0), { allow: true, via: "PUBLIC" });
});

test("[2026-10-16] the settings route takes SOLO, INVITE_ONLY and PUBLIC, and nothing else", () => {
    for (const joinPolicy of ["SOLO", "INVITE_ONLY", "PUBLIC"]) {
        assert.deepEqual(ParseSettingsBody({ joinPolicy }), { ok: true, value: { joinPolicy } });
    }
    assert.equal(ParseSettingsBody({ joinPolicy: "PRIVATE" }).ok, false);
});

test("[2026-10-16] a SOLO realm: Play, joins and requests from others are refused REALM_SOLO and nothing is stored; the host plays", async () => {
    const { repo, service, create, serve } = SetupRealms();
    const realm = await create("host-1", "friends", { joinPolicy: "PUBLIC" });
    await serve("host-1", realm.realmId);
    // friend-1 joins while the realm is public, then the host switches to solo mode.
    assert.equal((await service.join("friend-1", { name: "friends" })).joined, true);
    await service.updateSettings("host-1", { joinPolicy: "SOLO" });

    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: false, code: "REALM_SOLO" }, "a member waits");
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends" }), { ok: false, code: "REALM_SOLO" });
    await Rejects(service.join("friend-2", { name: "friends" }), "REALM_SOLO");
    assert.equal((await repo.findById(realm.realmId))!.joinRequests, undefined, "no join request is stored");
    assert.deepEqual(await service.authorizeEntry("host-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: true });

    // Others see it as not serving (older launchers show it offline); the host sees its own realm as it is.
    const seenByFriend = (await service.getByName("friend-1", "friends")).realm;
    assert.equal(seenByFriend.joinPolicy, "SOLO");
    assert.equal(seenByFriend.serving, false);
    assert.equal(seenByFriend.online, true);
    assert.equal((await service.getByName("host-1", "friends")).realm.serving, true);

    // Back to invite-only: the member plays again; a stranger is asked to request, as before.
    await service.updateSettings("host-1", { joinPolicy: "INVITE_ONLY" });
    assert.deepEqual(await service.authorizeEntry("friend-1", { name: "friends" }), { ok: true, realmId: realm.realmId, isHost: false });
    assert.deepEqual(await service.authorizeEntry("friend-2", { name: "friends" }), { ok: false, code: "REALM_JOIN_REQUESTED" });
});

test("[2026-10-16] the public directory does not list a SOLO realm to others; its host still sees it", async () => {
    const { service, create } = SetupRealms();
    await create("host-1", "friends", { joinPolicy: "PUBLIC", listed: true });
    await create("host-2", "others", { joinPolicy: "PUBLIC", listed: true });
    await service.updateSettings("host-1", { joinPolicy: "SOLO" });
    const names = async (viewer: string) => (await service.listListed(viewer, { limit: 20, offset: 0 })).realms.map((realm) => realm.name).sort();
    assert.deepEqual(await names("friend-1"), ["others"]);
    assert.deepEqual(await names("host-1"), ["friends", "others"]);
});
