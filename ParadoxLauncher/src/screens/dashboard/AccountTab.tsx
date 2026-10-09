import type { CSSProperties } from "react";
import { useAuth } from "../../auth/AuthContext";
import { formatClock } from "../../lib/sessions";
import { DiscordIcon, LogoutIcon, RefreshIcon, ShieldIcon } from "../../components/icons";
import { ArtBackdrop } from "../../components/ArtBackdrop";

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

export function AccountTab() {
  const { account, logout, accountCheckedAt, accountRefreshing, accountRefreshError, refreshAccount } = useAuth();
  const accountStatus = account?.status === "banned"
    ? "Account banned"
    : account?.status === "disabled"
      ? "Account disabled"
      : account?.approvalStatus === "pending"
        ? "Approval pending"
        : account?.approvalStatus === "rejected"
          ? "Access rejected"
          : account?.status === "active" && account.approvalStatus === "approved"
            ? "Access approved"
            : "Status unavailable";
  const good = account?.status === "active" && account?.approvalStatus === "approved";
  const checkedLabel = accountRefreshing
    ? "Refreshing from the account server…"
    : accountRefreshError
      ? "Last refresh failed. Showing the last confirmed status."
      : accountCheckedAt
        ? `Confirmed by the account server at ${formatClock(accountCheckedAt)}.`
        : "Waiting for the first account refresh.";
  const displayName = account?.displayName ?? "Slayer";

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Slayer profile</p>
          <h1 className="page-title">Account</h1>
          <p className="page-desc">Your identity across Mystic Paradox and the game.</p>
        </header>

        <section className="glass glow card reveal" style={at(1)} aria-label="Profile">
          <div className="profile">
            <span className="avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <h2 className="profile-name" title={displayName}>{displayName}</h2>
              <p className="profile-email">{account?.email || "No email on this account"}</p>
            </div>
          </div>
        </section>

        <section className="glass card reveal" style={at(2)} aria-label="Account status">
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className={`section-icon ${good ? "good" : "warn"}`}><ShieldIcon /></div>
                <div>
                  <h3 className="section-title">{accountStatus}</h3>
                  <p className="section-desc" aria-live="polite">{checkedLabel}</p>
                  {accountRefreshError && <p className="feedback bad" role="alert">{accountRefreshError}</p>}
                </div>
              </div>
              <div className="section-actions">
                <button type="button" className="btn btn-secondary" onClick={() => void refreshAccount()} disabled={accountRefreshing}>
                  {accountRefreshing ? <><span className="spinner" aria-hidden="true" />Refreshing…</> : <><RefreshIcon />Refresh</>}
                </button>
              </div>
            </div>
          </div>
          <div className="section">
            <div className="section-head">
              <div className="section-icon"><DiscordIcon /></div>
              <div>
                <h3 className="section-title">Discord</h3>
                <p className="section-desc">
                  {account?.discordLinked ? "Linked. You can sign in with Discord or your email." : "Not linked to this account."}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="glass card reveal" style={at(3)} aria-label="Sign out">
          <div className="section">
            <div className="section-row">
              <div className="section-head">
                <div className="section-icon bad"><LogoutIcon /></div>
                <div>
                  <h3 className="section-title">Sign out</h3>
                  <p className="section-desc">Closes a running game and returns to the sign-in screen.</p>
                </div>
              </div>
              <div className="section-actions">
                <button type="button" className="btn btn-danger" onClick={() => void logout()}>Sign out</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
