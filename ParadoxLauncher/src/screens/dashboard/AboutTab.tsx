import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AetherMark } from "../../components/AetherMark";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { ExternalIcon, LinkIcon, ShieldIcon } from "../../components/icons";
import { useServices } from "../../services/ServicesContext";
import { buildName } from "../../lib/sessions";
import { useLegalViewer } from "../../components/LegalDocument";
import { LEGAL } from "../../legal/legalMeta";

// [2026-10-15] The attribution notice that ADDITIONAL_TERMS.md (section 1) asks for in the Appropriate Legal Notices. The launcher is
// the project's own code, so it shows no upstream credit; the original authors' notices stay in the source and NOTICE.md.
const NOTICE_URL = "https://github.com/pranav158/Mystic-Paradox/blob/main/NOTICE.md";

const LINKS = [
  { href: "https://github.com/pranav158/Mystic-Paradox", label: "Mystic Paradox source code", sub: "GitHub", icon: LinkIcon },
  { href: "https://github.com/pranav158/Mystic-Paradox?tab=AGPL-3.0-1-ov-file", label: "AGPL-3.0 license", sub: "Your rights to this software", icon: ShieldIcon },
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
  const legal = useLegalViewer();

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

        <section className="glass card reveal" style={at(3)} aria-label="Licence and disclaimer">
          <div className="section">
            <p className="section-desc">
              Mystic Paradox is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). It comes
              with no warranty. If you run a changed version for other people over a network, the licence requires you to
              offer them its source.
            </p>
            <p className="section-desc">Copyright (C) 2026 MysticFox / Pranav Karande</p>
            <p className="section-desc">
              Mystic Paradox&apos;s Dauntless 1.12.0 and 1.14.7 ports and related modifications were developed by MysticFox /
              Pranav Karande. See{" "}
              <a href={NOTICE_URL} target="_blank" rel="noopener noreferrer" onClick={(event) => openExternal(event, NOTICE_URL)}>
                NOTICE.md
              </a>{" "}
              for contribution and provenance information.
            </p>
            <p className="section-desc">
              Mystic Paradox is not affiliated with, endorsed by or supported by the owners of Dauntless.
            </p>
          </div>
        </section>

        {/* [2026-10-14] The Terms of Use and Privacy Policy, read in the launcher. */}
        <section className="glass card reveal" style={at(4)} aria-label="Terms and privacy">
          <div className="section">
            <div className="link-list">
              <button type="button" className="link-row" onClick={() => legal.open("terms")}>
                <ShieldIcon />
                <span className="grow">
                  Terms of Use
                  <span className="sub">Version {LEGAL.termsVersion}</span>
                </span>
              </button>
              <button type="button" className="link-row" onClick={() => legal.open("privacy")}>
                <ShieldIcon />
                <span className="grow">
                  Privacy Policy
                  <span className="sub">Version {LEGAL.privacyVersion}</span>
                </span>
              </button>
            </div>
          </div>
        </section>

        {legal.dialog}
      </div>
    </div>
  );
}
