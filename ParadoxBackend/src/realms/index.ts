/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { Express } from "express";
import { logger } from "../logger";
import { CreateRealmsRouter } from "./routes/realmsLauncher";
import { IsRealmsModuleEnabled } from "./realmsConfig";
import { GetRealmsService, StartRealmsSweeper } from "./realmsInstance";

// [2026-10-13 realms S2] Paradox realms directory: a player hosts game servers on their own PC for friends, through our
// backend and Paradox accounts (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md). Self-contained: app.ts calls MountRealmsModule, the
// game-session and login routes call the two entry functions, and the p2p module imports the accessors below; nothing else of
// the app imports this folder. MYSTICPARADOX_REALMS_MODULE=on|true|1 turns it on; the default is off.
// [2026-10-13 hub design section 2] Entry authorization, presence, host hosting state, the sweeper and the event sink.

export { EnsureRealmsDatabase } from "./persistence/mongo/indexes";
export { IsRealmsModuleEnabled } from "./realmsConfig";
export {
    GetRealmsService,
    SetRealmEventSink,
    StartRealmsSweeper,
    StopRealmsSweeper,
    IsRealmsSweeperRunning,
    REALM_SWEEP_INTERVAL_MS
} from "./realmsInstance";
export { AuthorizeGameSessionRealm, BindRealmPresenceAtLogin } from "./entry";
export { HubRoomId, IsRealmHubReady, IsRealmOnline, IsRealmServing, PRESENCE_TTL_MS } from "./realmRules";
export type { EntryAuthorization, PresenceView, RealmHostView, RealmPublicInfo, RealmsService } from "./realmsService";
export type { RealmEntryErrorCode } from "./realmErrors";
export type {
    RealmBan,
    RealmEvent,
    RealmHosting,
    RealmHostingPatch,
    RealmHubKind,
    RealmHubState,
    RealmMember,
    RealmPresence,
    RealmRecord
} from "./realmTypes";

/**
 * Mounts /launcher/v1/realms when the module is switched on and starts the 15 s sweeper that reports hosts whose online state
 * lapsed; returns whether it did.
 */
export function MountRealmsModule(app: Express, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!IsRealmsModuleEnabled(env)) return false;
    app.use("/", CreateRealmsRouter({ service: GetRealmsService() }));
    StartRealmsSweeper();
    logger.info("[Realms] module on: /launcher/v1/realms mounted");
    return true;
}
