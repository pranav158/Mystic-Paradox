/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * [2026-10-10 1.14.7] Hunt UDP port pool with an owner per held port.
 *
 * The old pool was a plain array with LIFO pop() and "!FreePorts.includes(Port)" guards. That guard cannot
 * tell "already free" from "now held by a different hunt", so a late release from an old owner freed a port
 * a new hunt was using, and the next hunt got the same port:
 *   - readiness timeout: the catch pushed P and called the asynchronous Child.kill(); the next hunt popped P;
 *     the old child's exit event then pushed P again;
 *   - stale watchdog snapshot: the pass awaited a hub restart (up to 30 s) and then released a port that had
 *     been freed and re-taken meanwhile (the CleanupServer push had no guard at all).
 *
 * Rules:
 *   take(owner)            oldest free port first (FIFO), so a just-freed port is reused last
 *   release(port, owner)   frees only when the caller still owns the port; otherwise false, nothing changes
 *                          (idempotent; refuses stale releases)
 *   attachPid(...)         records the child pid once it is spawned
 *   reclaim(...)           frees leases whose owner is no longer a listed gameserver and whose process is
 *                          gone - the fallback when the exit event never arrives
 * Pure: no logger, env or game-data imports, so its tests run in the public CI.
 */

type Lease = { owner: string; pid?: number };

export class PortPool {
    private readonly free: number[] = [];
    private readonly held = new Map<number, Lease>();

    // Ignores a port that is already free or held.
    add(port: number): void {
        if (!this.held.has(port) && !this.free.includes(port)) this.free.push(port);
    }

    take(owner: string, pid?: number): number | undefined {
        const port = this.free.shift();
        if (port !== undefined) this.held.set(port, { owner, pid });
        return port;
    }

    attachPid(port: number, owner: string, pid: number | undefined): boolean {
        const lease = this.held.get(port);
        if (!lease || lease.owner !== owner) return false;
        lease.pid = pid;
        return true;
    }

    release(port: number, owner: string): boolean {
        if (this.held.get(port)?.owner !== owner) return false;
        this.held.delete(port);
        this.free.push(port);
        return true;
    }

    // Releases every lease whose owner is not live and whose process is gone (or never had a pid). A lease
    // with a live pid stays held even when its owner is unlisted: that process may still own the socket
    // (a timed-out hunt that is still being killed).
    reclaim(isOwnerLive: (owner: string) => boolean, isPidAlive: (pid: number) => boolean): Array<{ port: number; owner: string; pid?: number }> {
        const reclaimed: Array<{ port: number; owner: string; pid?: number }> = [];
        for (const [port, lease] of [...this.held]) {
            if (isOwnerLive(lease.owner)) continue;
            if (lease.pid !== undefined && isPidAlive(lease.pid)) continue;
            if (this.release(port, lease.owner)) reclaimed.push({ port, owner: lease.owner, pid: lease.pid });
        }
        return reclaimed;
    }

    ownerOf(port: number): string | undefined {
        return this.held.get(port)?.owner;
    }

    pidOf(port: number): number | undefined {
        return this.held.get(port)?.pid;
    }

    get freeCount(): number {
        return this.free.length;
    }

    get heldCount(): number {
        return this.held.size;
    }
}
