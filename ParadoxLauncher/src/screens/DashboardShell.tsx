import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";
import { AboutIcon, ChevronLeftIcon, ChevronRightIcon, HomeIcon, HostRealmIcon, LibraryIcon, RefreshIcon, ServersIcon, SettingsIcon } from "../components/icons";
import { AetherMark } from "../components/AetherMark";
import { useAuth } from "../auth/AuthContext";
import { useServer } from "../servers/ServerContext";
import { serverNaming } from "../servers/serverNames";
import { RealmInvitesProvider, useRealmInvites } from "../servers/RealmInvites";
import { ServicesProvider, useServices, type ServiceHealth } from "../services/ServicesContext";
import { setUiPrefs, useMediaQuery, useUiPrefs } from "../lib/prefs";
import { prefersReducedMotion, withViewTransition } from "../lib/platform";
import { buildName, formatClock } from "../lib/sessions";
import { OPTIONAL_PANELS } from "../lib/optionalPanels";
import { NoticeDock, NoticeTags } from "../components/NoticeBanner";
import { HomeTab } from "./dashboard/HomeTab";
import { LibraryTab } from "./dashboard/LibraryTab";
import { ServersTab } from "./dashboard/ServersTab";
import { HostRealmTab } from "./dashboard/HostRealmTab";
import { AccountTab } from "./dashboard/AccountTab";
import { SettingsTab } from "./dashboard/SettingsTab";
import { AboutTab } from "./dashboard/AboutTab";

export type Tab = "home" | "library" | "servers" | "host" | "account" | "settings" | "about";

type NavItem = { id: Tab; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

// [2026-10-14] "Host realm" exists only when a build ships an optional module's panel (src/p2p/*Panel.tsx). A public build
// has no such tab, so no nav item and no route to it.
const HOST_NAV_ITEM: NavItem = { id: "host", label: "Host realm", icon: HostRealmIcon };
const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "library", label: "Library", icon: LibraryIcon },
  // [2026-10-16] "Realms" (was "Servers & realms"): local servers are gone, so the page lists the official server and realms.
  { id: "servers", label: "Realms", icon: ServersIcon },
  ...(OPTIONAL_PANELS.length > 0 ? [HOST_NAV_ITEM] : []),
  { id: "settings", label: "Settings", icon: SettingsIcon },
  { id: "about", label: "About", icon: AboutIcon },
];

const SERVICE_TITLE: Record<ServiceHealth, string> = {
  checking: "Checking services",
  online: "Services online",
  degraded: "Service attention",
  unreachable: "Connection lost",
};

// [2026-10-13 realms S5] The card shows the SELECTED server's backend, so a local server is named instead of "Mystic Paradox".
function serviceDetail(health: ServiceHealth, serverName: string | null): string {
  const name = serverName ?? "Mystic Paradox";
  switch (health) {
    case "checking": return `Contacting ${name}…`;
    case "online": return serverName ? `${serverName} backend healthy` : "Backend healthy";
    case "degraded": return serverName ? `${serverName} reports an issue` : "Backend reports an issue";
    default: return serverName ? `Can't reach ${serverName}` : "Can't reach the service";
  }
}

function ServicesCard() {
  const { health, checkedAt, refreshing, supportedChangelist, refresh } = useServices();
  const { selected } = useServer();
  // Only a server other than the built-in official one is named (a realm by its realm name, servers/serverNames.ts).
  const serverName = selected && selected.kind !== "official" ? serverNaming(selected).primary : null;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // [2026-10-14] Escape closes the panel and returns focus to its trigger, so keyboard focus is not left in the hidden panel.
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const healthDetail = serviceDetail(health, serverName);
  const detail = refreshing ? "Refreshing…" : checkedAt ? `${healthDetail} · ${formatClock(checkedAt)}` : healthDetail;
  const supportedBuild = supportedChangelist ? `${buildName(supportedChangelist) ?? "CL"} · ${supportedChangelist}` : "Unknown";

  return (
    <div className="services-wrap" ref={wrapRef}>
      <div className="glass glass-strong services-pop" data-open={open} role="dialog" aria-label="Service status" aria-hidden={!open}>
        <div className="pop-title">
          <span>Service status</span>
          <button type="button" className={`icon-button${refreshing ? " spinning" : ""}`} onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh service status" tabIndex={open ? 0 : -1}>
            <RefreshIcon />
          </button>
        </div>
        <dl className="pop-rows">
          {serverName && (<><dt>Server</dt><dd className="truncate" title={serverName}>{serverName}</dd></>)}
          <dt>Backend</dt>
          <dd>{SERVICE_TITLE[health].replace("Services ", "")}</dd>
          <dt>Accepted build</dt>
          <dd>{supportedBuild}</dd>
          <dt>Last check</dt>
          <dd>{checkedAt ? formatClock(checkedAt) : "—"}</dd>
        </dl>
      </div>
      <button
        ref={triggerRef}
        type="button"
        className="services"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-tip={SERVICE_TITLE[health]}
      >
        <span className={`status-dot ${health}`} aria-hidden="true" />
        <span className="services-copy">
          <span className="services-title" aria-live="polite">{SERVICE_TITLE[health]}</span>
          <span className="services-sub">{detail}</span>
        </span>
        <ChevronRightIcon className="chev" />
      </button>
    </div>
  );
}

