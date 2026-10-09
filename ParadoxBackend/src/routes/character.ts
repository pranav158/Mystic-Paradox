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

import { Router } from "express";
import { logger } from "../logger";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { CreateCharacterForUid, GetCharactersForUid, GetCharacterWithUid, UpdateCharacterForUid } from "../controllers/character";
import express from "express";

export const characterRouter = Router();

// [1.12.0] "INVALID" is UE4/Phoenix's own sentinel for "no logged-in player" (e.g. a standalone
// gameserver with no client connected yet). It is NOT a real account - never auto-create,
// never persist, never write for it. Only the exact literal sentinel is special-cased here;
// any other unresolved/missing id still falls through to normal (loud) error handling.
const NO_PLAYER_SENTINEL = "INVALID";

function IsNoPlayerSentinel(UserId: unknown): boolean {
    return UserId === undefined || UserId === NO_PLAYER_SENTINEL;
}

// [1.14.7 2026-10-03] The character "data" blob stores several fields as DOUBLE-ENCODED JSON
// strings (RecentPlayers, AppearanceData, CharacterFlagData, SERIE_*). Capturing the bodies actually
// served to the hub showed "data":{"RecentPlayers":"{\"RecentPlayers\":[…]}" - a string where the
// 1.14.7 client reads an object - which is what it reports as
//   [LogJson][Error] Json Value of type 'String' used as a 'Object'.
// (three occurrences at tick 2, matching the three character fetches in that second).
// Decode that one field into the object the client expects; the other double-encoded fields are left
// alone because there is no evidence they are read as objects.
// GAMESERVER_CHARACTER_DECODE_RECENTPLAYERS=0 reverts to the raw stored blob.
// The 1.14.7 SDK types these three members as STRUCTS, not strings:
//   FArchonAppearanceData  AppearanceData   (Archon_structs.hpp:10861, used at 12218)
//   FCharacterFlagData     CharacterFlagData (Archon_structs.hpp:11963)
//   and the RecentPlayers blob (which the 1.14.7 client also reads as an object)
// while our stored character "data" holds each of them as a JSON-encoded STRING (the shape the 1.12
// client accepted). Decoding all three is what removes the three
// "Json Value of type 'String' used as a 'Object'" errors - one per field, one per character fetch.
// MEASURED (round 19): decoding all three made the load WORSE - LoadFailed went from 0 back to 1 and
// the String-as-Object count rose from 3 to 4 - so AppearanceData and CharacterFlagData must keep the
// 1.12 STRING shape even though the SDK types them as structs. Only RecentPlayers is decoded, which
// is the configuration measured with LoadFailed = 0 and LeavingMap = 0. Add a field here only with a
// fresh measurement that shows an improvement.
const NESTED_JSON_FIELDS = ["RecentPlayers"];

// One-shot guard so the effective /character shape is stated once per process (see the handler).
let EffectiveCharacterShapeLogged = false;

function DecodeNestedJsonFieldsInCharacterData(Data: unknown): unknown {
    // Default OFF: measured in round 19, decoding RecentPlayers changed the served body but did NOT
    // change the client's error count (3 with and without), and decoding all three fields made it
    // worse (4 errors, LoadFailed 0->1). The documented 1.12 string shape is therefore kept as the
    // default; set GAMESERVER_CHARACTER_DECODE_NESTED=1 to try the decoded shape again.
    if ((process.env.GAMESERVER_CHARACTER_DECODE_NESTED ?? "0") === "0") return Data;
    if (typeof Data !== "string") return Data;
    try {
        const Parsed = JSON.parse(Data);
        if (!Parsed || typeof Parsed !== "object") return Data;
        for (const Field of NESTED_JSON_FIELDS) {
            const Value = (Parsed as any)[Field];
            if (typeof Value === "string") {
                try { (Parsed as any)[Field] = JSON.parse(Value); } catch { /* leave as-is */ }
            }
        }
        return JSON.stringify(Parsed);
    } catch {
        return Data;
    }
}

