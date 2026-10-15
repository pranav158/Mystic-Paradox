import assert from "node:assert/strict";
import test from "node:test";
import {
    AdminLauncherNoticesView,
    EmptyLauncherNotices,
    IsLauncherNoticeActive,
    ParseLauncherNoticeInstant,
    PublicLauncherNoticesView,
    ValidateLauncherNoticesExpectedVersion,
    ValidateLauncherNoticesInput,
    ValidateLauncherNoticesReason
} from "./launcherNotices";

// [2026-10-15] The launcher notices' pure rules: every refusal of a manager save, the reason and expectedVersion checks, the active-window
// rule and the two views. The storage and the HTTP routes are tested in the persistence and route tests.

let NextId = 0;
const Options = { newId: () => `generated-${++NextId}` };

function Valid(body: unknown) {
    const Result = ValidateLauncherNoticesInput(body, Options);
    assert.equal(Result.ok, true, Result.ok ? "" : Result.message);
    return Result.ok ? Result.value : undefined;
}

function Refused(body: unknown): string {
    const Result = ValidateLauncherNoticesInput(body, Options);
    assert.equal(Result.ok, false, "the save should be refused");
    return Result.ok ? "" : Result.message;
}

test("a valid save keeps the text trimmed, normalizes the instants to UTC and assigns the missing ids", () => {
    const Saved = Valid({
        announcements: [{
            text: "  The backend service will restart at {time}.  ",
            tone: "warning",
            eventAt: "2026-10-16T05:30:00+05:30",
            showFrom: "2026-10-15T12:00:00Z",
            showUntil: "2026-10-16T00:30:00.000Z"
        }],
        tags: [{ id: "exp-tag_1", text: "EXPERIMENTAL BUILD", tone: "warning" }]
    });
    const { id, ...Rest } = Saved!.announcements[0]!;
    assert.match(id, /^generated-\d+$/, "an item without an id gets the server's id");
    assert.deepEqual(Rest, {
        text: "The backend service will restart at {time}.",
        tone: "warning",
        eventAt: "2026-10-16T00:00:00.000Z",
        showFrom: "2026-10-15T12:00:00.000Z",
        showUntil: "2026-10-16T00:30:00.000Z"
    });
    assert.deepEqual(Saved!.tags, [{ id: "exp-tag_1", text: "EXPERIMENTAL BUILD", tone: "warning" }]);
});

test("an empty save is valid: both lists may be empty", () => {
    assert.deepEqual(Valid({ announcements: [], tags: [] }), { announcements: [], tags: [] });
});

test("both lists are required, so an omitted list cannot clear the document by accident", () => {
    assert.match(Refused({ tags: [] }), /announcements must be a list/);
    assert.match(Refused({ announcements: [] }), /tags must be a list/);
    assert.match(Refused(undefined), /must be an object/);
    assert.match(Refused(["x"]), /must be an object/);
});

test("the limits: at most 3 announcements and 4 tags", () => {
    const Announcement = { text: "Notice", tone: "info" };
    assert.match(Refused({ announcements: [Announcement, Announcement, Announcement, Announcement], tags: [] }), /at most 3/);
    const Tag = { text: "TAG", tone: "info" };
    assert.match(Refused({ announcements: [], tags: [Tag, Tag, Tag, Tag, Tag] }), /at most 4/);
    assert.equal(Valid({ announcements: [Announcement, Announcement, Announcement], tags: [Tag, Tag, Tag, Tag] })!.tags.length, 4);
});

test("announcement text: 1 to 280 characters, counted on the trimmed text", () => {
    assert.equal(Valid({ announcements: [{ text: "a".repeat(280), tone: "info" }], tags: [] })!.announcements[0]!.text.length, 280);
    assert.match(Refused({ announcements: [{ text: "a".repeat(281), tone: "info" }], tags: [] }), /announcements\[0\]\.text must be 1 to 280/);
    assert.match(Refused({ announcements: [{ text: "   ", tone: "info" }], tags: [] }), /announcements\[0\]\.text must be 1 to 280/);
    assert.match(Refused({ announcements: [{ text: 42, tone: "info" }], tags: [] }), /announcements\[0\]\.text must be text/);
    // 280 characters of a two-unit character still count as 280 (code points, not UTF-16 units).
    assert.equal(Valid({ announcements: [{ text: "\u{1F525}".repeat(280), tone: "info" }], tags: [] })!.announcements.length, 1);
    assert.match(Refused({ announcements: [{ text: "\u{1F525}".repeat(281), tone: "info" }], tags: [] }), /must be 1 to 280/);
});

