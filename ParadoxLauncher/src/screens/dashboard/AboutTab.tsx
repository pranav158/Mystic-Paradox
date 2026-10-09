import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AetherMark } from "../../components/AetherMark";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { ExternalIcon, LinkIcon, ShieldIcon } from "../../components/icons";
import { useServices } from "../../services/ServicesContext";
import { buildName } from "../../lib/sessions";

const LINKS = [
  { href: "https://github.com/pranav158/Mystic-Paradox", label: "Source code", sub: "GitHub", icon: LinkIcon },
  { href: "https://github.com/pranav158/Mystic-Paradox?tab=AGPL-3.0-1-ov-file", label: "AGPL-3.0 license", sub: "Your rights to this software", icon: ShieldIcon },
  { href: "https://github.com/SyST3MDeV/Undaunted", label: "Undaunted by gwog", sub: "The original work this project builds on", icon: LinkIcon },
];

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

function openExternal(event: MouseEvent<HTMLAnchorElement>, href: string) {
  // Open in the system browser; fall back to the anchor if the opener is unavailable.
  event.preventDefault();
  openUrl(href).catch(() => window.open(href, "_blank", "noopener"));
}

export function AboutTab() {
  const [version, setVersion] = useState("");
  const { supportedChangelist } = useServices();

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">The launcher</p>
          <h1 className="page-title">About</h1>
          <p className="page-desc">Project information, versions and source links.</p>
        </header>

        <section className="glass glow card reveal" style={at(1)}>
          <div className="about-hero">
            <div className="about-mark"><AetherMark title={null} /></div>
            <div>
              <h2 className="about-title">Mystic Paradox</h2>
              <p className="section-desc">An unofficial community preservation project keeping the Shattered Isles alive after the storm.</p>
              <div className="game-tile-meta">
                <span className="chip accent">{version ? `Launcher v${version}` : "Launcher"}</span>
                {supportedChangelist && (
                  <span className="chip">Server build {buildName(supportedChangelist) ?? `CL ${supportedChangelist}`}</span>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="glass card reveal" style={at(2)} aria-label="Links">
          <div className="section">
            <div className="link-list">
              {LINKS.map(({ href, label, sub, icon: Icon }) => (
                <a key={href} className="link-row" href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => openExternal(event, href)}>
                  <Icon />
                  <span className="grow">
                    {label}
                    <span className="sub">{sub}</span>
                  </span>
                  <ExternalIcon />
                </a>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
