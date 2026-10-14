/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import express from "express";
import { logger } from "../logger";
import { GetRepositories, FriendEdgeRecord } from "../persistence";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";

// Epic MCP "friends-public-service" endpoints. The in-process DLL redirect rewrites
// friends-public-service-*.ol.epicgames.com to paradox.mysticfox.dev/__origin/<host>/...,
// and app.ts strips the prefix, leaving these /friends/api/... paths.
//
// Backed by the Mongo friendship graph (FriendshipRepository): friend list + send/accept/
// reject/remove invites. Invite-by-name resolves a display name to an accountId via the
// account service (routes/eos.ts GET /account/api/public/account/displayName/:name).
// Blocklist/recentPlayers/settings remain benign stubs. See
// Plans/MULTIPLAYER_AUTH_SOCIAL_LAUNCHER_PLAN.md.
export const friendsRouter = express.Router();

// Map an internal directed edge to Epic's friends-list entry shape.
function ToEpicFriend(edge: FriendEdgeRecord) {
    return {
        accountId: edge.otherId,
        status: edge.status === "ACCEPTED" ? "ACCEPTED" : "PENDING",
        direction: edge.direction ?? "OUTBOUND",
        created: edge.created,
        favorite: edge.favorite ?? false
    };
}

// Friends list. ?includePending=true also returns pending invites (both directions),
// which is how the client separates "friends" from "incoming/outgoing invites".
friendsRouter.get("/friends/api/public/friends/:accountId", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner: string = req.AuthData.userId;
    const IncludePending = String(req.query.includePending ?? "") === "true";

    const Edges = await GetRepositories().friendships.listForOwner(Owner);
    const Friends = Edges
        .filter((e) => e.status === "ACCEPTED" || (IncludePending && e.status === "PENDING"))
        .map(ToEpicFriend);

    logger.info(`Friends list for ${Owner}: ${Friends.length} (includePending=${IncludePending})`);
    res.json(Friends);
});

// Send a friend invite, or accept one already pending from :friendId. Epic uses POST for both.
friendsRouter.post("/friends/api/public/friends/:accountId/:friendId", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner: string = req.AuthData.userId;
    const Friend: string = req.params.friendId;

    if (!Friend || Friend === Owner) {
        res.status(400).send();
        return;
    }

    const Friendships = GetRepositories().friendships;
    const Existing = await Friendships.find(Owner, Friend);
    const Now = new Date().toISOString();

    if (Existing?.status === "ACCEPTED") {
        res.status(204).send();
        return;
    }

    if (Existing?.status === "PENDING" && Existing.direction === "INBOUND") {
        // They already invited us — accept: both edges become ACCEPTED.
        await Friendships.upsert({ ownerId: Owner, otherId: Friend, status: "ACCEPTED", created: Existing.created });
        await Friendships.upsert({ ownerId: Friend, otherId: Owner, status: "ACCEPTED", created: Now });
        logger.info(`${Owner} accepted friend invite from ${Friend}`);
        res.status(204).send();
        return;
    }

    // New/outbound invite: OUTBOUND edge on us, INBOUND edge on them.
    await Friendships.upsert({ ownerId: Owner, otherId: Friend, status: "PENDING", direction: "OUTBOUND", created: Now });
    await Friendships.upsert({ ownerId: Friend, otherId: Owner, status: "PENDING", direction: "INBOUND", created: Now });
    logger.info(`${Owner} sent friend invite to ${Friend}`);
    res.status(204).send();
});

// Reject a pending invite, or remove an existing friend — drops both directed edges.
friendsRouter.delete("/friends/api/public/friends/:accountId/:friendId", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner: string = req.AuthData.userId;
    const Friend: string = req.params.friendId;

    const Friendships = GetRepositories().friendships;
    await Friendships.remove(Owner, Friend);
    await Friendships.remove(Friend, Owner);

    logger.info(`${Owner} removed/rejected friend ${Friend}`);
    res.status(204).send();
});

// Blocklist — no blocked players yet (blocking is a later addition).
friendsRouter.get("/friends/api/public/blocklist/:accountId", (req, res) => {
    res.json([]);
});

// Recent players — none.
friendsRouter.get("/friends/api/public/list/:namespace/:accountId/recentPlayers", (req, res) => {
    res.json([]);
});

// Friend settings — sane public defaults so the social panel renders.
friendsRouter.get("/friends/api/v1/:accountId/settings", (req, res) => {
    res.json({ acceptInvites: "public", mutualPrivacy: "ALL" });
});

// [2026-10-15] Slayer Link (social-prod, DauntlessEndpointDocumentation/Social/SlayerLink). No link or invite is stored by this
// backend, so the status is empty and no friend has a free slot: the shapes are the captured ones, the content is the truth. The
// invite route (PUT /slayerlink/invite) is not answered here.
export const SLAYER_LINK_MAX_ACCOUNTS = 256;
const SLAYER_LINK_MAX_ID_LENGTH = 128;

/** POST /slayerlink/availability: every well-formed requested account, not available (no link can be made). */
export function SlayerLinkAvailabilityPayload(body: unknown): { availability: { account_id: string; available: boolean }[] } {
    const Requested: unknown[] = Array.isArray((body as { account_ids?: unknown } | null)?.account_ids)
        ? (body as { account_ids: unknown[] }).account_ids : [];
    const Ids = Requested
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= SLAYER_LINK_MAX_ID_LENGTH)
        .slice(0, SLAYER_LINK_MAX_ACCOUNTS);
    return { availability: Ids.map((accountId) => ({ account_id: accountId, available: false })) };
}

/** GET /slayerlink/status_good: the captured config, no invites and no links. */
export function SlayerLinkStatusPayload(): { config: { invite_expiry_hours: number; link_duration_hours: number }; invites: unknown[]; links: unknown[] } {
    return { config: { invite_expiry_hours: 48, link_duration_hours: 168 }, invites: [], links: [] };
}

friendsRouter.post("/slayerlink/availability", HasParadoxBackendAuth, (req, res) => {
    res.status(200).json({ code: null, message: "OK", payload: SlayerLinkAvailabilityPayload(req.body) });
});

friendsRouter.get("/slayerlink/status_good", HasParadoxBackendAuth, (req, res) => {
    res.status(200).json({ code: null, message: "OK", payload: SlayerLinkStatusPayload() });
});
