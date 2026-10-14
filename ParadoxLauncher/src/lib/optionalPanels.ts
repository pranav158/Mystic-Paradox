import type { ComponentType, CSSProperties } from "react";

// Panels of an optional launcher module (src/p2p/*Panel.tsx), loaded the way SettingsTab loads its cards. A build
// without that folder has none, and the Servers page then shows exactly what it showed before. Each panel decides for
// itself whether it applies to the selected server.
export const OPTIONAL_PANELS: ComponentType<{ style: CSSProperties }>[] = Object.values(
  import.meta.glob<{ default: ComponentType<{ style: CSSProperties }> }>("../p2p/*Panel.tsx", { eager: true }),
).map((module) => module.default);
