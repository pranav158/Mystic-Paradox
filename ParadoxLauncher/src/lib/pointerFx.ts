/**
 * One delegated, rAF-throttled pointer listener for the whole app:
 * - `.glow` surfaces get `--mx`/`--my` so their spotlight and rim light follow the cursor;
 * - `.parallax` layers get `--px`/`--py` (a few pixels) for the hero art drift.
 * Only CSS custom properties change, so the work stays on the compositor-friendly path.
 */
export function installPointerFx(): void {
  if (typeof window === "undefined") return;
  let frame = 0;
  let last: PointerEvent | null = null;

  const apply = () => {
    frame = 0;
    const event = last;
    if (!event) return;
    const target = event.target instanceof Element ? event.target : null;
    const glow = target?.closest<HTMLElement>(".glow");
    if (glow) {
      const rect = glow.getBoundingClientRect();
      glow.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      glow.style.setProperty("--my", `${event.clientY - rect.top}px`);
    }
    if (document.documentElement.dataset.motion === "reduced") return;
    const x = (event.clientX / window.innerWidth - 0.5) * 2;
    const y = (event.clientY / window.innerHeight - 0.5) * 2;
    document.querySelectorAll<HTMLElement>(".parallax").forEach((layer) => {
      const depth = Number(layer.dataset.depth ?? "10");
      layer.style.setProperty("--px", `${(-x * depth).toFixed(2)}px`);
      layer.style.setProperty("--py", `${(-y * depth * 0.6).toFixed(2)}px`);
    });
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      last = event;
      if (!frame) frame = window.requestAnimationFrame(apply);
    },
    { passive: true },
  );
}
