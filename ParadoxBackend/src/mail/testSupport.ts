/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] Test support for the code mail: a transport that records the messages instead of sending them (no network). A test
// reads the code the way a user would, from the text of the mail, so the code is never taken from the store.
import type { MailMessage, MailTransport } from "./mailSender";

export class RecordingMailTransport implements MailTransport {
    readonly sent: MailMessage[] = [];

    async send(message: MailMessage): Promise<void> {
        this.sent.push({ ...message });
    }

    /** The last message to the address, or undefined. */
    lastTo(to: string): MailMessage | undefined {
        for (let Index = this.sent.length - 1; Index >= 0; Index -= 1) {
            if (this.sent[Index]!.to === to) return this.sent[Index];
        }
        return undefined;
    }

    /** The 6-digit code in the last message to the address (the mail prints it alone on one line). */
    codeFor(to: string): string | undefined {
        const Found = /\n {4}(\d{6})\n/.exec(this.lastTo(to)?.text ?? "");
        return Found?.[1];
    }

    /** Waits until at least `count` messages are recorded: background sends finish after the response has gone out. */
    async waitForCount(count: number, timeoutMs = 2000): Promise<void> {
        const Deadline = Date.now() + timeoutMs;
        while (this.sent.length < count && Date.now() < Deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
}
