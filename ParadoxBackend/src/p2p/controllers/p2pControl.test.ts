import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { InMemoryP2PHuntRepository } from "../persistence/memory/InMemoryP2PHuntRepository";
import { AcknowledgeP2PControl, PollP2PControl } from "./p2pControl";

// [2026-10-16] The control channel when a launcher's cursor belongs to another account: launchers up to 0.1.72 keep one cursor per PC,
// so a new account on a PC that served another one polled "after 103" while its own JOIN_RENDEZVOUS was sequence 1 (16 Oct 06:10 UTC,
// the realm entry expired). Such a poll is answered from the start with the messages not acknowledged yet; normal cursors are unchanged.

afterEach(() => UseP2PPersistenceForTest(undefined));

function Repository(): InMemoryP2PHuntRepository {
    const Hunts = new InMemoryP2PHuntRepository();
    UseP2PPersistenceForTest({ p2pHunts: Hunts } as unknown as P2PRepositoryProvider);
    return Hunts;
}

function Enqueue(hunts: InMemoryP2PHuntRepository, accountId: string, messageType = "JOIN_RENDEZVOUS") {
    const now = Date.now();
    return hunts.enqueueControlMessage({
        accountId, messageType: messageType as any, sessionId: "87f6c5d7-fc8c-41b9-8837-5aeac1bd462d", generation: 1,
        payload: { role: "JOINER" }, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString()
    });
}

test("[2026-10-16] a cursor beyond the account's last message is answered from the start, with unacknowledged messages only", async () => {
    const Hunts = Repository();
    const Rendezvous = await Enqueue(Hunts, "new-account");
    assert.equal(Rendezvous.sequence, 1);

    // The other account's cursor (103) would have missed sequence 1; it is delivered, flagged.
    const First = await PollP2PControl("new-account", 103, 0) as any;
    assert.deepEqual(First.messages.map((message: any) => message.sequence), [1]);
    assert.equal(First.staleCursor, true);

    // Once acknowledged it is not delivered again, although the launcher keeps polling with its old cursor.
    await AcknowledgeP2PControl("new-account", Rendezvous.messageId);
    assert.deepEqual((await PollP2PControl("new-account", 103, 0) as any).messages, []);

    // The next message still arrives through the stale cursor.
    await Enqueue(Hunts, "new-account", "FENCE_NOW");
    assert.deepEqual((await PollP2PControl("new-account", 103, 0) as any).messages.map((message: any) => message.sequence), [2]);
});

test("[2026-10-16] a normal cursor is unchanged: messages after it, acknowledged or not, and no stale flag", async () => {
    const Hunts = Repository();
    for (let index = 0; index < 4; index++) await Enqueue(Hunts, "host");
    const Answer = await PollP2PControl("host", 2, 0) as any;
    assert.deepEqual(Answer.messages.map((message: any) => message.sequence), [3, 4]);
    assert.equal(Answer.staleCursor, undefined);
    // A cursor equal to the last message is up to date, not stale.
    assert.deepEqual((await PollP2PControl("host", 4, 0) as any).messages, []);
    // Cursor 0 on an account with no messages is a fresh launcher.
    assert.deepEqual((await PollP2PControl("nobody", 0, 0) as any).messages, []);
    assert.equal(await Hunts.latestControlSequence("host"), 4);
    assert.equal(await Hunts.latestControlSequence("nobody"), 0);
});
