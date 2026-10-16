/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { TouchGameSession } from "../../activity/activityMonitor";
import { Request, RequestHandler, Response, Router } from "express";
import { logger } from "../../logger";
import { HasLauncherAuth } from "../../middleware/HasLauncherAuth";
import { RequireActiveAccount } from "../../middleware/RequireActiveAccount";
import { GetRequestId } from "../../observability/requestContext";
import {
    Parsed,
    ParseAccountIdParam,
    ParseBanBody,
    ParseCreateRealmBody,
    ParseHeartbeatBody,
    ParseInviteBody,
    ParseInviteCodeParam,
    ParseJoinBody,
    ParseKnownHostKeyQuery,
    ParseListQuery,
    ParseNameParam,
    ParseSettingsBody,
    ParseUsernameBody
} from "../realmInput";
import { LauncherApiError, SendLauncherError } from "../realmErrors";
import { RealmsService } from "../realmsService";

// [2026-10-13 realms S2] The realms directory API for the launcher, under /launcher/v1/realms. Every route needs a
// launcher sign-in (HasLauncherAuth). Reads are GET and every change is POST: the launcher's CORS preflight
// (routes/launcherAuth.ts) allows only GET, POST and OPTIONS. Success is the JSON object the service returns; a failure is
// the launcher error envelope {error:{code,message,requestId}} with the REALM_* codes of realmErrors.ts.
//
//   POST /launcher/v1/realms                                   claim a name         {name, hostPublicKey, joinPolicy?, listed?, version?} -> 201 {realm}
//   GET  /launcher/v1/realms/mine                               {hosted, memberOf[]}
//   GET  /launcher/v1/realms/listed?limit=&offset=              {realms[]}            (listed realms, online first)
//   GET  /launcher/v1/realms/by-name/:name?knownHostKey=        {realm}               (ownershipChanged when a key is sent)
//   GET  /launcher/v1/realms/invite/:code                       {realm}               (preview, uses nothing)
//   POST /launcher/v1/realms/join                               {name?, inviteCode?, knownHostKey?} -> {realm, joined}
//   POST /launcher/v1/realms/by-name/:name/leave                {left:true}
//   POST /launcher/v1/realms/mine/settings                      {joinPolicy?, listed?} -> {realm}
//   POST /launcher/v1/realms/mine/invites                       {maxUses?, expiresInHours?} -> 201 {invite}
//   GET  /launcher/v1/realms/mine/invites                       {invites[]}
//   POST /launcher/v1/realms/mine/invites/:code/revoke          {invite}
//   POST /launcher/v1/realms/mine/members/:accountId/kick       {accountId, status}
//   POST /launcher/v1/realms/mine/members/:accountId/ban        {reason?} -> {accountId, status, changed}
//   POST /launcher/v1/realms/mine/members/:accountId/unban      {accountId, status, changed}
//   POST /launcher/v1/realms/mine/heartbeat                     {online?, version?, hosting?: {maxServers, maxPlayers, afkSeconds?}} -> {online, lastOnlineAt, onlineUntil, ttlSeconds, version}
//   POST /launcher/v1/realms/mine/release                       {released:true}       (the host gives the realm up)
//   GET  /launcher/v1/realms/mine/requests                      {requests: [{accountId, displayName, at}]}  (newest first; [2026-10-15])
//   POST /launcher/v1/realms/mine/requests/:accountId/approve   {accountId, status: "APPROVED"}  (member added, request removed)
//   POST /launcher/v1/realms/mine/requests/:accountId/deny      {accountId, status: "DENIED"}    (request removed)
//   POST /launcher/v1/realms/mine/members/add                   {username} -> {accountId, displayName, added}  (legacy: launchers to 0.1.68)
//   POST /launcher/v1/realms/mine/player-invites                {username} -> 201 {accountId, displayName, status: INVITED|MEMBER}  ([2026-10-16])
//   POST /launcher/v1/realms/mine/player-invites/:accountId/cancel  {accountId, status: "CANCELLED"}
//   GET  /launcher/v1/realms/player-invites                     {invites: [{realm, at}]}   (the caller's unanswered invites, newest first)
//   POST /launcher/v1/realms/player-invites/:name/accept        {realm, joined: true}
//   POST /launcher/v1/realms/player-invites/:name/decline       {declined: true}
//   POST /launcher/v1/realms/presence/heartbeat                 {} -> {realm: {name, serving, hubReady, hostOnline} | null, expiresAt}  (every 30 s while the game runs)
//   POST /launcher/v1/realms/presence/leave                     {} -> {left:true}      (the game exited)
//   GET  /launcher/v1/realms/presence                           {realm: {...} | null, expiresAt}

