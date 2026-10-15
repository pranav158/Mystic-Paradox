/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
    LauncherNotice,
    LauncherNoticeTag,
    LauncherNoticeTagTone,
    LauncherNoticeTone,
    LauncherNoticesRecord
} from "../persistence/contracts/LauncherNoticesRepository";

// [2026-10-15] The launcher notices (SteamDocs/LAUNCHER_NOTICES_2026_10_15.md): validation of a manager save, the active-window rule and
// the two views (public for the launcher, admin for the manager). Pure: no storage, no clock except the `nowMs` the caller passes.

export const LAUNCHER_NOTICE_LIMITS = Object.freeze({
    announcements: 3,
    tags: 4,
    announcementTextMax: 280,
    tagTextMax: 24,
    idMax: 64,
    reasonMin: 8,
    reasonMax: 200
});

/** The only placeholder: the launcher replaces it with the event time (UTC and the PC's local time). */
export const LAUNCHER_NOTICE_TIME_TOKEN = "{time}";

const ANNOUNCEMENT_TONES: readonly LauncherNoticeTone[] = ["info", "warning", "critical"];
const TAG_TONES: readonly LauncherNoticeTagTone[] = ["info", "warning", "danger", "success"];
// A full UTC or offset ISO-8601 instant, with the date and at least the hour and minute. Anything else is refused, not guessed at.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Every text is one line: control characters (tabs, line breaks, ...) are refused.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// Plain text only: angle brackets are refused, so nothing that looks like markup is stored.
const MARKUP_CHARACTER = /[<>]/;

export type LauncherNoticesCheck<T> = { ok: true; value: T } | { ok: false; message: string };

export interface LauncherNoticesInput {
    announcements: LauncherNotice[];
    tags: LauncherNoticeTag[];
}

function Pass<T>(value: T): LauncherNoticesCheck<T> {
    return { ok: true, value };
}

function Fail(message: string): { ok: false; message: string } {
    return { ok: false, message };
}

function CodePointLength(text: string): number {
    return Array.from(text).length;
}

/** The canonical UTC form of an ISO instant (`toISOString()`), or undefined when the value is not one. */
export function ParseLauncherNoticeInstant(value: unknown): string | undefined {
    if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
    const Ms = Date.parse(value);
    return Number.isFinite(Ms) ? new Date(Ms).toISOString() : undefined;
}

function CheckText(raw: unknown, label: string, max: number, allowTimeToken: boolean): LauncherNoticesCheck<string> {
    if (typeof raw !== "string") return Fail(`${label} must be text.`);
    const Text = raw.trim();
    const Length = CodePointLength(Text);
    if (Length < 1 || Length > max) return Fail(`${label} must be 1 to ${max} characters.`);
    if (CONTROL_CHARACTER.test(Text)) return Fail(`${label} must be one line of plain text (no tabs or line breaks).`);
    if (MARKUP_CHARACTER.test(Text)) return Fail(`${label} must be plain text (no < or > characters).`);
    if (!allowTimeToken) {
        if (Text.includes("{") || Text.includes("}")) return Fail(`${label} does not take placeholders.`);
        return Pass(Text);
    }
    if (Text.split(LAUNCHER_NOTICE_TIME_TOKEN).length - 1 > 1) return Fail(`${label} may contain {time} once.`);
    const Outside = Text.split(LAUNCHER_NOTICE_TIME_TOKEN).join("");
    if (Outside.includes("{") || Outside.includes("}")) return Fail(`${label} may only use the {time} placeholder.`);
    return Pass(Text);
}

function CheckId(raw: unknown, label: string): LauncherNoticesCheck<string | undefined> {
    if (raw === undefined || raw === null) return Pass(undefined);
    if (typeof raw !== "string" || !ID_PATTERN.test(raw)) {
        return Fail(`${label} must be 1 to ${LAUNCHER_NOTICE_LIMITS.idMax} letters, digits, "-" or "_".`);
    }
    return Pass(raw);
}

function CheckTone<T extends string>(raw: unknown, label: string, allowed: readonly T[]): LauncherNoticesCheck<T> {
    if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
        return Fail(`${label} must be one of ${allowed.join(", ")}.`);
    }
    return Pass(raw as T);
}

function CheckOptionalInstant(raw: unknown, label: string): LauncherNoticesCheck<string | undefined> {
    if (raw === undefined || raw === null) return Pass(undefined);
    const Instant = ParseLauncherNoticeInstant(raw);
    if (Instant === undefined) return Fail(`${label} must be an ISO time in UTC (for example 2026-10-16T00:00:00.000Z).`);
    return Pass(Instant);
}

