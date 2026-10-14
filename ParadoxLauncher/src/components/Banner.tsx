import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "./icons";

interface BannerProps {
  tone?: "danger" | "muted" | "success";
  children: ReactNode;
  /** [2026-10-14 realms] When given, the banner has a close button that calls it. */
  onDismiss?: () => void;
}

export function Banner({ tone = "danger", children, onDismiss }: BannerProps) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`banner${tone === "muted" ? "" : ` ${tone}`}`}>
      {tone === "success" ? <CheckIcon /> : <AlertIcon />}
      <div>{children}</div>
      {onDismiss && (
        <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={onDismiss}>×</button>
      )}
    </div>
  );
}
