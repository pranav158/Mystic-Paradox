import { useState, type CSSProperties } from "react";
import { describeAuthError, useAuth } from "../../auth/AuthContext";
import { useAccountRules } from "../../auth/AccountRules";
import { useServer } from "../../servers/ServerContext";
import { formatClock } from "../../lib/sessions";
import { formatLongDay, deactivationMessage } from "../../lib/accountDeletion";
import { AlertIcon, DiscordIcon, LogoutIcon, RefreshIcon, ShieldIcon } from "../../components/icons";
import { ArtBackdrop } from "../../components/ArtBackdrop";
import { Button } from "../../components/Button";
import { DeactivationBanner } from "../../components/DeactivationBanner";
import { DeleteAccountDialog } from "../../components/DeleteAccountDialog";
import { useLegalViewer } from "../../components/LegalDocument";

function at(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

export function AccountTab() {
  const { account, logout, accountCheckedAt, accountRefreshing, accountRefreshError, refreshAccount } = useAuth();
  const rules = useAccountRules();
  const { officialNetwork, selected } = useServer();
  const legal = useLegalViewer();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  // [2026-10-14] The Terms and privacy state, from the consent answer of this account.
  const accepted = rules.consent?.accepted ?? null;
  const acceptedDay = formatLongDay(accepted?.acceptedAt);
  const termsNote = rules.consent === null
    ? rules.gate === "failed"
      ? "Couldn't read which versions you accepted."
      : "Reading which versions you accepted…"
    : !rules.consent.supported
      ? "This server asks for no acceptance of the documents."
      : accepted
        ? `Accepted Terms of Use ${accepted.termsVersion} and Privacy Policy ${accepted.privacyVersion}${acceptedDay ? ` on ${acceptedDay}` : ""}.`
        : "Not accepted yet.";

  const deletion = rules.deletion;
  const holdDays = deletion?.holdDays ?? 30;
  const deletionNote = rules.deactivatedUntil
    ? `${deactivationMessage(rules.deactivatedUntil)} Restore the account to keep it.`
    : deletion === null
      ? rules.deletionChecking ? "Checking the account's deletion status…" : "Couldn't read the account's deletion status."
      : !deletion.supported
        ? "Account deletion isn't available on this server."
        : `Deactivates the account at once and deletes it for good after ${holdDays} days. Within those days you can restore it.`;

  async function restore() {
    setRestoreError(null);
    try {
      await rules.restoreAccount();
    } catch (err) {
      setRestoreError(describeAuthError(err));
    }
  }

  return (
    <div className="subpage">
      <ArtBackdrop motes={false} depth={6} />
      <div className="subpage-inner">
        <header className="page-head reveal" style={at(0)}>
          <p className="eyebrow">Slayer profile</p>
          <h1 className="page-title">Account</h1>
          <p className="page-desc">Your identity across Mystic Paradox and the game.</p>
        </header>

        {rules.deactivatedUntil && (
          <div className="reveal" style={at(1)}>
            <DeactivationBanner
              scheduledFor={rules.deactivatedUntil}
              restoring={rules.deletionBusy}
              error={restoreError}
              onRestore={() => void restore()}
            />
          </div>
        )}

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

        {officialNetwork ? (
          <>
            <section className="glass card reveal" style={at(3)} aria-label="Terms and privacy">
              <div className="section">
                <div className="section-row">
                  <div className="section-head">
                    <div className="section-icon"><ShieldIcon /></div>
                    <div>
                      <h3 className="section-title">Terms and privacy</h3>
                      <p className="section-desc" aria-live="polite">{termsNote}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => legal.open("terms")}>Terms of Use</button>
                    <button type="button" className="btn btn-secondary" onClick={() => legal.open("privacy")}>Privacy Policy</button>
                  </div>
                </div>
              </div>
            </section>

            <section className="glass card reveal" style={at(4)} aria-label="Account deletion">
              <div className="section">
                <div className="section-row">
                  <div className="section-head">
                    <div className="section-icon bad"><AlertIcon /></div>
                    <div>
                      <h3 className="section-title">{rules.deactivatedUntil ? "Deletion scheduled" : "Delete account"}</h3>
                      <p className="section-desc" aria-live="polite">{deletionNote}</p>
                    </div>
                  </div>
                  <div className="section-actions">
                    {rules.deactivatedUntil ? (
                      <Button variant="secondary" onClick={() => void restore()} loading={rules.deletionBusy} loadingLabel="Restoring…">
                        Restore account
                      </Button>
                    ) : deletion?.supported ? (
                      <button type="button" className="btn btn-danger" onClick={() => setDeleteOpen(true)} disabled={rules.deletionChecking}>
                        Delete account…
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <section className="glass card reveal" style={at(3)} aria-label="This server's account">
            <div className="section">
              <div className="section-head">
                <div className="section-icon warn"><ShieldIcon /></div>
                <div>
                  <h3 className="section-title">An account on {selected?.name ?? "a local server"}</h3>
                  <p className="section-desc">
                    Mystic Paradox does not hold this account. Its terms, its deletion and its data are for the operator of
                    that server to manage.
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="glass card reveal" style={at(5)} aria-label="Sign out">
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

      {deleteOpen && account && (
        <DeleteAccountDialog
          username={account.displayName}
          holdDays={holdDays}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async (typed) => {
            await rules.requestDeletion(typed);
            setDeleteOpen(false);
          }}
        />
      )}
      {legal.dialog}
    </div>
  );
}

