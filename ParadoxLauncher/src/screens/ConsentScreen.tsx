/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { useState } from "react";
import { describeAuthError, useAuth } from "../auth/AuthContext";
import { useAccountRules } from "../auth/AccountRules";
import { AuthCard, AuthLayout } from "../components/AuthLayout";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { LegalConsentChecks } from "../components/LegalConsentChecks";
import { LegalLinks, useLegalViewer } from "../components/LegalDocument";
import { LEGAL } from "../legal/legalMeta";

// [2026-10-14] The consent gate: after a Mystic Paradox sign-in the current Terms of Use and Privacy Policy must be
// accepted before the launcher opens. It is a blocking dialog: Escape does nothing, and the only ways out are Accept and
// Sign out.
export function ConsentScreen() {
  const { logout } = useAuth();
  const rules = useAccountRules();
  const legal = useLegalViewer();
  const [age, setAge] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minimumAge = rules.consent?.required?.minimumAge ?? LEGAL.minimumAge;
  const termsVersion = rules.consent?.required?.termsVersion ?? LEGAL.termsVersion;
  const privacyVersion = rules.consent?.required?.privacyVersion ?? LEGAL.privacyVersion;
  const ready = age && agree && !busy;

  async function accept() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await rules.acceptConsent(LEGAL.termsVersion, LEGAL.privacyVersion);
      // The gate closes by itself once the answer says the documents are accepted.
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <AuthCard title="Terms and privacy" subtitle="Accept the current documents to keep playing.">
        <p className="auth-foot">Terms of Use {termsVersion} · Privacy Policy {privacyVersion}</p>
        <LegalLinks onOpen={legal.open} />
      </AuthCard>
      <Modal
        title="Read and accept to continue"
        onClose={() => {}}
        footer={(
          <>
            <Button variant="ghost" onClick={() => void logout()} disabled={busy}>Sign out</Button>
            <Button onClick={() => void accept()} disabled={!ready} loading={busy} loadingLabel="Saving…">Accept and continue</Button>
          </>
        )}
      >
        <p className="modal-lead">
          Before you play, read and accept the current Terms of Use and Privacy Policy. They explain what Mystic Paradox
          is, the rules you agree to, and what data we keep.
        </p>
        <LegalConsentChecks
          minimumAge={minimumAge}
          age={age}
          agree={agree}
          disabled={busy}
          onAgeChange={setAge}
          onAgreeChange={setAgree}
          onOpen={legal.open}
        />
        {error && <Banner>{error}</Banner>}
      </Modal>
      {legal.dialog}
    </AuthLayout>
  );
}

// The consent answer could not be read: nothing is opened until it can. Try again asks once more.
export function ConsentUnavailableScreen() {
  const { logout } = useAuth();
  const rules = useAccountRules();
  return (
    <AuthLayout>
      <AuthCard title="Couldn't check your account" subtitle={rules.consentError ?? "The launcher couldn't read the Terms of Use status yet."}>
        <div className="status-actions">
          <Button onClick={rules.retryConsent}>Try again</Button>
          <Button variant="secondary" onClick={() => void logout()}>Sign out</Button>
        </div>
      </AuthCard>
    </AuthLayout>
  );
}

