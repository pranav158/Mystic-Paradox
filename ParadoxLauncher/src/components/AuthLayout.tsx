import type { ReactNode } from "react";
import { ArtBackdrop } from "./ArtBackdrop";
import { AetherMark } from "./AetherMark";

/** Art on the left, a glass card on the right; collapses to art-behind-card on narrow windows. */
export function AuthLayout({ children, banner }: { children: ReactNode; banner?: ReactNode }) {
  return (
    <div className="auth">
      <ArtBackdrop depth={14} />
      <div className="auth-brand">
        <div className="auth-brand-mark"><AetherMark title={null} /></div>
        <p className="auth-brand-name">Mystic Paradox</p>
        <p className="auth-brand-tag">A community preservation of Dauntless. The Shattered Isles are waiting, Slayer.</p>
      </div>
      <div className="auth-panel">
        {banner}
        {children}
      </div>
    </div>
  );
}

interface AuthCardProps {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AuthCard({ title, subtitle, icon, children, className }: AuthCardProps) {
  return (
    <div className={`glass glass-strong auth-card${className ? ` ${className}` : ""}`}>
      {icon}
      <header className="auth-head">
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}