const BASE = "/launcher/v1/realms";

export interface RealmsRouterDeps {
    service: RealmsService;
    /** Launcher authentication; tests substitute a stand-in. It must set req.LauncherAuthData.userId. */
    auth?: RequestHandler;
    /**
     * [2026-10-14] Account guards (middleware/RequireActiveAccount.ts): `hosting` on the routes that claim, run or change a realm (a
     * deactivated account, or one without the current consent when enforced); `active` on the routes that join a realm or keep its
     * presence (a deactivated account only). Tests substitute pass-through guards.
     */
    guards?: { hosting?: RequestHandler; active?: RequestHandler };
}

function Unwrap<T>(parsed: Parsed<T>): T {
    if (!parsed.ok) throw new LauncherApiError(parsed.code, parsed.message);
    return parsed.value;
}

function AccountIdOf(req: Request): string {
    const userId = (req as any).LauncherAuthData?.userId;
    if (typeof userId !== "string" || userId.length === 0) throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
    return userId;
}

async function Handle(res: Response, action: () => Promise<unknown>, successStatus = 200): Promise<void> {
    try {
        const result = await action();
        res.status(successStatus).json(result ?? {});
    } catch (error) {
        if (error instanceof LauncherApiError) {
            SendLauncherError(res, error);
            return;
        }
        logger.error(`Unhandled realms error requestId=${GetRequestId() ?? "missing"}: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "The realm request failed. Please try again."));
    }
}

export function CreateRealmsRouter(deps: RealmsRouterDeps): Router {
    const router = Router();
    const service = deps.service;

    // Scoped to this prefix only, so no other route of the app is touched by it.
    router.use(BASE, (_req, res, next) => {
        // Per-account answers; never cached by the WebView or a proxy.
        res.setHeader("Cache-Control", "no-store");
        next();
    });
    router.use(BASE, deps.auth ?? HasLauncherAuth);
    const hosting = deps.guards?.hosting ?? RequireActiveAccount({ consent: true });
    const active = deps.guards?.active ?? RequireActiveAccount({ consent: false });

    router.post(BASE, hosting, (req, res) =>
        Handle(res, async () => service.createRealm(AccountIdOf(req), Unwrap(ParseCreateRealmBody(req.body))), 201)
    );

    router.get(`${BASE}/mine`, (req, res) => Handle(res, async () => service.getMine(AccountIdOf(req))));

    router.get(`${BASE}/listed`, (req, res) =>
        Handle(res, async () => service.listListed(AccountIdOf(req), Unwrap(ParseListQuery(req.query))))
    );

    router.get(`${BASE}/by-name/:name`, (req, res) =>
        Handle(res, async () => service.getByName(
            AccountIdOf(req),
            Unwrap(ParseNameParam(req.params.name)),
            Unwrap(ParseKnownHostKeyQuery(req.query))
        ))
    );

    router.get(`${BASE}/invite/:code`, (req, res) =>
        Handle(res, async () => service.previewInvite(AccountIdOf(req), Unwrap(ParseInviteCodeParam(req.params.code))))
    );

    router.post(`${BASE}/join`, active, (req, res) =>
        Handle(res, async () => service.join(AccountIdOf(req), Unwrap(ParseJoinBody(req.body))))
    );

    router.post(`${BASE}/by-name/:name/leave`, (req, res) =>
        Handle(res, async () => service.leave(AccountIdOf(req), Unwrap(ParseNameParam(req.params.name))))
    );

    router.post(`${BASE}/mine/settings`, hosting, (req, res) =>
        Handle(res, async () => service.updateSettings(AccountIdOf(req), Unwrap(ParseSettingsBody(req.body))))
    );

    router.post(`${BASE}/mine/invites`, hosting, (req, res) =>
        Handle(res, async () => service.createInvite(AccountIdOf(req), Unwrap(ParseInviteBody(req.body))), 201)
    );

    router.get(`${BASE}/mine/invites`, (req, res) => Handle(res, async () => service.listInvites(AccountIdOf(req))));

    router.post(`${BASE}/mine/invites/:code/revoke`, hosting, (req, res) =>
        Handle(res, async () => service.revokeInvite(AccountIdOf(req), Unwrap(ParseInviteCodeParam(req.params.code))))
    );

    router.post(`${BASE}/mine/members/:accountId/kick`, hosting, (req, res) =>
        Handle(res, async () => service.kick(AccountIdOf(req), MemberParam(req)))
    );

    router.post(`${BASE}/mine/members/:accountId/ban`, hosting, (req, res) =>
        Handle(res, async () => {
            const { reason } = Unwrap(ParseBanBody(req.body));
            return service.ban(AccountIdOf(req), MemberParam(req), reason);
        })
    );

    router.post(`${BASE}/mine/members/:accountId/unban`, hosting, (req, res) =>
        Handle(res, async () => service.unban(AccountIdOf(req), MemberParam(req)))
    );

    router.post(`${BASE}/mine/heartbeat`, hosting, (req, res) =>
        Handle(res, async () => service.heartbeat(AccountIdOf(req), Unwrap(ParseHeartbeatBody(req.body))))
    );

    router.post(`${BASE}/mine/release`, hosting, (req, res) => Handle(res, async () => service.release(AccountIdOf(req))));

    // [2026-10-15] Join requests and adding players by username: the host's side, like kick and ban.
    router.get(`${BASE}/mine/requests`, (req, res) => Handle(res, async () => service.listJoinRequests(AccountIdOf(req))));

    router.post(`${BASE}/mine/requests/:accountId/approve`, hosting, (req, res) =>
        Handle(res, async () => service.approveJoinRequest(AccountIdOf(req), MemberParam(req)))
    );

    router.post(`${BASE}/mine/requests/:accountId/deny`, hosting, (req, res) =>
        Handle(res, async () => service.denyJoinRequest(AccountIdOf(req), MemberParam(req)))
    );

    router.post(`${BASE}/mine/members/add`, hosting, (req, res) =>
        Handle(res, async () => service.addMemberByUsername(AccountIdOf(req), Unwrap(ParseUsernameBody(req.body)).username))
    );

    // [2026-10-16] Player invites: the host invites by username; the player sees the invite and accepts or declines it.
    router.post(`${BASE}/mine/player-invites`, hosting, (req, res) =>
        Handle(res, async () => service.invitePlayerByUsername(AccountIdOf(req), Unwrap(ParseUsernameBody(req.body)).username), 201)
    );

    router.post(`${BASE}/mine/player-invites/:accountId/cancel`, hosting, (req, res) =>
        Handle(res, async () => service.cancelPlayerInvite(AccountIdOf(req), MemberParam(req)))
    );

    router.get(`${BASE}/player-invites`, (req, res) => Handle(res, async () => service.listMyPlayerInvites(AccountIdOf(req))));

    router.post(`${BASE}/player-invites/:name/accept`, active, (req, res) =>
        Handle(res, async () => service.acceptPlayerInvite(AccountIdOf(req), Unwrap(ParseNameParam(req.params.name))))
    );

    router.post(`${BASE}/player-invites/:name/decline`, (req, res) =>
        Handle(res, async () => service.declinePlayerInvite(AccountIdOf(req), Unwrap(ParseNameParam(req.params.name))))
    );

    // [2026-10-13 hub design section 2.2] The member's realm context: kept alive by the launcher, cleared when the game exits.
    router.post(`${BASE}/presence/heartbeat`, active, (req, res) => Handle(res, async () => {
        // [2026-10-14] The realm presence heartbeat (every 30 s while the game runs) extends the activity monitor's playtime.
        TouchGameSession(AccountIdOf(req));
        return service.presenceHeartbeat(AccountIdOf(req));
    }));

    router.post(`${BASE}/presence/leave`, (req, res) => Handle(res, async () => service.presenceLeave(AccountIdOf(req))));

    router.get(`${BASE}/presence`, (req, res) => Handle(res, async () => service.presenceStatus(AccountIdOf(req))));

    // Anything else under the prefix is unknown here: answer in the launcher envelope instead of falling through
    // to the app's empty 404 (the caller is already authenticated at this point).
    router.use(BASE, (_req, res) => {
        SendLauncherError(res, new LauncherApiError("NOT_FOUND", "Unknown realms route."));
    });

    return router;
}

function MemberParam(req: Request): string {
    const accountId = ParseAccountIdParam(req.params.accountId);
    if (accountId === undefined) throw new LauncherApiError("REALM_VALIDATION_FAILED", "That is not an account id.");
    return accountId;
}
