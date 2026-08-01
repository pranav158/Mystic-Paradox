import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AetherMark } from "../../components/AetherMark";

export function AboutTab() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="max-w-lg px-8 py-7">
      <h1 className="text-xl font-semibold tracking-tight text-text">About</h1>

      <div className="mt-7 rounded-2xl border border-border bg-surface p-6">
        <div className="flex items-center gap-3">
          <AetherMark size={30} />
          <div>
            <p className="text-[15px] font-semibold text-text">Mystic Paradox</p>
            <p className="text-xs text-text-muted">{version ? `Launcher v${version}` : "Launcher"}</p>
          </div>
        </div>

        <p className="mt-5 max-w-[60ch] text-[13px] leading-relaxed text-text-muted">
          An unofficial community preservation project keeping the Shattered Isles alive after the storm.
        </p>

        <div className="mt-5 flex gap-4 border-t border-border pt-4 text-[13px]">
          <a href="https://github.com/pranav158/Mystic-Paradox" target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
            Source code
          </a>
          <a href="https://github.com/pranav158/Mystic-Paradox?tab=AGPL-3.0-1-ov-file" target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
            AGPL-3.0 license
          </a>
        </div>
      </div>
    </div>
  );
}
