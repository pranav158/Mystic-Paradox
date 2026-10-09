import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "discord";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  loading = false,
  loadingLabel = "Please wait…",
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    variant === "discord" ? "btn-secondary btn-discord" : `btn-${variant}`,
    size === "md" ? "" : `btn-${size}`,
    block ? "btn-block" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <><span className="spinner" aria-hidden="true" />{loadingLabel}</> : children}
    </button>
  );
}
