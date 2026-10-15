// [2026-10-15] Launcher notices: the `{time}` token. Pure apart from the two viewer readers at the bottom, so the workflow
// tests load it as it is. The app always passes this PC's own zone and clock (viewerTimeZone, new Date()); the explicit
// `locale` and `timeZone` parameters exist so the tests can pin them.

const TIME_TOKEN = "{time}";
/** The suffix on the viewer's part: "00:00 UTC · 05:30 IST (local time)". */
const LOCAL_SUFFIX = " (local time)";
/** The clock is always 24-hour HH:mm with Latin digits, whatever the viewer's locale. */
const CLOCK_LOCALE = "en-GB";
/** A zone name like `GMT+5:30` is not a letter abbreviation: these locales are asked for one, in this order. */
const ABBREVIATION_LOCALES = ["en-IN", "en-US"];
const OFFSET_NAME = /^(GMT|UTC)[+-]/;

/** The PC's own zone, as Windows reports it through WebView2. Undefined when the runtime cannot say. */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The PC's own language, for the zone name and the date. Undefined lets Intl choose. */
export function viewerLocale(): string | undefined {
  try {
    return (typeof navigator !== "undefined" && navigator.language) || undefined;
  } catch {
    return undefined;
  }
}

function part(formatter: Intl.DateTimeFormat, date: Date, type: Intl.DateTimeFormatPartTypes): string {
  return formatter.formatToParts(date).find((item) => item.type === type)?.value ?? "";
}

function utcClock(date: Date): string {
  return new Intl.DateTimeFormat(CLOCK_LOCALE, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function zoneClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(CLOCK_LOCALE, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** The calendar day in the zone as `YYYY-MM-DD`, for comparing days (never shown). */
function dayKey(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return `${part(formatter, date, "year")}-${part(formatter, date, "month")}-${part(formatter, date, "day")}`;
}

function dateLabel(date: Date, locale: string | undefined, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short" }).format(date);
}

function shortZoneName(date: Date, locale: string | undefined, timeZone: string): string {
  return part(new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }), date, "timeZoneName");
}

/** The zone's letter abbreviation (IST, EDT, BST): the viewer's locale first, then en-IN and en-US for a `GMT+x` name. */
function zoneAbbreviation(date: Date, locale: string | undefined, timeZone: string): string {
  const own = shortZoneName(date, locale, timeZone);
  if (own && !OFFSET_NAME.test(own)) return own;
  for (const fallback of ABBREVIATION_LOCALES) {
    const name = shortZoneName(date, fallback, timeZone);
    if (name && !OFFSET_NAME.test(name)) return name;
  }
  return own;
}

/** True for every name of UTC that the runtime canonicalises (UTC, Etc/UTC, GMT, Zulu). Europe/London in winter is not. */
function isUtcZone(timeZone: string): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone === "UTC";
}

/**
 * The text that replaces `{time}`, or null when there is no usable event time.
 * - `00:00 UTC · 05:30 IST (local time)`: the UTC clock, then the viewer's clock and zone name.
 * - In a zone that is UTC itself: only `00:00 UTC`.
 * - When the event falls on another calendar day in the viewer's zone, the local date comes first: `Fri 16 Oct, 05:30 IST`.
 * - A zone the PC does not report (missing or invalid): only the UTC part.
 */
export function formatNoticeTime(
  eventAt: string | null | undefined,
  now: Date,
  locale: string | undefined,
  timeZone: string | undefined,
): string | null {
  if (!eventAt) return null;
  const event = new Date(eventAt);
  if (Number.isNaN(event.getTime()) || Number.isNaN(now.getTime())) return null;
  const utc = `${utcClock(event)} UTC`;
  if (!timeZone) return utc;
  try {
    const sameDay = dayKey(event, timeZone) === dayKey(now, timeZone);
    if (isUtcZone(timeZone)) {
      return sameDay ? utc : `${dateLabel(event, locale, timeZone)}, ${utc}`;
    }
    const clock = `${zoneClock(event, timeZone)} ${zoneAbbreviation(event, locale, timeZone)}`.trim();
    const local = sameDay ? clock : `${dateLabel(event, locale, timeZone)}, ${clock}`;
    return `${utc} · ${local}${LOCAL_SUFFIX}`;
  } catch {
    // The runtime refused the zone or the locale: show the part that does not depend on them.
    return utc;
  }
}

/**
 * The announcement text with `{time}` expanded. Without a usable time the token goes, with the preposition in front of it
 * ("will restart at {time}." reads "will restart."), so no broken sentence is shown.
 */
export function expandNoticeText(
  text: string,
  eventAt: string | null | undefined,
  now: Date,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  if (!text.includes(TIME_TOKEN)) return text;
  const phrase = formatNoticeTime(eventAt, now, locale, timeZone);
  if (phrase) return text.split(TIME_TOKEN).join(phrase);
  return text
    .replace(/\s+(?:at|on|from|until|by)\s*\{time\}/gi, "")
    .split(TIME_TOKEN)
    .join("")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}
