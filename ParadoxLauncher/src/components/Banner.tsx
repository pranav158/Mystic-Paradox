import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "./icons";

interface BannerProps {
  tone?: "danger" | "muted" | "success";
  children: ReactNode;
}

export function Banner({ tone = "danger", children }: BannerProps) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`banner${tone === "muted" ? "" : ` ${tone}`}`}>
      {tone === "success" ? <CheckIcon /> : <AlertIcon />}
      <div>{children}</div>
    </div>
  );
}