characterRouter.get("/character", HasParadoxBackendAuth, async (req: any, res) => {
    // [1.14.7 2026-10-03] A dedicated hub asks for the character with the gameserver API key and
    // NO player bearer token, so AuthData.userId is undefined and this route answered with an empty
    // list. The client then had no characterId, so its inventory POST was rejected with
    // "characterId must be a non-empty string" (400), it logged "Failed to retrieve player
    // inventory attempting to return to main menu", raised
    // "Disconnect Error Message: Failed to retrieve your character's inventory." and the hub left
    // the map (LeavingMap -> "LoadMap: failed to Listen"). Resolve the gameserver's no-player
    // requests to the configured single-account identity instead - the same account the auth
    // middleware already substitutes for path-based INVALID - which auto-creates the character if
    // the account has none. Player requests (bearer present) are untouched.
    // [1.14.7 CORRECTION 2026-10-04] Capture the VERIFIED no-player identity BEFORE it is resolved away.
    //
    // The previous gate tested only req.AuthData.IsGameserver, which is NOT proof of a phantom request: a
    // gameserver-keyed call can still carry a real player's bearer token, and such a request must keep its
    // real account and character ids. The identity is the proof - the request arrived with no player at all
    // (undefined userId, or the literal "INVALID" sentinel UE uses for "no logged-in player").
    const IsNoPlayerIdentity = IsNoPlayerSentinel(req.AuthData.userId);

    let UserId = req.AuthData.userId;
    if(IsNoPlayerSentinel(UserId) && req.AuthData?.IsGameserver){
        const NoPlayerUserId = (process.env.GAMESERVER_NO_PLAYER_USER_ID ?? process.env.DEV_USER_ID ?? "").trim();
        if(NoPlayerUserId.length > 0){
            UserId = NoPlayerUserId;
            logger.info(`GET /character: gameserver no-player request resolved to '${NoPlayerUserId}'`);
        }
    }

    if(IsNoPlayerSentinel(UserId)){
        logger.debug(`GET /character called with no-player sentinel (userId=${UserId}) - returning empty character list, not touching DB`);

        res.status(200);
        res.json([]);
        return;
    }

    const CharactersForUid = await GetCharactersForUid(UserId);

    logger.info(`Retrieved ${CharactersForUid.length} characters for ${UserId}`);

    // [1.14.7 EXPERIMENT 2026-10-03] The parser compares each returned character's "id" against the
    // id the client already holds (FUN_140dee610: local_108/local_100 = the returned id's Data/Num,
    // param_1[5]/param_1[6] = the client's own id Data/Num; a length mismatch fails immediately).
    // The hub's phantom player holds NO character id, so a non-empty list can never match and the
    // client logs "Failed To Parse All Required Fields" for every element. The parser's sibling
    // messages ("Parse Succeeded with Character Data" / "Parse Succeeded with NULL") imply an empty
    // list is the expected answer for a client without a character id. Gated so the previous
    // behaviour can be restored: GAMESERVER_CHARACTER_EMPTY_LIST=1 returns [].
    // [1.14.7 EXPERIMENT 2026-10-03] Parser branch decoded exactly: with the client's own id empty
    // (param_1[6] == 0), a returned id of length 0 takes the "0 == 0 -> 1 < 0 false -> fall through"
    // path and passes, while a length-38 UUID fails ("38 != 0" then "38 + 0 == 1" false). So a
    // character whose "id" is EMPTY satisfies the parser AND still carries the character data the
    // player-data load needs. GAMESERVER_CHARACTER_EMPTY_ID=1 selects that shape.
    // [1.14.7 PROBE 2026-10-03] The client logs "Json Value of type 'String' used as a 'Object'"
    // three times at tick 2 while loading player data. Our character wire object carries "data" as a
    // JSON-ENCODED STRING (the 1.12 shape). If 1.14.7 instead reads that field as an object, that is
    // exactly this error. GAMESERVER_CHARACTER_DATA_OBJECT=1 sends it as a parsed object so the
    // client's own log can confirm or refute it.
    // MEASURED (round 16): sending "data" as an object did NOT remove the three tick-2 String-as-Object
    // errors (still 3) and introduced an Array-as-Object error on the failure path, so the character
    // "data" field is NOT their source and the documented 1.12 string shape stays the default.
    const DataAsObject = (process.env.GAMESERVER_CHARACTER_DATA_OBJECT ?? "0") === "1";
    // Every character shape now also decodes the double-encoded RecentPlayers field (see the helper
    // at the top of this file): that string-in-object-position is what the client reports as
    // "Json Value of type 'String' used as a 'Object'" once per character fetch.
    const WithDataShape = (c: any) => {
        const Decoded = { ...c, data: DecodeNestedJsonFieldsInCharacterData(c?.data) };
        if (!DataAsObject || typeof Decoded.data !== "string") return Decoded;
        try { return { ...Decoded, data: JSON.parse(Decoded.data) }; } catch { return Decoded; }
    };

    // [1.14.7 CORRECTION 2026-10-04] These two experiment branches must NEVER apply to a real player.
    //
    // They were written for the hub's phantom player, which holds no character id. That case does not reach
    // this point: a gameserver no-player request is resolved to a real account above (line ~84), and a genuine
    // sentinel returns [] above (line ~92). So every request arriving here belongs to a REAL account whose
    // client holds its own 38-character character id - and blanking that id is destructive. Measured:
    //
    //   - 8379 responses carried an empty id for real players (devrepro0039 x5045, devrepro0040 x2854,
    //     f2aaa6bf-... x480);
    //   - the client was then left with no character id, so GET /loadout/<account>//all took the
    //     empty-character route and answered 400 - that route rejects real accounts by design (loadout.ts:66);
    //   - character saves had no record to update and were rejected: 476 HTTP 409s;
    //   - the player-data load timed out with "Loadout and daily bounty still incomplete", so the loading
    //     screen never closed. The hub's PostLogin was real, but the player never became playable.
    //
    // Now gated on the verified no-player case (a gameserver-keyed request), so a real player's stored ids are
    // always returned. The env flag is additionally off in .env.
    // [1.14.7 CORRECTION 2026-10-04] The compatibility shape applies only to a request with a VERIFIED
    // no-player identity. IsGameserver alone was wrong - it also matches a server request carrying a real
    // player's bearer, whose stored account and character ids must be preserved. Measured consequence of the
    // old gate: the hub's phantom character read still failed (nine parser failures before its timeout)
    // because the empty-id shape was no longer served to it.
    // [1.14.7 FIX 2026-10-04] The compatibility shape is restricted to the hub's own no-player character read.
    //
    // MEASURED, both directions, on live requests:
    //     client (real player)  gsKey=N bearer=Y
    //     hub    (phantom)      gsKey=Y bearer=N
    // so the two are exactly separable by the request's OWN headers, and a server request carrying a real
    // player's bearer (the case that must keep its stored ids) has bearer=Y and is excluded.
    //
    // WHY this shape is needed at all - decoded from the parser (FUN_140dee610) and confirmed in-process:
    //     if (returned.Num == held.Num) { if (1 < returned.Num) accept = StringCompare(...) == 0; }
    //     else                          { accept = (returned.Num + held.Num) == 1; }
    // The hub's phantom holds an EMPTY id (measured: heldNum=0, heldId=''), so the account's 36-char id
    // gives 36 + 0 != 1 and the parse fails; an EMPTY returned id gives 0 == 0 and passes. Verified end to
    // end: with this shape served, the phantom's parse succeeded on its FIRST attempt (a5=1 instead of 5),
    // every failure counter froze, and the hub survived a full 4-minute idle soak instead of exiting at 180s.
    //
    // The decision is carried on THIS request (its own headers), so each retry is classified independently -
    // never a global or last-requesting-player flag. Real-player requests and any request without the
    // gameserver key keep their stored account and character ids.
    const HasGameserverKey = req.headers["x-mysticparadox-gameserver-apikey"] !== undefined;
    const HasPlayerBearer = typeof req.headers.authorization === "string"
        && req.headers.authorization.toLowerCase().startsWith("bearer ");
    const PhantomCompatibilityShape = HasGameserverKey && !HasPlayerBearer;

    // Log the EFFECTIVE configuration once per process. The failed run showed zero branch executions and the
    // .env file alone could not establish which shape was actually served, so the process now states it.
    if (!EffectiveCharacterShapeLogged) {
        EffectiveCharacterShapeLogged = true;
        logger.info("GET /character effective shape: EMPTY_ID="
            + (process.env.GAMESERVER_CHARACTER_EMPTY_ID ?? "unset")
            + " EMPTY_LIST=" + (process.env.GAMESERVER_CHARACTER_EMPTY_LIST ?? "unset")
            + " DECODE_NESTED=" + (process.env.GAMESERVER_CHARACTER_DECODE_NESTED ?? "unset")
            + " noPlayerIdentity=" + IsNoPlayerIdentity
            + " isGameserver=" + (req.AuthData?.IsGameserver === true)
            + " phantomShape=" + PhantomCompatibilityShape);
    }

    if ((process.env.GAMESERVER_CHARACTER_EMPTY_ID ?? "0") === "1"
        && PhantomCompatibilityShape
        && CharactersForUid.length > 0) {
        logger.info("GET /character: returning the character with an EMPTY id (gameserver no-player experiment)");
        res.status(200);
        res.json(CharactersForUid.map((c: any) => WithDataShape({ ...c, id: "" })));
        return;
    }

    if ((process.env.GAMESERVER_CHARACTER_EMPTY_LIST ?? "0") === "1" && PhantomCompatibilityShape) {
        logger.info("GET /character: returning an EMPTY list (gameserver no-player experiment)");
        res.status(200);
        res.json([]);
        return;
    }

    // [1.14.7 TEST 2026-10-03] The 1.14.7 client's FOnlinePhoenixCharacter::OnGetHttpRequestComplete
    // (FUN_140dee610) requires the fields "id", "updateVersion" and "data" (the 3-character literal
    // at RVA 0x50A7B14 is "id") and logs "Failed To Parse All Required Fields" for every array
    // response this route returns. Testing the single-object shape here: set
    // GAMESERVER_CHARACTER_SINGLE_OBJECT=0 to restore the 1.12 array response.
    // MEASURED: the object shape is WORSE - the client then logs "Failed To Deserialize Response",
    // while the array shape deserializes and only fails the per-field check. So 1.14.7 also expects
    // an array; default back to it (the env var can still force the object for further testing).
    if ((process.env.GAMESERVER_CHARACTER_SINGLE_OBJECT ?? "0") !== "0" && CharactersForUid.length > 0) {
        logger.info("GET /character: returning a single character object (1.14.7 shape test)");
        res.status(200);
        res.json(CharactersForUid[0]);
        return;
    }

    res.status(200);
    res.json(CharactersForUid.map((c: any) => WithDataShape(c)));
});

