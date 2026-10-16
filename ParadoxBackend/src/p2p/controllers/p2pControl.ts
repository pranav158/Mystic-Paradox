import { GetP2PRepositories } from "../persistence";
import { LauncherApiError } from "../security/p2pErrors";

const MAX_WAIT_MS = 25_000;
const POLL_MS = 250;
const MAX_MESSAGES = 32;

function Delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function PollP2PControl(accountId: string, afterSequenceValue: unknown, waitMsValue: unknown) {
    const afterSequence = Number(afterSequenceValue ?? 0);
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMsValue ?? MAX_WAIT_MS)));
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isFinite(waitMs)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The control cursor is invalid.");
    }

    // [2026-10-16] A cursor beyond the account's last message belongs to another account: launchers up to 0.1.72 keep one cursor per
    // PC, so a new account on a PC that served another one asked for "after 103" while its own JOIN_RENDEZVOUS was sequence 1, and its
    // realm entry expired (16 Oct 06:10-06:11 UTC, REALM_ENTRY_EXPIRED). Such a poll is answered from the start with the messages not
    // acknowledged yet (a launcher acknowledges each message before it handles it), so each is still delivered once.
    const repos = GetP2PRepositories().p2pHunts;
    const staleCursor = afterSequence > 0 && afterSequence > await repos.latestControlSequence(accountId);
    const deadline = Date.now() + waitMs;
    do {
        const messages = await repos.listControlMessages(
            accountId,
            staleCursor ? 0 : afterSequence,
            new Date().toISOString(),
            MAX_MESSAGES,
            staleCursor ? { unacknowledgedOnly: true } : undefined
        );
        if (messages.length > 0) return staleCursor ? { messages, staleCursor: true } : { messages };
        if (Date.now() >= deadline) break;
        await Delay(Math.min(POLL_MS, deadline - Date.now()));
    } while (Date.now() <= deadline);
    return { messages: [] };
}

export async function AcknowledgeP2PControl(accountId: string, messageId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The control message ID is invalid.");
    }
    const acknowledged = await GetP2PRepositories().p2pHunts.acknowledgeControlMessage(
        accountId,
        messageId,
        new Date().toISOString()
    );
    if (!acknowledged) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Control message not found.");
    return { acknowledged: true, messageId };
}
