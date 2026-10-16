/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
    HOSTING_MAX_AFK_SECONDS,
    HOSTING_MAX_PLAYERS_LIMIT,
    HOSTING_MAX_SERVERS_LIMIT,
    INVITE_DEFAULT_MAX_USES,
    INVITE_DEFAULT_TTL_HOURS,
    INVITE_MAX_TTL_HOURS,
    INVITE_MAX_USES_LIMIT,
    NormalizeInviteCode,
    ValidateRealmName
} from "./realmRules";
import { RealmJoinPolicy } from "./realmTypes";

// [2026-10-13 realms S2] Strict parsers for everything a realms route reads from a request. Types are checked, never
// coerced ("true" is not a boolean, "5" is not a number); only the fields a route names are copied out, so unknown body
// keys are ignored and can never reach a database write. Every parser answers a result instead of throwing; the routes
// turn a failure into the module's error envelope.

export type ParseFailureCode = "REALM_VALIDATION_FAILED" | "REALM_NAME_INVALID" | "REALM_NAME_RESERVED";
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ParseFailureCode; message: string };

function Fail<T>(message: string, code: ParseFailureCode = "REALM_VALIDATION_FAILED"): Parsed<T> {
    return { ok: false, code, message };
}

function Ok<T>(value: T): Parsed<T> {
    return { ok: true, value };
}

/** A JSON object body; a missing body counts as an empty object, anything else (array, string, number) is refused. */
function AsObject(body: unknown): Record<string, unknown> | undefined {
    if (body === undefined || body === null) return {};
    if (typeof body !== "object" || Array.isArray(body)) return undefined;
    return body as Record<string, unknown>;
}

function Has(source: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
}

const HostKeyPattern = /^[A-Za-z0-9+/_=-]{16,512}$/;
const VersionPattern = /^[A-Za-z0-9._+-]{1,64}$/;
const AccountIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function ParseJoinPolicy(value: unknown): RealmJoinPolicy | undefined {
    return value === "INVITE_ONLY" || value === "PUBLIC" || value === "SOLO" ? value : undefined;
}

/** The host launcher's public key as text (base64, base64url or hex); only its alphabet and size are checked here. */
export function ParseHostPublicKey(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const key = value.trim();
    return HostKeyPattern.test(key) ? key : undefined;
}

export function ParseVersion(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const version = value.trim();
    return VersionPattern.test(version) ? version : undefined;
}

export function ParseAccountIdParam(value: unknown): string | undefined {
    return typeof value === "string" && AccountIdPattern.test(value) ? value : undefined;
}

export interface CreateRealmInput {
    /** [2026-10-16] Absent: the realm is named after the host's username (realmsService.createRealm, RealmNameForUsername). */
    name?: string;
    hostPublicKey: string;
    joinPolicy: RealmJoinPolicy;
    listed: boolean;
    version?: string;
}

/** POST /launcher/v1/realms. Invite-only and unlisted are the defaults (plan section 7). */
export function ParseCreateRealmBody(body: unknown): Parsed<CreateRealmInput> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");

    // [2026-10-16, owner] The launcher sends no name: the realm takes the host's username. A name that is sent is checked as before.
    let name: string | undefined;
    if (Has(source, "name")) {
        const checked = ValidateRealmName(source.name);
        if (!checked.ok) {
            return checked.reason === "RESERVED"
                ? Fail("That realm name is reserved.", "REALM_NAME_RESERVED")
                : Fail("A realm name is 3-24 letters, digits or hyphens, and cannot start or end with a hyphen.", "REALM_NAME_INVALID");
        }
        name = checked.name;
    }
    const hostPublicKey = ParseHostPublicKey(source.hostPublicKey);
    if (hostPublicKey === undefined) return Fail("hostPublicKey must be the host's public key as text.");

    let joinPolicy: RealmJoinPolicy = "INVITE_ONLY";
    if (Has(source, "joinPolicy")) {
        const parsed = ParseJoinPolicy(source.joinPolicy);
        if (parsed === undefined) return Fail("joinPolicy must be SOLO, INVITE_ONLY or PUBLIC.");
        joinPolicy = parsed;
    }
    let listed = false;
    if (Has(source, "listed")) {
        if (typeof source.listed !== "boolean") return Fail("listed must be true or false.");
        listed = source.listed;
    }
    const input: CreateRealmInput = { hostPublicKey, joinPolicy, listed };
    if (name !== undefined) input.name = name;
    if (Has(source, "version")) {
        const version = ParseVersion(source.version);
        if (version === undefined) return Fail("version is malformed.");
        input.version = version;
    }
    return Ok(input);
}

