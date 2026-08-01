/** The aether shard — a rotated square with an inner core. Pure CSS, no assets. */
export function AetherMark({ size = 34 }: { size?: number }) {
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} aria-hidden>
      <div
        className="absolute rotate-45 rounded-[3px] border border-accent/60 bg-accent-faint"
        style={{ width: size * 0.72, height: size * 0.72 }}
      />
      <div
        className="absolute rotate-45 rounded-[2px] bg-accent shadow-[0_0_10px] shadow-accent/50"
        style={{ width: size * 0.28, height: size * 0.28 }}
      />
    </div>
  );
}
