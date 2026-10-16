// [2026-10-15] The launcher notices on screen: the announcement banner (sticky, not dismissible), the dashboard's dock that
// keeps it at the top of the content area, and the tags under the sidebar wordmark and in the sign-in header. Text only:
// React escapes every string, so the notice text is never markup.
import type { LauncherAnnouncement, TagTone } from "../api/types";
import { useNotices } from "../notices/NoticesContext";
import { useServer } from "../servers/ServerContext";
import type { LauncherNotices } from "../api/types";
import { expandNoticeText, viewerLocale, viewerTimeZone } from "../notices/noticeTime";
import { useBuildBadge } from "../lib/buildKind";
import { AlertIcon, InfoIcon } from "./icons";

/**
 * The clock the `{time}` token is read with. The app passes nothing: it is this PC's clock and zone. The tests pin all
 * three so the output does not depend on the machine that runs them.
 */
export interface NoticeClock {
  now?: Date;
  locale?: string;
  timeZone?: string;
}

const BANNER_TONE: Record<LauncherAnnouncement["tone"], string> = {
  info: "notice-info",
  warning: "notice-warning",
  critical: "notice-critical",
};

const TAG_TONE: Record<TagTone, string> = {
  info: "accent",
  warning: "warn",
  danger: "bad",
  success: "good",
};

/** The clock a line is read with: the given one, or this PC's (undefined where the runtime cannot tell). */
interface ResolvedClock {
  now: Date;
  locale: string | undefined;
  timeZone: string | undefined;
}

interface NoticeLineProps {
  announcement: LauncherAnnouncement;
  clock: ResolvedClock;
}

function NoticeLine({ announcement, clock }: NoticeLineProps) {
  const critical = announcement.tone === "critical";
  return (
    <div
      role={critical ? "alert" : "status"}
      className={`notice-banner ${BANNER_TONE[announcement.tone] ?? "notice-info"}`}
      data-tone={announcement.tone}
    >
      {announcement.tone === "info" ? <InfoIcon /> : <AlertIcon />}
      <p>{expandNoticeText(announcement.text, announcement.eventAt, clock.now, clock.locale, clock.timeZone)}</p>
    </div>
  );
}

const NO_NOTICES: LauncherNotices = { announcements: [], tags: [] };

/**
 * [2026-10-15] The notices to show: the official backend's, while the selected server is on the official network (the official
 * server or a Paradox realm). A local (self-hosted) server is somebody else's: our "backend restart" banner and tags would be
 * wrong there, so nothing shows.
 */
function useShownNotices(): LauncherNotices {
  const notices = useNotices();
  const { officialNetwork } = useServer();
  return officialNetwork ? notices : NO_NOTICES;
}

/** Every announcement, stacked in the order the backend sent them. Renders nothing when there are none. */
export function NoticeBanner({ className, clock }: { className?: string; clock?: NoticeClock }) {
  const { announcements } = useShownNotices();
  if (announcements.length === 0) return null;
  const resolved: ResolvedClock = {
    now: clock?.now ?? new Date(),
    locale: clock?.locale ?? viewerLocale(),
    timeZone: clock?.timeZone ?? viewerTimeZone(),
  };
  return (
    <div className={`notice-stack${className ? ` ${className}` : ""}`}>
      {announcements.map((announcement) => (
        <NoticeLine key={announcement.id} announcement={announcement} clock={resolved} />
      ))}
    </div>
  );
}

/**
 * The dashboard's strip: at the top of the content area on every tab, below the title bar, and kept in view while the page
 * scrolls. Renders nothing without announcements, so the page layout is unchanged then.
 */
export function NoticeDock({ page = false }: { page?: boolean }) {
  const { announcements } = useShownNotices();
  if (announcements.length === 0) return null;
  return (
    // [2026-10-16] `page`: above a page other than Home, the banner keeps to the page's content width.
    <div className={`notice-dock${page ? " is-page" : ""}`}>
      <NoticeBanner />
    </div>
  );
}

/**
 * The chips: small uppercase labels, one per tag, in the order the backend sent them, then this launcher's own build badge
 * ([2026-10-16] UNOFFICIAL BUILD / DEVELOPMENT BUILD; none on the official build). The badge is the launcher's, not the
 * server's, so it shows on every server. Renders nothing without tags or badge.
 */
export function NoticeTags({ className }: { className?: string }) {
  const { tags } = useShownNotices();
  const badge = useBuildBadge();
  if (tags.length === 0 && !badge) return null;
  return (
    <ul className={`notice-tags${className ? ` ${className}` : ""}`} aria-label="Launcher notices">
      {tags.map((tag) => (
        <li key={tag.id}>
          <span className={`chip notice-tag ${TAG_TONE[tag.tone] ? TAG_TONE[tag.tone] : "accent"}`}>{tag.text}</span>
        </li>
      ))}
      {badge && (
        <li key="build-kind">
          <span className={`chip notice-tag build-badge${badge.tone ? ` ${badge.tone}` : ""}`} title={badge.title}>
            {badge.text}
          </span>
        </li>
      )}
    </ul>
  );
}