function CheckWindow(item: Record<string, unknown>, label: string): LauncherNoticesCheck<{ showFrom?: string; showUntil?: string }> {
    const From = CheckOptionalInstant(item.showFrom, `${label}.showFrom`);
    if (!From.ok) return From;
    const Until = CheckOptionalInstant(item.showUntil, `${label}.showUntil`);
    if (!Until.ok) return Until;
    if (From.value !== undefined && Until.value !== undefined && Date.parse(Until.value) < Date.parse(From.value)) {
        return Fail(`${label}.showUntil is before showFrom.`);
    }
    return Pass({
        ...(From.value !== undefined ? { showFrom: From.value } : {}),
        ...(Until.value !== undefined ? { showUntil: Until.value } : {})
    });
}

function CheckList(raw: unknown, label: string, max: number): LauncherNoticesCheck<Record<string, unknown>[]> {
    if (!Array.isArray(raw)) return Fail(`${label} must be a list.`);
    if (raw.length > max) return Fail(`${label} holds at most ${max} entries.`);
    for (let Index = 0; Index < raw.length; Index += 1) {
        const Entry = raw[Index];
        if (Entry === null || typeof Entry !== "object" || Array.isArray(Entry)) return Fail(`${label}[${Index}] must be an object.`);
    }
    return Pass(raw as Record<string, unknown>[]);
}

function CheckAnnouncement(item: Record<string, unknown>, index: number): LauncherNoticesCheck<Omit<LauncherNotice, "id"> & { id?: string }> {
    const Label = `announcements[${index}]`;
    const Id = CheckId(item.id, `${Label}.id`);
    if (!Id.ok) return Id;
    const Text = CheckText(item.text, `${Label}.text`, LAUNCHER_NOTICE_LIMITS.announcementTextMax, true);
    if (!Text.ok) return Text;
    const Tone = CheckTone(item.tone, `${Label}.tone`, ANNOUNCEMENT_TONES);
    if (!Tone.ok) return Tone;
    const EventAt = CheckOptionalInstant(item.eventAt, `${Label}.eventAt`);
    if (!EventAt.ok) return EventAt;
    if (Text.value.includes(LAUNCHER_NOTICE_TIME_TOKEN) && EventAt.value === undefined) {
        return Fail(`${Label}.eventAt is required when the text contains {time}.`);
    }
    const Window = CheckWindow(item, Label);
    if (!Window.ok) return Window;
    return Pass({
        ...(Id.value !== undefined ? { id: Id.value } : {}),
        text: Text.value,
        tone: Tone.value,
        ...(EventAt.value !== undefined ? { eventAt: EventAt.value } : {}),
        ...Window.value
    });
}

function CheckTag(item: Record<string, unknown>, index: number): LauncherNoticesCheck<Omit<LauncherNoticeTag, "id"> & { id?: string }> {
    const Label = `tags[${index}]`;
    const Id = CheckId(item.id, `${Label}.id`);
    if (!Id.ok) return Id;
    const Text = CheckText(item.text, `${Label}.text`, LAUNCHER_NOTICE_LIMITS.tagTextMax, false);
    if (!Text.ok) return Text;
    const Tone = CheckTone(item.tone, `${Label}.tone`, TAG_TONES);
    if (!Tone.ok) return Tone;
    if (item.eventAt !== undefined && item.eventAt !== null) return Fail(`${Label} does not take eventAt.`);
    const Window = CheckWindow(item, Label);
    if (!Window.ok) return Window;
    return Pass({
        ...(Id.value !== undefined ? { id: Id.value } : {}),
        text: Text.value,
        tone: Tone.value,
        ...Window.value
    });
}

/**
 * Validates a complete manager save (PUT body without the reason and version): both lists are required (a save is the whole set,
 * so an omitted list cannot quietly clear it), every limit is checked, and an item without an id gets one from `newId`. An id given
 * twice (within or across the two lists) is refused.
 */
export function ValidateLauncherNoticesInput(body: unknown, options: { newId: () => string }): LauncherNoticesCheck<LauncherNoticesInput> {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return Fail("The request body must be an object.");
    const Source = body as Record<string, unknown>;

    const AnnouncementList = CheckList(Source.announcements, "announcements", LAUNCHER_NOTICE_LIMITS.announcements);
    if (!AnnouncementList.ok) return AnnouncementList;
    const TagList = CheckList(Source.tags, "tags", LAUNCHER_NOTICE_LIMITS.tags);
    if (!TagList.ok) return TagList;

    const announcements: LauncherNotice[] = [];
    for (let Index = 0; Index < AnnouncementList.value.length; Index += 1) {
        const Checked = CheckAnnouncement(AnnouncementList.value[Index]!, Index);
        if (!Checked.ok) return Checked;
        announcements.push({ ...Checked.value, id: Checked.value.id ?? options.newId() } as LauncherNotice);
    }
    const tags: LauncherNoticeTag[] = [];
    for (let Index = 0; Index < TagList.value.length; Index += 1) {
        const Checked = CheckTag(TagList.value[Index]!, Index);
        if (!Checked.ok) return Checked;
        tags.push({ ...Checked.value, id: Checked.value.id ?? options.newId() } as LauncherNoticeTag);
    }

    const Seen = new Set<string>();
    for (const Item of [...announcements, ...tags]) {
        if (Seen.has(Item.id)) return Fail(`The id ${Item.id} is used by more than one notice or tag.`);
        Seen.add(Item.id);
    }
    return Pass({ announcements, tags });
}

