import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";
import { AboutIcon, ChevronLeftIcon, ChevronRightIcon, HomeIcon, LibraryIcon, RefreshIcon, SettingsIcon } from "../components/icons";
import { AetherMark } from "../components/AetherMark";
import { useAuth } from "../auth/AuthContext";
import { ServicesProvider, useServices, type ServiceHealth } from "../services/ServicesContext";
import { setUiPrefs, useMediaQuery, useUiPrefs } from "../lib/prefs";
import { prefersReducedMotion, withViewTransition } from "../lib/platform";
import { buildName, formatClock } from "../lib/sessions";
import { HomeTab } from "./dashboard/HomeTab";
import { LibraryTab } from "./dashboard/LibraryTab";
import { AccountTab } from "./dashboard/AccountTab";
import { SettingsTab } from "./dashboard/SettingsTab";
import { AboutTab } from "./dashboard/AboutTab";

export type Tab = "home" | "library" | "account" | "settings" | "about";

const NAV_ITEMS: { id: Tab; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "library", label: "Library", icon: LibraryIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
  { id: "about", label: "About", icon: AboutIcon },
];

const SERVICE_TITLE: Record<ServiceHealth, string> = {
  checking: "Checking services",
  online: "Services online",
  degraded: "Service attention",
  unreachable: "Connection lost",
};

const SERVICE_DETAIL: Record<ServiceHealth, string> = {
  checking: "Contacting Mystic Paradox…",
  online: "Backend healthy",
  degraded: "Backend reports an issue",
  unreachable: "Can't reach the service",
};

function ServicesCard() {
  const { health, checkedAt, refreshing, supportedChangelist, refresh } = useServices();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const detail = refreshing ? "Refreshing…" : checkedAt ? `${SERVICE_DETAIL[health]} · ${formatClock(checkedAt)}` : SERVICE_DETAIL[health];
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
          <dt>Backend</dt>
          <dd>{SERVICE_TITLE[health].replace("Services ", "")}</dd>
          <dt>Accepted build</dt>
          <dd>{supportedBuild}</dd>
          <dt>Last check</dt>
          <dd>{checkedAt ? formatClock(checkedAt) : "—"}</dd>
        </dl>
      </div>
      <button
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
        </div>

        <nav className="nav" aria-label="Launcher navigation" style={{ "--nav-index": Math.max(navIndex, 0) } as CSSProperties}>
          <span className="nav-indicator" data-hidden={navIndex < 0} aria-hidden="true" />
          {NAV_ITEMS.map(({ id, label, icon: ItemIcon }) => (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => navigate(id)}
              data-tip={label}
            >
              <ItemIcon />
              <span className="nav-label">{label}</span>
            </button>
          ))}
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
  return requested === "library" || requested === "account" || requested === "settings" || requested === "about" ? requested : "home";
}

// With View Transitions the page cross-fade is the entry animation; otherwise a CSS rise.
function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document && !prefersReducedMotion();
}

export function DashboardShell() {
  return (
    <ServicesProvider>
      <Shell />
    </ServicesProvider>
  );
}
