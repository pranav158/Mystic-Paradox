/** Compact monochrome sigil used across the launcher brand surfaces. */
export function AetherMark({ size, className, title = "Mystic Paradox" }: { size?: number; className?: string; title?: string | null }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <path d="M31.9 3.5 39 22.2 56.8 12l-10.2 19.4L58 49.8l-20.1-7L31.8 61l-6.2-18.2-20 7 11.1-18.4L6.1 12l17.8 10.2L31.9 3.5Z" />
      <path d="m31.9 17.4 3.8 13.1 12.8 1.1-12.1 5.7-4.5 12-3.3-12.2-11.9-5.8 12.7-.8 2.5-13.1Z" fill="#091321" opacity=".82" />
    </svg>
  );
}