characterRouter.put("/character", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const CharacterNameToCreate = req.body.name;

    if(IsNoPlayerSentinel(UserId)){
        logger.debug(`PUT /character called with no-player sentinel (userId=${UserId}) - refusing to create a character, not touching DB`);

        res.status(400);
        res.send();
        return;
    }

    logger.info(`Creating a character named ${CharacterNameToCreate} for user ${UserId}`);

    let NewCharacter = await CreateCharacterForUid(UserId, CharacterNameToCreate);

    res.status(200);
    res.json(NewCharacter);
})

characterRouter.post("/character", HasParadoxBackendAuth, async (req: any, res) => {
    let CharacterIdToUpdate = req.body.characterId;
    // [1.12.0] When Ramsgate/Training-Dojo Phoenix forwards a client-initiated character
    // save, it authenticates with the gameserver API key AND the client's Bearer JWT but
    // does NOT populate body.accountId. HasParadoxBackendAuth merges the JWT payload into
    // AuthData for exactly this case (see its comment). Fall back to the JWT-derived
    // userId so the save is attributed to the right player instead of being 400'd, which
    // is what caused the 60s PlayerData load timeout / disconnect crash observed in the
    // port8790_ramsgate logs.
    const UserId = req.AuthData.IsGameserver
        ? (req.body.accountId ?? req.AuthData.userId)
        : req.AuthData.userId;
    const DataToUpdateWith = req.body.data;
    const UpdateVersion = req.body.updateVersion;

    // [1.14.7 FIX 2026-10-04] The hub's phantom player saves with an EMPTY characterId - the live log showed
    //   WARN: UpdateCharacterForUid: no character record for characterId  userId f2aaa6bf-... (isGameserver=true)
    //   WARN: Update conflict for characterId  (userId f2aaa6bf-...) - returning HTTP 409
    //   INFO: [RES] POST /__origin/dauntless-prod.steelyard.ca/character -> 409
    // repeated continuously, so every server-authoritative save was rejected and the caller retried forever
    // (nothing the player did persisted). The READ side already solves exactly this: GET /inventory resolves
    // the account's character when a gameserver request carries no characterId (routes/inventory.ts:85-105).
    // Apply the same single-account rule here so the save lands on the real record. Player requests (bearer)
    // are untouched because they always carry a characterId.
    if (req.AuthData.IsGameserver && (typeof CharacterIdToUpdate !== "string" || CharacterIdToUpdate.length === 0)) {
        const Characters = await GetCharactersForUid(UserId);
        const Resolved = Characters.length > 0 ? Characters[0].id : undefined;
        if (typeof Resolved === "string" && Resolved.length > 0) {
            logger.info(`POST /character (no characterId): gameserver request resolved to '${Resolved}' for ${UserId}`);
            CharacterIdToUpdate = Resolved;
        }
        else {
            logger.warn(`POST /character (no characterId): no character exists for ${UserId} - the write cannot be attributed`);
        }
    }

    if(IsNoPlayerSentinel(UserId)){
        logger.warn(`POST /character called without a resolvable userId (authUserId=${req.AuthData.userId}, bodyAccountId=${req.body.accountId}) - refusing to update, not touching DB`);

        res.status(400);
        res.send();
        return;
    }

    logger.info(`Updating characterId ${CharacterIdToUpdate} for userId ${UserId} with updateVersion ${UpdateVersion} (IsGameserver=${req.AuthData.IsGameserver === true ? "Y" : "N"})`);

    const DidSucceed = await UpdateCharacterForUid(
        CharacterIdToUpdate,
        UserId,
        DataToUpdateWith,
        UpdateVersion,
        req.AuthData.IsGameserver === true   // [move4 Fix B] server-authoritative writes force-through on version conflict
    );

    if(!DidSucceed){
        // [move6 — 2026-07-10] EXACT REAL 1.12.0 CONFLICT RESPONSE
        // Only reached when IsGameserver=false (client PUT). Gameserver writes
        // never fall here because Fix B in controllers/character.ts force-writes
        // them at current+1 and returns true (DidSucceed=true).
        //
        // The real 1.12.0 server returns HTTP 409 with a hand-rolled Jetty-style
        // HTML body (verified from a live traffic capture in
        // DauntlessEndpointDocumentation/Inventory/PostCharacter.md "Conflict
        // resolution example"). The client's Phoenix HTTP layer is coded to
        // recognize THIS EXACT format as "conflict — do a follow-up GET /character
        // to reconcile" and does NOT tear down its queue on it.
        //
        // Prior attempts (empty 409 body / 200 with JSON) both broke Phoenix:
        //   * Empty 409 → "Null Response, Timeout?" → "Failing Any Queued Requests"
        //   * 200 with JSON on POST /character → unexpected shape → same abort +
        //     "Failed to update player account progress flag: UnknownError"
        //
        // The 409-HTML matches what Phoenix's state machine is coded against, so
        // the queued follow-up (progress-flag write / PJM Slayer unlock / etc.)
        // survives the conflict and completes on the next tick.
        //
        // Contents copied verbatim from the endpoint docs — do NOT reformat the
        // whitespace, indentation, trailing space in the <title>, or the four
        // spaces before "Conflict" in the <pre>. Phoenix may compare against the
        // exact bytes it saw in production. Content-Type also verbatim from docs.
        logger.warn(`Update conflict for characterId ${CharacterIdToUpdate} (userId ${UserId}) - returning HTTP 409 HTML matching real 1.12 server (Phoenix HTTP recognizes and does follow-up GET)`);

        res.status(409);
        res.setHeader("Content-Type", "text/html;charset=ISO-8859-1");
        res.send(
            "<html>\n" +
            "<head>\n" +
            "<meta http-equiv=\"Content-Type\" content=\"text/html;charset=ISO-8859-1\"/>\n" +
            "<title>Error 409 </title>\n" +
            "</head>\n" +
            "<body>\n" +
            "<h2>HTTP ERROR: 409</h2>\n" +
            "<p>Problem accessing /character. Reason:\n" +
            "<pre>    Conflict</pre></p>\n" +
            "<hr />\n" +
            "</body>\n" +
            "</html>\n"
        );
        return;
    }

    const UpdatedCharacter = await GetCharacterWithUid(CharacterIdToUpdate, UserId);

    res.status(200);
    res.json(UpdatedCharacter);
});
