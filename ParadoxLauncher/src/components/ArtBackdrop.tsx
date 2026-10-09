import type { CSSProperties } from "react";
import heroArt from "../assets/home-shattered-isles.webp";

// Fixed (not random) so the motes don't jump on every render.
const MOTES = [
  { x: "8%", s: "5px", d: "17s", delay: "-2s", drift: "30px" },
  { x: "16%", s: "3px", d: "13s", delay: "-9s", drift: "-20px" },
  { x: "27%", s: "4px", d: "19s", delay: "-5s", drift: "40px" },
  { x: "35%", s: "2px", d: "11s", delay: "-1s", drift: "10px" },
  { x: "44%", s: "6px", d: "23s", delay: "-14s", drift: "-35px" },
  { x: "53%", s: "3px", d: "15s", delay: "-7s", drift: "25px" },
  { x: "61%", s: "4px", d: "18s", delay: "-11s", drift: "-15px" },
  { x: "69%", s: "2px", d: "12s", delay: "-4s", drift: "20px" },
  { x: "76%", s: "5px", d: "21s", delay: "-16s", drift: "-30px" },
  { x: "84%", s: "3px", d: "14s", delay: "-8s", drift: "15px" },
  { x: "91%", s: "4px", d: "20s", delay: "-3s", drift: "-25px" },
  { x: "97%", s: "2px", d: "16s", delay: "-12s", drift: "10px" },
];

/** The hero artwork with pointer parallax, a slow drift and floating aether motes. */
export function ArtBackdrop({ motes = true, depth = 12 }: { motes?: boolean; depth?: number }) {
  return (
    <div className="art" aria-hidden="true">
      <div className="art-parallax parallax" data-depth={depth}>
        <div className="art-image" style={{ "--art": `url("${heroArt}")` } as CSSProperties} />
      </div>
      {motes && (
        <div className="motes">
          {MOTES.map((mote, index) => (
            <span
              key={index}
              style={{ "--x": mote.x, "--s": mote.s, "--d": mote.d, "--delay": mote.delay, "--drift": mote.drift } as CSSProperties}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export { heroArt };