/** The change reason of a save: trimmed, 8 to 200 characters (the operations policy's minimum, with the contract's maximum). */
export function ValidateLauncherNoticesReason(raw: unknown): LauncherNoticesCheck<string> {
    if (typeof raw !== "string") return Fail("A change reason of 8 to 200 characters is required.");
    const Reason = raw.trim();
    const Length = CodePointLength(Reason);
    if (Length < LAUNCHER_NOTICE_LIMITS.reasonMin || Length > LAUNCHER_NOTICE_LIMITS.reasonMax) {
        return Fail(`The change reason must be ${LAUNCHER_NOTICE_LIMITS.reasonMin} to ${LAUNCHER_NOTICE_LIMITS.reasonMax} characters.`);
    }
    return Pass(Reason);
}

/** The expected version of a save: a whole number, 0 or more (a missing or text value is refused, not read as 0). */
export function ValidateLauncherNoticesExpectedVersion(raw: unknown): LauncherNoticesCheck<number> {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
        return Fail("expectedVersion must be the version you loaded (a whole number, 0 or more).");
    }
    return Pass(raw);
}

/**
 * Whether a notice or tag is served at `nowMs`: showFrom is inclusive and showUntil exclusive; an absent bound is open. A bound that does not
 * parse hides the item (fail closed).
 */
export function IsLauncherNoticeActive(item: { showFrom?: string; showUntil?: string }, nowMs: number): boolean {
    if (item.showFrom !== undefined && !(nowMs >= Date.parse(item.showFrom))) return false;
    if (item.showUntil !== undefined && !(nowMs < Date.parse(item.showUntil))) return false;
    return true;
}

/** The record with nothing saved: version 0, no items. */
export function EmptyLauncherNotices(): LauncherNoticesRecord {
    return { version: 0, announcements: [], tags: [] };
}

export interface PublicLauncherNotice {
    id: string;
    text: string;
    tone: LauncherNoticeTone;
    eventAt?: string;
    showFrom?: string;
    showUntil?: string;
}

export interface PublicLauncherNoticeTag {
    id: string;
    text: string;
    tone: LauncherNoticeTagTone;
    showFrom?: string;
    showUntil?: string;
}

export interface PublicLauncherNotices {
    announcements: PublicLauncherNotice[];
    tags: PublicLauncherNoticeTag[];
    serverTime: string;
}

/** What GET /launcher/v1/notices answers: only the items active at `nowMs`, in the stored order. */
export function PublicLauncherNoticesView(record: LauncherNoticesRecord | undefined, nowMs: number, serverTime: string): PublicLauncherNotices {
    const Source = record ?? EmptyLauncherNotices();
    const announcements = (Array.isArray(Source.announcements) ? Source.announcements : [])
        .filter((item) => IsLauncherNoticeActive(item, nowMs))
        .map((item) => ({
            id: item.id,
            text: item.text,
            tone: item.tone,
            ...(item.eventAt !== undefined ? { eventAt: item.eventAt } : {}),
            ...(item.showFrom !== undefined ? { showFrom: item.showFrom } : {}),
            ...(item.showUntil !== undefined ? { showUntil: item.showUntil } : {})
        }));
    const tags = (Array.isArray(Source.tags) ? Source.tags : [])
        .filter((item) => IsLauncherNoticeActive(item, nowMs))
        .map((item) => ({
            id: item.id,
            text: item.text,
            tone: item.tone,
            ...(item.showFrom !== undefined ? { showFrom: item.showFrom } : {}),
            ...(item.showUntil !== undefined ? { showUntil: item.showUntil } : {})
        }));
    return { announcements, tags, serverTime };
}

export interface AdminLauncherNoticesView {
    version: number;
    updatedAt: string | null;
    updatedBy: string | null;
    announcements: LauncherNotice[];
    tags: LauncherNoticeTag[];
    serverTime: string;
}

/** What the manager's GET and PUT answer: the whole document, inactive items included. */
export function AdminLauncherNoticesView(record: LauncherNoticesRecord | undefined, serverTime: string): AdminLauncherNoticesView {
    const Source = record ?? EmptyLauncherNotices();
    return {
        version: Source.version,
        updatedAt: Source.updatedAt ?? null,
        updatedBy: Source.updatedBy ?? null,
        announcements: Array.isArray(Source.announcements) ? Source.announcements : [],
        tags: Array.isArray(Source.tags) ? Source.tags : [],
        serverTime
    };
}
