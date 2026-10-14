/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { CSSProperties } from "react";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { OPTIONAL_PANELS } from "../../lib/optionalPanels";

// [2026-10-14] The Host realm page: the panels of an optional module (src/p2p/*Panel.tsx, such as RealmHostPanel). The
// DashboardShell offers this tab only when at least one such panel is present, so a public build never reaches this page.
// Each panel decides for itself whether it applies to the selected server; a local server shows only this header.

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

export function HostRealmTab() {
  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Paradox realm</p>
          <h1 className="page-title">Host realm</h1>
          <p className="page-desc">
            Run your realm on this PC: Ramsgate, Training and the hunts, for the players you invite. It is available when
            the official server or a Paradox realm is selected in Servers &amp; realms.
          </p>
        </header>

        {OPTIONAL_PANELS.map((Panel, index) => <Panel key={index} style={at(1 + index)} />)}
      </div>
    </div>
  );
}