export interface RealmSettingsInput {
    joinPolicy?: RealmJoinPolicy;
    listed?: boolean;
}

/** POST /launcher/v1/realms/mine/settings; at least one setting is required. */
export function ParseSettingsBody(body: unknown): Parsed<RealmSettingsInput> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    const input: RealmSettingsInput = {};
    if (Has(source, "joinPolicy")) {
        const parsed = ParseJoinPolicy(source.joinPolicy);
        if (parsed === undefined) return Fail("joinPolicy must be SOLO, INVITE_ONLY or PUBLIC.");
        input.joinPolicy = parsed;
    }
    if (Has(source, "listed")) {
        if (typeof source.listed !== "boolean") return Fail("listed must be true or false.");
        input.listed = source.listed;
    }
    if (input.joinPolicy === undefined && input.listed === undefined) return Fail("Nothing to change: send joinPolicy and/or listed.");
    return Ok(input);
}

export interface CreateInviteInput {
    maxUses: number;
    ttlHours: number;
}

/** POST /launcher/v1/realms/mine/invites: maxUses 1-100 (default 10), expiresInHours 1-720 (default 168). */
export function ParseInviteBody(body: unknown): Parsed<CreateInviteInput> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    let maxUses = INVITE_DEFAULT_MAX_USES;
    if (Has(source, "maxUses")) {
        const value = source.maxUses;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > INVITE_MAX_USES_LIMIT) {
            return Fail(`maxUses must be a whole number from 1 to ${INVITE_MAX_USES_LIMIT}.`);
        }
        maxUses = value;
    }
    let ttlHours = INVITE_DEFAULT_TTL_HOURS;
    if (Has(source, "expiresInHours")) {
        const value = source.expiresInHours;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > INVITE_MAX_TTL_HOURS) {
            return Fail(`expiresInHours must be a whole number from 1 to ${INVITE_MAX_TTL_HOURS}.`);
        }
        ttlHours = value;
    }
    return Ok({ maxUses, ttlHours });
}

export interface JoinInput {
    name?: string;
    inviteCode?: string;
    knownHostKey?: string;
}

/**
 * POST /launcher/v1/realms/join: a realm name and/or an invite code (at least one). `knownHostKey` is the host key the
 * launcher showed the player when they agreed to this realm; a different key now means a new owner (REALM_OWNER_CHANGED).
 */
export function ParseJoinBody(body: unknown): Parsed<JoinInput> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    const input: JoinInput = {};
    if (Has(source, "name")) {
        // [2026-10-16] A join names a realm that already exists; it does not claim the name. So a well-formed reserved name passes, as
        // in ParseNameParam: the owner's own realm is "mysticfox" (reserved for new realms), and every join request to it by name was
        // refused with 400 (16 Oct 06:06:56 UTC, a new account's Ask to join), so only Play's own path reached the host.
        const name = ValidateRealmName(source.name);
        if (name.ok) input.name = name.name;
        else if (name.reason === "RESERVED" && typeof source.name === "string") input.name = source.name.trim().toLowerCase();
        else return Fail("That is not a realm name.", "REALM_NAME_INVALID");
    }
    if (Has(source, "inviteCode")) {
        const code = NormalizeInviteCode(source.inviteCode);
        if (code === undefined) return Fail("That is not an invite code.");
        input.inviteCode = code;
    }
    if (input.name === undefined && input.inviteCode === undefined) return Fail("Send a realm name and/or an invite code.");
    if (Has(source, "knownHostKey")) {
        const key = ParseHostPublicKey(source.knownHostKey);
        if (key === undefined) return Fail("knownHostKey is malformed.");
        input.knownHostKey = key;
    }
    return Ok(input);
}