test("tag text: 1 to 24 characters", () => {
    assert.equal(Valid({ announcements: [], tags: [{ text: "E".repeat(24), tone: "info" }] })!.tags[0]!.text.length, 24);
    assert.match(Refused({ announcements: [], tags: [{ text: "E".repeat(25), tone: "info" }] }), /tags\[0\]\.text must be 1 to 24/);
    assert.match(Refused({ announcements: [], tags: [{ text: "", tone: "info" }] }), /tags\[0\]\.text must be 1 to 24/);
});

test("plain text only: no line breaks or control characters, no angle brackets", () => {
    assert.match(Refused({ announcements: [{ text: "line one\nline two", tone: "info" }], tags: [] }), /one line of plain text/);
    assert.match(Refused({ announcements: [{ text: "tab\there", tone: "info" }], tags: [] }), /one line of plain text/);
    assert.match(Refused({ announcements: [{ text: "<b>bold</b>", tone: "info" }], tags: [] }), /no < or > characters/);
    assert.match(Refused({ announcements: [], tags: [{ text: "<i>", tone: "info" }] }), /no < or > characters/);
});

test("the {time} placeholder: needs eventAt, may appear once, and is the only brace", () => {
    assert.match(Refused({ announcements: [{ text: "Restart at {time}.", tone: "warning" }], tags: [] }),
        /announcements\[0\]\.eventAt is required when the text contains \{time\}/);
    assert.match(Refused({ announcements: [{ text: "{time} and {time}", tone: "warning", eventAt: "2026-10-16T00:00:00Z" }], tags: [] }),
        /may contain \{time\} once/);
    assert.match(Refused({ announcements: [{ text: "Restart at {Time}.", tone: "info", eventAt: "2026-10-16T00:00:00Z" }], tags: [] }),
        /may only use the \{time\} placeholder/);
    assert.match(Refused({ announcements: [{ text: "{{time}}", tone: "info", eventAt: "2026-10-16T00:00:00Z" }], tags: [] }),
        /may only use the \{time\} placeholder/);
    // Tags take no placeholder at all.
    assert.match(Refused({ announcements: [], tags: [{ text: "{time}", tone: "info" }] }), /does not take placeholders/);
    // eventAt without {time} is kept (the launcher then shows the text as written).
    assert.equal(Valid({ announcements: [{ text: "No token", tone: "info", eventAt: "2026-10-16T00:00:00Z" }], tags: [] })!.announcements[0]!.eventAt,
        "2026-10-16T00:00:00.000Z");
});

test("tones are fixed per list: announcements info|warning|critical, tags info|warning|danger|success", () => {
    assert.match(Refused({ announcements: [{ text: "x", tone: "danger" }], tags: [] }), /announcements\[0\]\.tone must be one of info, warning, critical/);
    assert.match(Refused({ announcements: [], tags: [{ text: "x", tone: "critical" }] }), /tags\[0\]\.tone must be one of info, warning, danger, success/);
    assert.equal(Valid({ announcements: [], tags: [{ text: "x", tone: "success" }] })!.tags[0]!.tone, "success");
    assert.match(Refused({ announcements: [{ text: "x" }], tags: [] }), /tone must be one of/);
});

test("ids: 1 to 64 letters, digits, dash or underscore; an id may appear once across both lists", () => {
    assert.match(Refused({ announcements: [{ id: "has space", text: "x", tone: "info" }], tags: [] }), /announcements\[0\]\.id must be 1 to 64/);
    assert.match(Refused({ announcements: [{ id: "a".repeat(65), text: "x", tone: "info" }], tags: [] }), /announcements\[0\]\.id must be 1 to 64/);
    assert.match(Refused({ announcements: [{ id: "", text: "x", tone: "info" }], tags: [] }), /announcements\[0\]\.id must be 1 to 64/);
    assert.match(Refused({
        announcements: [{ id: "same", text: "x", tone: "info" }],
        tags: [{ id: "same", text: "y", tone: "info" }]
    }), /The id same is used by more than one/);
    assert.match(Refused({
        announcements: [{ id: "dup", text: "x", tone: "info" }, { id: "dup", text: "y", tone: "info" }],
        tags: []
    }), /The id dup is used by more than one/);
});

