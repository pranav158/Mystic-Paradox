import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  loading?: boolean;
}

export function Button({ variant = "primary", loading = false, disabled, className, children, ...rest }: ButtonProps) {
  const base =
    "rounded-lg px-4 py-2.5 text-sm font-semibold transition-[background-color,border-color,box-shadow] duration-150 ease-(--ease-out-quart) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

  const variants = {
    primary:
      "bg-accent text-[oklch(0.13_0.02_255)] hover:bg-accent-hover active:bg-accent shadow-[0_1px_12px_-2px] shadow-accent/30",
    secondary:
      "bg-surface-raised text-text border border-border hover:border-border-strong hover:bg-[oklch(0.25_0.03_280)] active:bg-surface-raised",
  };

  return (
    <button className={`${base} ${variants[variant]} ${className ?? ""}`} disabled={disabled || loading} {...rest}>
      {loading ? "Please wait…" : children}
    </button>
  );
}
