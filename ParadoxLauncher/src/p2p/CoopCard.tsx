import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeError } from "../lib/sanitize";
import { formatClock } from "../lib/sessions";
import { CoopIcon } from "../components/icons";

// Settings → co-op card. SettingsTab loads every src/p2p/*Card.tsx it finds, so a launcher without this folder has no
// card; with it, the card shows only while the co-op switch is on (server enabled, signed co-op files installed).

interface P2PHostSettings {
  available: boolean;
  memoryNotice: string;
  transportReady: boolean;
  transportStatus: "DETECTING" | "READY" | "UNAVAILABLE";
  transportStatusDetail: string;
  transportCheckedAt?: string | null;
}

export default function CoopCard({ style }: { style: CSSProperties }) {
  const [hostSettings, setHostSettings] = useState<P2PHostSettings | null>(null);
  const [hostSettingsError, setHostSettingsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => void invoke<P2PHostSettings>("native_get_p2p_host_settings").then((next) => {
      if (cancelled) return;
      setHostSettings(next);
      setHostSettingsError(null);
    }).catch((err) => {
      if (!cancelled) setHostSettingsError(sanitizeError(err instanceof Error ? err.message : String(err)));
    });
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (hostSettings && !hostSettings.available) return null;

  const checkedAt = hostSettings?.transportCheckedAt ? Date.parse(hostSettings.transportCheckedAt) : NaN;
  // The connection idles until Play; only an actual error is a warning.
  const tone = hostSettingsError ? "warn" : hostSettings?.transportReady ? "good" : "";

  return (
    <section className="glass card reveal" style={style} aria-label="Co-op">
      <div className="section">
        <div className="section-head">
          <div className={`section-icon${tone ? ` ${tone}` : ""}`}><CoopIcon /></div>
          <div>
            <h2 className="section-title">Co-op connection</h2>
            <p className="section-desc">{hostSettings?.transportStatusDetail ?? "Checking the co-op connection…"}</p>
          </div>
        </div>
        <dl className="kv">
          {!Number.isNaN(checkedAt) && (<><dt>Status updated</dt><dd>{formatClock(checkedAt)}</dd></>)}
          {hostSettings?.memoryNotice && (<><dt>Hosting</dt><dd>{hostSettings.memoryNotice}</dd></>)}
        </dl>
        {hostSettingsError && <p className="feedback bad" role="alert">{hostSettingsError}</p>}
        <p className="note">Co-op hunts connect players through an encrypted relay; it carries game traffic only. Party hosting is chosen automatically when co-op hunts are enabled for your account.</p>
      </div>
    </section>
  );
}