test("eventAt must be a full ISO instant; tags do not take eventAt", () => {
    assert.match(Refused({ announcements: [{ text: "x", tone: "info", eventAt: "16 Oct 2026 00:00" }], tags: [] }),
        /announcements\[0\]\.eventAt must be an ISO time/);
    assert.match(Refused({ announcements: [{ text: "x", tone: "info", eventAt: "2026-10-16" }], tags: [] }),
        /announcements\[0\]\.eventAt must be an ISO time/);
    assert.match(Refused({ announcements: [], tags: [{ text: "x", tone: "info", eventAt: "2026-10-16T00:00:00Z" }] }),
        /tags\[0\] does not take eventAt/);
});

test("the window: showFrom and showUntil are ISO instants, and showUntil may not be before showFrom", () => {
    assert.match(Refused({ announcements: [{ text: "x", tone: "info", showFrom: "soon" }], tags: [] }),
        /announcements\[0\]\.showFrom must be an ISO time/);
    assert.match(Refused({ announcements: [], tags: [{ text: "x", tone: "info", showUntil: "2026-13-40T00:00:00Z" }] }),
        /tags\[0\]\.showUntil must be an ISO time/);
    assert.match(Refused({
        announcements: [{ text: "x", tone: "info", showFrom: "2026-10-16T01:00:00Z", showUntil: "2026-10-16T00:59:59Z" }],
        tags: []
    }), /announcements\[0\]\.showUntil is before showFrom/);
    // Equal bounds are accepted (an empty window: the item is never served).
    assert.equal(Valid({
        announcements: [{ text: "x", tone: "info", showFrom: "2026-10-16T01:00:00Z", showUntil: "2026-10-16T01:00:00Z" }], tags: []
    })!.announcements.length, 1);
});

test("a non-object entry and a non-array list are refused with the field named", () => {
    assert.match(Refused({ announcements: ["text"], tags: [] }), /announcements\[0\] must be an object/);
    assert.match(Refused({ announcements: [], tags: [null] }), /tags\[0\] must be an object/);
    assert.match(Refused({ announcements: "none", tags: [] }), /announcements must be a list/);
});

test("the reason: trimmed, 8 to 200 characters", () => {
    assert.deepEqual(ValidateLauncherNoticesReason("12345678"), { ok: true, value: "12345678" });
    assert.deepEqual(ValidateLauncherNoticesReason("   12345678   "), { ok: true, value: "12345678" });
    assert.equal(ValidateLauncherNoticesReason("1234567").ok, false);
    assert.equal(ValidateLauncherNoticesReason("       1234567   ").ok, false, "the spaces do not count");
    assert.equal(ValidateLauncherNoticesReason("a".repeat(200)).ok, true);
    const Long = ValidateLauncherNoticesReason("a".repeat(201));
    assert.equal(Long.ok, false);
    assert.match(Long.ok ? "" : Long.message, /8 to 200 characters/);
    assert.equal(ValidateLauncherNoticesReason(undefined).ok, false);
    assert.equal(ValidateLauncherNoticesReason(12345678).ok, false);
});