/** What the host chooses to run (section 2.3 of the hub design); advisory, the host is the only source. */
export interface HostingInput {
    maxServers: number;
    maxPlayers: number;
    afkSeconds?: number;
}

export interface HeartbeatInput {
    online?: boolean;
    version?: string;
    hosting?: HostingInput;
}

function ParseHostingInput(value: unknown): Parsed<HostingInput> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return Fail("hosting must be an object.");
    const source = value as Record<string, unknown>;
    const WholeNumber = (key: string, min: number, max: number): number | undefined => {
        const raw = source[key];
        return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max ? raw : undefined;
    };
    const maxServers = WholeNumber("maxServers", 1, HOSTING_MAX_SERVERS_LIMIT);
    if (maxServers === undefined) return Fail(`hosting.maxServers must be a whole number from 1 to ${HOSTING_MAX_SERVERS_LIMIT}.`);
    const maxPlayers = WholeNumber("maxPlayers", 1, HOSTING_MAX_PLAYERS_LIMIT);
    if (maxPlayers === undefined) return Fail(`hosting.maxPlayers must be a whole number from 1 to ${HOSTING_MAX_PLAYERS_LIMIT}.`);
    const hosting: HostingInput = { maxServers, maxPlayers };
    if (Has(source, "afkSeconds")) {
        const afkSeconds = WholeNumber("afkSeconds", 0, HOSTING_MAX_AFK_SECONDS);
        if (afkSeconds === undefined) return Fail(`hosting.afkSeconds must be a whole number from 0 to ${HOSTING_MAX_AFK_SECONDS}.`);
        hosting.afkSeconds = afkSeconds;
    }
    return Ok(hosting);
}

/**
 * POST /launcher/v1/realms/mine/heartbeat: optional version, online:false to close the realm on purpose, and `hosting` (what the
 * host's PC will run: maxServers 1-8, maxPlayers 1-64, optional afkSeconds 0-7200).
 */
export function ParseHeartbeatBody(body: unknown): Parsed<HeartbeatInput> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    const input: HeartbeatInput = {};
    if (Has(source, "online")) {
        if (typeof source.online !== "boolean") return Fail("online must be true or false.");
        input.online = source.online;
    }
    if (Has(source, "version")) {
        const version = ParseVersion(source.version);
        if (version === undefined) return Fail("version is malformed.");
        input.version = version;
    }
    if (Has(source, "hosting")) {
        const hosting = ParseHostingInput(source.hosting);
        if (!hosting.ok) return hosting;
        input.hosting = hosting.value;
    }
    return Ok(input);
}

export interface EntryRealmInput {
    name: string;
    inviteCode?: string;
    knownHostKey?: string;
}

/**
 * The optional `realm` of POST /launcher/v1/game-sessions: { name, inviteCode?, knownHostKey? }. The name is required; a reserved
 * name is well-formed and simply finds no realm. A `null` is read as absent by the caller, never here.
 */
export function ParseEntryRealm(value: unknown): Parsed<EntryRealmInput> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return Fail("realm must be an object with a name.");
    const source = value as Record<string, unknown>;
    if (!Has(source, "name")) return Fail("realm.name is required.");
    const name = ParseNameParam(source.name);
    if (!name.ok) return name;
    const input: EntryRealmInput = { name: name.value };
    if (Has(source, "inviteCode")) {
        const code = NormalizeInviteCode(source.inviteCode);
        if (code === undefined) return Fail("That is not an invite code.");
        input.inviteCode = code;
    }
    if (Has(source, "knownHostKey")) {
        const key = ParseHostPublicKey(source.knownHostKey);
        if (key === undefined) return Fail("knownHostKey is malformed.");
        input.knownHostKey = key;
    }
    return Ok(input);
}

