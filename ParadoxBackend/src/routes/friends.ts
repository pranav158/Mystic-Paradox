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










export const friendsRouter = express.Router();


function ToEpicFriend(edge: FriendEdgeRecord) {
    return {
        accountId: edge.otherId,
        status: edge.status === "ACCEPTED" ? "ACCEPTED" : "PENDING",
        direction: edge.direction ?? "OUTBOUND",
        created: edge.created,
        favorite: edge.favorite ?? false
    };
}



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
        
        await Friendships.upsert({ ownerId: Owner, otherId: Friend, status: "ACCEPTED", created: Existing.created });
        await Friendships.upsert({ ownerId: Friend, otherId: Owner, status: "ACCEPTED", created: Now });
        logger.info(`${Owner} accepted friend invite from ${Friend}`);
        res.status(204).send();
        return;
    }

    
    await Friendships.upsert({ ownerId: Owner, otherId: Friend, status: "PENDING", direction: "OUTBOUND", created: Now });
    await Friendships.upsert({ ownerId: Friend, otherId: Owner, status: "PENDING", direction: "INBOUND", created: Now });
    logger.info(`${Owner} sent friend invite to ${Friend}`);
    res.status(204).send();
});


friendsRouter.delete("/friends/api/public/friends/:accountId/:friendId", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner: string = req.AuthData.userId;
    const Friend: string = req.params.friendId;

    const Friendships = GetRepositories().friendships;
    await Friendships.remove(Owner, Friend);
    await Friendships.remove(Friend, Owner);

    logger.info(`${Owner} removed/rejected friend ${Friend}`);
    res.status(204).send();
});


friendsRouter.get("/friends/api/public/blocklist/:accountId", (req, res) => {
    res.json([]);
});


friendsRouter.get("/friends/api/public/list/:namespace/:accountId/recentPlayers", (req, res) => {
    res.json([]);
});


friendsRouter.get("/friends/api/v1/:accountId/settings", (req, res) => {
    res.json({ acceptInvites: "public", mutualPrivacy: "ALL" });
});