test("expectedVersion: a whole number of 0 or more; a missing or text value is refused, not read as 0", () => {
    assert.deepEqual(ValidateLauncherNoticesExpectedVersion(0), { ok: true, value: 0 });
    assert.deepEqual(ValidateLauncherNoticesExpectedVersion(7), { ok: true, value: 7 });
    for (const Bad of [undefined, null, "0", "7", -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        assert.equal(ValidateLauncherNoticesExpectedVersion(Bad).ok, false, `refuse ${String(Bad)}`);
    }
});

test("ParseLauncherNoticeInstant accepts full ISO instants only and returns the UTC form", () => {
    assert.equal(ParseLauncherNoticeInstant("2026-10-16T00:00:00Z"), "2026-10-16T00:00:00.000Z");
    assert.equal(ParseLauncherNoticeInstant("2026-10-16T05:30:00+05:30"), "2026-10-16T00:00:00.000Z");
    assert.equal(ParseLauncherNoticeInstant("2026-10-16T00:00:00.123456Z"), "2026-10-16T00:00:00.123Z");
    assert.equal(ParseLauncherNoticeInstant("2026-10-16"), undefined);
    assert.equal(ParseLauncherNoticeInstant("2026-10-16 00:00:00Z"), undefined);
    assert.equal(ParseLauncherNoticeInstant(1792108800000), undefined);
});

test("the active window: showFrom inclusive, showUntil exclusive, an absent bound is open, a bound that does not parse hides", () => {
    const Now = Date.parse("2026-10-16T00:00:00.000Z");
    assert.equal(IsLauncherNoticeActive({}, Now), true);
    assert.equal(IsLauncherNoticeActive({ showFrom: "2026-10-16T00:00:00.000Z" }, Now), true, "showFrom is inclusive");
    assert.equal(IsLauncherNoticeActive({ showFrom: "2026-10-16T00:00:00.001Z" }, Now), false, "not yet");
    assert.equal(IsLauncherNoticeActive({ showUntil: "2026-10-16T00:00:00.000Z" }, Now), false, "showUntil is exclusive");
    assert.equal(IsLauncherNoticeActive({ showUntil: "2026-10-16T00:00:00.001Z" }, Now), true);
    assert.equal(IsLauncherNoticeActive({ showFrom: "2026-10-15T00:00:00Z", showUntil: "2026-10-17T00:00:00Z" }, Now), true);
    assert.equal(IsLauncherNoticeActive({ showFrom: "garbage" }, Now), false, "a bound that does not parse hides the item");
    assert.equal(IsLauncherNoticeActive({ showUntil: "garbage" }, Now), false);
});

test("the public view: only the items active now, with the fields the launcher needs and no document metadata", () => {
    const Now = Date.parse("2026-10-16T00:10:00.000Z");
    const View = PublicLauncherNoticesView({
        version: 4,
        updatedAt: "2026-10-15T23:00:00.000Z",
        updatedBy: "manager:1",
        announcements: [
            { id: "live", text: "The backend service will restart at {time}.", tone: "warning", eventAt: "2026-10-16T00:00:00.000Z",
                showUntil: "2026-10-16T00:30:00.000Z" },
            { id: "later", text: "Not yet", tone: "info", showFrom: "2026-10-17T00:00:00.000Z" },
            { id: "over", text: "Over", tone: "info", showUntil: "2026-10-16T00:00:00.000Z" }
        ],
        tags: [
            { id: "tag", text: "EXPERIMENTAL BUILD", tone: "warning" },
            { id: "old-tag", text: "OLD", tone: "info", showUntil: "2026-10-01T00:00:00.000Z" }
        ]
    }, Now, "2026-10-16T00:10:00.000Z");
    assert.deepEqual(View, {
        announcements: [{ id: "live", text: "The backend service will restart at {time}.", tone: "warning",
            eventAt: "2026-10-16T00:00:00.000Z", showUntil: "2026-10-16T00:30:00.000Z" }],
        tags: [{ id: "tag", text: "EXPERIMENTAL BUILD", tone: "warning" }],
        serverTime: "2026-10-16T00:10:00.000Z"
    });
});

test("the public view of nothing saved is the empty set", () => {
    assert.deepEqual(PublicLauncherNoticesView(undefined, 0, "2026-10-16T00:10:00.000Z"),
        { announcements: [], tags: [], serverTime: "2026-10-16T00:10:00.000Z" });
    assert.deepEqual(EmptyLauncherNotices(), { version: 0, announcements: [], tags: [] });
});

test("the admin view: the whole document, inactive items included, absent metadata as null", () => {
    const Empty = AdminLauncherNoticesView(undefined, "2026-10-16T00:10:00.000Z");
    assert.deepEqual(Empty, { version: 0, updatedAt: null, updatedBy: null, announcements: [], tags: [], serverTime: "2026-10-16T00:10:00.000Z" });
    const Saved = AdminLauncherNoticesView({
        version: 2, updatedAt: "2026-10-15T23:00:00.000Z", updatedBy: "manager:1",
        announcements: [{ id: "old", text: "Old", tone: "info", showUntil: "2026-10-01T00:00:00.000Z" }], tags: []
    }, "2026-10-16T00:10:00.000Z");
    assert.equal(Saved.version, 2);
    assert.equal(Saved.updatedBy, "manager:1");
    assert.equal(Saved.announcements.length, 1, "an inactive item is still in the admin view");
});
