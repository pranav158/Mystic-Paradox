/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Button } from "./Button";
import { AlertIcon } from "./icons";
import { deactivationMessage } from "../lib/accountDeletion";

// [2026-10-14] The account is deactivated and waits for its deletion. Shown on Home and on Account until it is restored.
interface DeactivationBannerProps {
  scheduledFor: string;
  restoring: boolean;
  error?: string | null;
  onRestore: () => void;
}

export function DeactivationBanner({ scheduledFor, restoring, error, onRestore }: DeactivationBannerProps) {
  return (
    <section className="deactivation-banner" aria-label="Account deactivated">
      <div className="deactivation-copy" role="alert">
        <p className="deactivation-title"><AlertIcon />{deactivationMessage(scheduledFor)}</p>
        <p className="deactivation-note">You cannot play, host or join realms until you restore the account.</p>
        {error && <p className="feedback bad">{error}</p>}
      </div>
      <Button variant="secondary" onClick={onRestore} loading={restoring} loadingLabel="Restoring…">Restore account</Button>
    </section>
  );
}
