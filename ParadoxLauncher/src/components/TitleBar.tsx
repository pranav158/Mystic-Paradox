import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from "./icons";
import { isTauri } from "../lib/platform";

/**
 * The window is frameless (tauri.conf.json `decorations: false`), so this draws the drag region
 * and the window controls over the artwork. Nothing interactive may sit under the top strip.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      appWindow.isMaximized().then((value) => { if (!cancelled) setMaximized(value); }).catch(() => {});
    };
    sync();
    appWindow.onResized(sync).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;
  const appWindow = getCurrentWindow();

  return (
    <div className="titlebar">
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="window-controls">
        <button type="button" className="wc" aria-label="Minimize" onClick={() => void appWindow.minimize()}>
          <MinimizeIcon />
        </button>
        <button type="button" className="wc" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void appWindow.toggleMaximize()}>
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" className="wc wc-close" aria-label="Close" onClick={() => void appWindow.close()}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
