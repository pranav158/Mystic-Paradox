import { useState, type ComponentType, type SVGProps } from "react";
import { useAuth } from "../auth/AuthContext";
import { usePolicy } from "../policy/PolicyContext";
import { HomeIcon, LibraryIcon, AccountIcon, SettingsIcon, AboutIcon } from "../components/icons";
import mysticLogo from "../assets/mystic_full.png";
import { HomeTab } from "./dashboard/HomeTab";
import { LibraryTab } from "./dashboard/LibraryTab";
import { AccountTab } from "./dashboard/AccountTab";
import { SettingsTab } from "./dashboard/SettingsTab";
import { AboutTab } from "./dashboard/AboutTab";

type Tab = "home" | "library" | "account" | "settings" | "about";

const NAV_ITEMS: { id: Tab; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "home", label: "Home", icon: HomeIcon },
  { id: "library", label: "Library", icon: LibraryIcon },
  { id: "account", label: "Account", icon: AccountIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
  { id: "about", label: "About", icon: AboutIcon },
];

const TAB_CONTENT: Record<Tab, ComponentType> = {
  home: HomeTab,
  library: LibraryTab,
  account: AccountTab,
  settings: SettingsTab,
  about: AboutTab,
};

export function DashboardShell() {
  const { account } = useAuth();
  const { policy } = usePolicy();
  const isTester = policy?.roles.includes("tester") ?? false;
  const [tab, setTab] = useState<Tab>("home");
  const ActiveTab = TAB_CONTENT[tab];
  const activeLabel = NAV_ITEMS.find((item) => item.id === tab)?.label ?? "Home";

  return (
    <div className="flex h-full bg-bg">
      <nav className="flex w-[232px] shrink-0 flex-col border-r border-border bg-surface/90 px-3 pb-3 pt-5 shadow-[12px_0_40px_-32px] shadow-black">
        <div className="mb-6 flex flex-col items-center px-2">
          <img
            src={mysticLogo}
            alt="Mystic Development"
            className="h-[112px] w-[150px] object-contain drop-shadow-[0_0_18px_rgba(139,116,255,0.16)]"
          />
          <p className="-mt-1 rounded-full border border-border/80 bg-bg/60 px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-text-faint">
            Dauntless 1.12.0
          </p>
        </div>

        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-faint">Launcher</p>
        <div className="flex flex-col gap-1" role="tablist" aria-orientation="vertical">
          {NAV_ITEMS.map(({ id, label, icon: ItemIcon }) => {
            const active = tab === id;

            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                aria-current={active ? "page" : undefined}
                onClick={() => setTab(id)}
                className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-[background-color,color] duration-150 ease-(--ease-out-quart) ${
                  active
                    ? "bg-accent-muted/60 text-text shadow-[inset_0_0_20px_-12px] shadow-accent"
                    : "text-text-muted hover:bg-surface-raised hover:text-text"
                }`}
              >
                {active && <span aria-hidden className="absolute left-0 h-5 w-0.5 rounded-full bg-accent" />}
                <ItemIcon className={`h-4 w-4 shrink-0 transition-colors ${active ? "text-accent" : "group-hover:text-text"}`} />
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-auto flex items-center gap-2.5 rounded-xl border border-border bg-bg/50 p-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-muted text-xs font-semibold text-accent-hover">
            {(account?.displayName ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-text">{account?.displayName}</p>
            <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-online" />
              Online
            </p>
          </div>
        </div>
        <p className="mt-3 px-2 text-[10px] text-text-faint">{isTester ? "Tester build" : "Preview build"} · private server</p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/80 bg-bg/70 px-8 backdrop-blur-sm">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-faint">Mystic Paradox</p>
            <p className="mt-0.5 text-sm font-medium text-text">{activeLabel}</p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5 text-[11px] text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-online shadow-[0_0_8px] shadow-online" />
            Services online
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <ActiveTab />
        </main>
      </div>
    </div>
  );
}