export const BAN_REASON_MAX_LENGTH = 200;

/** POST .../members/:accountId/ban: an optional reason of at most 200 characters, without control characters. */
export function ParseBanBody(body: unknown): Parsed<{ reason?: string }> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    if (!Has(source, "reason")) return Ok({});
    const reason = source.reason;
    if (typeof reason !== "string") return Fail("reason must be text.");
    const trimmed = reason.trim();
    if (trimmed.length > BAN_REASON_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
        return Fail(`reason must be at most ${BAN_REASON_MAX_LENGTH} characters of plain text.`);
    }
    return Ok(trimmed.length === 0 ? {} : { reason: trimmed });
}

export const USERNAME_MAX_LENGTH = 64;

/**
 * [2026-10-15] POST /launcher/v1/realms/mine/members/add: the username of the player to let in. Trimmed; 1-64 characters without
 * control characters. Format is not policed beyond that: an unknown name is simply not found (REALM_PLAYER_NOT_FOUND), so accounts
 * created under older rules still resolve.
 */
export function ParseUsernameBody(body: unknown): Parsed<{ username: string }> {
    const source = AsObject(body);
    if (source === undefined) return Fail("The request body must be a JSON object.");
    if (!Has(source, "username")) return Fail("username is required.");
    const raw = source.username;
    if (typeof raw !== "string") return Fail("username must be text.");
    const username = raw.trim();
    if (username.length < 1 || username.length > USERNAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(username)) {
        return Fail(`username must be 1 to ${USERNAME_MAX_LENGTH} characters of plain text.`);
    }
    return Ok({ username });
}

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 50;
export const LIST_MAX_OFFSET = 10_000;

/** GET /launcher/v1/realms/listed?limit=1-50&offset=0-10000 (query strings: digits only). */
export function ParseListQuery(query: unknown): Parsed<{ limit: number; offset: number }> {
    const source = AsObject(query) ?? {};
    let limit = LIST_DEFAULT_LIMIT;
    let offset = 0;
    if (Has(source, "limit")) {
        const raw = source.limit;
        if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > LIST_MAX_LIMIT) {
            return Fail(`limit must be a whole number from 1 to ${LIST_MAX_LIMIT}.`);
        }
        limit = Number(raw);
    }
    if (Has(source, "offset")) {
        const raw = source.offset;
        if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw) || Number(raw) > LIST_MAX_OFFSET) {
            return Fail(`offset must be a whole number from 0 to ${LIST_MAX_OFFSET}.`);
        }
        offset = Number(raw);
    }
    return Ok({ limit, offset });
}

/** GET .../by-name/:name?knownHostKey=...: the optional key the launcher last showed the player. */
export function ParseKnownHostKeyQuery(query: unknown): Parsed<string | undefined> {
    const source = AsObject(query) ?? {};
    if (!Has(source, "knownHostKey")) return Ok(undefined);
    const key = ParseHostPublicKey(source.knownHostKey);
    return key === undefined ? Fail("knownHostKey is malformed.") : Ok(key);
}

/** A realm name from a URL path: format only, reserved names are simply not found. */
export function ParseNameParam(value: unknown): Parsed<string> {
    const name = ValidateRealmName(value);
    if (name.ok) return Ok(name.name);
    // A reserved name is well-formed: a lookup answers "not found" rather than "invalid".
    if (name.reason === "RESERVED" && typeof value === "string") return Ok(value.trim().toLowerCase());
    return Fail("That is not a realm name.", "REALM_NAME_INVALID");
}

export function ParseInviteCodeParam(value: unknown): Parsed<string> {
    const code = NormalizeInviteCode(value);
    return code === undefined ? Fail("That is not an invite code.") : Ok(code);
}