function Shell() {
  const { account } = useAuth();
  // [2026-10-16] Realm invites waiting for an answer: counted on the Realms item.
  const { invites } = useRealmInvites();
  const prefs = useUiPrefs();
  const narrow = useMediaQuery("(max-width: 1099px)");
  const compact = prefs.sidebar === "compact" || (prefs.sidebar === "auto" && narrow);
  const [tab, setTab] = useState<Tab>(initialTab);
  const mainRef = useRef<HTMLElement>(null);

  const navigate = useCallback((next: Tab) => {
    if (next === tab) return;
    withViewTransition(() => setTab(next));
    mainRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const navIndex = NAV_ITEMS.findIndex((item) => item.id === tab);
  const displayName = account?.displayName ?? "Slayer";
  const accountLine = account?.status === "active" && account.approvalStatus === "approved" ? "Signed in" : "Check account";

  let page;
  switch (tab) {
    case "home": page = <HomeTab onOpenAccount={() => navigate("account")} onNavigate={navigate} />; break;
    case "library": page = <LibraryTab />; break;
    case "servers": page = <ServersTab />; break;
    case "host": page = <HostRealmTab />; break;
    case "account": page = <AccountTab />; break;
    case "settings": page = <SettingsTab />; break;
    default: page = <AboutTab />;
  }

  return (
    <div className="shell" data-compact={compact}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><AetherMark title={null} /></div>
          <p className="brand-name">Mystic Paradox</p>
          <p className="brand-sub">Dauntless Server</p>
          {/* [2026-10-15] The launcher's tags (EXPERIMENTAL BUILD and the like); hidden in the collapsed rail. */}
          <NoticeTags className="brand-tags" />
        </div>

        <nav className="nav" aria-label="Launcher navigation" style={{ "--nav-index": Math.max(navIndex, 0) } as CSSProperties}>
          <span className="nav-indicator" data-hidden={navIndex < 0} aria-hidden="true" />
          {NAV_ITEMS.map(({ id, label, icon: ItemIcon }) => {
            const count = id === "servers" ? invites.length : 0;
            const tip = count > 0 ? `${label} · ${count === 1 ? "1 invite" : `${count} invites`}` : label;
            return (
              <button
                key={id}
                type="button"
                className="nav-item"
                aria-current={tab === id ? "page" : undefined}
                onClick={() => navigate(id)}
                data-tip={tip}
                aria-label={count > 0 ? tip : undefined}
              >
                <ItemIcon />
                <span className="nav-label">{label}</span>
                {count > 0 && <span className="nav-badge" aria-hidden="true">{count}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="collapse-toggle"
            onClick={() => setUiPrefs({ sidebar: compact ? "expanded" : "compact" })}
            aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
            data-tip={compact ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronLeftIcon />
            <span className="collapse-label">Collapse sidebar</span>
          </button>
          <button
            type="button"
            className="me"
            aria-current={tab === "account" ? "page" : undefined}
            onClick={() => navigate("account")}
            data-tip={displayName}
          >
            <span className="avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            <span className="me-copy">
              <span className="me-name">{displayName}</span>
              <span className="me-sub">{accountLine}</span>
            </span>
          </button>
          <ServicesCard />
        </div>
      </aside>

      <main className="main" ref={mainRef} aria-label="Launcher content">
        {/* [2026-10-15] The sticky announcement, above the tab's page (outside it, so it does not replay on a tab change). */}
        <NoticeDock page={tab !== "home"} />
        <div key={tab} className={`page-host${supportsViewTransitions() ? "" : " page-enter"}`}>
          {page}
        </div>
      </main>
    </div>
  );
}

// Dev browser preview only: `?tab=library` opens a tab directly for screenshots.
function initialTab(): Tab {
  if (!import.meta.env.DEV) return "home";
  const requested = new URLSearchParams(window.location.search).get("tab");
  return NAV_ITEMS.find((item) => item.id === requested)?.id ?? "home";
}

// With View Transitions the page cross-fade is the entry animation; otherwise a CSS rise.
function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document && !prefersReducedMotion();
}

export function DashboardShell() {
  return (
    <ServicesProvider>
      <RealmInvitesProvider>
        <Shell />
      </RealmInvitesProvider>
    </ServicesProvider>
  );
}
