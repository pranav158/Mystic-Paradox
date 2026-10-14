/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] The words for a deactivated account. One source for the Home banner, the Account page and Play's reason.
// The native side sends the same sentence for every refusal of a deactivated account (realm, hub, host and game routes),
// so an error that reads as one is the same message the banner shows.

/** A date the way the launcher writes it, in UTC so it matches the native side: "13 November 2026". */
export function formatLongDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The sentence shown wherever a deactivated account is. */
export function deactivationMessage(scheduledFor: string | null | undefined): string {
  const day = formatLongDay(scheduledFor);
  return day
    ? `Your account is deactivated and will be deleted on ${day}.`
    : "Your account is deactivated and scheduled for deletion.";
}

/** True for a refusal that says the account is deactivated (the native side's sentence, with or without the date). */
export function isDeactivationRefusal(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("Your account is deactivated");
}
