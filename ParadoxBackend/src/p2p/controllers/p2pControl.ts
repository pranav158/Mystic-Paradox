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

    const deadline = Date.now() + waitMs;
    do {
        const messages = await GetP2PRepositories().p2pHunts.listControlMessages(
            accountId,
            afterSequence,
            new Date().toISOString(),
            MAX_MESSAGES
        );
        if (messages.length > 0) return { messages };
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
